import type { Rule } from "@resource-forwarder/shared-types";
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
    joinCsv(rule.match.resourceType),
    joinCsv(rule.match.method),
    formatRuleTarget(rule),
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
  return rule.target.forwardProfile?.targetBaseUrl || "未填写目标地址";
}

/**
 * `formatTimestamp("2025-01-02T03:04:05Z")` → `"2025-01-02 03:04"`.
 * `short=true` drops the year for the rules-table column where horizontal
 * space is at a premium.
 */
export function formatTimestamp(value?: string, short = false): string {
  if (!value) return "—";
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
  if (value.includes("missing a forward profile")) {
    return "API 转发规则缺少目标转发配置。";
  }
  if (value.includes("mixes a wildcard site pattern")) {
    const match = value.match(/Project "([^"]+)"/);
    const name = match?.[1];
    return name
      ? `站点「${name}」的匹配模式同时包含通配符和具体模式——通配符会让具体模式失效。`
      : "站点的匹配模式同时包含通配符和具体模式——通配符会让具体模式失效。";
  }
  return value;
}
