import { Buffer } from "node:buffer";
import { readFile, stat } from "node:fs/promises";
import { STATUS_CODES } from "node:http";
import { basename, extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ForwardProfile,
  ForwardRequestPayload,
  ForwardResponsePayload,
  MatchResourceType,
  RequestContext,
  RuleBinding,
} from "@resource-forwarder/shared-types";
import { isTextualContentType, resolveForwardProfile } from "@resource-forwarder/rule-core";
import { DEFAULT_FORWARD_TIMEOUT_MS } from "./defaults.js";

/**
 * Sentinel thrown by `forwardThroughRule` when it can tell, just from response
 * headers, that buffering the body would be wrong (SSE streams) or expensive
 * (multi-MiB downloads). The route handler turns this into a 409 + `code:
 * "stream-unsupported"` so the extension can fall back to a native fetch.
 */
export const STREAMING_UNSUPPORTED = "STREAMING_UNSUPPORTED";

/** Hard cap above which we tell the page to fetch directly (~4 MiB). */
const MAX_FORWARDABLE_BODY_BYTES = 4 * 1024 * 1024;

// Accepts a structural subset rather than the full ForwardRequestPayload so the
// read-only /match endpoint can reuse the same URL parsing + field defaults
// while passing the wider MatchResourceType set (script/image/font/...), which
// the narrower ForwardRequestPayload.resourceType ("fetch"|"xmlhttprequest")
// can't express. A ForwardRequestPayload still satisfies this shape, so
// /forward's call site is unchanged.
export function createRequestContext(payload: {
  url: string;
  pageUrl?: string;
  method: string;
  tabId?: number;
  resourceType?: MatchResourceType;
  headers?: Record<string, string>;
}): RequestContext {
  const url = new URL(payload.url);
  return {
    url: url.toString(),
    pageUrl: payload.pageUrl,
    method: payload.method,
    host: url.host,
    pathname: url.pathname,
    query: collectQueryValues(url.searchParams),
    tabId: payload.tabId,
    resourceType: payload.resourceType ?? "fetch",
    headers: normalizeHeaderRecord(payload.headers),
  };
}

export async function forwardThroughRule(
  binding: RuleBinding,
  payload: ForwardRequestPayload,
): Promise<{ response: ForwardResponsePayload; targetUrl: string }> {
  const profile = resolveForwardProfile(binding);
  if (!profile) {
    throw new Error(`Rule ${binding.rule.id} does not have a forward profile.`);
  }

  const sourceUrl = new URL(payload.url);
  const responsePolicy = profile.responsePolicy;
  const responseMode = responsePolicy?.mode ?? "forward";
  if (responseMode === "mock_json" || responseMode === "mock_file") {
    const mocked = await buildMockResponse(profile, payload, binding.rule.id);
    await applyResponseDelay(responsePolicy?.delayMs);
    return mocked;
  }

  const targetUrl = buildForwardTargetUrl(profile, sourceUrl).toString();
  const headers = buildForwardHeaders(payload.headers, profile, sourceUrl);
  const requestBody = decodeRequestBody(payload);
  const response = await fetch(targetUrl, {
    method: payload.method,
    headers,
    body: requestBody,
    signal: AbortSignal.timeout(profile.timeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS),
  });

  const contentType = response.headers.get("content-type") ?? undefined;

  // Refuse to buffer responses that are inherently streaming. Doing so would
  // hold the request open until the upstream closed it (SSE never does) and
  // collapse every event into one base64 blob the page can't progressively
  // consume. Better to tell the page-bridge to retry natively.
  if (contentType && /text\/event-stream/i.test(contentType)) {
    throw new Error(STREAMING_UNSUPPORTED);
  }

  // Same logic for very large bodies: the entire response would be base64'd
  // and shipped through chrome.runtime.sendMessage, which has a practical
  // ceiling around 8 MiB. Fall through to the native fetch instead.
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORWARDABLE_BODY_BYTES) {
    throw new Error(STREAMING_UNSUPPORTED);
  }

  const status = resolveResponseStatus(responsePolicy?.status, response.status);
  const statusText = responsePolicy?.statusText?.trim() || (status === response.status ? response.statusText : "");
  let body: string | undefined;
  let bodyEncoding: "utf8" | "base64" = "utf8";
  // Every upstream body is buffered and reconstructed inside the page. Node's
  // fetch may also transparently decompress it, so transport-specific headers
  // from the original response are no longer trustworthy even without a JSON
  // patch.
  let bodyChanged = true;
  const responseHeaderSource = new Headers(response.headers);

  if (isTextualContentType(contentType) || responsePolicy?.jsonMergePatch !== undefined) {
    const text = await response.text();
    if (responsePolicy?.jsonMergePatch !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Configured JSON response patch requires an upstream JSON response.");
      }
      body = JSON.stringify(applyJsonMergePatch(parsed, responsePolicy.jsonMergePatch));
      responseHeaderSource.set("content-type", "application/json; charset=utf-8");
    } else {
      body = text;
    }
  } else {
    if (responsePolicy?.jsonMergePatch !== undefined) {
      throw new Error("Configured JSON response patch cannot be applied to a binary upstream response.");
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    body = buffer.toString("base64");
    bodyEncoding = "base64";
  }

  if (!statusAllowsBody(status)) {
    body = undefined;
    bodyEncoding = "utf8";
  }

  const responseHeaders = buildForwardResponseHeaders(responseHeaderSource, profile, bodyChanged);
  await applyResponseDelay(responsePolicy?.delayMs);
  return {
    targetUrl,
    response: {
      status,
      statusText,
      headers: responseHeaders,
      body,
      bodyEncoding,
      responseUrl: response.url,
      matchedRuleId: binding.rule.id,
    },
  };
}

