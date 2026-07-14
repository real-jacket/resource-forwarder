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
import { resolveEffectiveRequestHosts } from "./target-resolution.js";
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

export function matchesQuery(
  match: MatchCondition,
  query: Record<string, string[]> | undefined,
): boolean {
  const constraints = match.query;
  if (!constraints || Object.keys(constraints).length === 0) return true;
  const actual = query ?? {};
  return Object.entries(constraints).every(([name, pattern]) => {
    const values = actual[name];
    return Boolean(values?.some((value) => matchesValuePattern(pattern, value)));
  });
}

export function matchesHeaders(
  match: MatchCondition,
  headers: Record<string, string> | undefined,
): boolean {
  const constraints = match.headers;
  if (!constraints || Object.keys(constraints).length === 0) return true;
  const normalized = normalizeHeaderRecord(headers);
  return Object.entries(constraints).every(([name, pattern]) => {
    const value = normalized[name.toLowerCase()];
    return value !== undefined && matchesValuePattern(pattern, value);
  });
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

export function matchesRule(rule: Rule, context: RequestContext, hosts = rule.match.host): boolean {
  return (
    matchesHost(hosts, context.host) &&
    matchesPath(rule.match.pathGlob, context.pathname) &&
    matchesQuery(rule.match, context.query) &&
    matchesHeaders(rule.match, context.headers) &&
    matchesResourceType(rule.match, context.resourceType) &&
    matchesMethod(rule.match, context.method) &&
    matchesTabScope(rule.match, context.tabId)
  );
}

function matchesValuePattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const source = pattern
    .replace(/[|\\{}()[\]^$+.]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(value);
}

function normalizeHeaderRecord(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

export function resolveRuleBinding(
  workspace: WorkspaceSnapshot,
  ruleId: string,
): RuleBinding | undefined {
  const rule = workspace.rules.find((item) => item.id === ruleId);
  if (!rule) return undefined;

  const memberships = workspace.ruleSets.filter((item) => item.ruleIds.includes(ruleId));
  if (memberships.length !== 1) return undefined;
  const ruleSet = memberships[0];
  const project = workspace.projects.find((item) => item.id === ruleSet.projectId);
  if (!project) return undefined;
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

export function collectRuleConflicts(
  workspace: WorkspaceSnapshot,
  draft: Rule,
  context?: Pick<RuleBinding, "project" | "ruleSet">,
): RuleConflict[] {
  const draftBinding = context
    ? { ...context, rule: draft }
    : resolveRuleBinding(workspace, draft.id);
  const normalizedHosts = new Set(
    draftBinding ? resolveEffectiveRequestHosts({ ...draftBinding, rule: draft }) : draft.match.host,
  );
  return workspace.rules
    .filter((rule) => rule.id !== draft.id)
    .filter((rule) => rule.kind === draft.kind)
    .filter(
      (rule) =>
        rule.match.pathGlob === draft.match.pathGlob ||
        rule.match.pathGlob === "**" ||
        draft.match.pathGlob === "**",
    )
    .filter((rule) => {
      const binding = resolveRuleBinding(workspace, rule.id);
      const hosts = binding ? resolveEffectiveRequestHosts(binding) : rule.match.host;
      return hosts.some((host) => normalizedHosts.has(host) || host === "*" || normalizedHosts.has("*"));
    })
    .map((rule) => ({
      ruleId: rule.id,
      reason: `Potential overlap with ${rule.name} (${rule.id}).`,
    }));
}
