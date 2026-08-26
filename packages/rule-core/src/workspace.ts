import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  SupportedExportFormat,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import { matchesTabScope } from "./matchers.js";
import { matchesProjectSite, matchesRuleSetSite } from "./site-matching.js";

const TEXT_ENCODABLE_TYPES = new Set([
  "application/json",
  "application/javascript",
  "text/plain",
  "text/css",
  "text/html",
  "image/svg+xml",
]);

export function createEmptyWorkspace(): WorkspaceSnapshot {
  return {
    version: 1,
    revision: 0,
    updatedAt: new Date().toISOString(),
    projects: [],
    ruleSets: [],
    rules: [],
  };
}


export function detectFormat(content: string): SupportedExportFormat {
  const trimmed = content.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "yaml";
}

export function parseWorkspace(
  content: string,
  format = detectFormat(content),
): WorkspaceSnapshot {
  const raw = format === "json" ? JSON.parse(content) : parseYaml(content);
  return assertWorkspace(raw);
}

export function serializeWorkspace(
  snapshot: WorkspaceSnapshot,
  format: SupportedExportFormat,
): string {
  const normalized = assertWorkspace(snapshot);
  return format === "json"
    ? JSON.stringify(normalized, null, 2)
    : stringifyYaml(normalized, { defaultStringType: "QUOTE_DOUBLE" });
}

/**
 * Validate the shape of an arbitrary value as a WorkspaceSnapshot, throwing
 * loudly if the top-level structure is unrecognisable. Defensive normalisation
 * (defaulting missing arrays to empty, deriving siteMatchPatterns when only
 * siteHosts are present) lets us tolerate older snapshot versions and
 * partial JSON/YAML payloads without losing the rest of the document.
 */
