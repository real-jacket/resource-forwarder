import type {
  MatchCondition,
  MatchResourceType,
  RequestContext,
  Rule,
  RuleBinding,
  RuleKind,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import { globToPathRegexSource } from "./glob.js";
import { matchesProjectSite, matchesRuleSetSite } from "./workspace.js";

/**
 * Hot-path matcher reused across many requests.
 *
 * The naïve pickMatchingRule path re-runs `sortRules` (O(n log n) allocation),
 * filters bindings (O(n) plus per-binding lookups), and rebuilds the host /
 * path regex on every request. For the page-bridge that's invoked on every
 * fetch + XHR — a 100-rule workspace with 50 requests per page load was
 * spending several hundred ms in pickMatchingRule alone in profiling.
 *
 * prepareMatcher front-loads all of that so each request shrinks to a tight
 * inner loop:
 *
 *   for binding in bindings_by_kind[kind]:
 *     if hostRe.test(host) and pathRe.test(pathname) and ...
 *       return binding
 */
export interface MatcherCache {
  pick(context: RequestContext, kind?: RuleKind): RuleBinding | undefined;
  bindings(kind?: RuleKind): readonly RuleBinding[];
}

interface CompiledBinding {
  binding: RuleBinding;
  matchHost(host: string): boolean;
  matchPath(pathname: string): boolean;
  match: MatchCondition;
}

const ANY_HOST_MARKER = Symbol("any-host");

export function prepareMatcher(workspace: WorkspaceSnapshot): MatcherCache {
  const projectById = new Map<string, RuleBinding["project"]>();
  for (const project of workspace.projects) projectById.set(project.id, project);

  const ruleSetByRuleId = new Map<string, RuleBinding["ruleSet"]>();
  for (const ruleSet of workspace.ruleSets) {
    if (!ruleSet.enabled) continue;
    for (const id of ruleSet.ruleIds) ruleSetByRuleId.set(id, ruleSet);
  }

  const compiled: CompiledBinding[] = [];
  for (const rule of sortRulesInPlace(workspace.rules.slice())) {
    if (!rule.enabled) continue;
    const ruleSet = ruleSetByRuleId.get(rule.id);
    // A rule that doesn't belong to any enabled ruleSet (could be an orphan,
    // or a member of a disabled ruleSet) is dropped early so the inner loop
    // doesn't even consider it. Note: rules without a ruleSet are still
    // matchable to keep parity with resolveRuleBinding's lenient behavior.
    const linkedRuleSet = ruleSet ?? findRuleSetForRule(workspace, rule.id);
    if (linkedRuleSet && !linkedRuleSet.enabled) continue;
    const project = linkedRuleSet ? projectById.get(linkedRuleSet.projectId) : undefined;
    if (project && !project.enabled) continue;

    compiled.push({
      binding: { rule, ruleSet: linkedRuleSet, project },
      matchHost: buildHostMatcher(rule.match.host),
      matchPath: buildPathMatcher(rule.match.pathGlob),
      match: rule.match,
    });
  }

  // Bucket by kind so callers that pass a kind can iterate a smaller list.
  const buckets = new Map<RuleKind | "__all__", CompiledBinding[]>();
  buckets.set("__all__", compiled);
  for (const entry of compiled) {
    const list = buckets.get(entry.binding.rule.kind) ?? [];
    list.push(entry);
    buckets.set(entry.binding.rule.kind, list);
  }

  function bucketFor(kind?: RuleKind): CompiledBinding[] {
    return buckets.get(kind ?? "__all__") ?? [];
  }

  return {
    pick(context, kind) {
      const bucket = bucketFor(kind);
      for (const entry of bucket) {
        if (!matchesSiteScope(entry.binding, getPageUrl(context))) continue;
        if (!entry.matchHost(context.host)) continue;
        if (!entry.matchPath(context.pathname)) continue;
        if (!matchesResourceType(entry.match, context.resourceType)) continue;
        if (!matchesMethod(entry.match, context.method)) continue;
        if (!matchesTabScope(entry.match, context.tabId)) continue;
        return entry.binding;
      }
      return undefined;
    },
    bindings(kind) {
      return bucketFor(kind).map((entry) => entry.binding);
    },
  };
}

function matchesSiteScope(binding: RuleBinding, pageUrl: string | undefined): boolean {
  if (!pageUrl) {
    return true;
  }
  if (binding.project && !matchesProjectSite(binding.project, pageUrl)) {
    return false;
  }
  if (binding.ruleSet) {
    return matchesRuleSetSite(
      binding.ruleSet,
      binding.project ?? { siteHosts: [], siteMatchPatterns: [] },
      pageUrl,
    );
  }
  return true;
}

function getPageUrl(context: RequestContext): string | undefined {
  return (context as RequestContext & { pageUrl?: string }).pageUrl;
}

function sortRulesInPlace(rules: Rule[]): Rule[] {
  rules.sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
    return left.id.localeCompare(right.id);
  });
  return rules;
}

