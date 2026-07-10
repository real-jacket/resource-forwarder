import type { ForwardRequestPayload, RuleBinding } from "@resource-forwarder/shared-types";
import { resolveForwardProfile } from "@resource-forwarder/rule-core";

export function shouldAttachBrowserCookies(
  binding: RuleBinding | undefined,
  payload: ForwardRequestPayload,
): boolean {
  if (!binding) return false;
  if (Object.keys(payload.headers).some((name) => name.toLowerCase() === "cookie")) return false;
  const profile = resolveForwardProfile(binding);
  if (!profile) return false;

  try {
    const source = new URL(payload.url);
    const target = new URL(profile.targetBaseUrl);
    const passthrough = new Set(
      (profile.headerPolicy?.passthrough ?? []).map((name) => name.toLowerCase()),
    );
    return source.hostname === target.hostname || passthrough.has("cookie");
  } catch {
    return false;
  }
}

export function buildCookieHeader(
  cookies: Array<Pick<chrome.cookies.Cookie, "name" | "value" | "path">>,
): string {
  return [...cookies]
    .sort((left, right) => right.path.length - left.path.length || left.name.localeCompare(right.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
