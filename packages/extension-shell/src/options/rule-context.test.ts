import { describe, expect, it } from "vitest";
import type { Project, RuleSet } from "@resource-forwarder/shared-types";
import { resolveRuleContext } from "./rule-context.js";

const selectedProject: Project = {
  id: "project-selected",
  name: "当前站点",
  enabled: true,
  siteHosts: ["selected.example.com"],
  tags: [],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const selectedRuleSet: RuleSet = {
  id: "ruleset-selected",
  projectId: "project-selected",
  name: "当前分组",
  enabled: true,
  ruleIds: [],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const rowProject: Project = {
  ...selectedProject,
  id: "project-row",
  name: "规则所属站点",
  siteHosts: ["row.example.com"],
};

const rowRuleSet: RuleSet = {
  ...selectedRuleSet,
  id: "ruleset-row",
  projectId: "project-row",
  name: "规则所属分组",
};

describe("resolveRuleContext", () => {
  it("prefers the row-level project and ruleSet when present", () => {
    const resolved = resolveRuleContext({
      project: rowProject,
      ruleSet: rowRuleSet,
      selectedProject,
      selectedRuleSet,
    });

    expect(resolved.project?.id).toBe("project-row");
    expect(resolved.ruleSet?.id).toBe("ruleset-row");
  });

  it("falls back to the current selection when row context is missing", () => {
    const resolved = resolveRuleContext({ selectedProject, selectedRuleSet });

    expect(resolved.project?.id).toBe("project-selected");
    expect(resolved.ruleSet?.id).toBe("ruleset-selected");
  });

  it("falls back as a pair when only the row ruleSet exists", () => {
    const resolved = resolveRuleContext({
      project: null,
      ruleSet: rowRuleSet,
      selectedProject,
      selectedRuleSet,
    });

    expect(resolved.project?.id).toBe("project-selected");
    expect(resolved.ruleSet?.id).toBe("ruleset-selected");
  });

  it("rejects a selected ruleSet that belongs to another project", () => {
    const resolved = resolveRuleContext({
      selectedProject,
      selectedRuleSet: { ...selectedRuleSet, projectId: "another-project" },
    });

    expect(resolved).toEqual({});
  });
});