export function assertWorkspace(value: unknown): WorkspaceSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("Workspace payload must be an object.");
  }

  const candidate = value as WorkspaceSnapshot;

  if (!Array.isArray(candidate.projects) || !Array.isArray(candidate.ruleSets) || !Array.isArray(candidate.rules)) {
    throw new Error("Workspace payload must contain projects, ruleSets and rules arrays.");
  }

  return {
    version: typeof candidate.version === "number" ? candidate.version : 1,
    revision: Number.isInteger(candidate.revision) && candidate.revision >= 0 ? candidate.revision : 0,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
    projects: candidate.projects.map((project) => {
      const tags = Array.isArray(project.tags) ? project.tags : [];
      const siteHosts = Array.isArray(project.siteHosts)
        ? project.siteHosts.map((host: string) => normalizeImportedHost(host))
        : [];
      const siteMatchPatterns = Array.isArray(project.siteMatchPatterns) && project.siteMatchPatterns.length > 0
        ? project.siteMatchPatterns
        : siteHosts.length > 0
          ? siteHosts.map((h: string) => h === "*" ? "*" : `https://${h}/*`)
          : [];
      return { ...project, tags, siteHosts, siteMatchPatterns };
    }),
    ruleSets: candidate.ruleSets.map((ruleSet) => ({
      ...ruleSet,
      ruleIds: Array.isArray(ruleSet.ruleIds) ? ruleSet.ruleIds : [],
    })),
    rules: candidate.rules.map((rule) => ({
      ...rule,
      tags: Array.isArray(rule.tags) ? rule.tags : [],
      match: {
        ...rule.match,
        host: Array.isArray(rule.match?.host)
          ? rule.match.host.map((host: string) => normalizeImportedHost(host))
          : [],
        pathGlob: rule.match?.pathGlob || "**",
      },
    })),
    ...(candidate.agentReservations
      ? {
          agentReservations: {
            projectIds: Array.isArray(candidate.agentReservations.projectIds) ? candidate.agentReservations.projectIds : [],
            ruleSetIds: Array.isArray(candidate.agentReservations.ruleSetIds) ? candidate.agentReservations.ruleSetIds : [],
            ruleIds: Array.isArray(candidate.agentReservations.ruleIds) ? candidate.agentReservations.ruleIds : [],
            ...(candidate.agentReservations.ruleSetOwners && typeof candidate.agentReservations.ruleSetOwners === "object"
              ? { ruleSetOwners: candidate.agentReservations.ruleSetOwners }
              : {}),
            ...(candidate.agentReservations.ruleOwners && typeof candidate.agentReservations.ruleOwners === "object"
              ? { ruleOwners: candidate.agentReservations.ruleOwners }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Derive `siteHosts` from `siteMatchPatterns`.
 *
 * Extracts the host portion from each URL pattern so downstream consumers
 * (DNR `initiatorDomains`, UI display, fallback matching) always stay in
 * sync with the canonical patterns the user edits.
 */
export function deriveSiteHosts(patterns: string[]): string[] {
  const hosts = new Set<string>();
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed || trimmed === "*" || trimmed === "<all_urls>") {
      hosts.add("*");
      continue;
    }
    const m = trimmed.match(/^(?:\*|https?):\/\/([^/]+)/i);
    if (m?.[1]) hosts.add(normalizeImportedHost(m[1]));
  }
  return Array.from(hosts);
}


/**
 * Trim a workspace snapshot down to only the projects, rule sets, and rules
 * that are eligible to fire on the given page URL (and tab, when applicable).
 *
 * Used by the extension to ship a minimal config payload to the page bridge
 * — rules for unrelated tabs would just bloat the postMessage stream and
 * inflate matcher work without any benefit.
 */
export function trimWorkspaceForUrl(
  workspace: WorkspaceSnapshot,
  urlString: string,
  tabId?: number,
): WorkspaceSnapshot {
  const allowedProjectIds = new Set(
    workspace.projects
      .filter((project) => project.enabled)
      .filter((project) => matchesProjectSite(project, urlString))
      .map((project) => project.id),
  );
  const allowedProjects = new Map(
    workspace.projects
      .filter((project) => allowedProjectIds.has(project.id))
      .map((project) => [project.id, project] as const),
  );
  const allowedRuleSets = workspace.ruleSets.filter(
    (ruleSet) =>
      ruleSet.enabled &&
      allowedProjectIds.has(ruleSet.projectId) &&
      matchesRuleSetSite(
        ruleSet,
        allowedProjects.get(ruleSet.projectId) ?? { siteHosts: [], siteMatchPatterns: [] },
        urlString,
      ),
  );
  const membershipCounts = new Map<string, number>();
  for (const ruleSet of workspace.ruleSets) {
    for (const ruleId of ruleSet.ruleIds) {
      membershipCounts.set(ruleId, (membershipCounts.get(ruleId) ?? 0) + 1);
    }
  }
  const allowedRuleIds = new Set(allowedRuleSets.flatMap((ruleSet) => ruleSet.ruleIds));

  return {
    version: workspace.version,
    revision: workspace.revision,
    updatedAt: workspace.updatedAt,
    projects: workspace.projects.filter((project) => allowedProjectIds.has(project.id)),
    ruleSets: allowedRuleSets,
    rules: workspace.rules.filter(
      (rule) =>
        rule.enabled &&
        membershipCounts.get(rule.id) === 1 &&
        allowedRuleIds.has(rule.id) &&
        matchesTabScope(rule.match, tabId),
    ),
  };
}

/**
 * Heuristic: which Content-Type values are safe to round-trip as utf-8 text
 * vs. need to be base64-encoded. Defaulting to binary (false) when the
 * upstream omits Content-Type avoids silently corrupting binary payloads
 * (images, archives, protobuf, etc.). Well-behaved servers label their
 * responses correctly so the cost of a base64 round-trip is rare.
 */
export function isTextualContentType(contentType?: string): boolean {
  if (!contentType) return false;

  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (TEXT_ENCODABLE_TYPES.has(normalized)) return true;

  return normalized.startsWith("text/") || normalized.endsWith("+json") || normalized.endsWith("+xml");
}

/**
 * Normalise host strings imported from various sources (Resource Override
 * exports, manually edited workspace.json, legacy schema migrations) into
 * the canonical form the rest of the engine expects:
 * - strip URL scheme prefixes
 * - strip trailing dots and ports (Chrome DNR requestDomains rejects ports)
 * - collapse `*` and `.*` to the wildcard sentinel `*`
 */
export function normalizeImportedHost(host: string): string {
  const trimmed = host.replace(/^(https?)\s*:\s*\/\//i, "$1://").trim();
  const explicitUrlMatch = trimmed.match(/^(?:\*|https?|file):\/\/([^/]+)/i);
  const value = explicitUrlMatch?.[1] ?? trimmed;
  if (value === "*" || value === ".*") return "*";

  return value.replace(/\.$/, "").replace(/:\d+$/, "");
}
