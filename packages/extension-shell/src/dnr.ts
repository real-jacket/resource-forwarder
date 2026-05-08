import { getEnabledRuleBindings, matchesProjectSite, toDynamicRule } from "@resource-forwarder/rule-core";
import type { DynamicRedirectRule, Project, WorkspaceSnapshot } from "@resource-forwarder/shared-types";

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

    const rule = toDynamicRule(binding.rule, binding.project?.siteHosts);
    if (
      isGlobalProjectScope(binding.project) ||
      isHostWideProjectScope(binding.project) ||
      isSameOriginAssetRule(binding.project, binding.rule.match.host)
    ) {
      dynamicRules.push(rule);
      continue;
    }

    const tabIds = collectMatchedTabIdsForProject(binding.project, tabs);
    if (tabIds.length > 0) {
      sessionRules.push({
        ...rule,
        condition: {
          ...rule.condition,
          tabIds,
        },
      });
    }
  }

  return { dynamicRules, sessionRules };
}

function collectMatchedTabIdsForProject(project: Project | undefined, tabs: TabUrlSnapshot[]): number[] {
  if (!project) {
    return [];
  }

  const ids: number[] = [];
  for (const tab of tabs) {
    if (typeof tab.id !== "number" || !tab.url || !/^https?:/.test(tab.url)) {
      continue;
    }
    if (matchesProjectSite(project, tab.url)) {
      ids.push(tab.id);
    }
  }
  return ids;
}

function isGlobalProjectScope(project: Project | undefined): boolean {
  if (!project) {
    return true;
  }

  const patterns = project.siteMatchPatterns ?? [];
  if (patterns.length === 0) {
    return true;
  }

  return patterns.some((pattern) => {
    const trimmed = pattern.trim();
    return !trimmed || trimmed === "*" || trimmed === "<all_urls>";
  });
}

function isHostWideProjectScope(project: Project | undefined): boolean {
  if (!project || project.siteHosts.length === 0) {
    return false;
  }

  if (project.siteHosts.some((host) => host === "*" || host.includes("*"))) {
    return false;
  }

  const patterns = project.siteMatchPatterns ?? [];
  if (patterns.length === 0) {
    return true;
  }

  return patterns.every((pattern) => {
    const trimmed = pattern.trim();
    if (!trimmed || trimmed === "*" || trimmed === "<all_urls>") {
      return false;
    }

    const match = trimmed.match(/^(?:\*|https?):\/\/([^/]+)(\/.*)?$/i);
    if (!match) {
      return false;
    }

    const patternHost = match[1] ?? "";
    const patternPath = match[2] ?? "";
    const isKnownHost = project.siteHosts.includes(patternHost);
    const isHostWidePath = patternPath === "" || patternPath === "/" || patternPath === "/*" || patternPath === "/**";
    return isKnownHost && isHostWidePath;
  });
}

function isSameOriginAssetRule(project: Project | undefined, ruleHosts: string[]): boolean {
  if (!project || project.siteHosts.length === 0 || ruleHosts.length === 0) {
    return false;
  }

  if (project.siteHosts.some((host) => host === "*" || host.includes("*"))) {
    return false;
  }

  const concreteRuleHosts = ruleHosts.filter((host) => host !== "*" && !host.includes("*"));
  return concreteRuleHosts.length > 0 && concreteRuleHosts.every((host) => project.siteHosts.includes(host));
}
