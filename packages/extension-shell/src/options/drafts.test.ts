import { describe, expect, it } from "vitest";
import type { Project, Rule, RuleSet, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import {
  createBatchRuleDraft,
  createRuleDraft,
  fromProject,
  getRuleTemplatePresets,
  mergeRuleDraftByKind,
  toRule,
} from "./drafts.js";

const baseProject: Project = {
  id: "project-1",
  name: "示例站点",
  enabled: true,
  siteHosts: ["example.com"],
  siteMatchPatterns: ["https://example.com/*"],
  envLabel: "dev",
  note: "demo",
  tags: [],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const baseRuleSet: RuleSet = {
  id: "ruleset-1",
  projectId: "project-1",
  name: "默认规则组",
  enabled: true,
  ruleIds: [],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const emptyWorkspace: WorkspaceSnapshot = {
  version: 1,
  updatedAt: "2025-01-01T00:00:00.000Z",
  projects: [baseProject],
  ruleSets: [baseRuleSet],
  rules: [],
};

describe("createRuleDraft", () => {
  it("seeds api_forward defaults from project + ruleSet when no rule given", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "api_forward" });
    expect(draft.kind).toBe("api_forward");
    expect(draft.ruleSetId).toBe("ruleset-1");
    expect(draft.host).toBe("example.com");
    expect(draft.pathGlob).toBe("/api/**");
    expect(draft.method).toBe("GET, POST");
    expect(draft.id).toBe("");
  });

  it("populates from an existing rule when one is provided", () => {
    const rule: Rule = {
      id: "rule-1",
      name: "edit me",
      enabled: true,
      kind: "asset_redirect",
      priority: 50,
      match: {
        host: ["a.com", "b.com"],
        pathGlob: "/static/**",
        resourceType: ["script"],
        tabScope: { mode: "all" },
      },
      target: { redirectUrl: "https://cdn/app.js" },
      tags: ["t1"],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, rule });
    expect(draft.id).toBe("rule-1");
    expect(draft.host).toBe("a.com, b.com");
    expect(draft.redirectUrl).toBe("https://cdn/app.js");
    expect(draft.tags).toBe("t1");
    // headersJson is always a JSON-string, even when no headers exist
    expect(JSON.parse(draft.headersJson)).toEqual({});
  });
});

describe("createBatchRuleDraft", () => {
  it("inherits shape fields from a source draft and assigns a unique localId", () => {
    const first = createBatchRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "api_forward" });
    first.targetBaseUrl = "http://localhost:3000";
    const second = createBatchRuleDraft({ project: baseProject, ruleSet: baseRuleSet, source: first });
    expect(second.localId).not.toBe(first.localId);
    expect(second.targetBaseUrl).toBe("http://localhost:3000");
    expect(second.kind).toBe("api_forward");
  });
});

describe("mergeRuleDraftByKind", () => {
  it("clears asset-only fields when switching api_forward → asset_redirect", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "api_forward" });
    draft.targetBaseUrl = "http://localhost:3000";
    const next = mergeRuleDraftByKind(draft, "asset_redirect");
    expect(next.kind).toBe("asset_redirect");
    expect(next.targetBaseUrl).toBe("");
    expect(next.headersJson).toBe("");
  });

  it("clears api-only fields when switching asset_redirect → api_forward", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "asset_redirect" });
    draft.redirectUrl = "https://cdn/app.js";
    const next = mergeRuleDraftByKind(draft, "api_forward");
    expect(next.redirectUrl).toBe("");
    expect(next.headersJson).toBe("{}");
  });

  it("applies a patch on top of the kind-merged base", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "api_forward" });
    const next = mergeRuleDraftByKind(draft, "api_forward", { name: "patched" });
    expect(next.name).toBe("patched");
    expect(next.kind).toBe("api_forward");
  });
});

describe("fromProject", () => {
  it("derives siteMatchPatterns from siteHosts when patterns are missing", () => {
    const project: Project = { ...baseProject, siteMatchPatterns: undefined as unknown as string[] };
    const draft = fromProject(project);
    expect(draft.siteMatchPatterns).toBe("https://example.com/*");
  });

  it("preserves explicit siteMatchPatterns", () => {
    const draft = fromProject(baseProject);
    expect(draft.siteMatchPatterns).toBe("https://example.com/*");
    expect(draft.envLabel).toBe("dev");
  });
});

describe("toRule", () => {
  it("throws when ruleSetId is missing", () => {
    const draft = createRuleDraft({ kind: "api_forward" });
    expect(() => toRule(draft, emptyWorkspace, baseProject)).toThrow(/规则组/);
  });

  it("converts api_forward draft into a Rule with parsed headers", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "api_forward" });
    draft.targetBaseUrl = "http://localhost:3000";
    draft.headersJson = JSON.stringify({ "X-Debug": "1" });
    const rule = toRule(draft, emptyWorkspace, baseProject);
    expect(rule.kind).toBe("api_forward");
    expect(rule.target.forwardProfile?.targetBaseUrl).toBe("http://localhost:3000");
    expect(rule.target.forwardProfile?.headers).toEqual({ "X-Debug": "1" });
    // Generated id has the rule prefix
    expect(rule.id.startsWith("rule")).toBe(true);
  });

  it("converts asset_redirect draft into a Rule with redirectUrl", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "asset_redirect" });
    draft.redirectUrl = "https://cdn/app.js";
    const rule = toRule(draft, emptyWorkspace, baseProject);
    expect(rule.kind).toBe("asset_redirect");
    expect(rule.target.redirectUrl).toBe("https://cdn/app.js");
    expect(rule.target.forwardProfile).toBeUndefined();
  });

  it("preserves createdAt when editing an existing rule", () => {
    const existing: Rule = {
      id: "rule-existing",
      name: "old",
      enabled: true,
      kind: "api_forward",
      priority: 100,
      match: { host: ["example.com"], pathGlob: "/api/**", resourceType: ["fetch"], tabScope: { mode: "all" } },
      target: { forwardProfile: { targetBaseUrl: "http://x", headers: {} } },
      tags: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const workspace: WorkspaceSnapshot = { ...emptyWorkspace, rules: [existing] };
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, rule: existing });
    const rule = toRule(draft, workspace, baseProject);
    expect(rule.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(rule.updatedAt).not.toBe("2024-01-01T00:00:00.000Z");
  });
});

describe("getRuleTemplatePresets", () => {
  it("filters templates by kind", () => {
    const apiPresets = getRuleTemplatePresets("api_forward");
    expect(apiPresets.length).toBeGreaterThan(0);
    expect(apiPresets.every((p) => p.kind === "api_forward")).toBe(true);

    const assetPresets = getRuleTemplatePresets("asset_redirect");
    expect(assetPresets.length).toBeGreaterThan(0);
    expect(assetPresets.every((p) => p.kind === "asset_redirect")).toBe(true);
  });
});
