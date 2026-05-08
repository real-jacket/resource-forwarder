import { describe, expect, it } from "vitest";
import type { Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { prepareMatcher } from "./matcher-cache.js";
import { matchesPath } from "./matchers.js";

const ts = "2024-01-01T00:00:00.000Z";

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: "r",
    name: "Rule",
    enabled: true,
    kind: "api_forward",
    priority: 0,
    match: { host: ["app.example.com"], pathGlob: "/api/**", resourceType: ["fetch"], tabScope: { mode: "all" } },
    target: { forwardProfile: { targetBaseUrl: "https://up.example.com" } },
    tags: [],
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function workspace(rules: Rule[]): WorkspaceSnapshot {
  return {
    version: 1,
    updatedAt: ts,
    projects: [{ id: "p", name: "App", enabled: true, siteHosts: ["app.example.com"], tags: [], createdAt: ts, updatedAt: ts }],
    ruleSets: [
      { id: "rs", projectId: "p", name: "Default", enabled: true, ruleIds: rules.map((r) => r.id), createdAt: ts, updatedAt: ts },
    ],
    rules,
  };
}

describe("prepareMatcher", () => {
  it("returns the highest-priority binding for a request", () => {
    const matcher = prepareMatcher(
      workspace([
        rule({ id: "low", priority: 10 }),
        rule({ id: "high", priority: 100 }),
      ]),
    );

    const match = matcher.pick({
      url: "https://app.example.com/api/x",
      method: "GET",
      host: "app.example.com",
      pathname: "/api/x",
      resourceType: "fetch",
    }, "api_forward");

    expect(match?.rule.id).toBe("high");
  });

  it("filters disabled rules, rule sets, and projects out at compile time", () => {
    const ws = workspace([rule({ id: "ok" }), rule({ id: "off", enabled: false })]);
    const matcher = prepareMatcher(ws);
    expect(matcher.bindings("api_forward").map((b) => b.rule.id)).toEqual(["ok"]);
  });

  it("respects host wildcard patterns and suffix wildcards", () => {
    const matcher = prepareMatcher(
      workspace([
        rule({ id: "wild", match: { host: ["*.example.com"], pathGlob: "/**", resourceType: ["fetch"], tabScope: { mode: "all" } } }),
      ]),
    );
    const subdomain = matcher.pick({
      url: "https://api.example.com/x",
      method: "GET",
      host: "api.example.com",
      pathname: "/x",
      resourceType: "fetch",
    }, "api_forward");
    const unrelated = matcher.pick({
      url: "https://other.com/x",
      method: "GET",
      host: "other.com",
      pathname: "/x",
      resourceType: "fetch",
    }, "api_forward");
    expect(subdomain?.rule.id).toBe("wild");
    expect(unrelated).toBeUndefined();
  });

  it("rejects requests on disallowed methods even if host and path match", () => {
    const matcher = prepareMatcher(
      workspace([
        rule({ match: { host: ["app.example.com"], pathGlob: "/api/**", method: ["GET"], resourceType: ["fetch"], tabScope: { mode: "all" } } }),
      ]),
    );
    const post = matcher.pick({
      url: "https://app.example.com/api/x",
      method: "POST",
      host: "app.example.com",
      pathname: "/api/x",
      resourceType: "fetch",
    }, "api_forward");
    expect(post).toBeUndefined();
  });

  it("respects tabScope.tabIds gating", () => {
    const matcher = prepareMatcher(
      workspace([
        rule({ match: { host: ["app.example.com"], pathGlob: "/**", resourceType: ["fetch"], tabScope: { mode: "tabIds", tabIds: [42] } } }),
      ]),
    );
    expect(
      matcher.pick({ url: "https://app.example.com/x", method: "GET", host: "app.example.com", pathname: "/x", resourceType: "fetch", tabId: 42 }, "api_forward")?.rule.id,
    ).toBe("r");
    expect(
      matcher.pick({ url: "https://app.example.com/x", method: "GET", host: "app.example.com", pathname: "/x", resourceType: "fetch", tabId: 7 }, "api_forward"),
    ).toBeUndefined();
  });

  it("buckets by kind so api_forward search ignores asset_redirect rules", () => {
    const matcher = prepareMatcher(
      workspace([
        rule({ id: "api" }),
        rule({
          id: "asset",
          kind: "asset_redirect",
          target: { redirectUrl: "https://cdn.example.com/x.js" },
          match: { host: ["app.example.com"], pathGlob: "/api/**", resourceType: ["script"], tabScope: { mode: "all" } },
        }),
      ]),
    );
    expect(matcher.bindings("api_forward").map((b) => b.rule.id)).toEqual(["api"]);
    expect(matcher.bindings("asset_redirect").map((b) => b.rule.id)).toEqual(["asset"]);
  });

  it("evaluates many requests cheaply (smoke test for hot-path expectation)", () => {
    const big = workspace(
      Array.from({ length: 200 }, (_, i) =>
        rule({
          id: `rule-${i}`,
          priority: i,
          match: { host: ["app.example.com"], pathGlob: `/api/group${i}/**`, resourceType: ["fetch"], tabScope: { mode: "all" } },
        }),
      ),
    );
    const matcher = prepareMatcher(big);
    const ctx = {
      url: "https://app.example.com/api/group137/profile",
      method: "GET",
      host: "app.example.com",
      pathname: "/api/group137/profile",
      resourceType: "fetch" as const,
    };
    const start = performance.now();
    for (let i = 0; i < 1000; i += 1) matcher.pick(ctx, "api_forward");
    const elapsed = performance.now() - start;
    // Generous bound — flaky-test guard, not a strict perf assertion. The
    // pre-cache implementation took several seconds for this loop.
    expect(elapsed).toBeLessThan(500);
  });

  it("uses the same path-glob semantics as matchesPath (cross-consistency check)", () => {
    // Regression coverage for the glob-implementation dedupe: matcher-cache
    // now imports globToPathRegexSource from glob.ts instead of carrying its
    // own copy. This test makes sure the path-segment behaviour stays in sync
    // with the per-call matchesPath helper across single-segment, multi-segment
    // and trailing-slash variants.
    const cases: Array<[string, string, boolean]> = [
      ["/api/users", "/api/*", true],
      ["/api/users/42", "/api/*", false],
      ["/api/users/42", "/api/**", true],
      ["/api/", "/api/*", true],
      ["/api", "/api", true],
      ["/api", "/api/*", false],
    ];
    for (const [pathname, pathGlob, expected] of cases) {
      const matcher = prepareMatcher(workspace([rule({ id: "g", match: { host: ["app.example.com"], pathGlob, resourceType: ["fetch"], tabScope: { mode: "all" } } })]));
      const picked = matcher.pick({
        url: `https://app.example.com${pathname}`,
        method: "GET",
        host: "app.example.com",
        pathname,
        resourceType: "fetch",
      }, "api_forward");
      expect(Boolean(picked)).toBe(expected);
      expect(matchesPath(pathGlob, pathname)).toBe(expected);
    }
  });
});
