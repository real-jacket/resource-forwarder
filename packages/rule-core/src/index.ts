import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  DynamicRedirectRule,
  MatchCondition,
  MatchResourceType,
  RequestContext,
  Rule,
  RuleBinding,
  RuleKind,
  SupportedExportFormat,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";

const ASSET_RESOURCE_TYPES: MatchResourceType[] = ["script", "stylesheet", "image", "font"];
const TEXT_ENCODABLE_TYPES = new Set(["application/json", "application/javascript", "text/plain", "text/css", "text/html", "image/svg+xml"]);

const DNR_RESOURCE_TYPES: Record<string, Array<"script" | "stylesheet" | "image" | "font">> = {
  script: ["script"],
  stylesheet: ["stylesheet"],
  image: ["image"],
  font: ["font"],
};

export interface RuleConflict {
  ruleId: string;
  reason: string;
}

interface ResourceOverrideExportPayload {
  v?: number;
  data?: ResourceOverrideDomain[];
}

interface ResourceOverrideDomain {
  id?: string;
  name?: string;
  matchUrl?: string;
  on?: boolean;
  rules?: ResourceOverrideRule[];
}

type ResourceOverrideRule =
  | {
      type?: "normalOverride";
      match?: string;
      replace?: string;
      on?: boolean;
    }
  | {
      type?: "fileOverride";
      match?: string;
      file?: string;
      fileId?: string;
      on?: boolean;
    }
  | {
      type?: "fileInject";
      fileName?: string;
      file?: string;
      fileId?: string;
      fileType?: string;
      injectLocation?: string;
      on?: boolean;
    }
  | {
      type?: "headerRule";
      match?: string;
      requestRules?: unknown[];
      responseRules?: unknown[];
      on?: boolean;
    };

export interface ResourceOverrideImportReport {
  importedProjectCount: number;
  importedRuleCount: number;
  skippedRuleCount: number;
  warnings: string[];
}

export function createEmptyWorkspace(): WorkspaceSnapshot {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: [],
    ruleSets: [],
    rules: [],
  };
}

export function normalizeMethod(method: string): string {
  return method.toUpperCase();
}

export function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }

    if (left.createdAt !== right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }

    return left.id.localeCompare(right.id);
  });
}

export function detectFormat(content: string): SupportedExportFormat {
  const trimmed = content.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "yaml";
}

export function parseWorkspace(content: string, format = detectFormat(content)): WorkspaceSnapshot {
  const raw = format === "json" ? JSON.parse(content) : parseYaml(content);
  return assertWorkspace(raw);
}

export function serializeWorkspace(snapshot: WorkspaceSnapshot, format: SupportedExportFormat): string {
  const normalized = assertWorkspace(snapshot);
  return format === "json"
    ? JSON.stringify(normalized, null, 2)
    : stringifyYaml(normalized, { defaultStringType: "QUOTE_DOUBLE" });
}