export function buildForwardTargetUrl(profile: ForwardProfile, sourceUrl: URL): URL {
  const target = new URL(profile.targetBaseUrl);
  let pathname = sourceUrl.pathname;

  if (profile.stripPrefix && pathname.startsWith(profile.stripPrefix)) {
    pathname = pathname.slice(profile.stripPrefix.length) || "/";
  }

  for (const rewrite of profile.pathRewrite ?? []) {
    if (pathname.startsWith(rewrite.from)) {
      pathname = `${rewrite.to}${pathname.slice(rewrite.from.length)}`;
    }
  }

  const joinedPath = `${trimTrailingSlash(target.pathname)}${ensureLeadingSlash(pathname)}`.replace(/\/+/g, "/");
  target.pathname = joinedPath;

  // Merge source query into target query, preserving multi-value keys
  // (e.g. ?tag=a&tag=b). The previous .set() implementation collapsed those
  // to a single value. Source keys overwrite target keys with the same name —
  // the first time we see a key, drop any pre-existing target entries for it.
  const mergedParams = new URLSearchParams(target.search);
  const overriddenKeys = new Set<string>();
  sourceUrl.searchParams.forEach((value, key) => {
    if (!overriddenKeys.has(key)) {
      mergedParams.delete(key);
      overriddenKeys.add(key);
    }
    mergedParams.append(key, value);
  });
  for (const key of profile.queryPolicy?.remove ?? []) {
    mergedParams.delete(key);
  }
  for (const [key, value] of Object.entries(profile.queryPolicy?.set ?? {})) {
    mergedParams.set(key, value);
  }
  for (const [key, values] of Object.entries(profile.queryPolicy?.append ?? {})) {
    for (const value of values) mergedParams.append(key, value);
  }
  target.search = mergedParams.toString();
  return target;
}

export function buildForwardResponseHeaders(
  incomingHeaders: Headers,
  profile: ForwardProfile,
  bodyChanged = false,
): Record<string, string> {
  const headers = new Headers(incomingHeaders);
  if (bodyChanged) {
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
  }
  for (const name of profile.responseHeaderPolicy?.strip ?? []) {
    headers.delete(name);
  }
  for (const [name, value] of Object.entries(profile.responseHeaderPolicy?.set ?? {})) {
    headers.set(name, value);
  }
  return Object.fromEntries(headers.entries());
}

