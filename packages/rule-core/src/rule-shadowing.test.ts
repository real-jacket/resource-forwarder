import { describe, expect, it } from "vitest";
import type { Rule } from "@resource-forwarder/shared-types";
import { computeShadowedRuleIds } from "./rule-shadowing.js";

const ts = "2024-01-01T00:00:00.000Z";

function rule(overrides: Partial<Rule> & { id: string }): Rule {
  return {
    name: overrides.id,
    enabled: true,
    kind: "api_forward",
    priority: 100,
    match: { host: ["a.example.com"], pathGlob: "/**", tabScope: { mode: "all" } },
    target: { forwardProfile: { targetBaseUrl: "https://up.example.com" } },
    tags: [],
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  } as Rule;
}

describe("computeShadowedRuleIds", () => {
  it("marks a specific path as shadowed by an earlier wildcard that covers it", () => {
    // Precedence order: wildcard first (wins for every request the exact one matches).
    const rules = [
      rule({ id: "wild", match: { host: ["a.example.com"], pathGlob: "/sdk/demo/shimo-files/*", tabScope: { mode: "all" } } }),
      rule({ id: "exact", match: { host: ["a.example.com"], pathGlob: "/sdk/demo/shimo-files/2e8259efe5674995", tabScope: { mode: "all" } } }),
    ];

    expect(computeShadowedRuleIds(rules)).toEqual(new Set(["exact"]));
  });

  it("does not shadow the wildcard when the specific rule precedes it", () => {
    const rules = [
      rule({ id: "exact", match: { host: ["a.example.com"], pathGlob: "/sdk/demo/shimo-files/2e8259efe5674995", tabScope: { mode: "all" } } }),
      rule({ id: "wild", match: { host: ["a.example.com"], pathGlob: "/sdk/demo/shimo-files/*", tabScope: { mode: "all" } } }),
    ];

    expect(computeShadowedRuleIds(rules)).toEqual(new Set());
  });

  it("does not treat a single * as covering a deeper path segment", () => {
    const rules = [
      rule({ id: "wild", match: { host: ["a.example.com"], pathGlob: "/sdk/demo/shimo-files/*", tabScope: { mode: "all" } } }),
      rule({ id: "deep", match: { host: ["a.example.com"], pathGlob: "/sdk/demo/shimo-files/2e82/preview", tabScope: { mode: "all" } } }),
    ];

    // `*` does not cross `/`, so the wildcard does NOT cover the deeper path.
    expect(computeShadowedRuleIds(rules)).toEqual(new Set());
  });

  it("treats a trailing ** as covering any deeper path", () => {
    const rules = [
      rule({ id: "wild", match: { host: ["a.example.com"], pathGlob: "/sdk/demo/**", tabScope: { mode: "all" } } }),
      rule({ id: "deep", match: { host: ["a.example.com"], pathGlob: "/sdk/demo/shimo-files/2e82/preview", tabScope: { mode: "all" } } }),
    ];

    expect(computeShadowedRuleIds(rules)).toEqual(new Set(["deep"]));
  });

  it("does not shadow across different rule kinds", () => {
    const rules = [
      rule({ id: "api", kind: "api_forward", match: { host: ["a.example.com"], pathGlob: "/x/**", tabScope: { mode: "all" } } }),
      rule({ id: "asset", kind: "asset_redirect", target: { redirectUrl: "https://cdn/x.js" }, match: { host: ["a.example.com"], pathGlob: "/x/app.js", resourceType: ["script"], tabScope: { mode: "all" } } }),
    ];

    expect(computeShadowedRuleIds(rules)).toEqual(new Set());
  });

  it("does not shadow when the earlier rule narrows the HTTP method", () => {
    const rules = [
      rule({ id: "post-only", match: { host: ["a.example.com"], pathGlob: "/api/**", method: ["POST"], tabScope: { mode: "all" } } }),
      rule({ id: "any-method", match: { host: ["a.example.com"], pathGlob: "/api/users", tabScope: { mode: "all" } } }),
    ];

    // A GET /api/users still needs the second rule — it is not fully covered.
    expect(computeShadowedRuleIds(rules)).toEqual(new Set());
  });

  it("shadows when the earlier rule's method set is a superset", () => {
    const rules = [
      rule({ id: "broad", match: { host: ["a.example.com"], pathGlob: "/api/**", tabScope: { mode: "all" } } }),
      rule({ id: "narrow", match: { host: ["a.example.com"], pathGlob: "/api/users", method: ["GET"], tabScope: { mode: "all" } } }),
    ];

    expect(computeShadowedRuleIds(rules)).toEqual(new Set(["narrow"]));
  });

  it("covers a specific host via a wildcard host in the earlier rule", () => {
    const rules = [
      rule({ id: "wild-host", match: { host: ["*"], pathGlob: "/api/**", tabScope: { mode: "all" } } }),
      rule({ id: "exact-host", match: { host: ["a.example.com"], pathGlob: "/api/users", tabScope: { mode: "all" } } }),
    ];

    expect(computeShadowedRuleIds(rules)).toEqual(new Set(["exact-host"]));
  });

  it("ignores disabled rules as shadowers", () => {
    const rules = [
      rule({ id: "wild", enabled: false, match: { host: ["a.example.com"], pathGlob: "/api/**", tabScope: { mode: "all" } } }),
      rule({ id: "exact", match: { host: ["a.example.com"], pathGlob: "/api/users", tabScope: { mode: "all" } } }),
    ];

    expect(computeShadowedRuleIds(rules)).toEqual(new Set());
  });

  it("does not shadow an equal-priority asset_redirect (browser DNR ties are undefined)", () => {
    // Both priority 100; a wildcard covering an exact one would win under the
    // api_forward first-match model, but for asset_redirect Chrome DNR only
    // guarantees the strictly-higher priority wins, so we must not claim it.
    const rules = [
      rule({ id: "wild", kind: "asset_redirect", priority: 100, target: { redirectUrl: "https://cdn/a.js" }, match: { host: ["a.example.com"], pathGlob: "/static/*", resourceType: ["script"], tabScope: { mode: "all" } } }),
      rule({ id: "exact", kind: "asset_redirect", priority: 100, target: { redirectUrl: "https://cdn/b.js" }, match: { host: ["a.example.com"], pathGlob: "/static/app.js", resourceType: ["script"], tabScope: { mode: "all" } } }),
    ];

    expect(computeShadowedRuleIds(rules)).toEqual(new Set());
  });

  it("shadows a duplicated equal-priority asset_redirect (same match scope)", () => {
    // The common case: a copied group produces two identical asset rules at the
    // same priority. Only one can apply, so the later duplicate is redundant.
    const rules = [
      rule({ id: "orig", kind: "asset_redirect", priority: 100, target: { redirectUrl: "https://cdn/a.js" }, match: { host: ["a.example.com"], pathGlob: "/shimo-assets/sheet/entry.*.js", resourceType: ["script"], tabScope: { mode: "all" } } }),
      rule({ id: "copy", kind: "asset_redirect", priority: 100, target: { redirectUrl: "https://cdn/a.js" }, match: { host: ["a.example.com"], pathGlob: "/shimo-assets/sheet/entry.*.js", resourceType: ["script"], tabScope: { mode: "all" } } }),
    ];

    expect(computeShadowedRuleIds(rules)).toEqual(new Set(["copy"]));
  });

  it("shadows an asset_redirect only when a covering rule has strictly higher priority", () => {
    const rules = [
      rule({ id: "wild", kind: "asset_redirect", priority: 200, target: { redirectUrl: "https://cdn/a.js" }, match: { host: ["a.example.com"], pathGlob: "/static/*", resourceType: ["script"], tabScope: { mode: "all" } } }),
      rule({ id: "exact", kind: "asset_redirect", priority: 100, target: { redirectUrl: "https://cdn/b.js" }, match: { host: ["a.example.com"], pathGlob: "/static/app.js", resourceType: ["script"], tabScope: { mode: "all" } } }),
    ];

    expect(computeShadowedRuleIds(rules)).toEqual(new Set(["exact"]));
  });
});
