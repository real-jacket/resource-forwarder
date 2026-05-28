import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import {
  applyPendingDeletions,
  applyUpsertProject,
  applyUpsertRule,
  applyUpsertRuleSet,
  emptyPendingDeletions,
  isPendingDeletionsEmpty,
  mergePendingDeletions,
  mergeWorkspaces,
  planDeleteProject,
  planDeleteRule,
  planDeleteRuleSet,
  upsertById,
} from "./workspace-mutations.js";

const ts = "2024-01-01T00:00:00.000Z";

function baseWorkspace(): WorkspaceSnapshot {
  return {
    version: 1,
    updatedAt: ts,
    projects: [
      { id: "p1", name: "App", enabled: true, siteHosts: ["a.example.com"], tags: [], createdAt: ts, updatedAt: ts },
      { id: "p2", name: "Other", enabled: true, siteHosts: ["b.example.com"], tags: [], createdAt: ts, updatedAt: ts },
    ],
    ruleSets: [
      { id: "rs1", projectId: "p1", name: "Default", enabled: true, ruleIds: ["r1", "r2"], createdAt: ts, updatedAt: ts },
      { id: "rs2", projectId: "p2", name: "Default", enabled: true, ruleIds: ["r3"], createdAt: ts, updatedAt: ts },
    ],
    rules: [
      {
        id: "r1",
        name: "API",
        enabled: true,
        kind: "api_forward",
        priority: 100,
        match: { host: ["a.example.com"], pathGlob: "/api/**", resourceType: ["fetch"], tabScope: { mode: "all" } },
        target: { forwardProfile: { targetBaseUrl: "https://up.example.com" } },
        tags: [],
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: "r2",
        name: "Asset",
        enabled: true,
        kind: "asset_redirect",
        priority: 90,
        match: { host: ["a.example.com"], pathGlob: "/static/**", resourceType: ["script"], tabScope: { mode: "all" } },
        target: { redirectUrl: "https://cdn.example.com/x.js" },
        tags: [],
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: "r3",
        name: "Other API",
        enabled: true,
        kind: "api_forward",
        priority: 80,
        match: { host: ["b.example.com"], pathGlob: "/api/**", resourceType: ["fetch"], tabScope: { mode: "all" } },
        target: { forwardProfile: { targetBaseUrl: "https://up.example.com" } },
        tags: [],
        createdAt: ts,
        updatedAt: ts,
      },
    ],
  };
}

