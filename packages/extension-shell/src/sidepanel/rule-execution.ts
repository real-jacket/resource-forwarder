import {
  getEnabledRuleBindings,
  matchesProjectSite,
  matchesRuleSetSite,
  matchesTabScope,
} from "@resource-forwarder/rule-core";
import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";

export function collectExecutableRuleIds(
  workspace: WorkspaceSnapshot,
  currentUrl: string,
  tabId?: number,
): Set<string> {
  return new Set(
    getEnabledRuleBindings(workspace)
      .filter(({ project, ruleSet, rule }) =>
        Boolean(
          project &&
          ruleSet &&
          matchesProjectSite(project, currentUrl) &&
          matchesRuleSetSite(ruleSet, project, currentUrl) &&
          matchesTabScope(rule.match, tabId),
        ),
      )
      .map(({ rule }) => rule.id),
  );
}
