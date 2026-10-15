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
 */import { Rule } from "./types.js";
import { escapeRegex, globToPathRegexSource } from "./matcher-cache.js";

/**
 * Bounded LRU Cache with a default maxSize of 300
  */
export class BoundedLRUCache<K, V> {
    private cache = new Map<K, V>();
    constructor(public readonly maxSize: number = 300) {}

    get(key: K): V | undefined {
          if (!this.cache.has(key)) return undefined;
          const value = this.cache.get(key)!;
          this.cache.delete(key);
          this.cache.set(key, value);
          return value;
    }

    set(key: K, value: V): void {
          if (this.cache.has(key)) {
                  this.cache.delete(key);
          } else if (this.cache.size >= this.maxSize) {
                  const firstKey = this.cache.keys().next().value;
                  if (firstKey !== undefined) {
                            this.cache.delete(firstKey);
                  }
          }
          this.cache.set(key, value);
    }

    has(key: K): boolean {
          return this.cache.has(key);
    }

    clear(): void {
          this.cache.clear();
    }

    get size(): number {
          return this.cache.size;
    }
}

const regexCache = new BoundedLRUCache<string, RegExp>(300);

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
    return new RegExp(`^${globToPathRegexSource(pathGlob || "*")}$`).test(pathname);
}

/**
 * Match a rule pattern with try/catch error handling and LRU regex cache
  */
export function matchRulePattern(pattern: string, urlStr: string): boolean {
    try {
          if (!pattern || !urlStr) return false;
          let regex = regexCache.get(pattern);
          if (!regex) {
                  regex = new RegExp(pattern);
                  regexCache.set(pattern, regex);
          }
          return regex.test(urlStr);
    } catch (error) {
          return false;
    }
}

/**
 * Resolve target URL and preserve/merge original query parameters
  */
export function resolveTargetUrl(targetPattern: string, requestUrl: string): string {
    try {
          const origUrl = new URL(requestUrl);
          const targetUrl = new URL(targetPattern, origUrl.origin);

          // Merge original search params into targetUrl if not already present
          origUrl.searchParams.forEach((val, key) => {
                  if (!targetUrl.searchParams.has(key)) {
                            targetUrl.searchParams.set(key, val);
                  }
          });

          return targetUrl.toString();
    } catch (e) {
          return targetPattern;
    }
}
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

export function matchesRule(rule: Rule, context: RequestContext): boolean {
  return (
    matchesHost(rule.match.host, context.host) &&
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