describe("workspace-mutations", () => {
  describe("planDeleteProject", () => {
    it("removes the project, its rule sets, and the rules they own", () => {
      const { workspace, deletions } = planDeleteProject(baseWorkspace(), "p1");

      expect(workspace.projects.map((p) => p.id)).toEqual(["p2"]);
      expect(workspace.ruleSets.map((rs) => rs.id)).toEqual(["rs2"]);
      expect(workspace.rules.map((r) => r.id)).toEqual(["r3"]);
      expect(deletions.projectIds).toEqual(["p1"]);
      expect(deletions.ruleSetIds).toEqual(["rs1"]);
      expect(deletions.ruleIds).toEqual(["r1", "r2"]);
    });

    it("does not touch unrelated projects", () => {
      const { workspace } = planDeleteProject(baseWorkspace(), "missing");
      expect(workspace.projects).toHaveLength(2);
      expect(workspace.rules).toHaveLength(3);
    });
  });

  describe("planDeleteRule", () => {
    it("removes the rule from rules and from the owning rule set", () => {
      const { workspace, deletions } = planDeleteRule(baseWorkspace(), "r1");

      expect(workspace.rules.map((r) => r.id)).toEqual(["r2", "r3"]);
      const rs1 = workspace.ruleSets.find((rs) => rs.id === "rs1");
      expect(rs1?.ruleIds).toEqual(["r2"]);
      expect(deletions.ruleIds).toEqual(["r1"]);
    });
  });

  describe("planDeleteRuleSet", () => {
    it("removes the rule set and cascades its rules", () => {
      const { workspace, deletions } = planDeleteRuleSet(baseWorkspace(), "rs1");

      expect(workspace.ruleSets.map((rs) => rs.id)).toEqual(["rs2"]);
      expect(workspace.rules.map((r) => r.id)).toEqual(["r3"]);
      expect(workspace.projects).toHaveLength(2);
      expect(deletions.ruleSetIds).toEqual(["rs1"]);
      expect(deletions.ruleIds).toEqual(["r1", "r2"]);
      expect(deletions.projectIds).toEqual([]);
    });

    it("is a no-op for an unknown rule set id", () => {
      const { workspace, deletions } = planDeleteRuleSet(baseWorkspace(), "missing");
      expect(workspace.ruleSets).toHaveLength(2);
      expect(workspace.rules).toHaveLength(3);
      expect(deletions.ruleIds).toEqual([]);
    });
  });

  describe("applyUpsertRuleSet", () => {
    it("inserts a new rule set without touching others", () => {
      const ws = baseWorkspace();
      const updated = applyUpsertRuleSet(ws, {
        id: "rs3",
        projectId: "p1",
        name: "Extra",
        enabled: true,
        ruleIds: [],
        createdAt: ts,
        updatedAt: ts,
      });
      expect(updated.ruleSets.map((rs) => rs.id).sort()).toEqual(["rs1", "rs2", "rs3"]);
      const rs1 = updated.ruleSets.find((rs) => rs.id === "rs1");
      expect(rs1?.updatedAt).toBe(ts);
    });

    it("replaces an existing rule set and stamps updatedAt", () => {
      const ws = baseWorkspace();
      const updated = applyUpsertRuleSet(ws, { ...ws.ruleSets[0], name: "Renamed", enabled: false });
      const target = updated.ruleSets.find((rs) => rs.id === "rs1");
      expect(target?.name).toBe("Renamed");
      expect(target?.enabled).toBe(false);
      expect(target?.updatedAt).not.toBe(ts);
    });
  });

  describe("applyPendingDeletions", () => {
    it("is a no-op when deletions are empty", () => {
      const ws = baseWorkspace();
      const result = applyPendingDeletions(ws, emptyPendingDeletions());
      expect(result).toBe(ws);
    });

    it("applies cascading project deletes even when only the project id is queued", () => {
      // Reproduces the offline-resurrect bug: if only the project id is in the
      // pending queue and we pull a fresh workspace where the project (and its
      // rules / rule sets) reappeared, the cascade still has to remove all of
      // them so the next `merge: false` push reflects reality.
      const result = applyPendingDeletions(baseWorkspace(), {
        projectIds: ["p1"],
        ruleSetIds: [],
        ruleIds: [],
      });
      expect(result.ruleSets.map((rs) => rs.projectId)).toEqual(["p2"]);
      expect(result.projects).toHaveLength(1);
    });

    it("removes a queued rule from every owning rule set", () => {
      const result = applyPendingDeletions(baseWorkspace(), {
        projectIds: [],
        ruleSetIds: [],
        ruleIds: ["r2"],
      });
      const rs1 = result.ruleSets.find((rs) => rs.id === "rs1");
      expect(rs1?.ruleIds).toEqual(["r1"]);
      expect(result.rules.map((r) => r.id)).toEqual(["r1", "r3"]);
    });
  });

  describe("mergePendingDeletions", () => {
    it("dedupes ids when merging concurrent queues", () => {
      const merged = mergePendingDeletions(
        { projectIds: ["p1"], ruleSetIds: ["rs1"], ruleIds: ["r1"] },
        { projectIds: ["p1", "p2"], ruleIds: ["r1", "r3"] },
      );
      expect(merged.projectIds.sort()).toEqual(["p1", "p2"]);
      expect(merged.ruleIds.sort()).toEqual(["r1", "r3"]);
      expect(merged.ruleSetIds).toEqual(["rs1"]);
    });
  });

  describe("isPendingDeletionsEmpty", () => {
    it("recognises a freshly created queue as empty", () => {
      expect(isPendingDeletionsEmpty(emptyPendingDeletions())).toBe(true);
    });
    it("recognises any non-empty list as non-empty", () => {
      expect(isPendingDeletionsEmpty({ projectIds: ["x"], ruleSetIds: [], ruleIds: [] })).toBe(false);
    });
  });

  describe("applyUpsertProject", () => {
    it("inserts new projects and replaces existing ones", () => {
      const ws = baseWorkspace();
      const updated = applyUpsertProject(ws, {
        project: { ...ws.projects[0], name: "Renamed", enabled: false },
      });
      const project = updated.projects.find((p) => p.id === "p1");
      expect(project?.name).toBe("Renamed");
      expect(project?.enabled).toBe(false);
      expect(updated.projects).toHaveLength(2);
    });

    it("attaches new rule sets under the project being upserted", () => {
      const ws = baseWorkspace();
      const newRuleSet = {
        id: "rs-new",
        projectId: "ignored",
        name: "Extra",
        enabled: true,
        ruleIds: [],
        createdAt: ts,
        updatedAt: ts,
      };
      const updated = applyUpsertProject(ws, {
        project: ws.projects[0],
        ruleSets: [newRuleSet],
      });
      const attached = updated.ruleSets.find((rs) => rs.id === "rs-new");
      expect(attached?.projectId).toBe("p1");
    });
  });

  describe("applyUpsertRule", () => {
    it("moves a rule to the targeted rule set even if it was attached elsewhere", () => {
      const ws = baseWorkspace();
      const updated = applyUpsertRule(ws, { rule: ws.rules[0], ruleSetId: "rs2" });
      const rs1 = updated.ruleSets.find((rs) => rs.id === "rs1");
      const rs2 = updated.ruleSets.find((rs) => rs.id === "rs2");
      expect(rs1?.ruleIds).not.toContain("r1");
      expect(rs2?.ruleIds).toContain("r1");
    });
  });

  describe("mergeWorkspaces", () => {
    it("union-merges ids by id, with imported entries winning on conflict", () => {
      const a = baseWorkspace();
      const b: WorkspaceSnapshot = {
        ...a,
        projects: [{ ...a.projects[0], name: "Imported" }],
        ruleSets: [],
        rules: [],
      };
      const merged = mergeWorkspaces(a, b);
      expect(merged.projects.find((p) => p.id === "p1")?.name).toBe("Imported");
      expect(merged.projects.find((p) => p.id === "p2")).toBeDefined();
    });
  });

  describe("upsertById", () => {
    it("appends when missing and replaces when present", () => {
      const list = [{ id: "a", v: 1 }, { id: "b", v: 2 }];
      const inserted = upsertById(list, { id: "c", v: 3 });
      expect(inserted).toHaveLength(3);
      const replaced = upsertById(inserted, { id: "b", v: 99 });
      expect(replaced.find((x) => x.id === "b")?.v).toBe(99);
    });
  });
});
