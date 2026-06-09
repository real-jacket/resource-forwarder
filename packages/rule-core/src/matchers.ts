import type {
  MatchCondition,
  MatchResourceType,
  RequestContext,
  Rule,
  RuleBinding,
  RuleKind,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import { prepareMatcher } from "./matcher-cache.js";
import { escapeRegex, globToPathRegexSource } from "./glob.js";
import type { RuleConflict } from "./warnings.js";

export function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

/**
 * Stable rule sort: highest priority first, then oldest creation timestamp,
 * then id as the deterministic tiebreaker. Returns a NEW array so callers can
 * safely mutate the result without poisoning the workspace.
 */
export function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
    return left.id.localeCompare(right.id);
  });
}

export function matchesHost(patterns: string[], host: string): boolean {
  if (patterns.length === 0 || patterns.includes("*")) return true;

  return patterns.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix);
    }
    if (pattern.includes("*")) {
      return new RegExp(`^${escapeRegex(pattern).replace(/\*/g, ".*")}$`).test(host);
    }
    return host === pattern;
  });
}

export function matchesPath(pathGlob: string, pathname: string): boolean {
  // Aligns with matcher-cache via the shared globToPathRegexSource helper:
  // a single `*` does not cross `/`. Previously this used the wider
  // globToRegexSource (`[^?]*`), which over-matched compared to the cached
  // hot path used by the page-bridge. Tests in matcher-cache.test.ts pin
  // the two implementations together.
  return new RegExp(`^${globToPathRegexSource(pathGlob || "**")}$`).test(pathname);
}

export function matchesMethod(match: MatchCondition, method: string): boolean {
  if (!match.method || match.method.length === 0) return true;
  const normalized = normalizeMethod(method);
  return match.method.some((item) => normalizeMethod(item) === normalized);
}

export function matchesResourceType(match: MatchCondition, resourceType: MatchResourceType): boolean {
  if (!match.resourceType || match.resourceType.length === 0) return true;
  return match.resourceType.includes(resourceType);
}

export function matchesTabScope(match: MatchCondition, tabId?: number): boolean {
  if (!match.tabScope || match.tabScope.mode === "all") return true;
  if (typeof tabId !== "number") return false;
  return match.tabScope.tabIds.includes(tabId);
}

export function matchesRule(rule: Rule, context: RequestContext): boolean {
  return (
    matchesHost(rule.match.host, context.host) &&
    matchesPath(rule.match.pathGlob, context.pathname) &&
    matchesResourceType(rule.match, context.resourceType) &&
    matchesMethod(rule.match, context.method) &&
    matchesTabScope(rule.match, context.tabId)
  );
}

export function resolveRuleBinding(
  workspace: WorkspaceSnapshot,
  ruleId: string,
): RuleBinding | undefined {
  const rule = workspace.rules.find((item) => item.id === ruleId);
  if (!rule) return undefined;

  const ruleSet = workspace.ruleSets.find((item) => item.ruleIds.includes(ruleId));
  const project = ruleSet ? workspace.projects.find((item) => item.id === ruleSet.projectId) : undefined;
  return { rule, ruleSet, project };
}

export function getEnabledRuleBindings(
  workspace: WorkspaceSnapshot,
  kind?: RuleKind,
): RuleBinding[] {
  return sortRules(workspace.rules)
    .filter((rule) => (kind ? rule.kind === kind : true))
    .map((rule) => resolveRuleBinding(workspace, rule.id))
    .filter((binding): binding is RuleBinding => Boolean(binding))
    .filter((binding) => binding.rule.enabled)
    .filter((binding) => (binding.ruleSet ? binding.ruleSet.enabled : true))
    .filter((binding) => (binding.project ? binding.project.enabled : true));
}

export function pickMatchingRule(
  workspace: WorkspaceSnapshot,
  context: RequestContext,
  kind?: RuleKind,
): RuleBinding | undefined {
  return prepareMatcher(workspace).pick(context, kind);
}

export function collectRuleConflicts(workspace: WorkspaceSnapshot, draft: Rule): RuleConflict[] {
  const normalizedHosts = new Set(draft.match.host);
  return workspace.rules
    .filter((rule) => rule.id !== draft.id)
    .filter((rule) => rule.kind === draft.kind)
    .filter(
      (rule) =>
        rule.match.pathGlob === draft.match.pathGlob ||
        rule.match.pathGlob === "**" ||
        draft.match.pathGlob === "**",
    )
    .filter((rule) => rule.match.host.some((host) => normalizedHosts.has(host) || host === "*" || normalizedHosts.has("*")))
    .map((rule) => ({
      ruleId: rule.id,
      reason: `Potential overlap with ${rule.name} (${rule.id}).`,
    }));
}
