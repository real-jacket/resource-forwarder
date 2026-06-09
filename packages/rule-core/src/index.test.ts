import { describe, expect, it } from "vitest";
import type { Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import {
  collectProjectWarnings,
  collectUnsupportedRuleWarnings,
  matchesProjectSite,
  matchesRuleSetSite,
  parseWorkspace,
  parseResourceOverrideExport,
  pickMatchingRule,
  sanitizePathGlob,
  serializeWorkspace,
  toDynamicNetRequestRules,
  toDynamicRule,
  trimWorkspaceForUrl,
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
      siteMatchPatterns: ["https://app.example.com/*"],
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

  it("only matches a rule when the current page passes both project and rule set scope", () => {
    const scopedWorkspace: WorkspaceSnapshot = {
      ...workspace,
      ruleSets: [
        {
          ...workspace.ruleSets[0]!,
          siteMatchPatterns: ["https://app.example.com/tables/*"],
        },
      ],
    };

    const tablePage = pickMatchingRule(
      scopedWorkspace,
      {
        url: "https://app.example.com/api/profile",
        pageUrl: "https://app.example.com/tables/abc",
        method: "GET",
        host: "app.example.com",
        pathname: "/api/profile",
        resourceType: "fetch",
      },
      "api_forward",
    );
    const sheetPage = pickMatchingRule(
      scopedWorkspace,
      {
        url: "https://app.example.com/api/profile",
        pageUrl: "https://app.example.com/sheets/abc",
        method: "GET",
        host: "app.example.com",
        pathname: "/api/profile",
        resourceType: "fetch",
      },
      "api_forward",
    );

    expect(tablePage?.rule.id).toBe("rule-api");
    expect(sheetPage).toBeUndefined();
  });

  it("serializes and parses workspace snapshots", () => {
    const yaml = serializeWorkspace(workspace, "yaml");
    expect(parseWorkspace(yaml)).toEqual(workspace);
  });

  it("normalizes rule hosts when parsing workspace snapshots", () => {
    const parsed = parseWorkspace(JSON.stringify({
      ...workspace,
      rules: [
        {
          ...assetRule,
          match: {
            ...assetRule.match,
            host: ["https://app.example.com"],
          },
        },
      ],
    }));

    expect(parsed.rules[0]?.match.host).toEqual(["app.example.com"]);
  });

  it("sets initiatorDomains from project siteHosts even for same-origin asset redirects", () => {
    const rules = toDynamicNetRequestRules(workspace);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.action.redirect.url).toContain("https://cdn.example.com");
    expect(rules[0]?.condition.requestDomains).toEqual(["app.example.com"]);
    expect(rules[0]?.condition.initiatorDomains).toEqual(["app.example.com"]);
  });

  it("creates regexFilter + regexSubstitution for wildcard redirectUrl", () => {
    const rule: Rule = {
      ...assetRule,
      match: {
        host: ["co-dev-18.shimorelease.com"],
        pathGlob: "/minio/shimo-assets/table/*.chunk.js",
        resourceType: ["script"],
        tabScope: { mode: "all" },
      },
      target: { redirectUrl: "http://localhost:8000/*.chunk.js" },
    };

    const dnr = toDynamicRule(rule);
    expect(dnr.action.redirect.url).toBeUndefined();
    expect(dnr.action.redirect.regexSubstitution).toBe("http://localhost:8000/\\1.chunk.js");
    expect(dnr.condition.regexFilter).toBe(
      "^https?://(?:co-dev-18\\.shimorelease\\.com)/minio/shimo-assets/table/([^/?]*)\\.chunk\\.js",
    );
    expect(dnr.condition.requestDomains).toEqual(["co-dev-18.shimorelease.com"]);
    expect(dnr.condition.urlFilter).toBeUndefined();
  });

  it("creates regexFilter + regexSubstitution for ** wildcard", () => {
    const rule: Rule = {
      ...assetRule,
      match: {
        host: ["example.com"],
        pathGlob: "/assets/**",
        resourceType: ["script"],
        tabScope: { mode: "all" },
      },
      target: { redirectUrl: "http://localhost:3000/**" },
    };

    const dnr = toDynamicRule(rule);
    expect(dnr.action.redirect.regexSubstitution).toBe("http://localhost:3000/\\1");
    expect(dnr.condition.regexFilter).toBe("^https?://(?:example\\.com)/assets/(.*)");
  });

  it("uses static url for non-wildcard redirectUrl", () => {
    const dnr = toDynamicRule(assetRule);
    expect(dnr.action.redirect.url).toBe("https://cdn.example.com/assets/app.js");
    expect(dnr.action.redirect.regexSubstitution).toBeUndefined();
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

  it("sanitizePathGlob strips scheme + host from full-URL pathGlobs", () => {
    expect(sanitizePathGlob("https://host.example.com/api/v1/*.js")).toBe("/api/v1/*.js");
    expect(sanitizePathGlob("http://host.example.com/")).toBe("/");
    expect(sanitizePathGlob("https://host.example.com")).toBe("/");
    expect(sanitizePathGlob("ftp://host.example.com/x/*")).toBe("/x/*");
  });

  it("sanitizePathGlob leaves path-only inputs untouched", () => {
    expect(sanitizePathGlob("/api/**")).toBe("/api/**");
    expect(sanitizePathGlob("**")).toBe("**");
    expect(sanitizePathGlob("/minio/x/sdk-*.js")).toBe("/minio/x/sdk-*.js");
  });

  it("warns when a rule's pathGlob contains a URL scheme", () => {
    const warnings = collectUnsupportedRuleWarnings({
      ...assetRule,
      match: { ...assetRule.match, pathGlob: "https://app.example.com/assets/**" },
    });
    expect(warnings.some((w) => w.includes("匹配路径"))).toBe(true);
  });

  it("toDynamicRule sanitizes a full-URL pathGlob into a path-only urlFilter", () => {
    const dnr = toDynamicRule({
      ...assetRule,
      match: { ...assetRule.match, pathGlob: "https://app.example.com/assets/sdk-*.js" },
      target: { redirectUrl: "http://localhost:54321/sdk.js" },
    });
    expect(dnr.condition.urlFilter).toBe("|*://*/assets/sdk-*.js");
    expect(dnr.condition.urlFilter).not.toContain("https://app.example.com");
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

  it("imports localhost wildcard overrides as asset_redirect rules with wildcard redirectUrl", () => {
    const payload = JSON.stringify({
      v: 2,
      data: [
        {
          id: "localhost-wildcard",
          matchUrl: "https://app.example.com/*",
          on: true,
          rules: [
            {
              type: "normalOverride",
              match: "https://app.example.com/assets/table/*.chunk.js",
              replace: "http://localhost:8000/*.chunk.js",
              on: true,
            },
            {
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
    expect(imported.rules[0]?.kind).toBe("asset_redirect");
    expect(imported.rules[0]?.target.redirectUrl).toBe("http://localhost:8000/*.chunk.js");
    expect(imported.rules[0]?.match.resourceType).toEqual(["script"]);
    expect(imported.rules[1]?.kind).toBe("asset_redirect");
    expect(imported.rules[1]?.target.redirectUrl).toBe("http://localhost:8000/images/*.svg");
    expect(imported.rules[1]?.match.resourceType).toEqual(["image"]);
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

  it("preserves siteMatchPatterns from matchUrl during import", () => {
    const payload = JSON.stringify({
      v: 2,
      data: [
        {
          id: "scoped",
          matchUrl: "https://shimo.im/tables/*",
          on: true,
          rules: [
            {
              type: "normalOverride",
              match: "https://as.smgv.cn/table/zebra.*.js",
              replace: "http://localhost:8000/zebra.js",
              on: true,
            },
          ],
        },
      ],
    });

    const { workspace: imported } = parseResourceOverrideExport(payload);
    expect(imported.projects[0]?.siteMatchPatterns).toEqual(["https://shimo.im/tables/*"]);
    expect(imported.projects[0]?.siteHosts).toEqual(["shimo.im"]);
  });

  it("generates initiatorDomains from project siteHosts for cross-origin CDN rules", () => {
    const crossOriginWorkspace: WorkspaceSnapshot = {
      version: 1,
      updatedAt: "2024-01-01T00:00:00.000Z",
      projects: [
        {
          id: "p1",
          name: "shimo.im",
          enabled: true,
          siteHosts: ["shimo.im"],
          siteMatchPatterns: ["https://shimo.im/tables/*"],
          tags: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      ruleSets: [
        {
          id: "rs1",
          projectId: "p1",
          name: "Default",
          enabled: true,
          ruleIds: ["r1"],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      rules: [
        {
          id: "r1",
          name: "Zebra redirect",
          enabled: true,
          kind: "asset_redirect",
          priority: 100,
          match: {
            host: ["as.smgv.cn"],
            pathGlob: "/table/zebra.*.js",
            resourceType: ["script"],
            tabScope: { mode: "all" },
          },
          target: { redirectUrl: "http://localhost:8000/zebra.js" },
          tags: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    };

    const rules = toDynamicNetRequestRules(crossOriginWorkspace);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.condition.requestDomains).toEqual(["as.smgv.cn"]);
    expect(rules[0]?.condition.initiatorDomains).toEqual(["shimo.im"]);
  });

  it("omits initiatorDomains when project siteHosts contains wildcard", () => {
    const globalWorkspace: WorkspaceSnapshot = {
      ...workspace,
      projects: [{ ...workspace.projects[0]!, siteHosts: ["*"] }],
    };
    const rules = toDynamicNetRequestRules(globalWorkspace);
    expect(rules[0]?.condition.initiatorDomains).toBeUndefined();
  });

  it("sets initiatorDomains for host-only projects (no siteMatchPatterns)", () => {
    const hostOnlyWorkspace: WorkspaceSnapshot = {
      ...workspace,
      projects: [
        {
          ...workspace.projects[0]!,
          siteHosts: ["co-dev-18.shimorelease.com"],
          siteMatchPatterns: undefined,
        },
      ],
      rules: [
        {
          ...assetRule,
          match: {
            ...assetRule.match,
            host: ["co-dev-18.shimorelease.com"],
          },
        },
      ],
    };
    const rules = toDynamicNetRequestRules(hostOnlyWorkspace);
    expect(rules[0]?.condition.initiatorDomains).toEqual(["co-dev-18.shimorelease.com"]);
  });

  it("matchesProjectSite uses siteMatchPatterns for path-level matching", () => {
    const project = {
      siteHosts: ["shimo.im"],
      siteMatchPatterns: ["https://shimo.im/tables/*"],
    };
    expect(matchesProjectSite(project, "https://shimo.im/tables/abc")).toBe(true);
    expect(matchesProjectSite(project, "https://shimo.im/sheets/abc")).toBe(false);
    expect(matchesProjectSite(project, "https://other.com/tables/abc")).toBe(false);
  });

  it("matchesProjectSite treats trailing `*` as Chrome match-pattern wildcard spanning `/`", () => {
    const project = {
      siteHosts: ["co-dev-18.shimorelease.com"],
      siteMatchPatterns: ["https://co-dev-18.shimorelease.com/tables/*"],
    };
    expect(
      matchesProjectSite(
        project,
        "https://co-dev-18.shimorelease.com/tables/G8WoAMVQ2QfAJ3qM/?table=TbNkL5bFWTH&view=FSihaxoG1QJ",
      ),
    ).toBe(true);
    expect(
      matchesProjectSite(project, "https://co-dev-18.shimorelease.com/tables/abc/sub/leaf"),
    ).toBe(true);
    expect(matchesProjectSite(project, "https://co-dev-18.shimorelease.com/tables/")).toBe(true);
    expect(matchesProjectSite(project, "https://co-dev-18.shimorelease.com/sheets/abc")).toBe(false);
  });

  it("matchesRuleSetSite falls back to the project when group has no patterns", () => {
    const project = { siteHosts: ["shimo.im"], siteMatchPatterns: ["https://shimo.im/*"] };
    const ruleSet = {}; // no siteMatchPatterns
    expect(matchesRuleSetSite(ruleSet, project, "https://shimo.im/anything")).toBe(true);
    expect(matchesRuleSetSite(ruleSet, project, "https://other.com/anything")).toBe(false);
  });

  it("matchesRuleSetSite gates on group patterns when they are set", () => {
    const project = { siteHosts: ["shimo.im"], siteMatchPatterns: ["https://shimo.im/*"] };
    const sheetGroup = { siteMatchPatterns: ["https://shimo.im/sheet/*"] };
    const tableGroup = { siteMatchPatterns: ["https://shimo.im/tables/*"] };

    expect(matchesRuleSetSite(sheetGroup, project, "https://shimo.im/sheet/abc")).toBe(true);
    expect(matchesRuleSetSite(sheetGroup, project, "https://shimo.im/tables/abc")).toBe(false);
    expect(matchesRuleSetSite(tableGroup, project, "https://shimo.im/tables/abc")).toBe(true);
    expect(matchesRuleSetSite(tableGroup, project, "https://shimo.im/sheet/abc")).toBe(false);
  });

  it("matchesRuleSetSite treats an empty patterns array the same as undefined", () => {
    const project = { siteHosts: ["shimo.im"], siteMatchPatterns: ["https://shimo.im/*"] };
    const ruleSet = { siteMatchPatterns: [] };
    expect(matchesRuleSetSite(ruleSet, project, "https://shimo.im/anywhere")).toBe(true);
  });

  it("matchesProjectSite falls back to siteHosts when siteMatchPatterns is empty", () => {
    const project = { siteHosts: ["shimo.im"], siteMatchPatterns: [] };
    expect(matchesProjectSite(project, "https://shimo.im/tables/abc")).toBe(true);
    expect(matchesProjectSite(project, "https://shimo.im/sheets/abc")).toBe(true);
    expect(matchesProjectSite(project, "https://other.com/abc")).toBe(false);
  });

  it("matchesProjectSite matches all URLs when both siteHosts and siteMatchPatterns are empty", () => {
    const project = { siteHosts: [], siteMatchPatterns: [] };
    expect(matchesProjectSite(project, "https://any.site.com/path")).toBe(true);
  });

  it("trims workspace by project site scope while preserving cross-origin API rules", () => {
    const scopedWorkspace: WorkspaceSnapshot = {
      version: 1,
      updatedAt: "2024-01-01T00:00:00.000Z",
      projects: [
        {
          id: "p1",
          name: "Tables",
          enabled: true,
          siteHosts: ["shimo.im"],
          siteMatchPatterns: ["https://shimo.im/tables/*"],
          tags: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      ruleSets: [
        {
          id: "rs1",
          projectId: "p1",
          name: "Default",
          enabled: true,
          ruleIds: ["api-cross-origin"],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      rules: [
        {
          ...apiRule,
          id: "api-cross-origin",
          match: {
            ...apiRule.match,
            host: ["api.shimo.im"],
            pathGlob: "/v1/**",
          },
        },
      ],
    };

    const matchingPage = trimWorkspaceForUrl(scopedWorkspace, "https://shimo.im/tables/abc");
    expect(matchingPage.projects.map((project) => project.id)).toEqual(["p1"]);
    expect(matchingPage.rules.map((rule) => rule.id)).toEqual(["api-cross-origin"]);

    const nonMatchingPage = trimWorkspaceForUrl(scopedWorkspace, "https://shimo.im/sheets/abc");
    expect(nonMatchingPage.projects).toHaveLength(0);
    expect(nonMatchingPage.rules).toHaveLength(0);
  });

  it("trims workspace by rule set site scope inside a matched project", () => {
    const scopedWorkspace: WorkspaceSnapshot = {
      version: 1,
      updatedAt: "2024-01-01T00:00:00.000Z",
      projects: [
        {
          id: "p1",
          name: "App",
          enabled: true,
          siteHosts: ["app.example.com"],
          siteMatchPatterns: ["https://app.example.com/*"],
          tags: [],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      ruleSets: [
        {
          id: "tables",
          projectId: "p1",
          name: "Tables",
          enabled: true,
          ruleIds: ["rule-api"],
          siteMatchPatterns: ["https://app.example.com/tables/*"],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "sheets",
          projectId: "p1",
          name: "Sheets",
          enabled: true,
          ruleIds: ["rule-asset"],
          siteMatchPatterns: ["https://app.example.com/sheets/*"],
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      rules: [apiRule, assetRule],
    };

    const tablePage = trimWorkspaceForUrl(scopedWorkspace, "https://app.example.com/tables/abc");
    const sheetPage = trimWorkspaceForUrl(scopedWorkspace, "https://app.example.com/sheets/abc");

    expect(tablePage.ruleSets.map((ruleSet) => ruleSet.id)).toEqual(["tables"]);
    expect(tablePage.rules.map((rule) => rule.id)).toEqual(["rule-api"]);
    expect(sheetPage.ruleSets.map((ruleSet) => ruleSet.id)).toEqual(["sheets"]);
    expect(sheetPage.rules.map((rule) => rule.id)).toEqual(["rule-asset"]);
  });

  it("uses regexFilter instead of path-only urlFilter for wildcard DNR hosts", () => {
    const dnr = toDynamicRule({
      ...assetRule,
      match: {
        ...assetRule.match,
        host: ["*.cdn.example.com"],
        pathGlob: "/assets/**",
      },
      target: {
        redirectUrl: "https://localhost.example/assets/app.js",
      },
    });

    expect(dnr.condition.urlFilter).toBeUndefined();
    expect(dnr.condition.regexFilter).toBe("^https?:\\/\\/(?:[^.]+\\.cdn\\.example\\.com)/assets/.*(?:[?#].*)?$");
  });

  it("keeps wildcard-host regex DNR rules matching URLs with query strings", () => {
    const dnr = toDynamicRule({
      ...assetRule,
      match: {
        ...assetRule.match,
        host: ["*.cdn.example.com"],
        pathGlob: "/assets/*.js",
      },
      target: {
        redirectUrl: "https://localhost.example/assets/app.js",
      },
    });

    expect(new RegExp(dnr.condition.regexFilter!).test("https://foo.cdn.example.com/assets/app.js?v=1")).toBe(true);
    expect(new RegExp(dnr.condition.regexFilter!).test("https://other.example.com/assets/app.js?v=1")).toBe(false);
  });

  it("constrains wildcard redirectUrl regex filters to wildcard hosts", () => {
    const dnr = toDynamicRule({
      ...assetRule,
      match: {
        ...assetRule.match,
        host: ["*.cdn.example.com"],
        pathGlob: "/assets/*.js",
      },
      target: {
        redirectUrl: "http://localhost:8000/*.js",
      },
    });

    expect(dnr.condition.requestDomains).toBeUndefined();
    expect(new RegExp(dnr.condition.regexFilter!).test("https://foo.cdn.example.com/assets/app.js?v=1")).toBe(true);
    expect(new RegExp(dnr.condition.regexFilter!).test("https://other.example.com/assets/app.js?v=1")).toBe(false);
  });

  it("warns when a project mixes a wildcard site pattern with specific ones", () => {
    const warnings = collectProjectWarnings({
      id: "p1",
      name: "Mixed",
      enabled: true,
      siteHosts: ["shimo.im"],
      siteMatchPatterns: ["*", "https://shimo.im/tables/*"],
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/wildcard/);
  });

  it("does not warn when patterns are all specific or only the wildcard", () => {
    const baseProject = {
      id: "p1",
      name: "Specific",
      enabled: true,
      siteHosts: ["shimo.im"],
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(collectProjectWarnings({
      ...baseProject,
      siteMatchPatterns: ["https://shimo.im/tables/*", "https://shimo.im/sheets/*"],
    })).toEqual([]);

    expect(collectProjectWarnings({
      ...baseProject,
      siteMatchPatterns: ["*"],
    })).toEqual([]);

    expect(collectProjectWarnings({ ...baseProject, siteMatchPatterns: undefined })).toEqual([]);
  });
});
