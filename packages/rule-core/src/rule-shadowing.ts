import type { MatchCondition, Rule } from "@resource-forwarder/shared-types";

/**
 * Given rules in precedence order (highest-precedence first — the order in
 * which the runtime matcher tries them, i.e. the output of `sortRules`),
 * return the ids of rules that can never fire because an earlier rule of the
 * same kind *fully covers* them: every request the covered rule would match is
 * already matched by the higher-precedence one, which wins first.
 *
 * The cover test is deliberately SOUND (conservative): it only reports a rule
 * as shadowed when we can prove full coverage across every match dimension.
 * A false "shadowed" would gray out a rule that actually works, which is worse
 * than missing a genuine shadow — so when in doubt we do not report it.
 *
 * Callers should pass only the rules that actually compete on the page in
 * question (enabled, and in-scope for the current URL); disabled rules are
 * skipped here as shadowers regardless.
 */
export function computeShadowedRuleIds(rulesInPrecedenceOrder: Rule[]): Set<string> {
  const shadowed = new Set<string>();
  for (let i = 0; i < rulesInPrecedenceOrder.length; i += 1) {
    const covered = rulesInPrecedenceOrder[i];
    for (let j = 0; j < i; j += 1) {
      const shadower = rulesInPrecedenceOrder[j];
      if (!shadower.enabled) continue;
      if (shadower.kind !== covered.kind) continue;
      // api_forward uses the runtime's deterministic first-match order (already
      // encoded by the caller's sort), so an earlier covering rule always wins.
      //
      // asset_redirect runs through Chrome DNR, which only guarantees the
      // strictly-higher priority wins. At EQUAL priority a DNR tie is
      // undefined, so we only dim the covered rule when the two are full
      // duplicates (same match scope) — one is genuinely redundant no matter
      // which one Chrome picks. A one-way (partial) overlap at equal priority
      // is left alone, since the more specific rule might still win.
      if (covered.kind === "asset_redirect") {
        const strictlyHigher = shadower.priority > covered.priority;
        const equalDuplicate =
          shadower.priority === covered.priority && sameScope(shadower.match, covered.match);
        if (!strictlyHigher && !equalDuplicate) continue;
      }
      if (covers(shadower.match, covered.match)) {
        shadowed.add(covered.id);
        break;
      }
    }
  }
  return shadowed;
}

/** True when the two rules match exactly the same set of requests. */
function sameScope(a: MatchCondition, b: MatchCondition): boolean {
  return covers(a, b) && covers(b, a);
}

/** True when every request matching `inner` also matches `outer`. */
function covers(outer: MatchCondition, inner: MatchCondition): boolean {
  return (
    hostCovers(outer.host, inner.host) &&
    pathCovers(outer.pathGlob || "**", inner.pathGlob || "**") &&
    listCovers(normalizeMethods(outer.method), normalizeMethods(inner.method)) &&
    listCovers(outer.resourceType, inner.resourceType) &&
    constraintCovers(outer.query, inner.query) &&
    constraintCovers(lowerKeys(outer.headers), lowerKeys(inner.headers)) &&
    tabScopeCovers(outer.tabScope, inner.tabScope)
  );
}

function hostCovers(outer: string[], inner: string[]): boolean {
  if (outer.length === 0 || outer.includes("*")) return true;
  // `outer` is restricted, so it cannot cover an unrestricted / wildcard inner.
  if (inner.length === 0 || inner.includes("*")) return false;
  return inner.every((innerHost) => outer.some((outerHost) => hostPatternCovers(outerHost, innerHost)));
}

function hostPatternCovers(outer: string, inner: string): boolean {
  if (outer === "*") return true;
  if (outer === inner) return true;
  if (outer.startsWith("*.")) {
    if (inner.includes("*")) return false; // conservative: only exact inner hosts
    return inner.endsWith(outer.slice(1)); // "*.example.com" covers "a.example.com"
  }
  return false;
}

/**
 * Sound path-glob coverage aligned with `globToPathRegexSource` semantics
 * (`*` = `[^/]*`, `**` = `.*`, `?` = `[^/]`). Only the cases we can prove are
 * reported; anything else returns false.
 */
function pathCovers(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  if (outer === "**") return true;

  // Trailing `**` covers anything sharing its literal prefix (.* absorbs the rest).
  if (outer.endsWith("**")) {
    const prefix = outer.slice(0, -2);
    return !hasWildcard(prefix) && inner.startsWith(prefix);
  }

  // Trailing single `*` (with no other wildcard in `outer`) covers inner iff
  // inner shares the literal prefix and its remainder stays inside one segment
  // (no `/`, and no `**` which could cross a segment boundary).
  if (outer.endsWith("*") && !outer.endsWith("**")) {
    const prefix = outer.slice(0, -1);
    if (hasWildcard(prefix)) return false;
    if (!inner.startsWith(prefix)) return false;
    const remainder = inner.slice(prefix.length);
    return !remainder.includes("/") && !remainder.includes("**");
  }

  return false;
}

function hasWildcard(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

/** `outer` covers `inner` when it is unconstrained, or lists a superset. */
function listCovers(outer: string[] | undefined, inner: string[] | undefined): boolean {
  if (!outer || outer.length === 0) return true;
  if (!inner || inner.length === 0) return false; // inner matches all, outer is restricted
  return inner.every((value) => outer.includes(value));
}

/**
 * For key/value constraints (query params, headers): `outer` covers `inner`
 * only when every constraint `outer` imposes is also imposed identically by
 * `inner` — otherwise some inner-matching request could violate outer's
 * constraint.
 */
function constraintCovers(
  outer: Record<string, string> | undefined,
  inner: Record<string, string> | undefined,
): boolean {
  if (!outer || Object.keys(outer).length === 0) return true;
  if (!inner) return false;
  return Object.entries(outer).every(([key, value]) => inner[key] === value);
}

function tabScopeCovers(outer: MatchCondition["tabScope"], inner: MatchCondition["tabScope"]): boolean {
  if (!outer || outer.mode === "all") return true;
  if (!inner || inner.mode === "all") return false;
  return inner.tabIds.every((id) => outer.tabIds.includes(id));
}

function normalizeMethods(methods: string[] | undefined): string[] | undefined {
  return methods?.map((method) => method.toUpperCase());
}

function lowerKeys(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) next[key.toLowerCase()] = value;
  return next;
}