function findRuleSetForRule(workspace: WorkspaceSnapshot, ruleId: string): RuleBinding["ruleSet"] | undefined {
  for (const ruleSet of workspace.ruleSets) {
    if (ruleSet.ruleIds.includes(ruleId)) return ruleSet;
  }
  return undefined;
}

/**
 * Compile a host pattern list into a single matcher closure. Splits patterns
 * into the three categories matchesHost handles (wildcard / suffix / exact)
 * so we can take the cheapest possible code path per request — no regex when
 * all patterns are exact strings, only one combined regex when wildcards are
 * present.
 */
function buildHostMatcher(patterns: string[]): (host: string) => boolean {
  if (patterns.length === 0 || patterns.includes("*")) {
    // ANY_HOST_MARKER is just a readability hint — the function below makes
    // the same decision implicitly.
    void ANY_HOST_MARKER;
    return () => true;
  }

  const exact = new Set<string>();
  const suffixes: string[] = [];
  const wildcardPatterns: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("*.")) suffixes.push(pattern.slice(1));
    else if (pattern.includes("*")) wildcardPatterns.push(pattern);
    else exact.add(pattern);
  }

  const wildcardRegex = wildcardPatterns.length
    ? new RegExp(`^(?:${wildcardPatterns.map((p) => escapeRegex(p).replace(/\\\*/g, ".*")).join("|")})$`)
    : undefined;

  return (host: string) => {
    if (exact.has(host)) return true;
    for (const suffix of suffixes) {
      if (host.endsWith(suffix)) return true;
    }
    if (wildcardRegex && wildcardRegex.test(host)) return true;
    return false;
  };
}

function buildPathMatcher(pathGlob: string | undefined): (pathname: string) => boolean {
  const normalized = pathGlob || "**";
  if (normalized === "**") return () => true;
  const regex = new RegExp(`^${globToPathRegexSource(normalized)}$`);
  return (pathname: string) => regex.test(pathname);
}

function matchesResourceType(match: MatchCondition, resourceType: MatchResourceType): boolean {
  if (!match.resourceType || match.resourceType.length === 0) return true;
  return match.resourceType.includes(resourceType);
}

function matchesMethod(match: MatchCondition, method: string): boolean {
  if (!match.method || match.method.length === 0) return true;
  const normalized = method.toUpperCase();
  for (const item of match.method) {
    if (item.toUpperCase() === normalized) return true;
  }
  return false;
}

function matchesTabScope(match: MatchCondition, tabId?: number): boolean {
  if (!match.tabScope || match.tabScope.mode === "all") return true;
  if (typeof tabId !== "number") return false;
  return match.tabScope.tabIds.includes(tabId);
}

// Reuse the same glob-to-regex semantics as the canonical implementation in
// glob.ts (see globToPathRegexSource). The local helpers below stay because
// host matching has its own narrower needs that do not benefit from the path
// glob compiler.

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
