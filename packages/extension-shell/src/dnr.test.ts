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
        updatedAt: "2026-01-01T00:00:00.000Z",
        projects: [
          project({
            siteHosts: ["co-dev-17.shimorelease.com"],
            siteMatchPatterns: ["https://co-dev-17.shimorelease.com/*"],
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
    expect(groups.dynamicRules[0]?.condition.initiatorDomains).toBeUndefined();
    expect(groups.sessionRules).toHaveLength(0);
  });

  it("keeps same-origin path-scoped asset rules dynamic so initial scripts are not missed", () => {
    const groups = buildScopedDnrRuleGroups(
      {
        version: 1,
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
        rules: [
          {
            ...assetRule("rule-zebra", "co-dev-17.shimorelease.com", "http://localhost:8000/zebra.js"),
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
    expect(groups.sessionRules).toHaveLength(0);
  });
});
