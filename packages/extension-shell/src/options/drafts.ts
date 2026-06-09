import type {
  MatchResourceType,
  Project,
  Rule,
  RuleSet,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import { sanitizePathGlob } from "@resource-forwarder/rule-core";
import { createId, joinCsv, normalizeHostInput, splitCsv } from "../shared/helpers.js";
import {
  defaultApiTypes,
  defaultAssetTypes,
  type BatchRuleDraft,
  type ProjectDraft,
  type RuleDraft,
  type RuleTemplatePreset,
} from "./types.js";

/**
 * Domain-pure helpers for converting between persisted Project / Rule shapes
 * and the form-friendly Draft representations the editor uses internally.
 *
 * Pulling these out of `main.tsx` keeps the App component focused on UI state
 * and gives us a place to unit-test the conversions without mounting React.
 */

/**
 * Re-apply kind-specific defaults when the user toggles between
 * `api_forward` and `asset_redirect`. The function intentionally preserves
 * fields that make sense across kinds (host, path) and resets the ones that
 * don't (e.g. clears redirectUrl when switching to api_forward).
 */
export function mergeRuleDraftByKind<T extends RuleDraft | BatchRuleDraft>(
  draft: T,
  kind: Rule["kind"],
  patch: Partial<T> = {},
): T {
  const base = {
    ...draft,
    kind,
    resourceType:
      patch.resourceType ?? (kind === draft.kind ? draft.resourceType : defaultResourceTypeText(kind)),
    method: patch.method ?? (kind === draft.kind ? draft.method : defaultMethodText(kind)),
    redirectUrl: kind === "asset_redirect" ? (patch.redirectUrl ?? draft.redirectUrl) : "",
    targetBaseUrl: kind === "api_forward" ? (patch.targetBaseUrl ?? draft.targetBaseUrl) : "",
    stripPrefix: kind === "api_forward" ? (patch.stripPrefix ?? draft.stripPrefix) : "",
    headersJson: kind === "api_forward" ? (patch.headersJson ?? draft.headersJson ?? "{}") : "",
  };
  return { ...base, ...patch } as T;
}

/**
 * Build an empty (or pre-filled from `rule`) RuleDraft, using the surrounding
 * project / ruleSet to seed reasonable defaults like host and ruleSetId.
 */
export function createRuleDraft(options?: {
  project?: Project;
  ruleSet?: RuleSet;
  kind?: Rule["kind"];
  rule?: Rule;
}): RuleDraft {
  const kind = options?.rule?.kind ?? options?.kind ?? "api_forward";
  return {
    id: options?.rule?.id ?? "",
    ruleSetId: options?.ruleSet?.id ?? "",
    name: options?.rule?.name ?? "",
    kind,
    enabled: options?.rule?.enabled ?? true,
    priority: options?.rule?.priority ?? 100,
    host: joinCsv(options?.rule?.match.host ?? options?.project?.siteHosts),
    pathGlob: options?.rule?.match.pathGlob ?? (kind === "api_forward" ? "/api/**" : "/assets/**"),
    resourceType: joinCsv(
      options?.rule?.match.resourceType ?? (kind === "api_forward" ? defaultApiTypes : defaultAssetTypes),
    ),
    method: joinCsv(options?.rule?.match.method ?? (kind === "api_forward" ? ["GET", "POST"] : undefined)),
    redirectUrl: options?.rule?.target.redirectUrl ?? "",
    targetBaseUrl: options?.rule?.target.forwardProfile?.targetBaseUrl ?? "",
    stripPrefix: options?.rule?.target.forwardProfile?.stripPrefix ?? "",
    headersJson: JSON.stringify(options?.rule?.target.forwardProfile?.headers ?? {}, null, 2),
    tags: joinCsv(options?.rule?.tags),
    note: options?.rule?.note ?? "",
  };
}

/**
 * Same as createRuleDraft but for the batch editor — gets a stable per-row
 * `localId`, and inherits "shape" fields (host/method/etc.) from the previous
 * row in the batch so adjacent rules differ only in their meaningful parts.
 */
export function createBatchRuleDraft(options?: {
  project?: Project;
  ruleSet?: RuleSet;
  kind?: Rule["kind"];
  source?: RuleDraft | BatchRuleDraft;
}): BatchRuleDraft {
  const base = createRuleDraft({
    project: options?.project,
    ruleSet: options?.ruleSet,
    kind: options?.source?.kind ?? options?.kind,
  });
  const source = options?.source;
  return {
    localId: createId("draft"),
    ...base,
    kind: source?.kind ?? base.kind,
    enabled: source?.enabled ?? base.enabled,
    priority: source?.priority ?? base.priority,
    host: source?.host ?? base.host,
    resourceType: source?.resourceType ?? base.resourceType,
    method: source?.method ?? base.method,
    redirectUrl: source?.kind === "asset_redirect" ? source.redirectUrl : base.redirectUrl,
    targetBaseUrl: source?.kind === "api_forward" ? source.targetBaseUrl : base.targetBaseUrl,
    stripPrefix: source?.kind === "api_forward" ? source.stripPrefix : base.stripPrefix,
    headersJson: source?.kind === "api_forward" ? source.headersJson : base.headersJson,
    tags: source?.tags ?? base.tags,
  };
}

/** Hydrate the Project edit modal from a persisted Project record. */
export function fromProject(project: Project): ProjectDraft {
  return {
    id: project.id,
    name: project.name,
    siteMatchPatterns: joinCsv(project.siteMatchPatterns ?? project.siteHosts.map((h) => `https://${h}/*`)),
    baseUrl: project.baseUrl ?? "",
    envLabel: project.envLabel ?? "",
    note: project.note ?? "",
    enabled: project.enabled,
  };
}

/**
 * Convert an editor draft back into a canonical Rule. Throws when the draft
 * is in an inconsistent state (e.g. no ruleSetId) so the caller can show a
 * targeted error instead of silently saving garbage.
 */
export function toRule(draft: RuleDraft, workspace: WorkspaceSnapshot, project: Project): Rule {
  if (!draft.ruleSetId) {
    throw new Error("当前站点还没有分组，请先保存站点后再添加规则。");
  }
  const existing = workspace.rules.find((r) => r.id === draft.id);
  const now = new Date().toISOString();
  const host = splitCsv(draft.host).map(normalizeHostInput);
  const resourceType = splitCsv(draft.resourceType) as MatchResourceType[];
  const method = splitCsv(draft.method);
  const headers =
    draft.kind === "api_forward" && draft.headersJson.trim()
      ? (JSON.parse(draft.headersJson) as Record<string, string>)
      : {};

  return {
    id: draft.id || createId("rule"),
    name: draft.name.trim() || (draft.kind === "api_forward" ? "新的 API 转发" : "新的资源替换"),
    enabled: draft.enabled,
    kind: draft.kind,
    priority: Number.isFinite(draft.priority) ? draft.priority : 100,
    match: {
      host: host.length > 0 ? host : project.siteHosts,
      pathGlob: sanitizePathGlob(draft.pathGlob || "**"),
      resourceType:
        resourceType.length > 0
          ? resourceType
          : draft.kind === "api_forward"
            ? defaultApiTypes
            : defaultAssetTypes,
      method: draft.kind === "api_forward" ? (method.length > 0 ? method : ["GET", "POST"]) : undefined,
      tabScope: { mode: "all" as const },
    },
    target:
      draft.kind === "asset_redirect"
        ? { redirectUrl: draft.redirectUrl.trim() }
        : {
            forwardProfile: {
              targetBaseUrl: draft.targetBaseUrl.trim(),
              stripPrefix: draft.stripPrefix.trim() || undefined,
              headers,
            },
          },
    note: draft.note.trim() || undefined,
    tags: splitCsv(draft.tags),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function defaultResourceTypeText(kind: Rule["kind"]): string {
  return joinCsv(kind === "api_forward" ? defaultApiTypes : defaultAssetTypes);
}

function defaultMethodText(kind: Rule["kind"]): string {
  return kind === "api_forward" ? "GET, POST" : "";
}

/** Filter the global preset list down to those applicable for the given kind. */
export function getRuleTemplatePresets(kind: Rule["kind"]): RuleTemplatePreset[] {
  return ruleTemplatePresets.filter((t) => t.kind === kind);
}

/**
 * Curated quick-fill templates surfaced in the rule editor. Keep this list
 * short — every entry costs the user a moment of scanning.
 */
const ruleTemplatePresets: RuleTemplatePreset[] = [
  {
    id: "api-local",
    kind: "api_forward",
    label: "本地 API 联调",
    description: "把 /api 请求转给本地服务",
    patch: {
      kind: "api_forward",
      name: "本地 API 转发",
      pathGlob: "/api/**",
      targetBaseUrl: "http://127.0.0.1:3000",
      stripPrefix: "",
      headersJson: "{}",
      resourceType: defaultResourceTypeText("api_forward"),
      method: defaultMethodText("api_forward"),
    },
  },
  {
    id: "api-bff",
    kind: "api_forward",
    label: "BFF / 网关转发",
    description: "替换目标网关地址，适合切 staging",
    patch: {
      kind: "api_forward",
      name: "网关 API 转发",
      pathGlob: "/gateway/**",
      targetBaseUrl: "https://staging.example.com",
      stripPrefix: "",
      headersJson: "{}",
      resourceType: defaultResourceTypeText("api_forward"),
      method: defaultMethodText("api_forward"),
    },
  },
  {
    id: "asset-bundle",
    kind: "asset_redirect",
    label: "静态资源替换",
    description: "替换脚本、样式或图片到 CDN",
    patch: {
      kind: "asset_redirect",
      name: "静态资源替换",
      pathGlob: "/assets/**",
      redirectUrl: "https://cdn.example.com/assets/app.js",
      resourceType: defaultResourceTypeText("asset_redirect"),
      method: defaultMethodText("asset_redirect"),
    },
  },
  {
    id: "asset-single-file",
    kind: "asset_redirect",
    label: "单文件覆盖",
    description: "替换一条精确文件路径",
    patch: {
      kind: "asset_redirect",
      name: "单文件资源替换",
      pathGlob: "/static/app.js",
      redirectUrl: "https://cdn.example.com/static/app.js",
      resourceType: "script",
      method: defaultMethodText("asset_redirect"),
    },
  },
];
