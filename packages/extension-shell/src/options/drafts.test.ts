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
  baseUrl: "https://project.example.com/base/",
  envLabel: "dev",
  note: "demo",
  tags: [],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const baseRuleSet: RuleSet = {
  id: "ruleset-1",
  projectId: "project-1",
  name: "默认分组",
  enabled: true,
  ruleIds: [],
  baseUrl: "https://ruleset.example.com/tables/",
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

  it("seeds asset_redirect defaults with asset-only resource types", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "asset_redirect" });
    expect(draft.resourceType).toBe("script, stylesheet, image, font");
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

  it("upgrades legacy asset_redirect default resource types when editing an existing rule", () => {
    const rule: Rule = {
      id: "rule-legacy-asset",
      name: "legacy asset",
      enabled: true,
      kind: "asset_redirect",
      priority: 50,
      match: {
        host: ["as.smgv.cn"],
        pathGlob: "/table/table_calc_engine_bg.*.wasm",
        resourceType: ["script", "stylesheet", "image", "font"],
        tabScope: { mode: "all" },
      },
      target: { redirectUrl: "http://localhost:8000/table_calc_engine_bg.wasm" },
      tags: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, rule });
    expect(draft.resourceType).toBe("script, stylesheet, image, font, xmlhttprequest, other");
  });

  it("adds wasm fetch-compatible resource types even when the existing rule only listed asset buckets", () => {
    const rule: Rule = {
      id: "rule-wasm-asset-only",
      name: "wasm asset only",
      enabled: true,
      kind: "asset_redirect",
      priority: 50,
      match: {
        host: ["as.smgv.cn"],
        pathGlob: "/table/table_calc_engine_bg.3f3bf4aec3.wasm",
        resourceType: ["script"],
        tabScope: { mode: "all" },
      },
      target: { redirectUrl: "http://localhost:8000/table_calc_engine_bg.3f3bf4aec3.wasm" },
      tags: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, rule });
    expect(draft.resourceType).toBe("script, xmlhttprequest, other");
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
    expect(draft.baseUrl).toBe("https://project.example.com/base/");
    expect(draft.envLabel).toBe("dev");
  });
});

