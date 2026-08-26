import { describe, expect, it } from "vitest";
import { createEmptyWorkspace, parseWorkspace, serializeWorkspace } from "./workspace.js";

describe("workspace revision", () => {
  it("starts empty workspaces at revision zero", () => {
    const workspace = createEmptyWorkspace();
    expect(workspace.version).toBe(1);
    expect(workspace.revision).toBe(0);
  });

  it("hydrates legacy snapshots without a revision at zero", () => {
    const workspace = parseWorkspace(JSON.stringify({
      version: 1,
      updatedAt: "2026-08-26T00:00:00.000Z",
      projects: [],
      ruleSets: [],
      rules: [],
    }));

    expect(workspace.revision).toBe(0);
  });

  it("normalizes invalid revisions without changing the format version", () => {
    const negative = parseWorkspace(JSON.stringify({ revision: -1, projects: [], ruleSets: [], rules: [] }));
    const fractional = parseWorkspace(JSON.stringify({ revision: 1.5, projects: [], ruleSets: [], rules: [] }));

    expect(negative).toMatchObject({ version: 1, revision: 0 });
    expect(fractional).toMatchObject({ version: 1, revision: 0 });
  });

  it("preserves revision during serialization", () => {
    const content = serializeWorkspace({
      ...createEmptyWorkspace(),
      revision: 7,
    }, "json");

    expect(JSON.parse(content)).toMatchObject({ version: 1, revision: 7 });
  });
});