export function parseResourceOverrideExport(content: string): {
  workspace: WorkspaceSnapshot;
  report: ResourceOverrideImportReport;
} {
  const raw = JSON.parse(content) as ResourceOverrideExportPayload;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.data)) {
    throw new Error("Resource Override payload must be a JSON object with a data array.");
  }

  const now = new Date().toISOString();
  const workspace = createEmptyWorkspace();
  workspace.updatedAt = now;

  const report: ResourceOverrideImportReport = {
    importedProjectCount: 0,
    importedRuleCount: 0,
    skippedRuleCount: 0,
    warnings: [],
  };

  raw.data.forEach((domain, domainIndex) => {
    const domainScope = resolveResourceOverrideDomainScope(domain);
    const domainLabel = domainScope || domain.id || `domain-${domainIndex + 1}`;
    const siteHosts = collectResourceOverrideHosts(domain);
    if (siteHosts.length === 0) {
      report.warnings.push(`已跳过 ${domainLabel}：无法从 matchUrl / name 或规则 match 中提取可用 host。`);
      return;
    }

    if (!domainScope) {
      report.warnings.push(`已根据 ${domainLabel} 下规则的 match 自动推断 host：${siteHosts.join(", ")}。`);
    }

    const projectId = `ro-project-${stablePositiveHash(`${domain.id ?? domainLabel}-project`)}`;
    const ruleSetId = `ro-ruleset-${stablePositiveHash(`${domain.id ?? domainLabel}-ruleset`)}`;
    const ruleIds: string[] = [];

    const siteMatchPatterns = domainScope ? [domainScope] : [];

    workspace.projects.push({
      id: projectId,
      name: buildImportedProjectName(siteHosts[0] ?? domainLabel),
      enabled: domain.on !== false,
      siteHosts,
      siteMatchPatterns,
      envLabel: "resource-override",
      note: `Imported from Resource Override domain ${domainLabel}`,
      tags: ["resource-override-import"],
      createdAt: now,
      updatedAt: now,
    });

    for (const [ruleIndex, rule] of (domain.rules ?? []).entries()) {
      const converted = convertResourceOverrideRule(rule, {
        domainLabel,
        domainMatchUrl: domain.matchUrl ?? "",
        fallbackHosts: siteHosts,
        now,
        ruleIndex,
      });

      if (!converted.rule) {
        report.skippedRuleCount += 1;
        report.warnings.push(`已跳过 ${domainLabel} 的第 ${ruleIndex + 1} 条规则：${converted.reason ?? "当前类型或目标地址暂不支持。"}。`);
        continue;
      }

      workspace.rules.push(converted.rule);
      ruleIds.push(converted.rule.id);
      report.importedRuleCount += 1;
    }

    workspace.ruleSets.push({
      id: ruleSetId,
      projectId,
      name: `${buildImportedProjectName(siteHosts[0] ?? domainLabel)} 规则组`,
      enabled: true,
      ruleIds,
      note: "Imported from Resource Override",
      createdAt: now,
      updatedAt: now,
    });

    report.importedProjectCount += 1;
  });

  return {
    workspace,
    report,
  };
}

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
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
    projects: candidate.projects.map((project) => {
      const tags = Array.isArray(project.tags) ? project.tags : [];
      const siteHosts = Array.isArray(project.siteHosts) ? project.siteHosts : [];
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
        host: Array.isArray(rule.match?.host) ? rule.match.host : [],
        pathGlob: rule.match?.pathGlob || "**",
      },
    })),
  };
}

export function resolveRuleBinding(workspace: WorkspaceSnapshot, ruleId: string): RuleBinding | undefined {
  const rule = workspace.rules.find((item) => item.id === ruleId);
  if (!rule) {
    return undefined;
  }

  const ruleSet = workspace.ruleSets.find((item) => item.ruleIds.includes(ruleId));
  const project = ruleSet ? workspace.projects.find((item) => item.id === ruleSet.projectId) : undefined;
  return { rule, ruleSet, project };
}

