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
  const headers = buildForwardHeaders(payload.headers, profile.headers);
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

  const mergedParams = new URLSearchParams(target.search);
  sourceUrl.searchParams.forEach((value, key) => {
    mergedParams.set(key, value);
  });
  target.search = mergedParams.toString();
  return target;
}

function buildForwardHeaders(
  incomingHeaders: Record<string, string>,
  injectedHeaders?: Record<string, string>,
): Headers {
  const headers = new Headers(incomingHeaders);
  headers.delete("host");
  headers.delete("content-length");

  for (const [name, value] of Object.entries(injectedHeaders ?? {})) {
    headers.set(name, value);
  }

  return headers;
}

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
