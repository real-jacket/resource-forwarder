import {
  getEnabledRuleBindings,
  matchesProjectSite,
  matchesRuleSetSite,
  matchesTabScope,
  resolveForwardProfile,
  resolveRuleTargetValue,
} from "@resource-forwarder/rule-core";
import { buildForwardTargetUrl } from "@resource-forwarder/forward-core";
import type { Project, Rule, RuleSet, WorkspaceSnapshot } from "@resource-forwarder/shared-types";

export function collectExecutableRuleIds(
  workspace: WorkspaceSnapshot,
  currentUrl: string,
  tabId?: number,
): Set<string> {
  return new Set(
    getEnabledRuleBindings(workspace)
      .filter(({ project, ruleSet, rule }) =>
        Boolean(
          project &&
          ruleSet &&
          matchesProjectSite(project, currentUrl) &&
          matchesRuleSetSite(ruleSet, project, currentUrl) &&
          matchesTabScope(rule.match, tabId),
        ),
      )
      .map(({ rule }) => rule.id),
  );
}

export function describeRuleRoutes(
  rule: Rule,
  project: Project,
  ruleSet: RuleSet,
  currentUrl: string,
): Array<{ source: string; target: string }> {
  const protocol = safeProtocol(currentUrl);
  const currentHost = safeHost(currentUrl);
  const hosts = rule.match.host.length > 0 && !rule.match.host.includes("*")
    ? rule.match.host
    : [currentHost || "*"];
  const path = rule.match.pathGlob.startsWith("/") ? rule.match.pathGlob : `/${rule.match.pathGlob}`;
  const binding = { project, ruleSet, rule };

  return hosts.map((host) => {
    const source = `${host === "*" ? "https?" : protocol}//${host}${path}`;
    if (rule.kind === "asset_redirect") {
      return {
        source,
        target: resolveRuleTargetValue(rule.target.redirectUrl, binding) ?? "目标地址无效",
      };
    }

    const profile = resolveForwardProfile(binding);
    if (!profile) return { source, target: "目标地址无效" };
    const sourceUrl = new URL(`${protocol}//${host.includes("*") ? "placeholder.invalid" : host}${path}`);
    return { source, target: buildForwardTargetUrl(profile, sourceUrl).toString() };
  });
}

function safeProtocol(value: string): "http:" | "https:" {
  try {
    return new URL(value).protocol === "http:" ? "http:" : "https:";
  } catch {
    return "https:";
  }
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
