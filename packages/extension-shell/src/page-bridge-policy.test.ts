import { describe, expect, it } from "vitest";
import type { Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { needsPageBridge } from "./page-bridge-policy.js";

const apiRule = (enabled: boolean): Rule => ({
  id: "api",
  name: "API",
  enabled,
  kind: "api_forward",
  priority: 100,
  match: { host: ["example.com"], pathGlob: "/api/**", tabScope: { mode: "all" } },
  target: { forwardProfile: { targetBaseUrl: "https://upstream.example.com" } },
  tags: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function workspace(rules: Rule[]): WorkspaceSnapshot {
  return {
    version: 1,
    revision: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: [{
      id: "project",
      name: "Project",
      enabled: true,
      siteHosts: ["example.com"],
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    ruleSets: [{
      id: "ruleset",
      projectId: "project",
      name: "Rules",
      enabled: true,
      ruleIds: rules.map((rule) => rule.id),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    rules,
  };
}

describe("needsPageBridge", () => {
  it("returns false for an empty workspace", () => {
    expect(needsPageBridge(workspace([]))).toBe(false);
  });

  it("returns false for asset-only rules", () => {
    expect(needsPageBridge(workspace([{ ...apiRule(true), kind: "asset_redirect", target: { redirectUrl: "https://cdn.example.com/app.js" } }]))).toBe(false);
  });

  it("returns false for disabled API rules", () => {
    expect(needsPageBridge(workspace([apiRule(false)]))).toBe(false);
  });

  it("returns true for enabled API rules", () => {
    expect(needsPageBridge(workspace([apiRule(true)]))).toBe(true);
  });
});
