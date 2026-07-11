import type {
  ForwardProfile,
  ForwardRequestPayload,
  ForwardResponsePayload,
  MatchResourceType,
  RequestContext,
  RuleBinding,
} from "@resource-forwarder/shared-types";
import { isTextualContentType, resolveForwardProfile } from "@resource-forwarder/rule-core";

/** Stable sentinel used when an extension message cannot safely carry the body. */
export const STREAMING_UNSUPPORTED = "STREAMING_UNSUPPORTED";

const DEFAULT_FORWARD_TIMEOUT_MS = 15_000;
const MAX_FORWARDABLE_BODY_BYTES = 4 * 1024 * 1024;

export interface ForwardMockFileResult {
  value: unknown;
  displayName: string;
}

export type ForwardMockFileAdapter = (configuredPath: string) => Promise<ForwardMockFileResult>;

export interface ForwardExecutionOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  mockFile?: ForwardMockFileAdapter;
}

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

export async function executeForward(
  binding: RuleBinding,
  payload: ForwardRequestPayload,
  options: ForwardExecutionOptions = {},
): Promise<{ response: ForwardResponsePayload; targetUrl: string }> {
  const profile = resolveForwardProfile(binding);
  if (!profile) {
    throw new Error(`Rule ${binding.rule.id} does not have a forward profile.`);
  }

  const sourceUrl = new URL(payload.url);
  const responsePolicy = profile.responsePolicy;
  const responseMode = responsePolicy?.mode ?? "forward";
  if (responseMode === "mock_json" || responseMode === "mock_file") {
    const mocked = await buildMockResponse(profile, payload, binding.rule.id, options.mockFile);
    await applyResponseDelay(responsePolicy?.delayMs, options.signal);
    return mocked;
  }

  const targetUrl = buildForwardTargetUrl(profile, sourceUrl).toString();
  const headers = buildForwardHeaders(payload.headers, profile, sourceUrl);
  const requestBody = decodeRequestBody(payload);
  const timeout = createTimeoutSignal(profile.timeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS, options.signal);

  try {
    const response = await (options.fetch ?? globalThis.fetch)(targetUrl, {
      method: payload.method,
      headers,
      body: requestBody,
      signal: timeout.signal,
    });
    const contentType = response.headers.get("content-type") ?? undefined;

    if (contentType && /text\/event-stream/i.test(contentType)) {
      throw new Error(STREAMING_UNSUPPORTED);
    }
    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FORWARDABLE_BODY_BYTES) {
      throw new Error(STREAMING_UNSUPPORTED);
    }

    const status = resolveResponseStatus(responsePolicy?.status, response.status);
    const statusText = responsePolicy?.statusText?.trim() || (status === response.status ? response.statusText : "");
    let body: string | undefined;
    let bodyEncoding: "utf8" | "base64" = "utf8";
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
      body = bytesToBase64(new Uint8Array(await response.arrayBuffer()));
      bodyEncoding = "base64";
    }

    if (!statusAllowsBody(status)) {
      body = undefined;
      bodyEncoding = "utf8";
    }

    const responseHeaders = buildForwardResponseHeaders(responseHeaderSource, profile, true);
    await applyResponseDelay(responsePolicy?.delayMs, options.signal);
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
  } finally {
    timeout.dispose();
  }
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
  target.pathname = `${trimTrailingSlash(target.pathname)}${ensureLeadingSlash(pathname)}`.replace(/\/+/g, "/");

  const mergedParams = new URLSearchParams(target.search);
  const overriddenKeys = new Set<string>();
  sourceUrl.searchParams.forEach((value, key) => {
    if (!overriddenKeys.has(key)) {
      mergedParams.delete(key);
      overriddenKeys.add(key);
    }
    mergedParams.append(key, value);
  });
  for (const key of profile.queryPolicy?.remove ?? []) mergedParams.delete(key);
  for (const [key, value] of Object.entries(profile.queryPolicy?.set ?? {})) mergedParams.set(key, value);
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
  for (const name of profile.responseHeaderPolicy?.strip ?? []) headers.delete(name);
  for (const [name, value] of Object.entries(profile.responseHeaderPolicy?.set ?? {})) headers.set(name, value);
  return Object.fromEntries(headers.entries());
}

