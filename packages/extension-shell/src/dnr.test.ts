import { describe, expect, it } from "vitest";
import type { DynamicRedirectRule, Project, Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { buildDynamicRuleUpdatePlan, buildScopedDnrRuleGroups, collectMatchedTabIdsForUrls } from "./dnr.js";

const rule = (id: number): DynamicRedirectRule => ({
  id,
  priority: 1,
  action: {
    type: "redirect",
    redirect: {
      url: "http://localhost:8000/app.js",
    },
  },
  condition: {
    urlFilter: "|*://*/app.js",
  },
});

const project = (overrides: Partial<Project> = {}): Project => ({
  id: "project-1",
  name: "Project",
  enabled: true,
  siteHosts: ["co-dev-18.shimorelease.com"],
  siteMatchPatterns: ["https://co-dev-18.shimorelease.com/tables/*"],
  tags: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const workspace = (projects: Project[]): WorkspaceSnapshot => ({
  version: 1,
  revision: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  projects,
  ruleSets: [],
  rules: [],
});

const assetRule = (id: string, host: string, redirectUrl: string): Rule => ({
  id,
  name: id,
  enabled: true,
  kind: "asset_redirect",
  priority: 100,
  match: {
    host: [host],
    pathGlob: "/assets/**",
    resourceType: ["script"],
    tabScope: { mode: "all" },
  },
  target: {
    redirectUrl,
  },
  tags: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("dnr helpers", () => {
  it("removes previously managed rules before adding current rules with the same ids", () => {
    const currentRules = [rule(101), rule(102)];

    const plan = buildDynamicRuleUpdatePlan([101, 999], currentRules);

    expect(plan.removeRuleIds).toEqual([101, 999]);
    expect(plan.addRules).toBe(currentRules);
  });

  it("matches tab ids from the latest URL so SPA route changes can enable scoped DNR rules", () => {
    const ids = collectMatchedTabIdsForUrls(
      workspace([project()]),
      [
        { id: 1, url: "https://co-dev-18.shimorelease.com/" },
        { id: 2, url: "https://co-dev-18.shimorelease.com/tables/abc" },
      ],
    );

    expect(ids).toEqual([2]);
  });

  it("scopes each DNR rule to tabs matching its own project", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [
          project({ id: "tables", siteMatchPatterns: ["https://app.example.com/tables/*"], siteHosts: ["app.example.com"] }),
          project({ id: "sheets", siteMatchPatterns: ["https://app.example.com/sheets/*"], siteHosts: ["app.example.com"] }),
        ],
        ruleSets: [
          {
            id: "rs-tables",
            projectId: "tables",
            name: "Tables",
            enabled: true,
            ruleIds: ["rule-tables"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "rs-sheets",
            projectId: "sheets",
            name: "Sheets",
            enabled: true,
            ruleIds: ["rule-sheets"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        rules: [
          assetRule("rule-tables", "cdn.example.com", "http://localhost:8000/tables.js"),
          assetRule("rule-sheets", "cdn.example.com", "http://localhost:8000/sheets.js"),
        ],
      },
      [
        { id: 1, url: "https://app.example.com/" },
        { id: 2, url: "https://app.example.com/tables/abc" },
        { id: 3, url: "https://app.example.com/sheets/abc" },
      ],
    );

    expect(groups.dynamicRules).toHaveLength(0);
    expect(groups.sessionRules).toHaveLength(2);
    expect(groups.sessionRules.find((item) => item.action.redirect.url?.includes("tables"))?.condition.tabIds).toEqual([2]);
    expect(groups.sessionRules.find((item) => item.action.redirect.url?.includes("sheets"))?.condition.tabIds).toEqual([3]);
  });

  it("keeps global DNR rules dynamic while scoped project rules use session tabIds", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [
          project({ id: "global", siteMatchPatterns: [], siteHosts: ["*"] }),
          project({ id: "tables", siteMatchPatterns: ["https://app.example.com/tables/*"], siteHosts: ["app.example.com"] }),
        ],
        ruleSets: [
          {
            id: "rs-global",
            projectId: "global",
            name: "Global",
            enabled: true,
            ruleIds: ["rule-global"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "rs-tables",
            projectId: "tables",
            name: "Tables",
            enabled: true,
            ruleIds: ["rule-tables"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        rules: [
          assetRule("rule-global", "global-cdn.example.com", "http://localhost:8000/global.js"),
          assetRule("rule-tables", "cdn.example.com", "http://localhost:8000/tables.js"),
        ],
      },
      [{ id: 2, url: "https://app.example.com/tables/abc" }],
    );

    expect(groups.dynamicRules.map((item) => item.action.redirect.url)).toEqual(["http://localhost:8000/global.js"]);
    expect(groups.dynamicRules[0]?.condition.tabIds).toBeUndefined();
    expect(groups.sessionRules.map((item) => item.action.redirect.url)).toEqual(["http://localhost:8000/tables.js"]);
    expect(groups.sessionRules[0]?.condition.tabIds).toEqual([2]);
  });

  it("keeps host-wide project rules dynamic so early page scripts can be redirected", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [
          project({
            siteHosts: ["co-dev-17.shimorelease.com"],
            siteMatchPatterns: ["*://co-dev-17.shimorelease.com/*"],
          }),
        ],
        ruleSets: [
          {
            id: "rs-host-wide",
            projectId: "project-1",
            name: "Host wide",
            enabled: true,
            ruleIds: ["rule-zebra"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        rules: [
          {
            ...assetRule("rule-zebra", "co-dev-17.shimorelease.com", "http://localhost:8080/zebra.js"),
            match: {
              host: ["co-dev-17.shimorelease.com"],
              pathGlob: "/minio/shimo-assets/table/zebra.*.js",
              resourceType: ["script"],
              tabScope: { mode: "all" },
            },
          },
        ],
      },
      [],
    );

    expect(groups.dynamicRules).toHaveLength(1);
    expect(groups.dynamicRules[0]?.condition.tabIds).toBeUndefined();
    expect(groups.dynamicRules[0]?.condition.requestDomains).toEqual(["co-dev-17.shimorelease.com"]);
    expect(groups.dynamicRules[0]?.condition.initiatorDomains).toEqual(["co-dev-17.shimorelease.com"]);
    expect(groups.sessionRules).toHaveLength(0);
  });

  it("keeps wildcard-host projects with scoped patterns in session rules", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [project({ siteHosts: ["*"], siteMatchPatterns: ["https://app.example.com/tables/*"] })],
        ruleSets: [{ id: "scope", projectId: "project-1", name: "Scope", enabled: true, ruleIds: ["rule"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        rules: [assetRule("rule", "cdn.example.com", "http://localhost:8000/app.js")],
      },
      [
        { id: 1, url: "https://app.example.com/tables/abc" },
        { id: 2, url: "https://other.example.com/tables/abc" },
      ],
    );

    expect(groups.dynamicRules).toHaveLength(0);
    expect(groups.sessionRules[0]?.condition.tabIds).toEqual([1]);
  });

  it("keeps partially covered multi-host projects in session rules", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [project({ siteHosts: ["a.example.com", "b.example.com"], siteMatchPatterns: ["*://a.example.com/*"] })],
        ruleSets: [{ id: "scope", projectId: "project-1", name: "Scope", enabled: true, ruleIds: ["rule"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        rules: [assetRule("rule", "cdn.example.com", "http://localhost:8000/app.js")],
      },
      [
        { id: 1, url: "https://a.example.com/page" },
        { id: 2, url: "https://b.example.com/page" },
      ],
    );

    expect(groups.dynamicRules).toHaveLength(0);
    expect(groups.sessionRules[0]?.condition.tabIds).toEqual([1]);
  });

  it("keeps rule sets covering only a project host subset in session rules", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [project({ siteHosts: ["a.example.com", "b.example.com"], siteMatchPatterns: ["*://a.example.com/*", "*://b.example.com/*"] })],
        ruleSets: [{ id: "scope", projectId: "project-1", name: "Scope", enabled: true, ruleIds: ["rule"], siteMatchPatterns: ["*://a.example.com/*"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        rules: [assetRule("rule", "cdn.example.com", "http://localhost:8000/app.js")],
      },
      [
        { id: 1, url: "https://a.example.com/page" },
        { id: 2, url: "https://b.example.com/page" },
      ],
    );

    expect(groups.dynamicRules).toHaveLength(0);
    expect(groups.sessionRules[0]?.condition.tabIds).toEqual([1]);
  });

  it.each([
    ["https-only", "https://app.example.com/*", "https://app.example.com/page"],
    ["path-scoped", "*://app.example.com/tables/*", "https://app.example.com/tables/abc"],
  ])("keeps %s project patterns in session rules", (_label, pattern, url) => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [project({ siteHosts: ["app.example.com"], siteMatchPatterns: [pattern] })],
        ruleSets: [{ id: "scope", projectId: "project-1", name: "Scope", enabled: true, ruleIds: ["rule"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        rules: [assetRule("rule", "cdn.example.com", "http://localhost:8000/app.js")],
      },
      [{ id: 1, url }],
    );

    expect(groups.dynamicRules).toHaveLength(0);
    expect(groups.sessionRules[0]?.condition.tabIds).toEqual([1]);
  });

  it("uses tabIds without stale initiatorDomains for universal project patterns", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [project({ siteHosts: ["stale.example.com"], siteMatchPatterns: ["*"] })],
        ruleSets: [{ id: "scope", projectId: "project-1", name: "Scope", enabled: true, ruleIds: ["rule"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        rules: [assetRule("rule", "cdn.example.com", "http://localhost:8000/app.js")],
      },
      [{ id: 7, url: "https://actual.example.com/page" }],
    );

    expect(groups.dynamicRules).toHaveLength(0);
    expect(groups.sessionRules[0]?.condition.tabIds).toEqual([7]);
    expect(groups.sessionRules[0]?.condition.initiatorDomains).toBeUndefined();
  });

  it.each([
    ["siteHosts", ["app.example.com:8443"], undefined],
    ["siteMatchPatterns", ["app.example.com"], ["*://app.example.com:8443/*"]],
  ])("keeps explicit ports from %s in session rules", (_label, siteHosts, siteMatchPatterns) => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [project({ siteHosts, siteMatchPatterns })],
        ruleSets: [{ id: "scope", projectId: "project-1", name: "Scope", enabled: true, ruleIds: ["rule"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        rules: [assetRule("rule", "cdn.example.com", "http://localhost:8000/app.js")],
      },
      [{ id: 8, url: "https://app.example.com:8443/page" }],
    );

    expect(groups.dynamicRules).toHaveLength(0);
    expect(groups.sessionRules[0]?.condition.tabIds).toEqual([8]);
    expect(groups.sessionRules[0]?.condition.initiatorDomains).toBeUndefined();
  });

  it("keeps same-origin path-scoped asset rules in the matching tab session", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [
          project({
            siteHosts: ["co-dev-17.shimorelease.com"],
            siteMatchPatterns: ["https://co-dev-17.shimorelease.com/tables/*"],
          }),
        ],
        ruleSets: [
          {
            id: "rs-tables",
            projectId: "project-1",
            name: "Tables",
            enabled: true,
            ruleIds: ["rule-zebra"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        rules: [assetRule("rule-zebra", "co-dev-17.shimorelease.com", "http://localhost:8000/zebra.js")],
      },
      [
        { id: 4, url: "https://co-dev-17.shimorelease.com/tables/abc" },
        { id: 5, url: "https://co-dev-17.shimorelease.com/sheets/abc" },
      ],
    );

    expect(groups.dynamicRules).toHaveLength(0);
    expect(groups.sessionRules).toHaveLength(1);
    expect(groups.sessionRules[0]?.condition.tabIds).toEqual([4]);
    expect(groups.sessionRules[0]?.condition.initiatorDomains).toBeUndefined();
  });

  it("resolves relative asset redirect targets with rule set baseUrl first, then project baseUrl", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [
          project({
            id: "tables",
            siteHosts: ["app.example.com"],
            siteMatchPatterns: ["https://app.example.com/tables/*"],
            baseUrl: "http://project-local.test/project-base/",
          }),
        ],
        ruleSets: [
          {
            id: "rs-tables",
            projectId: "tables",
            name: "Tables",
            enabled: true,
            ruleIds: ["rule-rs", "rule-project"],
            siteMatchPatterns: ["https://app.example.com/tables/*"],
            baseUrl: "http://ruleset-local.test/group-base/",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        rules: [
          assetRule("rule-rs", "cdn.example.com", "bundle/app.js"),
          {
            ...assetRule("rule-project", "cdn.example.com", "bundle/project.js"),
            priority: 50,
          },
        ],
      },
      [{ id: 2, url: "https://app.example.com/tables/abc" }],
    );

    expect(groups.sessionRules.map((item) => item.action.redirect.url)).toEqual([
      "http://ruleset-local.test/group-base/bundle/app.js",
      "http://ruleset-local.test/group-base/bundle/project.js",
    ]);

    const fallbackGroups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [
          project({
            id: "tables",
            siteHosts: ["app.example.com"],
            siteMatchPatterns: ["https://app.example.com/tables/*"],
            baseUrl: "http://project-local.test/project-base/",
          }),
        ],
        ruleSets: [
          {
            id: "rs-tables",
            projectId: "tables",
            name: "Tables",
            enabled: true,
            ruleIds: ["rule-project"],
            siteMatchPatterns: ["https://app.example.com/tables/*"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        rules: [assetRule("rule-project", "cdn.example.com", "bundle/project.js")],
      },
      [{ id: 2, url: "https://app.example.com/tables/abc" }],
    );

    expect(fallbackGroups.sessionRules.map((item) => item.action.redirect.url)).toEqual([
      "http://project-local.test/project-base/bundle/project.js",
    ]);
  });

  it("treats host-only projects (no siteMatchPatterns) as host-wide, not global, so initiatorDomains is bound", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [
          project({
            siteHosts: ["co-dev-18.shimorelease.com"],
            siteMatchPatterns: undefined,
          }),
        ],
        ruleSets: [
          {
            id: "rs-host-only",
            projectId: "project-1",
            name: "Host only",
            enabled: true,
            ruleIds: ["rule-zebra"],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        rules: [
          {
            ...assetRule("rule-zebra", "co-dev-18.shimorelease.com", "http://localhost:8000/zebra.js"),
            match: {
              host: ["co-dev-18.shimorelease.com"],
              pathGlob: "/minio/shimo-assets/table/zebra.*.js",
              resourceType: ["script"],
              tabScope: { mode: "all" },
            },
          },
        ],
      },
      [],
    );

    expect(groups.dynamicRules).toHaveLength(1);
    expect(groups.dynamicRules[0]?.condition.initiatorDomains).toEqual(["co-dev-18.shimorelease.com"]);
    expect(groups.sessionRules).toHaveLength(0);
  });

  it("separates two path-scoped rule sets in one project", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [project({ siteHosts: ["app.example.com"], siteMatchPatterns: ["https://app.example.com/*"] })],
        ruleSets: [
          { id: "tables", projectId: "project-1", name: "Tables", enabled: true, ruleIds: ["table-rule"], siteMatchPatterns: ["https://app.example.com/tables/*"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
          { id: "sheets", projectId: "project-1", name: "Sheets", enabled: true, ruleIds: ["sheet-rule"], siteMatchPatterns: ["https://app.example.com/sheets/*"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        ],
        rules: [
          assetRule("table-rule", "cdn.example.com", "http://localhost:8000/table.js"),
          assetRule("sheet-rule", "cdn.example.com", "http://localhost:8000/sheet.js"),
        ],
      },
      [
        { id: 10, url: "https://app.example.com/tables/abc" },
        { id: 11, url: "https://app.example.com/sheets/abc" },
      ],
    );

    expect(groups.dynamicRules).toHaveLength(0);
    expect(groups.sessionRules.find((rule) => rule.action.redirect.url?.endsWith("table.js"))?.condition.tabIds).toEqual([10]);
    expect(groups.sessionRules.find((rule) => rule.action.redirect.url?.endsWith("sheet.js"))?.condition.tabIds).toEqual([11]);
  });

  it("intersects explicit tab ids with project and rule set scope", () => {
    const scopedRule = assetRule("scoped", "cdn.example.com", "http://localhost:8000/scoped.js");
    scopedRule.match.tabScope = { mode: "tabIds", tabIds: [2, 3, 99] };
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [project({ siteHosts: ["app.example.com"], siteMatchPatterns: ["https://app.example.com/*"] })],
        ruleSets: [{ id: "tables", projectId: "project-1", name: "Tables", enabled: true, ruleIds: ["scoped"], siteMatchPatterns: ["https://app.example.com/tables/*"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        rules: [scopedRule],
      },
      [
        { id: 2, url: "https://app.example.com/tables/abc" },
        { id: 3, url: "https://app.example.com/sheets/abc" },
        { id: 4, url: "https://app.example.com/tables/def" },
      ],
    );

    expect(groups.dynamicRules).toHaveLength(0);
    expect(groups.sessionRules[0]?.condition.tabIds).toEqual([2]);
  });

  it("omits page-scoped rules when no tab is eligible", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
        revision: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [project({ siteHosts: ["app.example.com"], siteMatchPatterns: ["https://app.example.com/tables/*"] })],
        ruleSets: [{ id: "tables", projectId: "project-1", name: "Tables", enabled: true, ruleIds: ["rule"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        rules: [assetRule("rule", "cdn.example.com", "http://localhost:8000/app.js")],
      },
      [{ id: 1, url: "https://app.example.com/sheets/abc" }],
    );

    expect(groups).toEqual({ dynamicRules: [], sessionRules: [] });
  });

});
