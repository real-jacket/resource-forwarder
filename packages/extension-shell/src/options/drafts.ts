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

const legacyDefaultAssetTypes: MatchResourceType[] = ["script", "stylesheet", "image", "font"];

function isWasmPathGlob(pathGlob: string | undefined): boolean {
  return (pathGlob ?? "").toLowerCase().includes(".wasm");
}

function normalizeAssetResourceTypes(
  resourceTypes: MatchResourceType[] | undefined,
  pathGlob?: string,
): MatchResourceType[] | undefined {
  if (!resourceTypes || resourceTypes.length === 0) {
    return resourceTypes;
  }

  const sameLength = resourceTypes.length === legacyDefaultAssetTypes.length;
  const hasLegacyDefaults = sameLength && legacyDefaultAssetTypes.every((type) => resourceTypes.includes(type));
  const normalized = hasLegacyDefaults ? defaultAssetTypes : resourceTypes;

  if (!isWasmPathGlob(pathGlob)) {
    return normalized;
  }

  const merged = [...normalized];
  if (!merged.includes("xmlhttprequest")) merged.push("xmlhttprequest");
  if (!merged.includes("other")) merged.push("other");
  return merged;
}

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
    pathRewriteJson: kind === "api_forward" ? (patch.pathRewriteJson ?? draft.pathRewriteJson ?? "[]") : "",
    queryRemove: kind === "api_forward" ? (patch.queryRemove ?? draft.queryRemove ?? "") : "",
    querySetJson: kind === "api_forward" ? (patch.querySetJson ?? draft.querySetJson ?? "{}") : "",
    queryAppendJson: kind === "api_forward" ? (patch.queryAppendJson ?? draft.queryAppendJson ?? "{}") : "",
    headersJson: kind === "api_forward" ? (patch.headersJson ?? draft.headersJson ?? "{}") : "",
    headerStrip: kind === "api_forward" ? (patch.headerStrip ?? draft.headerStrip ?? "") : "",
    headerPassthrough: kind === "api_forward" ? (patch.headerPassthrough ?? draft.headerPassthrough ?? "") : "",
    responseMode: kind === "api_forward" ? (patch.responseMode ?? draft.responseMode ?? "forward") : "forward",
    responseStatus: kind === "api_forward" ? (patch.responseStatus ?? draft.responseStatus ?? "") : "",
    responseStatusText: kind === "api_forward" ? (patch.responseStatusText ?? draft.responseStatusText ?? "") : "",
    responseDelayMs: kind === "api_forward" ? (patch.responseDelayMs ?? draft.responseDelayMs ?? 0) : 0,
    responseJsonPatch: kind === "api_forward" ? (patch.responseJsonPatch ?? draft.responseJsonPatch ?? "") : "",
    responseMockJson: kind === "api_forward" ? (patch.responseMockJson ?? draft.responseMockJson ?? "{}") : "{}",
    responseMockFilePath: kind === "api_forward" ? (patch.responseMockFilePath ?? draft.responseMockFilePath ?? "") : "",
    responseHeadersJson: kind === "api_forward" ? (patch.responseHeadersJson ?? draft.responseHeadersJson ?? "{}") : "",
    responseHeaderStrip: kind === "api_forward" ? (patch.responseHeaderStrip ?? draft.responseHeaderStrip ?? "") : "",
    timeoutMs: kind === "api_forward" ? (patch.timeoutMs ?? draft.timeoutMs ?? 15000) : 15000,
    fallbackMode: kind === "api_forward" ? (patch.fallbackMode ?? draft.fallbackMode ?? "native") : "native",
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
  const forwardProfile = options?.rule?.target.forwardProfile;
  const responsePolicy = forwardProfile?.responsePolicy;
  return {
    id: options?.rule?.id ?? "",
    ruleSetId: options?.ruleSet?.id ?? "",
    name: options?.rule?.name ?? "",
    kind,
    enabled: options?.rule?.enabled ?? true,
    priority: options?.rule?.priority ?? 100,
    hostMode: options?.rule ? (options.rule.match.inheritHost ? "inherit" : "custom") : "inherit",
    host: options?.rule?.match.inheritHost ? "" : joinCsv(options?.rule?.match.host),
    pathGlob: options?.rule?.match.pathGlob ?? (kind === "api_forward" ? "/api/**" : "/assets/**"),
    queryMatchJson: JSON.stringify(options?.rule?.match.query ?? {}, null, 2),
    headerMatchJson: JSON.stringify(options?.rule?.match.headers ?? {}, null, 2),
    resourceType: joinCsv(
      kind === "asset_redirect"
        ? normalizeAssetResourceTypes(options?.rule?.match.resourceType, options?.rule?.match.pathGlob) ?? defaultAssetTypes
        : options?.rule?.match.resourceType ?? defaultApiTypes,
    ),
    method: joinCsv(options?.rule?.match.method ?? (kind === "api_forward" ? ["GET", "POST"] : undefined)),
    redirectUrl: options?.rule?.target.redirectUrl ?? "",
    targetBaseUrl: forwardProfile?.targetBaseUrl ?? "",
    stripPrefix: forwardProfile?.stripPrefix ?? "",
    pathRewriteJson: JSON.stringify(forwardProfile?.pathRewrite ?? [], null, 2),
    queryRemove: joinCsv(forwardProfile?.queryPolicy?.remove),
    querySetJson: JSON.stringify(forwardProfile?.queryPolicy?.set ?? {}, null, 2),
    queryAppendJson: JSON.stringify(forwardProfile?.queryPolicy?.append ?? {}, null, 2),
    headersJson: JSON.stringify(forwardProfile?.headers ?? {}, null, 2),
    headerStrip: joinCsv(forwardProfile?.headerPolicy?.strip),
    headerPassthrough: joinCsv(forwardProfile?.headerPolicy?.passthrough),
    responseMode: responsePolicy?.mode ?? "forward",
    responseStatus: responsePolicy?.status?.toString() ?? "",
    responseStatusText: responsePolicy?.statusText ?? "",
    responseDelayMs: responsePolicy?.delayMs ?? 0,
    responseJsonPatch:
      responsePolicy?.jsonMergePatch === undefined
        ? ""
        : JSON.stringify(responsePolicy.jsonMergePatch, null, 2),
    responseMockJson: JSON.stringify(responsePolicy?.mockJson ?? {}, null, 2),
    responseMockFilePath: responsePolicy?.mockFilePath ?? "",
    responseHeadersJson: JSON.stringify(forwardProfile?.responseHeaderPolicy?.set ?? {}, null, 2),
    responseHeaderStrip: joinCsv(forwardProfile?.responseHeaderPolicy?.strip),
    executionMode: forwardProfile?.executionMode ?? "auto",
    timeoutMs: forwardProfile?.timeoutMs ?? 15000,
    fallbackMode: forwardProfile?.fallbackMode ?? "native",
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
    hostMode: source?.hostMode ?? base.hostMode,
    host: source?.host ?? base.host,
    resourceType: source?.resourceType ?? base.resourceType,
    method: source?.method ?? base.method,
    redirectUrl: source?.kind === "asset_redirect" ? source.redirectUrl : base.redirectUrl,
    targetBaseUrl: source?.kind === "api_forward" ? source.targetBaseUrl : base.targetBaseUrl,
    stripPrefix: source?.kind === "api_forward" ? source.stripPrefix : base.stripPrefix,
    pathRewriteJson: source?.kind === "api_forward" ? source.pathRewriteJson : base.pathRewriteJson,
    queryRemove: source?.kind === "api_forward" ? source.queryRemove : base.queryRemove,
    querySetJson: source?.kind === "api_forward" ? source.querySetJson : base.querySetJson,
    queryAppendJson: source?.kind === "api_forward" ? source.queryAppendJson : base.queryAppendJson,
    headersJson: source?.kind === "api_forward" ? source.headersJson : base.headersJson,
    headerStrip: source?.kind === "api_forward" ? source.headerStrip : base.headerStrip,
    headerPassthrough: source?.kind === "api_forward" ? source.headerPassthrough : base.headerPassthrough,
    responseMode: source?.kind === "api_forward" ? source.responseMode : base.responseMode,
    responseStatus: source?.kind === "api_forward" ? source.responseStatus : base.responseStatus,
    responseStatusText: source?.kind === "api_forward" ? source.responseStatusText : base.responseStatusText,
    responseDelayMs: source?.kind === "api_forward" ? source.responseDelayMs : base.responseDelayMs,
    responseJsonPatch: source?.kind === "api_forward" ? source.responseJsonPatch : base.responseJsonPatch,
    responseMockJson: source?.kind === "api_forward" ? source.responseMockJson : base.responseMockJson,
    responseMockFilePath: source?.kind === "api_forward" ? source.responseMockFilePath : base.responseMockFilePath,
    responseHeadersJson: source?.kind === "api_forward" ? source.responseHeadersJson : base.responseHeadersJson,
    responseHeaderStrip: source?.kind === "api_forward" ? source.responseHeaderStrip : base.responseHeaderStrip,
    timeoutMs: source?.kind === "api_forward" ? source.timeoutMs : base.timeoutMs,
    fallbackMode: source?.kind === "api_forward" ? source.fallbackMode : base.fallbackMode,
    tags: source?.tags ?? base.tags,
  };
}

