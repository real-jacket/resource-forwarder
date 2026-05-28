import type {
  DynamicRedirectRule,
  MatchCondition,
  MatchResourceType,
  Rule,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import { buildHostRegexSource, buildRegexFilter, escapeRegex, globToUrlFilter, sanitizePathGlob, stablePositiveHash } from "./glob.js";
import { getEnabledRuleBindings } from "./matchers.js";

const ASSET_RESOURCE_TYPES: MatchResourceType[] = ["script", "stylesheet", "image", "font"];

const DNR_RESOURCE_TYPES: Record<string, Array<"script" | "stylesheet" | "image" | "font">> = {
  script: ["script"],
  stylesheet: ["stylesheet"],
  image: ["image"],
  font: ["font"],
};

export function toDynamicNetRequestRules(workspace: WorkspaceSnapshot): DynamicRedirectRule[] {
  return getEnabledRuleBindings(workspace, "asset_redirect")
    .filter((binding) => Boolean(binding.rule.target.redirectUrl))
    .map((binding) => toDynamicRule(binding.rule, binding.project?.siteHosts));
}

export function toDynamicRule(rule: Rule, projectSiteHosts?: string[]): DynamicRedirectRule {
  const hasSpecificTypes = rule.match.resourceType && rule.match.resourceType.length > 0;
  const resourceTypes = hasSpecificTypes
    ? rule.match.resourceType!
        .filter((type) => ASSET_RESOURCE_TYPES.includes(type))
        .flatMap((type) => DNR_RESOURCE_TYPES[type] ?? [])
    : undefined;

  const redirectUrl = rule.target.redirectUrl ?? "";
  const initiatorDomains = resolveInitiatorDomains(projectSiteHosts);
  // Defensive: strip any scheme+host from pathGlob before it flows into the
  // urlFilter / regexFilter builders. Users sometimes paste a full URL into
  // the "匹配路径" field, and a single malformed urlFilter is enough to make
  // Chrome reject the whole updateDynamicRules batch.
  const match: typeof rule.match = {
    ...rule.match,
    pathGlob: sanitizePathGlob(rule.match.pathGlob || "**"),
  };

  if (redirectUrl.includes("*")) {
    const wildcard = buildWildcardRedirect(match, redirectUrl);
    return {
      id: stablePositiveHash(rule.id),
      priority: rule.priority,
      action: {
        type: "redirect",
        redirect: { regexSubstitution: wildcard.regexSubstitution },
      },
      condition: {
        regexFilter: wildcard.regexFilter,
        ...(wildcard.requestDomains ? { requestDomains: wildcard.requestDomains } : {}),
        ...(initiatorDomains ? { initiatorDomains } : {}),
        ...(resourceTypes && resourceTypes.length > 0 ? { resourceTypes } : {}),
      },
    };
  }

  const condition = buildDnrCondition(match);
  return {
    id: stablePositiveHash(rule.id),
    priority: rule.priority,
    action: {
      type: "redirect",
      redirect: { url: redirectUrl },
    },
    condition: {
      ...condition,
      ...(initiatorDomains ? { initiatorDomains } : {}),
      ...(resourceTypes && resourceTypes.length > 0 ? { resourceTypes } : {}),
    },
  };
}

/**
 * Derive `initiatorDomains` for a DNR rule from the project's siteHosts.
 *
 * `initiatorDomains` limits the rule to only intercept requests initiated by
 * pages on these domains — mirroring Resource Override's matchUrl behaviour
 * where rules are scoped to the page you're browsing, not every page.
 *
 * Returns undefined (no restriction) when:
 * - siteHosts is not provided or empty
 * - siteHosts contains the wildcard "*"
 *
 * Same-origin asset rules (rule.match.host == project.siteHosts) used to skip
 * initiatorDomains as well, but that meant the rule fired for any page that
 * fetched the resource — including pages whose project was disabled or not
 * matched at all. We now always bind to the project's siteHosts so DNR matches
 * the sidepanel's "matched site" view.
 */
function resolveInitiatorDomains(
  projectSiteHosts: string[] | undefined,
): string[] | undefined {
  if (!projectSiteHosts || projectSiteHosts.length === 0) return undefined;
  if (projectSiteHosts.includes("*")) return undefined;

  const concrete = projectSiteHosts.filter((h) => h !== "*" && !h.startsWith("*."));
  if (concrete.length === 0) return undefined;

  return concrete;
}

/**
 * Build regexFilter + regexSubstitution for a wildcard redirect.
 * Each `*` / `**` in pathGlob becomes a capture group in regexFilter, and
 * each corresponding `*` / `**` in redirectUrl references it via \1, \2, etc.
 *
 * Chrome DNR applies find-and-replace: the matched portion of the URL is
 * replaced by regexSubstitution while the unmatched suffix (e.g. query params)
 * is preserved.
 */
function buildWildcardRedirect(
  match: MatchCondition,
  redirectUrl: string,
): { regexFilter: string; regexSubstitution: string; requestDomains?: string[] } {
  const pathGlob = match.pathGlob || "**";
  const hostPattern = buildHostRegexSource(match.host, "[^/]+");

  let pathRegex = "";
  for (let i = 0; i < pathGlob.length; i += 1) {
    const ch = pathGlob[i];
    if (ch === "*" && pathGlob[i + 1] === "*") {
      pathRegex += "(.*)";
      i += 1;
    } else if (ch === "*") {
      pathRegex += "([^/?]*)";
    } else {
      pathRegex += escapeRegex(ch);
    }
  }

  if (!pathRegex.startsWith("/")) pathRegex = `/${pathRegex}`;

  const regexFilter = `^https?://${hostPattern}${pathRegex}`;

  let captureIndex = 0;
  let substitution = "";
  for (let i = 0; i < redirectUrl.length; i += 1) {
    if (redirectUrl[i] === "*" && redirectUrl[i + 1] === "*") {
      captureIndex += 1;
      substitution += `\\${captureIndex}`;
      i += 1;
    } else if (redirectUrl[i] === "*") {
      captureIndex += 1;
      substitution += `\\${captureIndex}`;
    } else {
      substitution += redirectUrl[i];
    }
  }

  const concreteHosts = match.host.filter((h) => h !== "*" && !h.includes("*"));

  return {
    regexFilter,
    regexSubstitution: substitution,
    ...(concreteHosts.length > 0 ? { requestDomains: concreteHosts } : {}),
  };
}

/**
 * Build a DNR condition preferring urlFilter + requestDomains over regexFilter.
 * Chrome DNR regexFilter has a 2KB compiled-size limit; urlFilter does not.
 *
 * urlFilter supports: `*` (wildcard), `|` (start/end anchor), `||` (domain anchor).
 * We use urlFilter when the glob can be expressed with simple `*` wildcards.
 */
function buildDnrCondition(
  match: MatchCondition,
): Pick<DynamicRedirectRule["condition"], "regexFilter" | "urlFilter" | "requestDomains"> {
  const hasWildcardHost = match.host.some((host) => host !== "*" && host.includes("*"));
  if (hasWildcardHost) return { regexFilter: buildRegexFilter(match) };

  const urlFilter = globToUrlFilter(match.pathGlob || "**");
  const concreteHosts = match.host.filter((h) => h !== "*" && !h.includes("*"));

  if (urlFilter !== null) {
    return {
      urlFilter,
      ...(concreteHosts.length > 0 ? { requestDomains: concreteHosts } : {}),
    };
  }

  return { regexFilter: buildRegexFilter(match) };
}
