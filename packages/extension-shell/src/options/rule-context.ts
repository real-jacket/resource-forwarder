import type { Project, RuleSet } from "@resource-forwarder/shared-types";

export function resolveRuleContext(options: {
  project?: Project | null;
  ruleSet?: RuleSet | null;
  selectedProject?: Project;
  selectedRuleSet?: RuleSet;
}): { project?: Project; ruleSet?: RuleSet } {
  return {
    project: options.project ?? options.selectedProject,
    ruleSet: options.ruleSet ?? options.selectedRuleSet,
  };
}
