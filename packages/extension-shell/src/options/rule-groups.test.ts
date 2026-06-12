import { describe, expect, it } from "vitest";
import type { RuleSet } from "@resource-forwarder/shared-types";
import { buildRuleGroups, isRuleEffectivelyDisabled, toggleCollapsedRuleSetIds } from "./rule-groups.js";

const ruleSetA: RuleSet = {
  id: "ruleset-a",
  projectId: "project-1",
  name: "Alpha",
  enabled: true,
  ruleIds: ["rule-1"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const ruleSetB: RuleSet = {
  id: "ruleset-b",
  projectId: "project-1",
  name: "Beta",
  enabled: true,
  ruleIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("buildRuleGroups", () => {
  it("adds empty groups for the selected project and sorts orphan rows last", () => {
    const groups = buildRuleGroups(
      [
        { rule: { id: "rule-1" }, ruleSet: ruleSetA },
        { rule: { id: "orphan-rule" }, ruleSet: null },
      ],
      "project-1",
      [ruleSetA, ruleSetB],
    );

    expect(groups.map((group) => group.ruleSet?.id ?? "orphan")).toEqual([
      "ruleset-a",
      "ruleset-b",
      "orphan",
    ]);
    expect(groups[1].rows).toHaveLength(0);
    expect(groups[2].rows).toHaveLength(1);
  });
});

describe("toggleCollapsedRuleSetIds", () => {
  it("adds and removes the target ruleset id without mutating the original set", () => {
    const original = new Set<string>(["ruleset-a"]);
    const expanded = toggleCollapsedRuleSetIds(original, "ruleset-b");
    const collapsed = toggleCollapsedRuleSetIds(expanded, "ruleset-b");

    expect(Array.from(original)).toEqual(["ruleset-a"]);
    expect(Array.from(expanded).sort()).toEqual(["ruleset-a", "ruleset-b"]);
    expect(Array.from(collapsed)).toEqual(["ruleset-a"]);
  });
});

describe("isRuleEffectivelyDisabled", () => {
  it("treats a rule as disabled when itself or any parent scope is off", () => {
    expect(isRuleEffectivelyDisabled(true, true, true)).toBe(false);
    expect(isRuleEffectivelyDisabled(false, true, true)).toBe(true);
    expect(isRuleEffectivelyDisabled(true, false, true)).toBe(true);
    expect(isRuleEffectivelyDisabled(true, true, false)).toBe(true);
  });
});
