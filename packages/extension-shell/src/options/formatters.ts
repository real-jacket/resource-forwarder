import type { Project, Rule, RuleSet } from "@resource-forwarder/shared-types";
import { joinCsv } from "../shared/helpers.js";

/**
 * Pure presentation helpers shared by the rules table and inspectors.
 * No React, no DOM — safe to call from anywhere and easy to unit-test.
 */

/**
 * Build a single lowercased haystack from the searchable parts of a rule so
 * the toolbar's text filter can do a simple `String.includes` instead of
 * walking the rule's nested fields per keystroke.
 */
export function buildRuleSearchText(rule: Rule): string {
  return [
    rule.name,
    rule.kind,
    joinCsv(rule.match.host),
    rule.match.pathGlob,
    JSON.stringify(rule.match.query ?? {}),
    JSON.stringify(rule.match.headers ?? {}),
    joinCsv(rule.match.resourceType),
    joinCsv(rule.match.method),
    formatRuleTarget(rule),
    JSON.stringify(rule.target.forwardProfile?.pathRewrite ?? []),
    JSON.stringify(rule.target.forwardProfile?.queryPolicy ?? {}),
    JSON.stringify(rule.target.forwardProfile?.responsePolicy ?? {}),
    rule.note ?? "",
    joinCsv(rule.tags),
  ]
    .join(" ")
    .toLowerCase();
}

/** Human-readable target column for the rules list. */
export function formatRuleTarget(rule: Rule): string {
  if (rule.kind === "asset_redirect") {
    return rule.target.redirectUrl || "未填写 HTTPS 地址";
  }
  const responseMode = rule.target.forwardProfile?.responsePolicy?.mode ?? "forward";
  if (responseMode === "mock_json") return "Mock：内联 JSON";
  if (responseMode === "mock_file") {
    const path = rule.target.forwardProfile?.responsePolicy?.mockFilePath ?? "";
    const name = path.split(/[\\/]/).pop();
    return `Mock 文件：${name || "未填写"}`;
  }
  return rule.target.forwardProfile?.targetBaseUrl || "未填写目标地址";
}

export function formatProjectScopeSummary(project: Project): string {
  const scope = joinCsv(project.siteMatchPatterns ?? project.siteHosts) || "未填写站点匹配";
  const requestHosts = joinCsv(project.defaultRequestHosts ?? project.siteHosts) || "所有 Host";
  return [
    `页面 ${scope}`,
    `请求 Host ${requestHosts}`,
    project.baseUrl ? `基础路径 ${project.baseUrl}` : "",
  ].filter(Boolean).join(" · ");
}

export function formatRuleSetScopeSummary(ruleSet: RuleSet): string {
  const scope = joinCsv(ruleSet.siteMatchPatterns ?? []);
  const requestHosts = joinCsv(ruleSet.defaultRequestHosts);
  return [
    scope ? `页面 ${scope}` : "页面继承站点",
    requestHosts ? `请求 Host ${requestHosts}` : "请求 Host 继承站点",
    ruleSet.baseUrl ? `基础路径 ${ruleSet.baseUrl}` : "",
  ].filter(Boolean).join(" · ");
}

/**
 * `formatTimestamp("2025-01-02T03:04:05Z")` → `"2025-01-02 03:04"`.
 * `short=true` drops the year for the rules-table column where horizontal
 * space is at a premium.
 */
export function formatTimestamp(value?: string, short = false): string {
  if (!value) return "-";
  const d = new Date(value);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  if (short) return `${mm}-${dd} ${hh}:${mi}`;
  return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

/**
 * Translate the English warning sentinels emitted by `rule-core` into the
 * Chinese copy shown in the editor. Falls through to the original string
 * when no translation is registered so unknown warnings stay visible.
 */
export function localizeWarning(value: string): string {
  if (value.includes("must point to an HTTPS target")) {
    return "资源替换规则目前只支持跳到浏览器可直接访问的 HTTPS 地址。";
  }
  if (value.includes("cannot match query parameters or request headers")) {
    return "资源替换由 Chrome DNR 执行，不能按 Query 参数或请求 Header 匹配；请改用 API 转发。";
  }
  if (value.includes("needs a target URL")) {
    return "真实转发模式必须填写目标地址。";
  }
  if (value.includes("needs a local JSON file path")) {
    return "本地 JSON 文件模式必须填写文件路径。";
  }
  if (value.includes("invalid response status")) {
    return "响应状态码必须是 100 到 599 之间的整数。";
  }
  if (value.includes("is not assigned to a rule set")) {
    return "存在未归入分组的规则。为避免越过站点范围，该规则不会参与匹配。";
  }
  if (value.includes("is assigned to multiple rule sets")) {
    return "同一规则被多个分组引用，归属不明确，因此不会参与匹配。";
  }
  if (value.includes("references a missing project")) {
    return "存在找不到所属站点的分组，该分组下规则不会参与匹配。";
  }
  if (value.includes("references missing rule")) {
    return "存在引用已删除规则的分组，请清理无效引用。";
  }
  if (value.includes("missing a forward profile")) {
    return "API 转发规则缺少目标转发配置。";
  }
  if (value.includes("mixes a wildcard site pattern")) {
    const match = value.match(/Project "([^"]+)"/);
    const name = match?.[1];
    return name
      ? `站点「${name}」的匹配模式同时包含通配符和具体模式。通配符会让具体模式失效。`
      : "站点的匹配模式同时包含通配符和具体模式。通配符会让具体模式失效。";
  }
  return value;
}