describe("toRule", () => {
  it("throws when ruleSetId is missing", () => {
    const draft = createRuleDraft({ kind: "api_forward" });
    expect(() => toRule(draft, emptyWorkspace, baseProject)).toThrow(/分组/);
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

  it("upgrades legacy asset_redirect default resource types on save", () => {
    const existing: Rule = {
      id: "rule-existing-asset",
      name: "old asset",
      enabled: true,
      kind: "asset_redirect",
      priority: 100,
      match: {
        host: ["as.smgv.cn"],
        pathGlob: "/table/table_calc_engine_bg.*.wasm",
        resourceType: ["script", "stylesheet", "image", "font"],
        tabScope: { mode: "all" },
      },
      target: { redirectUrl: "http://localhost:8000/table_calc_engine_bg.wasm" },
      tags: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const workspace: WorkspaceSnapshot = { ...emptyWorkspace, rules: [existing] };
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, rule: existing });
    const rule = toRule(draft, workspace, baseProject);
    expect(rule.match.resourceType).toEqual(["script", "stylesheet", "image", "font", "xmlhttprequest", "other"]);
  });

  it("adds wasm fetch-compatible resource types on save even for narrow asset-only rules", () => {
    const existing: Rule = {
      id: "rule-existing-wasm",
      name: "old wasm",
      enabled: true,
      kind: "asset_redirect",
      priority: 100,
      match: {
        host: ["as.smgv.cn"],
        pathGlob: "/table/table_calc_engine_bg.3f3bf4aec3.wasm",
        resourceType: ["script"],
        tabScope: { mode: "all" },
      },
      target: { redirectUrl: "http://localhost:8000/table_calc_engine_bg.3f3bf4aec3.wasm" },
      tags: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const workspace: WorkspaceSnapshot = { ...emptyWorkspace, rules: [existing] };
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, rule: existing });
    const rule = toRule(draft, workspace, baseProject);
    expect(rule.match.resourceType).toEqual(["script", "xmlhttprequest", "other"]);
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

  it("round-trips all API forwarding fields without silently dropping advanced config", () => {
    const existing: Rule = {
      id: "rule-advanced",
      name: "advanced",
      enabled: true,
      kind: "api_forward",
      priority: 100,
      match: {
        host: ["example.com"],
        pathGlob: "/api/**",
        query: { tenant: "dev-*" },
        headers: { "x-client": "web-*" },
        resourceType: ["fetch"],
        method: ["GET"],
        tabScope: { mode: "all" },
      },
      target: {
        forwardProfile: {
          executionMode: "local",
          targetBaseUrl: "http://localhost:3000/base?from=target",
          stripPrefix: "/api",
          pathRewrite: [{ from: "/users", to: "/v1/users" }],
          queryPolicy: {
            remove: ["token"],
            set: { env: "local" },
            append: { tag: ["debug", "frontend"] },
          },
          headers: { "x-debug": "1" },
          headerPolicy: { strip: ["x-old"], passthrough: ["authorization"] },
          responseHeaderPolicy: { strip: ["content-security-policy"], set: { "cache-control": "no-store" } },
          timeoutMs: 45000,
          fallbackMode: "error",
        },
      },
      tags: ["local"],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const workspace: WorkspaceSnapshot = { ...emptyWorkspace, rules: [existing] };
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, rule: existing });
    const saved = toRule(draft, workspace, baseProject);

    expect(saved.match.query).toEqual(existing.match.query);
    expect(saved.match.headers).toEqual(existing.match.headers);
    expect(saved.target.forwardProfile).toEqual(existing.target.forwardProfile);
  });

  it("round-trips forwarded JSON response patches and response overrides", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "api_forward" });
    draft.targetBaseUrl = "http://localhost:3000";
    draft.responseMode = "forward";
    draft.responseStatus = "202";
    draft.responseStatusText = "Accepted for UI";
    draft.responseDelayMs = 350;
    draft.responseJsonPatch = JSON.stringify({ data: { name: "Local", role: null }, debug: true });

    const rule = toRule(draft, emptyWorkspace, baseProject);
    const restored = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, rule });

    expect(rule.target.forwardProfile?.responsePolicy).toEqual({
      mode: "forward",
      status: 202,
      statusText: "Accepted for UI",
      delayMs: 350,
      jsonMergePatch: { data: { name: "Local", role: null }, debug: true },
      mockJson: undefined,
      mockFilePath: undefined,
    });
    expect(restored.responseMode).toBe("forward");
    expect(JSON.parse(restored.responseJsonPatch)).toEqual({ data: { name: "Local", role: null }, debug: true });
  });

  it("allows an inline JSON mock without a target URL", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "api_forward" });
    draft.targetBaseUrl = "";
    draft.responseMode = "mock_json";
    draft.responseStatus = "404";
    draft.responseMockJson = JSON.stringify({ code: "USER_NOT_FOUND", data: null });

    const rule = toRule(draft, emptyWorkspace, baseProject);
    expect(rule.target.forwardProfile?.targetBaseUrl).toBe("");
    expect(rule.target.forwardProfile?.responsePolicy).toMatchObject({
      mode: "mock_json",
      status: 404,
      mockJson: { code: "USER_NOT_FOUND", data: null },
    });
  });

  it("round-trips a local JSON file mock", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "api_forward" });
    draft.targetBaseUrl = "";
    draft.responseMode = "mock_file";
    draft.responseMockFilePath = "./mocks/user-detail.json";

    const rule = toRule(draft, emptyWorkspace, baseProject);
    const restored = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, rule });
    expect(rule.target.forwardProfile?.responsePolicy).toMatchObject({
      mode: "mock_file",
      mockFilePath: "./mocks/user-detail.json",
    });
    expect(restored.responseMockFilePath).toBe("./mocks/user-detail.json");
  });

  it("validates target, file path, status, delay and JSON response inputs", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "api_forward" });

    draft.responseMode = "forward";
    draft.targetBaseUrl = "";
    expect(() => toRule(draft, emptyWorkspace, baseProject)).toThrow(/目标地址/);

    draft.responseMode = "mock_file";
    expect(() => toRule(draft, emptyWorkspace, baseProject)).toThrow(/文件路径/);

    draft.responseMode = "mock_json";
    draft.responseMockJson = "{broken";
    expect(() => toRule(draft, emptyWorkspace, baseProject)).toThrow(/Mock JSON/);

    draft.responseMockJson = "{}";
    draft.responseStatus = "99";
    expect(() => toRule(draft, emptyWorkspace, baseProject)).toThrow(/100 到 599/);

    draft.responseStatus = "200";
    draft.responseDelayMs = 30001;
    expect(() => toRule(draft, emptyWorkspace, baseProject)).toThrow(/30000/);
  });

  it("auto-strips scheme + host when user pastes a full URL into pathGlob", () => {
    const draft = createRuleDraft({ project: baseProject, ruleSet: baseRuleSet, kind: "asset_redirect" });
    draft.pathGlob = "https://uccp-dev.shimorelease.com/minio/weboffice-assets/docx/sdk-*.js";
    draft.redirectUrl = "http://localhost:54321/editor-document/sdk.js";
    const rule = toRule(draft, emptyWorkspace, baseProject);
    expect(rule.match.pathGlob).toBe("/minio/weboffice-assets/docx/sdk-*.js");
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
