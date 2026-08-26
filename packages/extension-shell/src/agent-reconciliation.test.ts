import { describe, expect, it } from "vitest";
import type { Project, Rule, RuleSet, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { reconcileAgentManagedSubtrees, replaceUserOwnedSlice, userOwnedSlice } from "./agent-reconciliation.js";

const ts = "2026-08-26T00:00:00.000Z";

function project(id: string, tags: string[] = []): Project {
  return { id, name: id, enabled: true, siteHosts: ["example.com"], tags, createdAt: ts, updatedAt: ts };
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
    priority: 1,
    match: { host: ["example.com"], pathGlob: "/**", resourceType: ["script"], tabScope: { mode: "all" } },
    target: { redirectUrl: "https://cdn.example.com/app.js" },
    tags: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

function workspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    version: 1,
    revision: 4,
    updatedAt: ts,
    projects: [project("user"), project("agent", ["agent-managed"])],
    ruleSets: [ruleSet("user-rs", "user", []), ruleSet("agent-rs", "agent", ["agent-rule"])],
    rules: [rule("agent-rule")],
    ...overrides,
  };
}

describe("extension agent reconciliation", () => {
  it("lets an external agent upsert replace a clean local subtree", () => {
    const local = workspace();
    const service = workspace({
      revision: 5,
      projects: [project("user"), { ...project("agent", ["agent-managed"]), name: "External" }],
    });

    const next = reconcileAgentManagedSubtrees(local, service);
    expect(next.projects.find((item) => item.id === "agent")?.name).toBe("External");
    expect(next.revision).toBe(5);
  });

  it("lets an external agent upsert win over dirty user state", () => {
    const local = workspace({ projects: [project("local-user"), project("agent", ["agent-managed"])], revision: 4 });
    const service = workspace({ projects: [project("user"), { ...project("agent", ["agent-managed"]), name: "Service" }], revision: 6 });

    const next = reconcileAgentManagedSubtrees(local, service);
    expect(next.projects.find((item) => item.id === "agent")?.name).toBe("Service");
    expect(next.projects.find((item) => item.id === "local-user")).toBeDefined();
  });

  it("treats service omission as an agent delete even with pending local state", () => {
    const next = reconcileAgentManagedSubtrees(workspace(), workspace({ revision: 7, projects: [project("user")], ruleSets: [ruleSet("user-rs", "user", [])], rules: [] }));

    expect(next.projects.find((item) => item.id === "agent")).toBeUndefined();
    expect(next.ruleSets.find((item) => item.id === "agent-rs")).toBeUndefined();
    expect(next.rules.find((item) => item.id === "agent-rule")).toBeUndefined();
  });

  it("preserves agent projects during replace import and never imports agent markers", () => {
    const local = workspace();
    const imported = workspace({
      projects: [{ ...project("agent", ["agent-managed"]), name: "Imported Agent" }, project("imported-user")],
      ruleSets: [ruleSet("imported-rs", "agent", [])],
      rules: [],
    });

    const next = replaceUserOwnedSlice(local, imported);
    expect(next.projects.find((item) => item.id === "agent")?.name).toBe("agent");
    expect(next.projects.find((item) => item.id === "imported-user")).toBeDefined();
    expect(next.ruleSets.find((item) => item.id === "imported-rs")).toBeUndefined();
  });
  it("rejects imported rulesets pointing to active or reserved agent projects", () => {
    const local = workspace({ agentReservations: { projectIds: ["deleted-agent"], ruleSetIds: ["deleted-rs"], ruleIds: ["deleted-rule"] } });
    const activeReference = workspace({ projects: [project("user")], ruleSets: [ruleSet("bad-active", "agent", [])], rules: [] });
    const reservedReference = workspace({ projects: [project("user")], ruleSets: [ruleSet("bad-reserved", "deleted-agent", [])], rules: [] });

    expect(() => replaceUserOwnedSlice(local, activeReference)).toThrow(/agent ownership/i);
    expect(() => replaceUserOwnedSlice(local, reservedReference)).toThrow(/agent ownership/i);
  });

  it("omits internal reservations from outbound user-owned slices", () => {
    const local = workspace({ agentReservations: { projectIds: ["deleted-agent"], ruleSetIds: [], ruleIds: [] } });

    expect(userOwnedSlice(local).agentReservations).toBeUndefined();
  });
});
