import { describe, expect, it } from "vitest";
import type { Rule } from "@resource-forwarder/shared-types";
import { buildRuleSearchText, formatRuleTarget, formatTimestamp, localizeWarning } from "./formatters.js";

const baseRule: Rule = {
  id: "rule-1",
  name: "API 转发示例",
  enabled: true,
  kind: "api_forward",
  priority: 100,
  match: {
    host: ["example.com"],
    pathGlob: "/api/**",
    resourceType: ["fetch"],
    method: ["GET", "POST"],
    tabScope: { mode: "all" },
  },
  target: { forwardProfile: { targetBaseUrl: "http://localhost:3000", headers: {} } },
  note: "调试",
  tags: ["staging"],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

describe("formatRuleTarget", () => {
  it("returns redirectUrl for asset_redirect rules", () => {
    const rule: Rule = { ...baseRule, kind: "asset_redirect", target: { redirectUrl: "https://cdn/app.js" } };
    expect(formatRuleTarget(rule)).toBe("https://cdn/app.js");
  });

  it("returns forward target base URL for api_forward rules", () => {
    expect(formatRuleTarget(baseRule)).toBe("http://localhost:3000");
  });

  it("falls back to a placeholder when the target is empty", () => {
    const empty: Rule = { ...baseRule, target: { forwardProfile: { targetBaseUrl: "", headers: {} } } };
    expect(formatRuleTarget(empty)).toMatch(/未填写/);
  });
});

describe("buildRuleSearchText", () => {
  it("collapses every searchable field into a lowercase haystack", () => {
    const text = buildRuleSearchText(baseRule);
    expect(text).toContain("api 转发示例");
    expect(text).toContain("example.com");
    expect(text).toContain("/api/**");
    expect(text).toContain("staging");
    expect(text).toContain("http://localhost:3000");
    // Method case is normalized
    expect(text).toContain("get, post");
  });
});

describe("formatTimestamp", () => {
  it("returns em-dash for missing values", () => {
    expect(formatTimestamp(undefined)).toBe("—");
  });

  it("formats a full local timestamp by default", () => {
    const out = formatTimestamp("2025-03-04T10:20:30Z");
    // Year prefix present, format roughly YYYY-MM-DD HH:MM
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("drops the year when short=true", () => {
    const out = formatTimestamp("2025-03-04T10:20:30Z", true);
    expect(out).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("localizeWarning", () => {
  it("translates HTTPS-target warnings", () => {
    expect(localizeWarning("Rule must point to an HTTPS target")).toContain("HTTPS");
  });

  it("translates missing forward profile warnings", () => {
    expect(localizeWarning("Rule is missing a forward profile")).toContain("API 转发");
  });

  it("interpolates the project name into wildcard-mix warnings", () => {
    const out = localizeWarning('Project "demo" mixes a wildcard site pattern with concrete patterns');
    expect(out).toContain("demo");
    expect(out).toContain("通配符");
  });

  it("falls through unknown warnings unchanged", () => {
    expect(localizeWarning("some unknown sentinel")).toBe("some unknown sentinel");
  });
});