export function getEnabledRuleBindings(workspace: WorkspaceSnapshot, kind?: RuleKind): RuleBinding[] {
  return sortRules(workspace.rules)
    .filter((rule) => (kind ? rule.kind === kind : true))
    .map((rule) => resolveRuleBinding(workspace, rule.id))
    .filter((binding): binding is RuleBinding => Boolean(binding))
    .filter((binding) => binding.rule.enabled)
    .filter((binding) => (binding.ruleSet ? binding.ruleSet.enabled : true))
    .filter((binding) => (binding.project ? binding.project.enabled : true));
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

export function pickMatchingRule(
  workspace: WorkspaceSnapshot,
  context: RequestContext,
  kind?: RuleKind,
): RuleBinding | undefined {
  return getEnabledRuleBindings(workspace, kind).find((binding) => matchesRule(binding.rule, context));
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

export function collectUnsupportedRuleWarnings(rule: Rule): string[] {
  const warnings: string[] = [];

  if (rule.kind === "asset_redirect") {
    const redirectUrl = rule.target.redirectUrl ?? "";
    const isValidTarget =
      redirectUrl.startsWith("https://") ||
      redirectUrl.startsWith("http://localhost") ||
      redirectUrl.startsWith("http://127.0.0.1");
    if (!isValidTarget) {
      warnings.push(`Asset redirect rule ${rule.name} must point to an HTTPS target.`);
    }
  }

  if (rule.kind === "api_forward" && !rule.target.forwardProfile) {
    warnings.push(`API forward rule ${rule.name} is missing a forward profile.`);
  }

  return warnings;
}

export function collectWorkspaceWarnings(workspace: WorkspaceSnapshot): string[] {
  return workspace.rules.flatMap((rule) => collectUnsupportedRuleWarnings(rule));
}

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
  const initiatorDomains = resolveInitiatorDomains(projectSiteHosts, rule.match.host);

  if (redirectUrl.includes("*")) {
    const wildcard = buildWildcardRedirect(rule.match, redirectUrl);
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

  const condition = buildDnrCondition(rule.match);
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
 * - siteHosts only lists the same hosts as the rule's own match.host
 *   (self-referential: the rule targets the same domain the page is on)
 */
function resolveInitiatorDomains(
  projectSiteHosts: string[] | undefined,
  ruleMatchHosts: string[],
): string[] | undefined {
  if (!projectSiteHosts || projectSiteHosts.length === 0) {
    return undefined;
  }

  if (projectSiteHosts.includes("*")) {
    return undefined;
  }

  const concrete = projectSiteHosts.filter((h) => h !== "*" && !h.startsWith("*."));
  if (concrete.length === 0) {
    return undefined;
  }

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

  if (!pathRegex.startsWith("/")) {
    pathRegex = `/${pathRegex}`;
  }

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
function buildDnrCondition(match: MatchCondition): Pick<DynamicRedirectRule["condition"], "regexFilter" | "urlFilter" | "requestDomains"> {
  const hasWildcardHost = match.host.some((host) => host !== "*" && host.includes("*"));
  if (hasWildcardHost) {
    return { regexFilter: buildRegexFilter(match) };
  }

  const urlFilter = globToUrlFilter(match.pathGlob || "**");
  const concreteHosts = match.host.filter((h) => h !== "*" && !h.includes("*"));

  if (urlFilter !== null) {
    return {
      urlFilter,
      ...(concreteHosts.length > 0 ? { requestDomains: concreteHosts } : {}),
    };
  }

  // Fall back to regexFilter for complex patterns
  return { regexFilter: buildRegexFilter(match) };
}

/**
 * Convert a path glob to a DNR urlFilter string, or return null if it
 * contains patterns that urlFilter cannot express (e.g. `?`, `[...]`).
 *
 * Mapping:
 *   `**`    → `*`     (match anything)
 *   `*`     → `*`     (match anything except `?`)
 *   `.`     → `.`     (literal — urlFilter treats `.` as literal)
 *   other   → literal
 */
function globToUrlFilter(glob: string): string | null {
  if (/[?[\]{}()]/.test(glob)) return null;

  let filter = glob
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "*")
    .replace(/\0/g, "*");

  // Collapse consecutive wildcards
  filter = filter.replace(/\*{2,}/g, "*");

  if (!filter.startsWith("/")) {
    filter = `/${filter}`;
  }

  // urlFilter `|` anchors: start-match on path
  return `|*://*${filter}`;
}

export function buildRegexFilter(match: MatchCondition): string {
  const hostPattern = buildHostRegexSource(match.host, ".*");
  const pathPattern = globToRegexSource(match.pathGlob || "**");
  return `^https?:\\/\\/${hostPattern}${pathPattern}(?:[?#].*)?$`;
}

export function matchesHost(patterns: string[], host: string): boolean {
  if (patterns.length === 0 || patterns.includes("*")) {
    return true;
  }

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
  return new RegExp(`^${globToRegexSource(pathGlob || "**")}$`).test(pathname);
}

export function matchesMethod(match: MatchCondition, method: string): boolean {
  if (!match.method || match.method.length === 0) {
    return true;
  }

  const normalized = normalizeMethod(method);
  return match.method.some((item) => normalizeMethod(item) === normalized);
}

export function matchesResourceType(match: MatchCondition, resourceType: MatchResourceType): boolean {
  if (!match.resourceType || match.resourceType.length === 0) {
    return true;
  }

  return match.resourceType.includes(resourceType);
}

export function matchesTabScope(match: MatchCondition, tabId?: number): boolean {
  if (!match.tabScope || match.tabScope.mode === "all") {
    return true;
  }

  if (typeof tabId !== "number") {
    return false;
  }

  return match.tabScope.tabIds.includes(tabId);
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
    if (m?.[1]) {
      hosts.add(normalizeImportedHost(m[1]));
    }
  }
  return Array.from(hosts);
}

/**
 * Check whether a page URL matches a project's site scope.
 *
 * Match logic (mirrors Resource Override's matchUrl semantics):
 * 1. If siteMatchPatterns is non-empty, at least one pattern must match the URL.
 * 2. Otherwise fall back to siteHosts — page host must be in the list.
 * 3. If both are empty/wildcard, the project matches all pages.
 */
export function matchesProjectSite(project: { siteHosts: string[]; siteMatchPatterns?: string[] }, pageUrl: string): boolean {
  const patterns = project.siteMatchPatterns ?? [];
  if (patterns.length > 0) {
    return patterns.some((pattern) => matchesSitePattern(pattern, pageUrl));
  }

  if (project.siteHosts.length === 0 || project.siteHosts.includes("*")) {
    return true;
  }

  try {
    const host = new URL(pageUrl).host;
    return matchesHost(project.siteHosts, host);
  } catch {
    return false;
  }
}

function matchesSitePattern(pattern: string, pageUrl: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed === "*" || trimmed === "<all_urls>") {
    return true;
  }

  const patternUrlMatch = trimmed.match(/^(\*|https?):\/\/([^/]*)(\/.*)?$/i);
  if (!patternUrlMatch) {
    return false;
  }

  const [, patternScheme, patternHost, patternPath] = patternUrlMatch;

  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }

  if (patternScheme !== "*" && url.protocol !== `${patternScheme}:`) {
    return false;
  }

  if (patternHost !== "*" && !matchesHost([patternHost!], url.host)) {
    return false;
  }

  const pathGlob = patternPath || "/**";
  const normalizedGlob = pathGlob.endsWith("*") ? pathGlob : `${pathGlob}**`;
  return matchesPath(normalizedGlob, url.pathname);
}

