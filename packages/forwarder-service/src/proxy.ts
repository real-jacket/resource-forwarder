import { Buffer } from "node:buffer";
import type {
  ForwardProfile,
  ForwardRequestPayload,
  ForwardResponsePayload,
  RequestContext,
  RuleBinding,
} from "@resource-forwarder/shared-types";
import { isTextualContentType } from "@resource-forwarder/rule-core";
import { DEFAULT_FORWARD_TIMEOUT_MS } from "./defaults.js";

export function createRequestContext(payload: ForwardRequestPayload): RequestContext {
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
  const headers = buildForwardHeaders(payload.headers, profile);
  const body = decodeRequestBody(payload);
  const response = await fetch(targetUrl, {
    method: payload.method,
    headers,
    body,
    signal: AbortSignal.timeout(profile.timeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS),
  });

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const contentType = response.headers.get("content-type") ?? undefined;

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
): Headers {
  const policy = profile.headerPolicy;
  const stripExtra = (policy?.strip ?? []).map((name) => name.toLowerCase());
  const passthrough = new Set((policy?.passthrough ?? []).map((name) => name.toLowerCase()));

  const headers = new Headers();
  for (const [name, value] of Object.entries(incomingHeaders)) {
    const lower = name.toLowerCase();
    if (!passthrough.has(lower) && (DEFAULT_STRIP_HEADERS.has(lower) || stripExtra.includes(lower))) {
      continue;
    }
    headers.set(name, value);
  }

  for (const [name, value] of Object.entries(profile.headers ?? {})) {
    headers.set(name, value);
  }

  return headers;
}

// Headers stripped by default before the request leaves the local service.
// host / content-length: values become invalid after the URL/body rewrite.
// cookie, cookie2: depth-of-defence — fetch/XHR shouldn't surface these to
//   user code anyway, but a future code path could, so we don't trust the
//   incoming map.
// origin, referer: cross-origin upstreams often reject mismatched values.
// Use ForwardHeaderPolicy.passthrough to override per-rule.
const DEFAULT_STRIP_HEADERS = new Set([
  "host",
  "content-length",
  "cookie",
  "cookie2",
  "origin",
  "referer",
]);

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
