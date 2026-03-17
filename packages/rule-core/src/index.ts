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
    projects: candidate.projects.map((project) => ({
      ...project,
      tags: Array.isArray(project.tags) ? project.tags : [],
      siteHosts: Array.isArray(project.siteHosts) ? project.siteHosts : [],
    })),
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
    if (!redirectUrl.startsWith("https://")) {
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
    .map((binding) => toDynamicRule(binding.rule));
}

export function toDynamicRule(rule: Rule): DynamicRedirectRule {
  const resourceTypes = (rule.match.resourceType ?? ASSET_RESOURCE_TYPES)
    .filter((type) => ASSET_RESOURCE_TYPES.includes(type))
    .flatMap((type) => DNR_RESOURCE_TYPES[type] ?? []);

  return {
    id: stablePositiveHash(rule.id),
    priority: rule.priority,
    action: {
      type: "redirect",
      redirect: {
        url: rule.target.redirectUrl ?? "",
      },
    },
    condition: {
      regexFilter: buildRegexFilter(rule.match),
      resourceTypes,
    },
  };
}

export function buildRegexFilter(match: MatchCondition): string {
  const hostPattern =
    match.host.length === 0 || match.host.includes("*")
      ? ".*"
      : `(?:${match.host.map((host) => escapeRegex(host).replace(/\\\*/g, "[^.]+" )).join("|")})`;
  const pathPattern = globToRegexSource(match.pathGlob || "**");
  return `^https?:\\/\\/${hostPattern}${pathPattern}$`;
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
      return new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`).test(host);
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

export function trimWorkspaceForUrl(workspace: WorkspaceSnapshot, urlString: string, tabId?: number): WorkspaceSnapshot {
  const url = new URL(urlString);
  const allowedRuleIds = new Set(
    getEnabledRuleBindings(workspace)
      .filter((binding) => matchesHost(binding.rule.match.host, url.host) && matchesTabScope(binding.rule.match, tabId))
      .map((binding) => binding.rule.id),
  );

  const allowedRuleSets = workspace.ruleSets.filter((ruleSet) => ruleSet.ruleIds.some((ruleId) => allowedRuleIds.has(ruleId)));
  const allowedProjectIds = new Set(allowedRuleSets.map((ruleSet) => ruleSet.projectId));

  return {
    version: workspace.version,
    updatedAt: workspace.updatedAt,
    projects: workspace.projects.filter((project) => allowedProjectIds.has(project.id)),
    ruleSets: allowedRuleSets,
    rules: workspace.rules.filter((rule) => allowedRuleIds.has(rule.id)),
  };
}

export function isTextualContentType(contentType?: string): boolean {
  if (!contentType) {
    return true;
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

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function stablePositiveHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 1000000000 || 1;
}
