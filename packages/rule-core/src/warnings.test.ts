import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { collectWorkspaceWarnings } from "./warnings.js";

const ts = "2026-01-01T00:00:00.000Z";

function baseWorkspace(): WorkspaceSnapshot {
  return {
    version: 1,
    updatedAt: ts,
    projects: [{
      id: "project-1",
      name: "App",
      enabled: true,
      siteHosts: ["app.example.com"],
      tags: [],
      createdAt: ts,
      updatedAt: ts,
    }],
    ruleSets: [{
      id: "ruleset-1",
      projectId: "project-1",
      name: "Default",
      enabled: true,
      ruleIds: ["rule-1"],
      createdAt: ts,
      updatedAt: ts,
    }],
    rules: [{
      id: "rule-1",
      name: "API",
      enabled: true,
      kind: "api_forward",
      priority: 100,
      match: { host: ["app.example.com"], pathGlob: "/api/**", resourceType: ["fetch"], tabScope: { mode: "all" } },
      target: { forwardProfile: { targetBaseUrl: "http://localhost:3000" } },
      tags: [],
      createdAt: ts,
      updatedAt: ts,
    }],
  };
}

describe("collectWorkspaceWarnings hierarchy", () => {
  it("reports orphan and multiply assigned rules", () => {
    const orphan = baseWorkspace();
    orphan.ruleSets[0].ruleIds = [];
    expect(collectWorkspaceWarnings(orphan)).toEqual(expect.arrayContaining([expect.stringMatching(/not assigned/)]));

    const duplicate = baseWorkspace();
    duplicate.ruleSets.push({ ...duplicate.ruleSets[0], id: "ruleset-2", name: "Other" });
    expect(collectWorkspaceWarnings(duplicate)).toEqual(expect.arrayContaining([expect.stringMatching(/multiple rule sets/)]));
  });

  it("reports missing project and missing rule references", () => {
    const invalid = baseWorkspace();
    invalid.ruleSets[0].projectId = "missing-project";
    invalid.ruleSets[0].ruleIds.push("missing-rule");
    const warnings = collectWorkspaceWarnings(invalid);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/missing project/),
      expect.stringMatching(/missing rule missing-rule/),
    ]));
  });
});
