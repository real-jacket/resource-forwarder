import { describe, expect, it } from "vitest";
import type {
  AppliedRevisionPayload,
  AppliedRevisionResponse,
  MutationResponse,
  ProjectSubtree,
  SubtreePayload,
  SwitchProjectsPayload,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";

describe("shared control contracts", () => {
  const workspace: WorkspaceSnapshot = {
    version: 1,
    revision: 4,
    updatedAt: "2026-08-26T00:00:00.000Z",
    projects: [],
    ruleSets: [],
    rules: [],
  };

  it("exposes the persisted revision on mutation and service snapshots", () => {
    const response: MutationResponse = {
      workspace,
      revision: workspace.revision,
      warnings: [],
    };
    expect(response.workspace.revision).toBe(4);
    expect(response.revision).toBe(4);
  });

  it("normalizes subtree, switch, and applied revision payload shapes", () => {
    const subtree: ProjectSubtree = { project: {} as ProjectSubtree["project"], ruleSets: [], rules: [] };
    const subtreePayload: SubtreePayload = { ...subtree, ifRevision: 4 };
    const switchPayload: SwitchProjectsPayload = { projectId: "project", enabled: true, ifRevision: 4 };
    const applied: AppliedRevisionPayload = { revision: 4 };
    const appliedResponse: AppliedRevisionResponse = { appliedRevision: 4 };

    expect(subtreePayload.ifRevision).toBe(4);
    expect(switchPayload.projectId).toBe("project");
    expect(appliedResponse.appliedRevision).toBe(applied.revision);
  });
});
