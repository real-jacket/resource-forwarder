import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { collectExecutableRuleIds, describeRuleRoutes } from "./rule-execution.js";

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
