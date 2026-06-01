import { Buffer } from "node:buffer";
import type {
  ForwardProfile,
  ForwardRequestPayload,
  ForwardResponsePayload,
  MatchResourceType,
  RequestContext,
  RuleBinding,
} from "@resource-forwarder/shared-types";
import { isTextualContentType } from "@resource-forwarder/rule-core";
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
  method: string;
  tabId?: number;
  resourceType?: MatchResourceType;
  headers?: Record<string, string>;
}): RequestContext {
  const url = new URL(payload.url);
  return {
    url: url.toString(),
    method: payload.method,
    host: url.host,
    pathname: url.pathname,
    tabId: payload.tabId,
    resourceType: payload.resourceType ?? "fetch",
    headers: payload.headers,
  };
}

export async function forwardThroughRule(
  binding: RuleBinding,
  payload: ForwardRequestPayload,
): Promise<{ response: ForwardResponsePayload; targetUrl: string }> {
  const profile = binding.rule.target.forwardProfile;
  if (!profile) {
    throw new Error(`Rule ${binding.rule.id} does not have a forward profile.`);
  }

  const sourceUrl = new URL(payload.url);
  const targetUrl = buildForwardTargetUrl(profile, sourceUrl).toString();
  const headers = buildForwardHeaders(payload.headers, profile, sourceUrl);
  const body = decodeRequestBody(payload);
  const response = await fetch(targetUrl, {
    method: payload.method,
    headers,
    body,
    signal: AbortSignal.timeout(profile.timeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS),
  });

  const responseHeaders = Object.fromEntries(response.headers.entries());
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

  if (isTextualContentType(contentType)) {
    return {
      targetUrl,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: await response.text(),
        bodyEncoding: "utf8",
        responseUrl: response.url,
        matchedRuleId: binding.rule.id,
      },
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    targetUrl,
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: buffer.toString("base64"),
      bodyEncoding: "base64",
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
  target.search = mergedParams.toString();
  return target;
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
