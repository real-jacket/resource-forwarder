import type { Project, Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";

export interface RuleConflict {
  ruleId: string;
  reason: string;
}

export function collectUnsupportedRuleWarnings(rule: Rule): string[] {
  const warnings: string[] = [];

  if (rule.kind === "asset_redirect") {
    const redirectUrl = rule.target.redirectUrl ?? "";
    const isRelativeTarget = redirectUrl.length > 0 && !redirectUrl.includes("://");
    const isValidTarget =
      isRelativeTarget ||
      redirectUrl.startsWith("https://") ||
      redirectUrl.startsWith("http://localhost") ||
      redirectUrl.startsWith("http://127.0.0.1");
    if (!isValidTarget) {
      warnings.push(`Asset redirect rule ${rule.name} must point to an HTTPS target.`);
    }
  }

  const pathGlob = rule.match.pathGlob ?? "";
  if (pathGlob.includes("://")) {
    // The pathGlob is meant to be just a URL path (e.g. /api/**), not a full
    // URL. A glob like https://host/path emits a bogus DNR filter that Chrome
    // rejects. toDynamicRule sanitizes it before DNR submission, but we still
    // surface a warning so the user knows to clean up the stored data.
    warnings.push(
      `规则 ${rule.name} 的匹配路径 \`${pathGlob}\` 像完整 URL，已自动按 path 部分匹配；建议改成 \`/path/...\` 形式。`,
    );
  }

  if (rule.kind === "api_forward") {
    const profile = rule.target.forwardProfile;
    if (!profile) {
      warnings.push(`API forward rule ${rule.name} is missing a forward profile.`);
    } else {
      const responseMode = profile.responsePolicy?.mode ?? "forward";
      if (responseMode === "forward" && !profile.targetBaseUrl?.trim()) {
        warnings.push(`API forward rule ${rule.name} needs a target URL when response mode is forward.`);
      }
      if (responseMode === "mock_file" && !profile.responsePolicy?.mockFilePath?.trim()) {
        warnings.push(`API forward rule ${rule.name} needs a local JSON file path.`);
      }
      const status = profile.responsePolicy?.status;
      if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) {
        warnings.push(`API forward rule ${rule.name} has an invalid response status.`);
      }
    }
  }

  if (rule.kind === "asset_redirect" && (rule.match.query || rule.match.headers)) {
    warnings.push(`Asset redirect rule ${rule.name} cannot match query parameters or request headers in Chrome DNR.`);
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
  const hierarchyWarnings: string[] = [];
  const ruleIds = new Set(workspace.rules.map((rule) => rule.id));
  const projectIds = new Set(workspace.projects.map((project) => project.id));

  for (const rule of workspace.rules) {
    const memberships = workspace.ruleSets.filter((ruleSet) => ruleSet.ruleIds.includes(rule.id));
    if (memberships.length === 0) {
      hierarchyWarnings.push(`Rule ${rule.name} is not assigned to a rule set and will not match.`);
    } else if (memberships.length > 1) {
      hierarchyWarnings.push(`Rule ${rule.name} is assigned to multiple rule sets and will not match.`);
    }
  }

  for (const ruleSet of workspace.ruleSets) {
    if (!projectIds.has(ruleSet.projectId)) {
      hierarchyWarnings.push(`Rule set ${ruleSet.name} references a missing project and its rules will not match.`);
    }
    for (const ruleId of ruleSet.ruleIds) {
      if (!ruleIds.has(ruleId)) {
        hierarchyWarnings.push(`Rule set ${ruleSet.name} references missing rule ${ruleId}.`);
      }
    }
  }

  return [
    ...hierarchyWarnings,
    ...workspace.projects.flatMap((project) => collectProjectWarnings(project)),
    ...workspace.rules.flatMap((rule) => collectUnsupportedRuleWarnings(rule)),
  ];
}
