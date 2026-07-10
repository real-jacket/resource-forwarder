import { describe, expect, it } from "vitest";
import type { ForwardRequestPayload, RuleBinding } from "@resource-forwarder/shared-types";
import { buildCookieHeader, shouldAttachBrowserCookies } from "./cookie-forwarding.js";

function payload(headers: Record<string, string> = {}): ForwardRequestPayload {
  return {
    url: "https://app.example.com/api/me",
    method: "GET",
    headers,
    resourceType: "fetch",
  };
}

function binding(targetBaseUrl: string, passthrough: string[] = []): RuleBinding {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    rule: {
      id: "r",
      name: "r",
      enabled: true,
      kind: "api_forward",
      priority: 1,
      match: { host: ["app.example.com"], pathGlob: "/api/**" },
      target: { forwardProfile: { targetBaseUrl, headerPolicy: { passthrough } } },
      tags: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe("cookie forwarding", () => {
  it("attaches browser cookies automatically for same-host forwarding", () => {
    expect(shouldAttachBrowserCookies(binding("https://app.example.com/dev"), payload())).toBe(true);
  });

  it("requires explicit cookie passthrough for cross-host forwarding", () => {
    expect(shouldAttachBrowserCookies(binding("http://localhost:3000"), payload())).toBe(false);
    expect(shouldAttachBrowserCookies(binding("http://localhost:3000", ["Cookie"]), payload())).toBe(true);
  });

  it("does not overwrite a cookie header already supplied by the request", () => {
    expect(shouldAttachBrowserCookies(binding("https://app.example.com"), payload({ Cookie: "manual=1" }))).toBe(false);
  });

  it("orders specific cookie paths before broad paths", () => {
    expect(buildCookieHeader([
      { name: "root", value: "1", path: "/" },
      { name: "api", value: "2", path: "/api" },
    ])).toBe("api=2; root=1");
  });
});
