import { describe, expect, it } from "vitest";
import type { Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import {
  collectUnsupportedRuleWarnings,
  parseWorkspace,
  parseResourceOverrideExport,
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

  it("reports unsupported asset targets for non-HTTPS non-localhost URLs", () => {
    const warnings = collectUnsupportedRuleWarnings({
      ...assetRule,
      target: { redirectUrl: "http://remote-server.example.com/app.js" },
    });
    expect(warnings[0]).toContain("HTTPS");
  });

  it("allows localhost HTTP targets for asset_redirect without warnings", () => {
    const warnings = collectUnsupportedRuleWarnings({
      ...assetRule,
      target: { redirectUrl: "http://localhost:3000/app.js" },
    });
    expect(warnings).toHaveLength(0);
  });

  it("converts supported Resource Override exports into workspace rules", () => {
    const payload = JSON.stringify({
      v: 1,
      data: [
        {
          id: "d1",
          matchUrl: "*://app.example.com/*",
          on: true,
          rules: [
            {
              type: "normalOverride",
              match: "https://app.example.com/assets/app.js",
              replace: "https://cdn.example.com/assets/app.js",
              on: true,
            },
            {
              type: "normalOverride",
              match: "https://app.example.com/api/**",
              replace: "http://localhost:3000",
              on: true,
            },
            {
              type: "fileInject",
              fileName: "inject.js",
              file: "console.log(1)",
              fileId: "f1",
              fileType: "js",
              injectLocation: "body",
              on: true,
            },
          ],
        },
      ],
    });

    const { workspace: imported, report } = parseResourceOverrideExport(payload);
    expect(imported.projects).toHaveLength(1);
    expect(imported.ruleSets[0]?.ruleIds).toHaveLength(2);
    expect(imported.rules.map((rule) => rule.kind)).toEqual(["asset_redirect", "api_forward"]);
    expect(imported.rules[1]?.target.forwardProfile?.targetBaseUrl).toBe("http://localhost:3000");
    expect(report.importedProjectCount).toBe(1);
    expect(report.importedRuleCount).toBe(2);
    expect(report.skippedRuleCount).toBe(1);
  });

  it("supports legacy domain name field and infers host from rule match when scope is missing", () => {
    const payload = JSON.stringify({
      v: 2,
      data: [
        {
          id: "legacy-name",
          name: "https://legacy.example.com/*",
          on: true,
          rules: [
            {
              type: "normalOverride",
              match: "https://legacy.example.com/assets/main.js",
              replace: "https://cdn.example.com/assets/main.js",
              on: true,
            },
          ],
        },
        {
          id: "inferred-host",
          matchUrl: "",
          on: true,
          rules: [
            {
              type: "normalOverride",
              match: "https://assets.example.com/runtime.js",
              replace: "https://cdn.example.com/runtime.js",
              on: true,
            },
          ],
        },
      ],
    });

    const { workspace: imported, report } = parseResourceOverrideExport(payload);
    expect(imported.projects).toHaveLength(2);
    expect(imported.projects[0]?.siteHosts).toEqual(["legacy.example.com"]);
    expect(imported.projects[1]?.siteHosts).toEqual(["assets.example.com"]);
    expect(imported.rules).toHaveLength(2);
    expect(report.warnings.some((item) => item.includes("自动推断 host"))).toBe(true);
  });

  it("imports localhost asset overrides as asset_redirect rules", () => {
    const payload = JSON.stringify({
      v: 2,
      data: [
        {
          id: "localhost-http",
          matchUrl: "https://app.example.com/*",
          on: true,
          rules: [
            {
              type: "normalOverride",
              match: "https://app.example.com/assets/main.js",
              replace: "http://localhost:8080/main.js",
              on: true,
            },
          ],
        },
      ],
    });

    const { workspace: imported, report } = parseResourceOverrideExport(payload);
    expect(imported.rules).toHaveLength(1);
    expect(imported.rules[0]?.kind).toBe("asset_redirect");
    expect(imported.rules[0]?.target.redirectUrl).toBe("http://localhost:8080/main.js");
    expect(report.importedRuleCount).toBe(1);
    expect(report.skippedRuleCount).toBe(0);
  });

  it("imports localhost wildcard overrides as api_forward rules with stripPrefix", () => {
    const payload = JSON.stringify({
      v: 2,
      data: [
        {
          id: "localhost-wildcard",
          matchUrl: "https://app.example.com/*",
          on: true,
          rules: [
            {
              // match dir: /assets/table  →  replace dir: /  →  stripPrefix = /assets/table
              type: "normalOverride",
              match: "https://app.example.com/assets/table/*.chunk.js",
              replace: "http://localhost:8000/*.chunk.js",
              on: true,
            },
            {
              // same dir structure → no stripPrefix
              type: "normalOverride",
              match: "https://app.example.com/images/*.svg",
              replace: "http://localhost:8000/images/*.svg",
              on: true,
            },
          ],
        },
      ],
    });

    const { workspace: imported, report } = parseResourceOverrideExport(payload);
    expect(imported.rules).toHaveLength(2);
    expect(imported.rules[0]?.kind).toBe("api_forward");
    expect(imported.rules[0]?.target.forwardProfile?.targetBaseUrl).toBe("http://localhost:8000");
    expect(imported.rules[0]?.target.forwardProfile?.stripPrefix).toBe("/assets/table");
    expect(imported.rules[1]?.kind).toBe("api_forward");
    expect(imported.rules[1]?.target.forwardProfile?.stripPrefix).toBeUndefined();
    expect(report.importedRuleCount).toBe(2);
    expect(report.skippedRuleCount).toBe(0);
  });

  it("assigns per-rule host from match URL, not the domain-level host", () => {
    const payload = JSON.stringify({
      v: 2,
      data: [
        {
          id: "cross-origin",
          matchUrl: "https://shimodev.com/*",
          on: true,
          rules: [
            {
              type: "normalOverride",
              match: "https://cdn.example.com/assets/app.js",
              replace: "http://localhost:8080/app.js",
              on: true,
            },
            {
              type: "normalOverride",
              match: "https://shimodev.com/entry.js",
              replace: "http://localhost:8080/entry.js",
              on: true,
            },
          ],
        },
      ],
    });

    const { workspace: imported } = parseResourceOverrideExport(payload);
    expect(imported.rules).toHaveLength(2);
    expect(imported.rules[0]?.match.host).toEqual(["cdn.example.com"]);
    expect(imported.rules[1]?.match.host).toEqual(["shimodev.com"]);
  });
});