export function trimWorkspaceForUrl(workspace: WorkspaceSnapshot, urlString: string, tabId?: number): WorkspaceSnapshot {
  const allowedProjectIds = new Set(
    workspace.projects
      .filter((project) => project.enabled)
      .filter((project) => matchesProjectSite(project, urlString))
      .map((project) => project.id),
  );
  const allowedRuleSets = workspace.ruleSets.filter(
    (ruleSet) => ruleSet.enabled && allowedProjectIds.has(ruleSet.projectId),
  );
  const allowedRuleIds = new Set(allowedRuleSets.flatMap((ruleSet) => ruleSet.ruleIds));

  return {
    version: workspace.version,
    updatedAt: workspace.updatedAt,
    projects: workspace.projects.filter((project) => allowedProjectIds.has(project.id)),
    ruleSets: allowedRuleSets,
    rules: workspace.rules.filter(
      (rule) => rule.enabled && allowedRuleIds.has(rule.id) && matchesTabScope(rule.match, tabId),
    ),
  };
}

export function isTextualContentType(contentType?: string): boolean {
  // Default to binary when the upstream omits Content-Type — decoding an
  // unknown payload as utf-8 is lossy for binary content (images, archives,
  // protobuf, etc.) and only saves a base64 round-trip for the text case,
  // which most well-behaved servers label correctly anyway.
  if (!contentType) {
    return false;
  }

  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (TEXT_ENCODABLE_TYPES.has(normalized)) {
    return true;
  }

  return normalized.startsWith("text/") || normalized.endsWith("+json") || normalized.endsWith("+xml");
}

