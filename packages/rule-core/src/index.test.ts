import { describe, expect, it } from "vitest";
import type { Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import {
  collectUnsupportedRuleWarnings,
  parseWorkspace,
  pickMatchingRule,
  serializeWorkspace,
  toDynamicNetRequestRules,
} from "./index.js";

const apiRule: Rule = {
  id: "rule-api",
  name: "Forward API",
  enabled: true,
  kind: "api_forward",
  priority: 100,
  match: {
    host: ["app.example.com"],
    pathGlob: "/api/**",
    resourceType: ["fetch", "xmlhttprequest"],
    method: ["GET", "POST"],
    tabScope: { mode: "all" },
  },
  target: {
    forwardProfile: {
      targetBaseUrl: "https://dev.example.com",
    },
  },
  tags: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const assetRule: Rule = {
  id: "rule-asset",
  name: "Asset Redirect",
  enabled: true,
  kind: "asset_redirect",
  priority: 80,
  match: {
    host: ["app.example.com"],
    pathGlob: "/assets/**",
    resourceType: ["script"],
    tabScope: { mode: "all" },
  },
  target: {
    redirectUrl: "https://cdn.example.com/assets/app.js",
  },
  tags: [],
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const workspace: WorkspaceSnapshot = {
  version: 1,
  updatedAt: "2024-01-01T00:00:00.000Z",
  projects: [
    {
      id: "project-1",
      name: "App",
      enabled: true,
      siteHosts: ["app.example.com"],
      tags: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ],
  ruleSets: [
    {
      id: "ruleset-1",
      projectId: "project-1",
      name: "Default",
      enabled: true,
      ruleIds: ["rule-api", "rule-asset"],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ],
  rules: [apiRule, assetRule],
};

describe("rule-core", () => {
  it("matches the highest priority API rule", () => {
    const match = pickMatchingRule(
      workspace,
      {
        url: "https://app.example.com/api/profile",
        method: "GET",
        host: "app.example.com",
        pathname: "/api/profile",
        resourceType: "fetch",
      },
      "api_forward",
    );

    expect(match?.rule.id).toBe("rule-api");
  });

  it("serializes and parses workspace snapshots", () => {
    const yaml = serializeWorkspace(workspace, "yaml");
    expect(parseWorkspace(yaml)).toEqual(workspace);
  });

  it("creates dynamic DNR rules for asset redirects", () => {
    const rules = toDynamicNetRequestRules(workspace);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.action.redirect.url).toContain("https://cdn.example.com");
  });

  it("reports unsupported asset targets", () => {
    const warnings = collectUnsupportedRuleWarnings({
      ...assetRule,
      target: { redirectUrl: "http://localhost:3000/app.js" },
    });
    expect(warnings[0]).toContain("HTTPS");
  });
});