/** Hydrate the Project edit modal from a persisted Project record. */
export function fromProject(project: Project): ProjectDraft {
  return {
    id: project.id,
    name: project.name,
    siteMatchPatterns: joinCsv(project.siteMatchPatterns ?? project.siteHosts.map((h) => `https://${h}/*`)),
    defaultRequestHosts: joinCsv(project.defaultRequestHosts),
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
  if (draft.hostMode === "custom" && host.length === 0) {
    throw new Error("自定义请求 Host 不能为空；如需匹配所有 Host，请填写 *。");
  }
  const resourceType = splitCsv(draft.resourceType) as MatchResourceType[];
  const normalizedAssetResourceType =
    draft.kind === "asset_redirect"
      ? (normalizeAssetResourceTypes(resourceType, draft.pathGlob) ?? resourceType)
      : resourceType;
  const method = splitCsv(draft.method);
  const queryMatch = draft.kind === "api_forward" ? parseStringRecord(draft.queryMatchJson, "查询参数匹配") : {};
  const headerMatch = draft.kind === "api_forward" ? parseStringRecord(draft.headerMatchJson, "请求 Header 匹配") : {};
  const headers =
    draft.kind === "api_forward" && draft.headersJson.trim()
      ? parseStringRecord(draft.headersJson, "注入 Header")
      : {};
  const pathRewrite = draft.kind === "api_forward" ? parsePathRewrite(draft.pathRewriteJson) : [];
  const querySet = draft.kind === "api_forward" ? parseStringRecord(draft.querySetJson, "Query 覆盖") : {};
  const queryAppend = draft.kind === "api_forward" ? parseStringArrayRecord(draft.queryAppendJson, "Query 追加") : {};
  const responseStatus = draft.kind === "api_forward" ? parseOptionalStatus(draft.responseStatus) : undefined;
  const responseDelayMs = draft.kind === "api_forward" ? parseResponseDelay(draft.responseDelayMs) : 0;
  const responseJsonPatch =
    draft.kind === "api_forward" ? parseOptionalJsonValue(draft.responseJsonPatch, "响应 JSON 合并覆盖") : undefined;
  const responseMockJson =
    draft.kind === "api_forward" && draft.responseMode === "mock_json"
      ? parseJsonValue(draft.responseMockJson, "Mock JSON")
      : undefined;
  const responseHeaders = draft.kind === "api_forward" ? parseStringRecord(draft.responseHeadersJson, "响应 Header") : {};
  const hasResponsePolicy =
    draft.kind === "api_forward" &&
    (draft.responseMode !== "forward" ||
      responseStatus !== undefined ||
      Boolean(draft.responseStatusText.trim()) ||
      responseDelayMs > 0 ||
      responseJsonPatch !== undefined);

  if (draft.kind === "api_forward" && draft.responseMode === "forward" && !draft.targetBaseUrl.trim()) {
    throw new Error("转发真实响应时必须填写目标地址。");
  }
  if (draft.kind === "api_forward" && draft.responseMode === "mock_file" && !draft.responseMockFilePath.trim()) {
    throw new Error("使用本地 JSON 文件时必须填写文件路径。");
  }

  return {
    id: draft.id || createId("rule"),
    name: draft.name.trim() || (draft.kind === "api_forward" ? "新的 API 转发" : "新的资源替换"),
    enabled: draft.enabled,
    kind: draft.kind,
    priority: Number.isFinite(draft.priority) ? draft.priority : 100,
    match: {
      host: draft.hostMode === "inherit" ? [] : host,
      ...(draft.hostMode === "inherit" ? { inheritHost: true } : {}),
      pathGlob: sanitizePathGlob(draft.pathGlob || "**"),
      query: Object.keys(queryMatch).length > 0 ? queryMatch : undefined,
      headers: Object.keys(headerMatch).length > 0 ? headerMatch : undefined,
      resourceType:
        normalizedAssetResourceType.length > 0
          ? normalizedAssetResourceType
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
              ...(draft.executionMode === "auto" ? {} : { executionMode: draft.executionMode }),
              targetBaseUrl: draft.targetBaseUrl.trim(),
              stripPrefix: draft.stripPrefix.trim() || undefined,
              pathRewrite: pathRewrite.length > 0 ? pathRewrite : undefined,
              queryPolicy: {
                remove: splitCsv(draft.queryRemove),
                set: querySet,
                append: queryAppend,
              },
              headers,
              headerPolicy: {
                strip: splitCsv(draft.headerStrip),
                passthrough: splitCsv(draft.headerPassthrough),
              },
              ...(hasResponsePolicy
                ? { responsePolicy: {
                    mode: draft.responseMode,
                    status: responseStatus,
                    statusText: draft.responseStatusText.trim() || undefined,
                    delayMs: responseDelayMs || undefined,
                    jsonMergePatch: responseJsonPatch,
                    mockJson: responseMockJson,
                    mockFilePath:
                      draft.responseMode === "mock_file"
                        ? draft.responseMockFilePath.trim()
                        : undefined,
                  } }
                : {}),
              responseHeaderPolicy: {
                strip: splitCsv(draft.responseHeaderStrip),
                set: responseHeaders,
              },
              timeoutMs: Number.isFinite(draft.timeoutMs) && draft.timeoutMs > 0 ? draft.timeoutMs : 15000,
              fallbackMode: draft.fallbackMode,
            },
          },
    note: draft.note.trim() || undefined,
    tags: splitCsv(draft.tags),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function parseStringRecord(value: string, label: string): Record<string, string> {
  const parsed = parseJson(value, label);
  if (!isPlainRecord(parsed) || Object.values(parsed).some((item) => typeof item !== "string")) {
    throw new Error(`${label}必须是字符串键值 JSON 对象。`);
  }
  return parsed as Record<string, string>;
}

function parseStringArrayRecord(value: string, label: string): Record<string, string[]> {
  const parsed = parseJson(value, label);
  if (
    !isPlainRecord(parsed) ||
    Object.values(parsed).some(
      (item) => !Array.isArray(item) || item.some((entry) => typeof entry !== "string"),
    )
  ) {
    throw new Error(`${label}必须是字符串数组键值 JSON 对象。`);
  }
  return parsed as Record<string, string[]>;
}

function parsePathRewrite(value: string): Array<{ from: string; to: string }> {
  const parsed = parseJson(value, "路径改写");
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (item) => !isPlainRecord(item) || typeof item.from !== "string" || typeof item.to !== "string",
    )
  ) {
    throw new Error('路径改写必须是 [{"from":"/api","to":"/v1"}] 格式。');
  }
  return parsed as Array<{ from: string; to: string }>;
}

function parseOptionalStatus(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const status = Number(trimmed);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error("响应状态码必须是 100 到 599 之间的整数。");
  }
  return status;
}

function parseResponseDelay(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 30000) {
    throw new Error("响应延迟必须在 0 到 30000 毫秒之间。");
  }
  return Math.round(value);
}

function parseOptionalJsonValue(value: string, label: string): unknown | undefined {
  if (!value.trim()) return undefined;
  return parseJsonValue(value, label);
}

function parseJsonValue(value: string, label: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch {
    throw new Error(`${label}不是合法 JSON。`);
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value.trim() || (label === "路径改写" ? "[]" : "{}"));
  } catch {
    throw new Error(`${label}不是合法 JSON。`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    description: "把 /api 请求转到本机或其他环境",
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