function globToRegexSource(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const current = glob[index];
    const next = glob[index + 1];
    if (current === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (current === "*") {
      source += "[^?]*";
      continue;
    }

    if (current === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegex(current);
  }

  if (!source.startsWith("/")) {
    source = `/${source}`;
  }

  return source;
}

function convertResourceOverrideRule(
  rule: ResourceOverrideRule,
  options: {
    domainLabel: string;
    domainMatchUrl: string;
    fallbackHosts: string[];
    now: string;
    ruleIndex: number;
  },
): {
  rule: Rule | null;
  reason?: string;
} {
  if (rule.type !== "normalOverride") {
    return {
      rule: null,
      reason: `仅支持 normalOverride，当前为 ${rule.type ?? "unknown"}`,
    };
  }

  const pathGlob = extractResourceOverridePathGlob(rule.match ?? "");
  const replacement = sanitizeResourceOverrideUrl(rule.replace?.trim() ?? "");
  if (!pathGlob || !replacement) {
    return {
      rule: null,
      reason: !pathGlob ? "无法解析 match 路径" : "缺少 replace 目标",
    };
  }

  // Each rule's host comes from its own match URL, not the domain-level hosts.
  // A single Resource Override domain group can contain rules targeting different CDN hosts.
  const ruleHost = extractResourceOverrideRuleHost(rule);
  const ruleHosts = ruleHost ? [ruleHost] : options.fallbackHosts;

  const id = `ro-rule-${stablePositiveHash(`${options.domainLabel}-${options.ruleIndex}-${pathGlob}-${replacement}`)}`;
  const note = `Imported from Resource Override (${options.domainLabel})`;
  const baseRule = {
    id,
    enabled: rule.on !== false,
    priority: Math.max(1, 100 - options.ruleIndex),
    match: {
      host: ruleHosts,
      pathGlob,
      tabScope: { mode: "all" as const },
    },
    note,
    tags: ["resource-override-import"],
    createdAt: options.now,
    updatedAt: options.now,
  };

  if (!replacement.startsWith("http://") && !replacement.startsWith("https://")) {
    return {
      rule: null,
      reason: "replace 目标仅支持 http/https URL",
    };
  }

  let target: URL;
  try {
    target = new URL(replacement);
  } catch {
    return {
      rule: null,
      reason: `replace 不是合法 URL: ${replacement}`,
    };
  }

  // HTTPS target without wildcards → simple asset_redirect (DNR redirect)
  if (replacement.startsWith("https://") && !replacement.includes("*")) {
    return {
      rule: {
        ...baseRule,
        name: `RO 资源替换 ${pathGlob}`,
        kind: "asset_redirect",
        match: {
          ...baseRule.match,
          resourceType: inferResourceTypesFromPath(pathGlob),
        },
        target: {
          redirectUrl: replacement,
        },
      },
    };
  }

  // localhost / 127.0.0.1 target with a specific file path (no wildcard, not root) →
  // asset_redirect. Chrome DNR allows redirecting to http://localhost and http://127.0.0.1.
  const isLocalhost =
    target.hostname === "localhost" || target.hostname === "127.0.0.1";
  const hasWildcardInReplace = target.pathname.includes("*");
  const isRootPath = target.pathname === "/" || target.pathname === "";

  if (isLocalhost && !hasWildcardInReplace && !isRootPath) {
    return {
      rule: {
        ...baseRule,
        name: `RO 资源替换 ${pathGlob}`,
        kind: "asset_redirect",
        match: {
          ...baseRule.match,
          resourceType: inferResourceTypesFromPath(pathGlob),
        },
        target: {
          redirectUrl: replacement.trim(),
        },
      },
    };
  }

  // localhost / 127.0.0.1 target WITH wildcards in replace path →
  // asset_redirect with wildcard redirectUrl. toDynamicRule will convert the
  // aligned wildcards into regexFilter + regexSubstitution for Chrome DNR,
  // so the redirect works for <script> tags and other browser-initiated loads
  // that page-bridge (fetch/XHR patching) cannot intercept.
  if (isLocalhost && hasWildcardInReplace) {
    return {
      rule: {
        ...baseRule,
        name: `RO 资源替换 ${pathGlob}`,
        kind: "asset_redirect",
        match: {
          ...baseRule.match,
          resourceType: inferResourceTypesFromPath(pathGlob),
        },
        target: {
          redirectUrl: replacement.trim(),
        },
      },
    };
  }

  // localhost / 127.0.0.1 target with root base URL (no wildcard, no specific file) →
  // api_forward so the local service handles path rewriting for all sub-paths.
  if (isLocalhost && isRootPath) {
    const stripPrefix = inferLocalhostStripPrefix(pathGlob, target.pathname);
    return {
      rule: {
        ...baseRule,
        name: `RO 本地转发 ${pathGlob}`,
        kind: "api_forward",
        match: {
          ...baseRule.match,
          resourceType: inferResourceTypesFromPath(pathGlob),
          method: ["GET"],
        },
        target: {
          forwardProfile: {
            targetBaseUrl: target.origin,
            ...(stripPrefix ? { stripPrefix } : {}),
          },
        },
      },
    };
  }

  // Non-local HTTP target: only allow as api_forward when it looks like an API
  if (looksLikeApiPath(pathGlob) && (target.pathname === "/" || target.pathname === "")) {
    return {
      rule: {
        ...baseRule,
        name: `RO API 转发 ${pathGlob}`,
        kind: "api_forward",
        match: {
          ...baseRule.match,
          resourceType: ["fetch", "xmlhttprequest"],
          method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        },
        target: {
          forwardProfile: {
            targetBaseUrl: target.origin,
          },
        },
      },
    };
  }

  return {
    rule: null,
    reason: "资源替换目标须为 HTTPS 地址，或本地 localhost / 127.0.0.1 地址",
  };
}

function resolveResourceOverrideDomainScope(domain: ResourceOverrideDomain): string {
  return domain.matchUrl?.trim() || domain.name?.trim() || "";
}

function collectResourceOverrideHosts(domain: ResourceOverrideDomain): string[] {
  const explicitHosts = extractResourceOverrideHosts(resolveResourceOverrideDomainScope(domain));
  if (explicitHosts.length > 0) {
    return explicitHosts;
  }

  const inferredHosts = (domain.rules ?? [])
    .map((rule) => extractResourceOverrideRuleHost(rule))
    .filter((host): host is string => Boolean(host));

  return Array.from(new Set(inferredHosts));
}

function extractResourceOverrideRuleHost(rule: ResourceOverrideRule): string | null {
  const matchValue = "match" in rule ? sanitizeResourceOverrideUrl(rule.match?.trim() ?? "") : "";
  if (!matchValue) {
    return null;
  }

  const explicitUrlMatch = matchValue.match(/^(?:\*|https?):\/\/([^/]+)/i);
  if (!explicitUrlMatch?.[1]) {
    return null;
  }

  return normalizeImportedHost(explicitUrlMatch[1]);
}

function extractResourceOverrideHosts(matchUrl: string): string[] {
  const trimmed = matchUrl.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed === "*" || trimmed === "<all_urls>") {
    return ["*"];
  }

  const explicitUrlMatch = trimmed.match(/^(?:\*|https?|file):\/\/([^/]+)/i);
  if (explicitUrlMatch?.[1]) {
    return [normalizeImportedHost(explicitUrlMatch[1])];
  }

  if (trimmed.startsWith("*.") || /^[a-z0-9*.-]+(?::\d+)?$/i.test(trimmed)) {
    return [normalizeImportedHost(trimmed)];
  }

  return [];
}

