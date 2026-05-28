import type { MatchResourceType, Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { stablePositiveHash } from "./glob.js";
import { createEmptyWorkspace, normalizeImportedHost } from "./workspace.js";

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
      name: `${buildImportedProjectName(siteHosts[0] ?? domainLabel)} 默认分组`,
      enabled: true,
      ruleIds,
      note: "Imported from Resource Override",
      createdAt: now,
      updatedAt: now,
    });

    report.importedProjectCount += 1;
  });

  return { workspace, report };
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
    return { rule: null, reason: `仅支持 normalOverride，当前为 ${rule.type ?? "unknown"}` };
  }

  const pathGlob = extractResourceOverridePathGlob(rule.match ?? "");
  const replacement = sanitizeResourceOverrideUrl(rule.replace?.trim() ?? "");
  if (!pathGlob || !replacement) {
    return { rule: null, reason: !pathGlob ? "无法解析 match 路径" : "缺少 replace 目标" };
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
    return { rule: null, reason: "replace 目标仅支持 http/https URL" };
  }

  let target: URL;
  try {
    target = new URL(replacement);
  } catch {
    return { rule: null, reason: `replace 不是合法 URL: ${replacement}` };
  }

  // HTTPS target without wildcards → simple asset_redirect (DNR redirect)
  if (replacement.startsWith("https://") && !replacement.includes("*")) {
    return {
      rule: {
        ...baseRule,
        name: `RO 资源替换 ${pathGlob}`,
        kind: "asset_redirect",
        match: { ...baseRule.match, resourceType: inferResourceTypesFromPath(pathGlob) },
        target: { redirectUrl: replacement },
      },
    };
  }

  // localhost / 127.0.0.1 target with a specific file path (no wildcard, not root) →
  // asset_redirect. Chrome DNR allows redirecting to http://localhost and http://127.0.0.1.
  const isLocalhost = target.hostname === "localhost" || target.hostname === "127.0.0.1";
  const hasWildcardInReplace = target.pathname.includes("*");
  const isRootPath = target.pathname === "/" || target.pathname === "";

  if (isLocalhost && !hasWildcardInReplace && !isRootPath) {
    return {
      rule: {
        ...baseRule,
        name: `RO 资源替换 ${pathGlob}`,
        kind: "asset_redirect",
        match: { ...baseRule.match, resourceType: inferResourceTypesFromPath(pathGlob) },
        target: { redirectUrl: replacement.trim() },
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
        match: { ...baseRule.match, resourceType: inferResourceTypesFromPath(pathGlob) },
        target: { redirectUrl: replacement.trim() },
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
        target: { forwardProfile: { targetBaseUrl: target.origin } },
      },
    };
  }

  return { rule: null, reason: "资源替换目标须为 HTTPS 地址，或本地 localhost / 127.0.0.1 地址" };
}

function resolveResourceOverrideDomainScope(domain: ResourceOverrideDomain): string {
  return domain.matchUrl?.trim() || domain.name?.trim() || "";
}

function collectResourceOverrideHosts(domain: ResourceOverrideDomain): string[] {
  const explicitHosts = extractResourceOverrideHosts(resolveResourceOverrideDomainScope(domain));
  if (explicitHosts.length > 0) return explicitHosts;

  const inferredHosts = (domain.rules ?? [])
    .map((rule) => extractResourceOverrideRuleHost(rule))
    .filter((host): host is string => Boolean(host));

  return Array.from(new Set(inferredHosts));
}

function extractResourceOverrideRuleHost(rule: ResourceOverrideRule): string | null {
  const matchValue = "match" in rule ? sanitizeResourceOverrideUrl(rule.match?.trim() ?? "") : "";
  if (!matchValue) return null;

  const explicitUrlMatch = matchValue.match(/^(?:\*|https?):\/\/([^/]+)/i);
  if (!explicitUrlMatch?.[1]) return null;

  return normalizeImportedHost(explicitUrlMatch[1]);
}

function extractResourceOverrideHosts(matchUrl: string): string[] {
  const trimmed = matchUrl.trim();
  if (!trimmed) return [];

  if (trimmed === "*" || trimmed === "<all_urls>") return ["*"];

  const explicitUrlMatch = trimmed.match(/^(?:\*|https?|file):\/\/([^/]+)/i);
  if (explicitUrlMatch?.[1]) return [normalizeImportedHost(explicitUrlMatch[1])];

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

function extractResourceOverridePathGlob(match: string): string | null {
  const trimmed = sanitizeResourceOverrideUrl(match.trim());
  if (!trimmed) return null;

  let pathPart = trimmed;
  const explicitUrlMatch = trimmed.match(/^(?:\*|https?):\/\/[^/]+(\/.*)$/i);
  if (explicitUrlMatch?.[1]) pathPart = explicitUrlMatch[1];

  if (!pathPart.startsWith("/")) return null;

  const sanitized = pathPart.split("?")[0]?.split("#")[0] ?? pathPart;
  if (sanitized === "/*" || sanitized === "/") return "/**";

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
  if (stripped.endsWith(".css") || normalized.endsWith(".css")) return ["stylesheet"];
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico)$/.test(stripped) || /\.(png|jpe?g|gif|svg|webp|avif|ico)$/.test(normalized)) {
    return ["image"];
  }
  if (/\.(woff2?|ttf|otf|eot)$/.test(stripped) || /\.(woff2?|ttf|otf|eot)$/.test(normalized)) {
    return ["font"];
  }
  // Check if the directory name hints at a resource type (e.g. /images/**)
  const dirSegment = stripped.replace(/\/+$/, "").split("/").pop() ?? "";
  if (/^images?$/i.test(dirSegment) || /^icons?$/i.test(dirSegment) || /^img$/i.test(dirSegment)) return ["image"];
  if (/^fonts?$/i.test(dirSegment)) return ["font"];
  if (/^styles?$/i.test(dirSegment) || /^css$/i.test(dirSegment)) return ["stylesheet"];
  if (/^scripts?$/i.test(dirSegment) || /^js$/i.test(dirSegment)) return ["script"];

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

  if (matchDir === replaceDir) return "";

  // If match has a longer directory that starts with replace's directory,
  // the extra segment is what needs to be stripped.
  if (matchDir.startsWith(replaceDir)) {
    // e.g. matchDir="/sheet", replaceDir="" → strip "/sheet"
    return matchDir;
  }

  // Fallback: strip the entire match directory
  return matchDir;
}