async function buildMockResponse(
  profile: ForwardProfile,
  payload: ForwardRequestPayload,
  ruleId: string,
): Promise<{ response: ForwardResponsePayload; targetUrl: string }> {
  const policy = profile.responsePolicy;
  const mode = policy?.mode ?? "mock_json";
  let value: unknown;
  let targetUrl = "mock:inline-json";

  if (mode === "mock_file") {
    const configuredPath = policy?.mockFilePath?.trim();
    if (!configuredPath) {
      throw new Error("Mock JSON file path is required.");
    }
    const filePath = resolve(configuredPath);
    if (extname(filePath).toLowerCase() !== ".json") {
      throw new Error("Mock response files must use the .json extension.");
    }
    const displayName = basename(filePath);
    let file: Buffer;
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        throw new Error("not-a-file");
      }
      if (fileStat.size > MAX_FORWARDABLE_BODY_BYTES) {
        throw new Error("file-too-large");
      }
      file = await readFile(filePath);
    } catch (error) {
      if (error instanceof Error && error.message === "file-too-large") {
        throw new Error(`Mock JSON file ${displayName} exceeds ${MAX_FORWARDABLE_BODY_BYTES} bytes.`);
      }
      throw new Error(`Unable to read mock JSON file ${displayName}.`);
    }
    if (file.byteLength > MAX_FORWARDABLE_BODY_BYTES) {
      throw new Error(`Mock JSON file exceeds ${MAX_FORWARDABLE_BODY_BYTES} bytes.`);
    }
    try {
      value = JSON.parse(file.toString("utf8"));
    } catch {
      throw new Error("Mock response file is not valid JSON.");
    }
    targetUrl = `mock-file:${displayName}`;
  } else {
    value = policy?.mockJson ?? {};
  }

  const status = resolveResponseStatus(policy?.status, 200);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  const responseHeaders = buildForwardResponseHeaders(headers, profile, true);
  return {
    targetUrl,
    response: {
      status,
      statusText: policy?.statusText?.trim() || STATUS_CODES[status] || "",
      headers: responseHeaders,
      body: statusAllowsBody(status) ? JSON.stringify(value) : undefined,
      bodyEncoding: "utf8",
      responseUrl: payload.url,
      matchedRuleId: ruleId,
    },
  };
}

function resolveResponseStatus(configured: number | undefined, fallback: number): number {
  if (configured === undefined) return fallback;
  if (!Number.isInteger(configured) || configured < 100 || configured > 599) {
    throw new Error("Response status must be an integer between 100 and 599.");
  }
  return configured;
}

function statusAllowsBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

async function applyResponseDelay(delayMs: number | undefined): Promise<void> {
  if (!delayMs || delayMs <= 0) return;
  await delay(Math.min(Math.round(delayMs), 30000));
}

function applyJsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = applyJsonMergePatch(result[key], value);
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildForwardHeaders(
  incomingHeaders: Record<string, string>,
  profile: ForwardProfile,
  sourceUrl: URL,
): Headers {
  const policy = profile.headerPolicy;
  const stripExtra = (policy?.strip ?? []).map((name) => name.toLowerCase());
  const passthrough = new Set((policy?.passthrough ?? []).map((name) => name.toLowerCase()));

  // Default strip list. host / content-length must always be dropped (the
  // values become wrong after url/body rewrite). Cookie / origin / referer
  // get stripped *only when going cross-origin*: a same-host forward usually
  // wants the cookie session preserved, and stripping it forces every user
  // to add an explicit passthrough policy. The auth-style headers stay
  // protected for cross-origin destinations.
  const strip = new Set<string>(["host", "content-length"]);
  let isSameOrigin = false;
  try {
    const target = new URL(profile.targetBaseUrl);
    isSameOrigin = target.hostname === sourceUrl.hostname;
  } catch {
    // Malformed targetBaseUrl — fall through to "treat as cross-origin" which
    // is the safer default.
  }
  if (!isSameOrigin) {
    strip.add("cookie");
    strip.add("cookie2");
    strip.add("origin");
    strip.add("referer");
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(incomingHeaders)) {
    const lower = name.toLowerCase();
    if (!passthrough.has(lower) && (strip.has(lower) || stripExtra.includes(lower))) {
      continue;
    }
    headers.set(name, value);
  }

  for (const [name, value] of Object.entries(profile.headers ?? {})) {
    headers.set(name, value);
  }

  return headers;
}

// host / content-length are always stripped because their values become invalid
// after the URL and body rewrite. Cookie / origin / referer are stripped *only
// when going cross-origin* — same-host forwards typically want the session
// cookie preserved. Use ForwardHeaderPolicy.passthrough to override per-rule.

function decodeRequestBody(payload: ForwardRequestPayload): BodyInit | undefined {
  if (!payload.body || payload.method.toUpperCase() === "GET" || payload.method.toUpperCase() === "HEAD") {
    return undefined;
  }

  if (payload.bodyEncoding === "base64") {
    return Buffer.from(payload.body, "base64");
  }

  return payload.body;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") && value !== "/" ? value.slice(0, -1) : value;
}

function ensureLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function collectQueryValues(searchParams: URLSearchParams): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  searchParams.forEach((value, key) => {
    (result[key] ??= []).push(value);
  });
  return result;
}

function normalizeHeaderRecord(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
}
