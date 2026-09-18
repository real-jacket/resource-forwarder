import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { collectExecutableRuleIds, collectShadowedRuleIds, describeRuleRoutes } from "./rule-execution.js";

const now = "2026-08-15T00:00:00.000Z";

function workspace(): WorkspaceSnapshot {
  return {
    version: 1,
    revision: 0,
    updatedAt: now,
    projects: [{
      id: "project",
      name: "Project",
      enabled: true,
      siteHosts: ["example.com"],
      siteMatchPatterns: ["https://example.com/*"],
      tags: [],
      createdAt: now,
      updatedAt: now,
    }],
    ruleSets: [{
      id: "ruleset",
      projectId: "project",
      name: "Rules",
      enabled: true,
      ruleIds: ["rule"],
      createdAt: now,
      updatedAt: now,
    }],
    rules: [{
      id: "rule",
      name: "Rule",
      enabled: true,
      kind: "api_forward",
      priority: 100,
      match: { host: ["example.com"], pathGlob: "/api/**", tabScope: { mode: "all" } },
      target: { forwardProfile: { targetBaseUrl: "https://upstream.example.com" } },
      tags: [],
      createdAt: now,
      updatedAt: now,
    }],
  };
}

describe("collectExecutableRuleIds", () => {
  it("excludes rules under a disabled Project", () => {
    const value = workspace();
    value.projects[0]!.enabled = false;
    expect(collectExecutableRuleIds(value, "https://example.com/page", 1)).toEqual(new Set());
  });

  it("excludes rules under a disabled RuleSet", () => {
    const value = workspace();
    value.ruleSets[0]!.enabled = false;
    expect(collectExecutableRuleIds(value, "https://example.com/page", 1)).toEqual(new Set());
  });

  it("excludes explicit tab scopes that miss the current tab", () => {
    const value = workspace();
    value.rules[0]!.match.tabScope = { mode: "tabIds", tabIds: [2] };
    expect(collectExecutableRuleIds(value, "https://example.com/page", 1)).toEqual(new Set());
  });

  it("excludes ambiguous RuleSet membership", () => {
    const value = workspace();
    value.ruleSets.push({
      ...value.ruleSets[0]!,
      id: "other-ruleset",
    });
    expect(collectExecutableRuleIds(value, "https://example.com/page", 1)).toEqual(new Set());
  });
});

describe("collectShadowedRuleIds", () => {
  // Mirrors the real scenario: a group is copied (our copy feature), so a
  // second rule set on the same page carries a byte-for-byte duplicate asset
  // rule at the same priority. Both are page-active, but only one redirect can
  // apply — the copy must be reported as shadowed.
  function twoDuplicateGroups(): WorkspaceSnapshot {
    const assetMatch = {
      host: ["co-dev-office-18.shimorelease.com"],
      pathGlob: "/shimo-assets/sheet/entry.*.js",
      resourceType: ["script" as const],
      tabScope: { mode: "all" as const },
    };
    const baseRule = {
      name: "entryjs",
      enabled: true,
      kind: "asset_redirect" as const,
      priority: 100,
      match: assetMatch,
      target: { redirectUrl: "http://localhost:8080/entry.js" },
      tags: [],
      createdAt: now,
      updatedAt: now,
    };
    return {
      version: 1,
      revision: 0,
      updatedAt: now,
      projects: [{
        id: "project",
        name: "co-dev-office-18",
        enabled: true,
        siteHosts: ["co-dev-office-18.shimorelease.com"],
        siteMatchPatterns: ["https://co-dev-office-18.shimorelease.com/sdk/demo/shimo-files/*"],
        tags: [],
        createdAt: now,
        updatedAt: now,
      }],
      ruleSets: [
        { id: "sheet", projectId: "project", name: "sheet", enabled: true, ruleIds: ["entry-orig"], siteMatchPatterns: ["https://co-dev-office-18.shimorelease.com/sdk/demo/shimo-files/*"], createdAt: now, updatedAt: now },
        { id: "sheet-copy", projectId: "project", name: "sheet-2e82", enabled: true, ruleIds: ["entry-copy"], siteMatchPatterns: ["https://co-dev-office-18.shimorelease.com/sdk/demo/shimo-files/2e8259efe5674995"], createdAt: "2026-08-16T00:00:00.000Z", updatedAt: now },
      ],
      rules: [
        { ...baseRule, id: "entry-orig" },
        { ...baseRule, id: "entry-copy", createdAt: "2026-08-16T00:00:00.000Z" },
      ],
    };
  }

  it("shadows the broader-scoped duplicate and keeps the exact-scope one effective", () => {
    const url = "https://co-dev-office-18.shimorelease.com/sdk/demo/shimo-files/2e8259efe5674995";
    const value = twoDuplicateGroups();

    // Sanity: both duplicates are page-active (enabled + in-scope).
    expect(collectExecutableRuleIds(value, url, 1)).toEqual(new Set(["entry-orig", "entry-copy"]));
    // "sheet" scopes the whole `/shimo-files/*`; the copied "sheet-2e82" group
    // scopes the exact URL — the exact one is the effective winner, so the
    // broader original is the redundant (shadowed) one.
    expect(collectShadowedRuleIds(value, url, 1)).toEqual(new Set(["entry-orig"]));
  });
});

describe("describeRuleRoutes", () => {
  it("expands a relative asset target into a complete source and target pair", () => {
    const value = workspace();
    const project = value.projects[0]!;
    const ruleSet = value.ruleSets[0]!;
    ruleSet.baseUrl = "https://localhost.example/assets/";
    const rule = {
      ...value.rules[0]!,
      kind: "asset_redirect" as const,
      match: { ...value.rules[0]!.match, pathGlob: "/static/entry-*.js" },
      target: { redirectUrl: "entry-*.js" },
    };

    expect(describeRuleRoutes(rule, project, ruleSet, "https://example.com/page")).toEqual([{
      source: "https://example.com/static/entry-*.js",
      target: "https://localhost.example/assets/entry-*.js",
    }]);
  });

  it("shows the final forwarded URL pattern for API rules", () => {
    const value = workspace();
    const rule = value.rules[0]!;
    rule.target.forwardProfile = {
      targetBaseUrl: "https://api.example.net/v1",
      stripPrefix: "/api",
    };

    expect(describeRuleRoutes(
      rule,
      value.projects[0]!,
      value.ruleSets[0]!,
      "https://example.com/page",
    )).toEqual([{
      source: "https://example.com/api/**",
      target: "https://api.example.net/v1/**",
    }]);
  });

  it("uses a safe placeholder when an API host contains a wildcard", () => {
    const value = workspace();
    const rule = value.rules[0]!;
    rule.match.host = ["*.example.com"];
    rule.target.forwardProfile = { targetBaseUrl: "https://api.example.net" };

    expect(describeRuleRoutes(rule, value.projects[0]!, value.ruleSets[0]!, "https://example.com/page")[0]).toEqual({
      source: "https://*.example.com/api/**",
      target: "https://api.example.net/api/**",
    });
  });
});