/**
 * Fix common typos found in Resource Override exports, e.g. "http: //host" → "http://host".
 */
function sanitizeResourceOverrideUrl(url: string): string {
  return url.replace(/^(https?)\s*:\s*\/\//i, "$1://");
}

function normalizeImportedHost(host: string): string {
  if (host === "*" || host === ".*") {
    return "*";
  }

  // Strip trailing dot and port — Chrome DNR requestDomains doesn't support ports
  return host.replace(/\.$/, "").replace(/:\d+$/, "");
}

function extractResourceOverridePathGlob(match: string): string | null {
  const trimmed = sanitizeResourceOverrideUrl(match.trim());
  if (!trimmed) {
    return null;
  }

  let pathPart = trimmed;
  const explicitUrlMatch = trimmed.match(/^(?:\*|https?):\/\/[^/]+(\/.*)$/i);
  if (explicitUrlMatch?.[1]) {
    pathPart = explicitUrlMatch[1];
  }

  if (!pathPart.startsWith("/")) {
    return null;
  }

  const sanitized = pathPart.split("?")[0]?.split("#")[0] ?? pathPart;
  if (sanitized === "/*" || sanitized === "/") {
    return "/**";
  }

  return sanitized.replace(/\/\*$/, "/**");
}

function inferResourceTypesFromPath(pathGlob: string): MatchResourceType[] | undefined {
  // Strip trailing wildcards so "*.css*" → "*.css", "/images/**" → "/images/"
  const stripped = pathGlob.toLowerCase().replace(/\*+$/, "");
  const normalized = pathGlob.toLowerCase();

  if (
    stripped.endsWith(".js") || stripped.endsWith(".mjs") || stripped.endsWith(".cjs") ||
    normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")
  ) {
    return ["script"];
  }
  if (stripped.endsWith(".css") || normalized.endsWith(".css")) {
    return ["stylesheet"];
  }
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico)$/.test(stripped) || /\.(png|jpe?g|gif|svg|webp|avif|ico)$/.test(normalized)) {
    return ["image"];
  }
  if (/\.(woff2?|ttf|otf|eot)$/.test(stripped) || /\.(woff2?|ttf|otf|eot)$/.test(normalized)) {
    return ["font"];
  }
  // Check if the directory name hints at a resource type (e.g. /images/**)
  const dirSegment = stripped.replace(/\/+$/, "").split("/").pop() ?? "";
  if (/^images?$/i.test(dirSegment) || /^icons?$/i.test(dirSegment) || /^img$/i.test(dirSegment)) {
    return ["image"];
  }
  if (/^fonts?$/i.test(dirSegment)) {
    return ["font"];
  }
  if (/^styles?$/i.test(dirSegment) || /^css$/i.test(dirSegment)) {
    return ["stylesheet"];
  }
  if (/^scripts?$/i.test(dirSegment) || /^js$/i.test(dirSegment)) {
    return ["script"];
  }
  // Return undefined for unrecognized types (.json, .xml, etc.) —
  // toDynamicRule will omit resourceTypes from the DNR condition so Chrome matches all types.
  return undefined;
}

