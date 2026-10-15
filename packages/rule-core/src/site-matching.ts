import { matchesHost, matchesPath } from "./matchers.js";

export function matchesProjectSite(
  project: { siteHosts: string[]; siteMatchPatterns?: string[] },
  pageUrl: string,
): boolean {
  const patterns = project.siteMatchPatterns ?? [];
  if (patterns.length > 0) {
    return patterns.some((pattern) => matchesSitePattern(pattern, pageUrl));
  }

  if (project.siteHosts.length === 0 || project.siteHosts.includes("*")) return true;

  try {
    return matchesHost(project.siteHosts, new URL(pageUrl).host);
  } catch {
    return false;
  }
}

export function matchesRuleSetSite(
  ruleSet: { siteMatchPatterns?: string[] },
  fallbackProject: { siteHosts: string[]; siteMatchPatterns?: string[] },
  pageUrl: string,
): boolean {
  const patterns = ruleSet.siteMatchPatterns ?? [];
  if (patterns.length === 0) {
    return matchesProjectSite(fallbackProject, pageUrl);
  }
  return patterns.some((pattern) => matchesSitePattern(pattern, pageUrl));
}

/**
 * How specifically a set of site-match patterns pins down a given page URL.
 * Higher = more specific (an exact URL beats a `/*` wildcard). Returns -1 when
 * none of the patterns match the URL. Measured as the literal (non-wildcard)
 * character count of the most specific matching pattern.
 *
 * Used to break ties between equal-priority asset_redirect rules whose owning
 * groups both match the current page: the more specific group is treated as
 * the effective one, since the browser's DNR tie for equal priority is
 * otherwise undefined.
 */
export function siteScopeSpecificity(patterns: string[], pageUrl: string): number {
  let best = -1;
  for (const pattern of patterns) {
    if (!matchesSitePattern(pattern, pageUrl)) continue;
    best = Math.max(best, pattern.replace(/\*/g, "").length);
  }
  return best;
}

function matchesSitePattern(pattern: string, pageUrl: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed === "*" || trimmed === "<all_urls>") return true;

  const patternUrlMatch = trimmed.match(/^(\*|https?):\/\/([^/]*)(\/.*)?$/i);
  if (!patternUrlMatch) return false;

  const [, patternScheme, patternHost, patternPath] = patternUrlMatch;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }

  if (patternScheme !== "*" && url.protocol !== `${patternScheme}:`) return false;
  if (patternHost !== "*" && !matchesHost([patternHost!], url.host)) return false;

  const pathGlob = patternPath || "/**";
  const crossSegmentGlob = pathGlob.replace(/(?<!\*)\*(?!\*)/g, "**");
  const normalizedGlob = crossSegmentGlob.endsWith("*") ? crossSegmentGlob : `${crossSegmentGlob}**`;
  return matchesPath(normalizedGlob, url.pathname);
}
