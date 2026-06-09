import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { createProjectCopyBundle } from "./project-copy.js";

const now = "2026-04-28T03:50:00.000Z";

const workspace: WorkspaceSnapshot = {
  version: 1,
  updatedAt: now,
  projects: [
    {
      id: "project-1",
      name: "生产环境",
      enabled: true,
      siteHosts: ["shimo.im"],
      siteMatchPatterns: ["https://shimo.im/tables/*"],
      baseUrl: "https://dev.shimo.im/base/",
      tags: ["prod"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "project-2",
      name: "生产环境 副本",
      enabled: true,
      siteHosts: ["shimo.im"],
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  ruleSets: [
    {
      id: "ruleset-1",
      projectId: "project-1",
      name: "默认分组",
      enabled: true,
      ruleIds: ["rule-api", "rule-asset"],
      baseUrl: "https://dev.shimo.im/tables/",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  rules: [
    {
      id: "rule-api",
      name: "API 转发",
      enabled: true,
      kind: "api_forward",
      priority: 100,
      match: {
        host: ["api.shimo.im"],
        pathGlob: "/api/**",
        resourceType: ["fetch"],
        method: ["GET"],
        tabScope: { mode: "all" },
      },
      target: {
        forwardProfile: {
          targetBaseUrl: "http://127.0.0.1:3000",
          headers: { "x-env": "local" },
        },
      },
      tags: ["api"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "rule-asset",
      name: "资源替换",
      enabled: true,
      kind: "asset_redirect",
      priority: 80,
      match: {
        host: ["cdn.shimo.im"],
        pathGlob: "/assets/**",
        resourceType: ["script"],
        tabScope: { mode: "all" },
      },
      target: {
        redirectUrl: "http://localhost:8000/app.js",
      },
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

describe("createProjectCopyBundle", () => {
  it("copies a project with rule sets and rules using fresh ids", () => {
    const ids = ["project-copy", "ruleset-copy", "rule-api-copy", "rule-asset-copy"];
    const bundle = createProjectCopyBundle(workspace, "project-1", now, () => ids.shift()!);

    expect(bundle.project).toMatchObject({
      id: "project-copy",
      name: "生产环境 副本 2",
      siteHosts: ["shimo.im"],
      siteMatchPatterns: ["https://shimo.im/tables/*"],
      baseUrl: "https://dev.shimo.im/base/",
      createdAt: now,
      updatedAt: now,
    });
    expect(bundle.ruleSets).toEqual([
      expect.objectContaining({
        id: "ruleset-copy",
        projectId: "project-copy",
        ruleIds: ["rule-api-copy", "rule-asset-copy"],
        baseUrl: "https://dev.shimo.im/tables/",
      }),
    ]);
    expect(bundle.rules.map((rule) => rule.id)).toEqual(["rule-api-copy", "rule-asset-copy"]);
    expect(bundle.rules[0]).toMatchObject({
      name: "API 转发",
      target: {
        forwardProfile: {
          targetBaseUrl: "http://127.0.0.1:3000",
          headers: { "x-env": "local" },
        },
      },
    });
  });
});
