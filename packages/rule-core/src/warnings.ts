import type { Project, Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";

export interface RuleConflict {
  ruleId: string;
  reason: string;
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

export function collectProjectWarnings(project: Project): string[] {
  const warnings: string[] = [];
  const patterns = project.siteMatchPatterns ?? [];

  // A wildcard pattern in a list of specific patterns silently subsumes the
  // others — every page matches the wildcard, so the precise patterns become
  // dead config. Surface this so the user notices the contradiction.
  if (patterns.length > 1) {
    const hasWildcard = patterns.some((pattern) => {
      const trimmed = pattern.trim();
      return !trimmed || trimmed === "*" || trimmed === "<all_urls>";
    });
    if (hasWildcard) {
      warnings.push(
        `Project "${project.name}" mixes a wildcard site pattern with specific ones; the wildcard makes the others redundant.`,
      );
    }
  }

  return warnings;
}

export function collectWorkspaceWarnings(workspace: WorkspaceSnapshot): string[] {
  return [
    ...workspace.projects.flatMap((project) => collectProjectWarnings(project)),
    ...workspace.rules.flatMap((rule) => collectUnsupportedRuleWarnings(rule)),
  ];
}
