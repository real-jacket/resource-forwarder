import {
  computeShadowedRuleIds,
  getEnabledRuleBindings,
  matchesProjectSite,
  matchesRuleSetSite,
  matchesTabScope,
  resolveForwardProfile,
  resolveRuleTargetValue,
  siteScopeSpecificity,
  sortRules,
} from "@resource-forwarder/rule-core";
import { buildForwardTargetUrl } from "@resource-forwarder/forward-core";
import type { Project, Rule, RuleSet, WorkspaceSnapshot } from "@resource-forwarder/shared-types";

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

/**
 * Ids of page-active rules that can never fire because a higher-precedence
 * rule of the same kind fully covers them. Feeds the sidepanel's "被覆盖"
 * dimming so only the rule that actually wins reads as effective.
 *
 * Precedence is kind-aware:
 *  - api_forward runs through the runtime matcher, which is deterministic
 *    (`sortRules`: priority, then oldest, then id) — so that order decides the
 *    winner.
 *  - asset_redirect runs through Chrome DNR, whose tie at equal priority is
 *    undefined. When two duplicate asset rules both match the page, the one
 *    whose owning group matches the URL more specifically is treated as the
 *    winner; the broader-scoped duplicate is the shadowed one.
 */
export function collectShadowedRuleIds(
  workspace: WorkspaceSnapshot,
  currentUrl: string,
  tabId?: number,
): Set<string> {
  const executable = collectExecutableRuleIds(workspace, currentUrl, tabId);
  const competing = workspace.rules.filter((rule) => executable.has(rule.id));

  const api = sortRules(competing.filter((rule) => rule.kind === "api_forward"));
  const asset = orderAssetsByEffectiveWinner(
    competing.filter((rule) => rule.kind === "asset_redirect"),
    workspace,
    currentUrl,
  );

  return new Set([
    ...computeShadowedRuleIds(api),
    ...computeShadowedRuleIds(asset),
  ]);
}

/**
 * Order asset rules so the one most likely to be the effective winner comes
 * first (and therefore shadows its duplicates): highest priority, then the
 * most page-specific owning group, then oldest, then id.
 */
function orderAssetsByEffectiveWinner(
  rules: Rule[],
  workspace: WorkspaceSnapshot,
  currentUrl: string,
): Rule[] {
  const specificityByRuleId = new Map<string, number>();
  const ruleSetById = new Map(workspace.ruleSets.map((ruleSet) => [ruleSet.id, ruleSet]));
  const projectById = new Map(workspace.projects.map((project) => [project.id, project]));
  for (const rule of rules) {
    specificityByRuleId.set(rule.id, ruleScopeSpecificity(rule.id, ruleSetById, projectById, currentUrl));
  }

  return rules.slice().sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    const specLeft = specificityByRuleId.get(left.id) ?? -1;
    const specRight = specificityByRuleId.get(right.id) ?? -1;
    if (specLeft !== specRight) return specRight - specLeft;
    if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
    return left.id.localeCompare(right.id);
  });
}

/** Specificity of a rule's owning group's page scope, relative to the URL. */
function ruleScopeSpecificity(
  ruleId: string,
  ruleSetById: Map<string, RuleSet>,
  projectById: Map<string, Project>,
  currentUrl: string,
): number {
  for (const ruleSet of ruleSetById.values()) {
    if (!ruleSet.ruleIds.includes(ruleId)) continue;
    const project = projectById.get(ruleSet.projectId);
    const patterns = ruleSet.siteMatchPatterns?.length
      ? ruleSet.siteMatchPatterns
      : project?.siteMatchPatterns ?? [];
    return siteScopeSpecificity(patterns, currentUrl);
  }
  return -1;
}

export function describeRuleRoutes(
  rule: Rule,
  project: Project,
  ruleSet: RuleSet,
  currentUrl: string,
): Array<{ source: string; target: string }> {
  const protocol = safeProtocol(currentUrl);
  const currentHost = safeHost(currentUrl);
  const hosts = rule.match.host.length > 0 && !rule.match.host.includes("*")
    ? rule.match.host
    : [currentHost || "*"];
  const path = rule.match.pathGlob.startsWith("/") ? rule.match.pathGlob : `/${rule.match.pathGlob}`;
  const binding = { project, ruleSet, rule };

  return hosts.map((host) => {
    const source = `${host === "*" ? "https?" : protocol}//${host}${path}`;
    if (rule.kind === "asset_redirect") {
      return {
        source,
        target: resolveRuleTargetValue(rule.target.redirectUrl, binding) ?? "目标地址无效",
      };
    }

    const profile = resolveForwardProfile(binding);
    if (!profile) return { source, target: "目标地址无效" };
    const sourceUrl = new URL(`${protocol}//${host.includes("*") ? "placeholder.invalid" : host}${path}`);
    return { source, target: buildForwardTargetUrl(profile, sourceUrl).toString() };
  });
}

function safeProtocol(value: string): "http:" | "https:" {
  try {
    return new URL(value).protocol === "http:" ? "http:" : "https:";
  } catch {
    return "https:";
  }
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