async function buildMockResponse(
  profile: ForwardProfile,
  payload: ForwardRequestPayload,
  ruleId: string,
  mockFile: ForwardMockFileAdapter | undefined,
): Promise<{ response: ForwardResponsePayload; targetUrl: string }> {
  const policy = profile.responsePolicy;
  const mode = policy?.mode ?? "mock_json";
  let value: unknown;
  let targetUrl = "mock:inline-json";

  if (mode === "mock_file") {
    const configuredPath = policy?.mockFilePath?.trim();
    if (!configuredPath) throw new Error("Mock JSON file path is required.");
    if (!mockFile) throw new Error("Mock file execution requires a mockFile adapter.");
    const loaded = await mockFile(configuredPath);
    value = loaded.value;
    targetUrl = `mock-file:${loaded.displayName}`;
  } else {
    value = policy?.mockJson ?? {};
  }

  const status = resolveResponseStatus(policy?.status, 200);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  return {
    targetUrl,
    response: {
      status,
      statusText: policy?.statusText?.trim() || HTTP_STATUS_TEXT[status] || "",
      headers: buildForwardResponseHeaders(headers, profile, true),
      body: statusAllowsBody(status) ? JSON.stringify(value) : undefined,
      bodyEncoding: "utf8",
      responseUrl: payload.url,
      matchedRuleId: ruleId,
    },
  };
}

function buildForwardHeaders(incomingHeaders: Record<string, string>, profile: ForwardProfile, sourceUrl: URL): Headers {
  const policy = profile.headerPolicy;
  const stripExtra = (policy?.strip ?? []).map((name) => name.toLowerCase());
  const passthrough = new Set((policy?.passthrough ?? []).map((name) => name.toLowerCase()));
  const strip = new Set<string>(["host", "content-length"]);
  let isSameOrigin = false;
  try {
    isSameOrigin = new URL(profile.targetBaseUrl).hostname === sourceUrl.hostname;
  } catch {
    // Treat malformed targets as cross-origin, which is the safer default.
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
    if (!passthrough.has(lower) && (strip.has(lower) || stripExtra.includes(lower))) continue;
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(profile.headers ?? {})) headers.set(name, value);
  return headers;
}

function decodeRequestBody(payload: ForwardRequestPayload): BodyInit | undefined {
  if (!payload.body || payload.method.toUpperCase() === "GET" || payload.method.toUpperCase() === "HEAD") return undefined;
  return payload.bodyEncoding === "base64" ? base64ToArrayBuffer(payload.body) : payload.body;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function createTimeoutSignal(timeoutMs: number, external?: AbortSignal): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    },
  };
}

async function applyResponseDelay(delayMs: number | undefined, signal?: AbortSignal): Promise<void> {
  if (!delayMs || delayMs <= 0) return;
  const duration = Math.min(Math.round(delayMs), 30_000);
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, duration);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
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

function applyJsonMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = applyJsonMergePatch(result[key], value);
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") && value !== "/" ? value.slice(0, -1) : value;
}

function ensureLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function collectQueryValues(searchParams: URLSearchParams): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  searchParams.forEach((value, key) => (result[key] ??= []).push(value));
  return result;
}

function normalizeHeaderRecord(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
}

const HTTP_STATUS_TEXT: Record<number, string> = {
  100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints",
  200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content",
  205: "Reset Content", 206: "Partial Content", 207: "Multi-Status", 208: "Already Reported", 226: "IM Used",
  300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
  305: "Use Proxy", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 406: "Not Acceptable", 407: "Proxy Authentication Required", 408: "Request Timeout",
  409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large",
  414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable", 417: "Expectation Failed",
  418: "I'm a Teapot", 421: "Misdirected Request", 422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency",
  425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests",
  431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable",
  504: "Gateway Timeout", 505: "HTTP Version Not Supported", 506: "Variant Also Negotiates", 507: "Insufficient Storage",
  508: "Loop Detected", 510: "Not Extended", 511: "Network Authentication Required",
};