function looksLikeApiPath(pathGlob: string): boolean {
  const normalized = pathGlob.toLowerCase();
  return normalized.includes("/api") || normalized.includes("/graphql") || normalized.includes("/rest/");
}

function buildImportedProjectName(host: string): string {
  return host === "*" ? "全局规则" : host;
}

/**
 * Compute the path prefix to strip when forwarding to a localhost dev server.
 *
 * Resource Override rules typically map:
 *   match  /path/to/dir/file.HASH.ext  →  replace http://localhost:PORT/file.ext
 * The local dev server doesn't know about the production directory structure, so
 * we strip the directory prefix that isn't present on the replace side.
 *
 * Examples:
 *   matchPath = /sheet/entry.*.js,   replacePath = /entry.js       → stripPrefix = /sheet
 *   matchPath = /a/b/c/*.chunk.js,   replacePath = /*.chunk.js     → stripPrefix = /a/b/c
 *   matchPath = /images/*.svg,       replacePath = /images/*.svg   → stripPrefix = (none)
 */
function inferLocalhostStripPrefix(matchPathGlob: string, replacePath: string): string {
  // Directory = everything up to (but not including) the last "/"
  const matchDir = matchPathGlob.substring(0, matchPathGlob.lastIndexOf("/"));
  const replaceDir = replacePath.substring(0, replacePath.lastIndexOf("/"));

  if (matchDir === replaceDir) {
    return "";
  }

  // If match has a longer directory that starts with replace's directory,
  // the extra segment is what needs to be stripped.
  if (matchDir.startsWith(replaceDir)) {
    // e.g. matchDir="/sheet", replaceDir="" → strip "/sheet"
    return matchDir;
  }

  // Fallback: strip the entire match directory
  return matchDir;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function buildHostRegexSource(hosts: string[], wildcardSource: string): string {
  if (hosts.length === 0 || hosts.includes("*")) {
    return wildcardSource;
  }

  return `(?:${hosts.map((host) => escapeRegex(host).replace(/\*/g, "[^.]+")).join("|")})`;
}

function stablePositiveHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 1000000000 || 1;
}
