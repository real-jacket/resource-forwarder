import type { Project, RuleSet } from "@resource-forwarder/shared-types";

export function resolveRuleContext(options: {
  project?: Project | null;
  ruleSet?: RuleSet | null;
  selectedProject?: Project;
  selectedRuleSet?: RuleSet;
}): { project?: Project; ruleSet?: RuleSet } {
  if (options.project && options.ruleSet?.projectId === options.project.id) {
    return { project: options.project, ruleSet: options.ruleSet };
  }
  if (options.selectedProject && options.selectedRuleSet?.projectId === options.selectedProject.id) {
    return { project: options.selectedProject, ruleSet: options.selectedRuleSet };
  }
  return {};
}
