import { describe, expect, it } from "vitest";
import type { Project, ProjectSubtree, Rule, RuleSet, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import {
  getSwitchGroup,
  isAgentManagedProject,
  mergeUserOwnedSlice,
  projectSubtree,
  replaceProjectSubtree,
  switchProjectGroup,
  validateProjectSubtree,
  workspaceWithoutAgentManaged,
} from "./agent-control.js";

const ts = "2026-08-26T00:00:00.000Z";

function project(id: string, tags: string[] = [], enabled = true): Project {
  return { id, name: id, enabled, siteHosts: [`${id}.example.com`], tags, createdAt: ts, updatedAt: ts };
}

function ruleSet(id: string, projectId: string, ruleIds: string[]): RuleSet {
  return { id, projectId, name: id, enabled: true, ruleIds, createdAt: ts, updatedAt: ts };
}

function rule(id: string): Rule {
  return {
    id,
    name: id,
    enabled: true,
    kind: "asset_redirect",
    priority: 100,
    match: { host: ["app.example.com"], pathGlob: "/**", resourceType: ["script"], tabScope: { mode: "all" } },
    target: { redirectUrl: "https://cdn.example.com/app.js" },
    tags: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    version: 1,
    revision: 5,
    updatedAt: ts,
    projects: [
      project("p1", ["agent-managed", "switch-group:main"]),
      project("p2", ["agent-managed", "switch-group:main"]),
      project("p3", ["agent-managed", "switch-group:other"]),
      project("user"),
    ],
    ruleSets: [ruleSet("rs1", "p1", ["r1", "r2"]), ruleSet("rs2", "p2", ["r3"]), ruleSet("rs3", "p3", []), ruleSet("user-rs", "user", [])],
    rules: [rule("r1"), rule("r2"), rule("r3")],
  };
}

function subtree(projectId: string, ruleIds: string[]): ProjectSubtree {
  return {
    project: project(projectId, ["agent-managed", "switch-group:main"]),
    ruleSets: [ruleSet("rs1", projectId, ruleIds)],
    rules: ruleIds.map(rule),
  };
}

describe("agent control", () => {
  it("accepts a valid subtree and removes stale rules on shrink", () => {
    const next = replaceProjectSubtree(workspace(), subtree("p1", ["r1"]));

    expect(projectSubtree(next, "p1").rules.map((item) => item.id)).toEqual(["r1"]);
    expect(next.rules.map((item) => item.id)).toEqual(["r3", "r1"]);
  });
  it("allows the same agent project to reclaim shrunk rule IDs", () => {
    const shrunk = replaceProjectSubtree(workspace(), subtree("p1", ["r1"]));
    expect(shrunk.agentReservations?.ruleIds).toContain("r2");

    const restored = replaceProjectSubtree(shrunk, subtree("p1", ["r1", "r2"]));
    expect(restored.ruleSets.find((ruleSet) => ruleSet.id === "rs1")?.ruleIds).toEqual(["r1", "r2"]);

    const otherProject = {
      ...subtree("p2", ["r2"]),
      ruleSets: [ruleSet("rs2", "p2", ["r2"])],
    };
    expect(() => replaceProjectSubtree(shrunk, otherProject)).toThrow(/reserved/i);
  });

  it("rejects rule set and rule ids owned by another project", () => {
    const current = workspace();
    const collidingRuleSet = { ...subtree("p1", ["r1"]), ruleSets: [ruleSet("rs2", "p1", ["r1"])] };
    const collidingRule = { ...subtree("p1", ["r3"]) };

    expect(() => validateProjectSubtree(current, collidingRuleSet)).toThrow(/rule set id/i);
    expect(() => validateProjectSubtree(current, collidingRule)).toThrow(/rule id/i);
  });

  it("rejects duplicate and zero or multiple rule membership", () => {
    const current = workspace();
    const duplicate = { ...subtree("p1", ["r1"]), ruleSets: [ruleSet("rs1", "p1", ["r1"]), ruleSet("rs1", "p1", ["r1"])] };
    const missing = { ...subtree("p1", ["r1"]), ruleSets: [ruleSet("rs1", "p1", ["missing"])] };
    const extra = { ...subtree("p1", ["r1"]), rules: [rule("r1"), rule("extra")] };
    const multiple = { ...subtree("p1", ["r1"]), ruleSets: [ruleSet("rs1", "p1", ["r1"]), ruleSet("rs-new", "p1", ["r1"])] };

    expect(() => validateProjectSubtree(current, duplicate)).toThrow(/duplicate rule set/i);
    expect(() => validateProjectSubtree(current, missing)).toThrow(/missing/i);
    expect(() => validateProjectSubtree(current, extra)).toThrow(/not referenced/i);
    expect(() => validateProjectSubtree(current, multiple)).toThrow(/multiple rule sets/i);
  });

  it("preserves unrelated projects and their subtrees", () => {
    const next = replaceProjectSubtree(workspace(), subtree("p1", ["r1"]));

    expect(next.projects.map((item) => item.id)).toEqual(["p2", "p3", "user", "p1"]);
    expect(next.ruleSets.map((item) => item.id)).toEqual(["rs2", "rs3", "user-rs", "rs1"]);
  });

  it("switches only enabled siblings in the same group", () => {
    const current = workspace();
    current.projects.push(project("user-main", ["switch-group:main"]));
    const next = switchProjectGroup(current, "p2", true);

    expect(next.projects.find((item) => item.id === "p1")?.enabled).toBe(false);
    expect(next.projects.find((item) => item.id === "p2")?.enabled).toBe(true);
    expect(next.projects.find((item) => item.id === "p3")?.enabled).toBe(true);
    expect(next.projects.find((item) => item.id === "user")?.enabled).toBe(true);
    expect(next.projects.find((item) => item.id === "user-main")?.enabled).toBe(true);
  });

  it("treats a project with no switch group as an independent toggle", () => {
    const current = workspace();
    const next = switchProjectGroup(current, "user", false);

    expect(next.projects.find((item) => item.id === "user")?.enabled).toBe(false);
    expect(next.projects.find((item) => item.id === "p1")?.enabled).toBe(true);
    expect(getSwitchGroup(next.projects.find((item) => item.id === "user")!)).toBeUndefined();
  });

  it("keeps ownership immutable and preserves agent subtrees during user merges", () => {
    const current = workspace();
    const imported = {
      ...workspace(),
      projects: [project("p1"), project("new-user")],
      ruleSets: [ruleSet("imported-rs", "p1", [])],
      rules: [],
    };

    expect(isAgentManagedProject(current.projects[0]!)).toBe(true);
    expect(() => validateProjectSubtree(current, { ...subtree("user", []), project: project("user", ["agent-managed"]) })).toThrow(/immutable/i);
    const merged = mergeUserOwnedSlice(current, imported);
    expect(merged.projects.find((item) => item.id === "p1")?.tags).toContain("agent-managed");
    expect(merged.projects.find((item) => item.id === "new-user")).toBeDefined();
    expect(workspaceWithoutAgentManaged(merged).projects.map((item) => item.id)).not.toContain("p1");
  });
});
