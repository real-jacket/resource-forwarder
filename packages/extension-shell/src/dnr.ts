import {
  getEnabledRuleBindings,
  matchesProjectSite,
  matchesRuleSetSite,
  matchesTabScope,
  resolveRuleTargetValue,
  toDynamicRule,
} from "@resource-forwarder/rule-core";
import type { DynamicRedirectRule, Project, RuleSet, WorkspaceSnapshot } from "@resource-forwarder/shared-types";

export interface TabUrlSnapshot {
  id?: number;
  url?: string;
}

export interface ScopedDnrRuleGroups {
  dynamicRules: DynamicRedirectRule[];
  sessionRules: DynamicRedirectRule[];
}

export function buildDynamicRuleUpdatePlan(
  previousManagedRuleIds: number[],
  finalRules: DynamicRedirectRule[],
): { removeRuleIds: number[]; addRules: DynamicRedirectRule[] } {
  return {
    removeRuleIds: previousManagedRuleIds,
    addRules: finalRules,
  };
}

/**
 * Determine which tab IDs match at least one enabled project's site scope.
 * Returns undefined if any project has no siteMatchPatterns (global scope) —
 * meaning no tabIds restriction should be applied.
 */
export function collectMatchedTabIdsForUrls(
  workspace: WorkspaceSnapshot,
  tabs: TabUrlSnapshot[],
): number[] | undefined {
  const enabledProjects = workspace.projects.filter((p) => p.enabled);
  if (enabledProjects.length === 0) {
    return [];
  }

  const hasGlobalProject = enabledProjects.some(
    (p) => !p.siteMatchPatterns || p.siteMatchPatterns.length === 0,
  );
  if (hasGlobalProject) {
    return undefined;
  }

  const ids: number[] = [];
  for (const tab of tabs) {
    if (typeof tab.id !== "number" || !tab.url || !/^https?:/.test(tab.url)) {
      continue;
    }
    const matches = enabledProjects.some((project) => matchesProjectSite(project, tab.url!));
    if (matches) {
      ids.push(tab.id);
    }
  }
  return ids;
}

export function buildScopedDnrRuleGroups(
  workspace: WorkspaceSnapshot,
  tabs: TabUrlSnapshot[],
): ScopedDnrRuleGroups {
  const dynamicRules: DynamicRedirectRule[] = [];
  const sessionRules: DynamicRedirectRule[] = [];

  for (const binding of getEnabledRuleBindings(workspace, "asset_redirect")) {
    if (!binding.rule.target.redirectUrl) {
      continue;
    }

    const redirectUrl = resolveRuleTargetValue(binding.rule.target.redirectUrl, binding);
    if (!redirectUrl) {
      continue;
    }

    const rule = toDynamicRule(
      {
        ...binding.rule,
        target: {
          ...binding.rule.target,
          redirectUrl,
        },
      },
      binding.project?.siteHosts,
    );
    const canStayDynamic =
      canExpressPageScopeWithInitiatorDomains(binding.project, binding.ruleSet) &&
      binding.rule.match.tabScope?.mode !== "tabIds";
    if (canStayDynamic) {
      dynamicRules.push(rule);
      continue;
    }

    const condition = { ...rule.condition };
    delete condition.initiatorDomains;
    const tabIds = collectEligibleTabIds(binding.project, binding.ruleSet, binding.rule.match, tabs);
    if (tabIds.length > 0) {
      sessionRules.push({
        ...rule,
        condition: { ...condition, tabIds },
      });
    }
  }

  return { dynamicRules, sessionRules };
}

function collectEligibleTabIds(
  project: Project | undefined,
  ruleSet: RuleSet | undefined,
  match: Parameters<typeof matchesTabScope>[0],
  tabs: TabUrlSnapshot[],
): number[] {
  if (!project || !ruleSet) {
    return [];
  }

  const ids: number[] = [];
  for (const tab of tabs) {
    if (typeof tab.id !== "number" || !tab.url || !/^https?:/.test(tab.url)) {
      continue;
    }
    if (
      matchesProjectSite(project, tab.url) &&
      matchesRuleSetSite(ruleSet, project, tab.url) &&
      matchesTabScope(match, tab.id)
    ) {
      ids.push(tab.id);
    }
  }
  return ids;
}

type DnrPageScope = "global" | "host-wide" | "narrow";

function canExpressPageScopeWithInitiatorDomains(
  project: Project | undefined,
  ruleSet: RuleSet | undefined,
): boolean {
  if (!project) return true;
  const projectScope = classifyDnrPageScope(project.siteHosts, project.siteMatchPatterns);
  if (projectScope === "narrow") return false;

  const ruleSetPatterns = ruleSet?.siteMatchPatterns ?? [];
  if (ruleSetPatterns.length === 0 || ruleSetPatterns.some(isUniversalSitePattern)) {
    return true;
  }

  const ruleSetScope = classifyDnrPageScope(project.siteHosts, ruleSetPatterns);
  return projectScope === "host-wide" && ruleSetScope === "host-wide";
}

function classifyDnrPageScope(siteHosts: string[], siteMatchPatterns?: string[]): DnrPageScope {
  const patterns = siteMatchPatterns ?? [];
  const concreteHosts = new Set(siteHosts.filter((host) => host !== "*" && !host.includes("*")));
  if (siteHosts.some(hasExplicitPort)) return "narrow";
  const hasGlobalHosts = siteHosts.length === 0 || siteHosts.includes("*");

  if (patterns.length === 0) {
    if (hasGlobalHosts) return "global";
    return concreteHosts.size === siteHosts.length ? "host-wide" : "narrow";
  }

  if (patterns.some(isUniversalSitePattern)) {
    return hasGlobalHosts ? "global" : "narrow";
  }
  if (hasGlobalHosts || concreteHosts.size !== siteHosts.length) {
    return "narrow";
  }

  const coveredHosts = new Set<string>();
  for (const pattern of patterns) {
    const match = pattern.trim().match(/^(\*|https?):\/\/([^/]+)(\/.*)?$/i);
    if (!match || match[1] !== "*") return "narrow";
    const host = match[2] ?? "";
    const path = match[3] ?? "";
    if (hasExplicitPort(host)) return "narrow";
    if (!concreteHosts.has(host) || (path !== "" && path !== "/" && path !== "/*" && path !== "/**")) {
      return "narrow";
    }
    coveredHosts.add(host);
  }
  return coveredHosts.size === concreteHosts.size ? "host-wide" : "narrow";
}

function isUniversalSitePattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  return !trimmed || trimmed === "*" || trimmed === "<all_urls>";
}

function hasExplicitPort(host: string): boolean {
  return /:\d+$/.test(host);
}
