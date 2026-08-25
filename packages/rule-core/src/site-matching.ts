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
