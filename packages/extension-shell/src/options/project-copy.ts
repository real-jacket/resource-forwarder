import type { Project, Rule, RuleSet, WorkspaceSnapshot } from "@resource-forwarder/shared-types";

export interface ProjectCopyBundle {
  project: Project;
  ruleSets: RuleSet[];
  rules: Rule[];
}

export function createProjectCopyBundle(
  workspace: WorkspaceSnapshot,
  projectId: string,
  now: string,
  createId: (prefix: string) => string,
): ProjectCopyBundle {
  const sourceProject = workspace.projects.find((project) => project.id === projectId);
  if (!sourceProject) {
    throw new Error("要复制的站点不存在。");
  }

  const nextProjectId = createId("project");
  const sourceRuleSets = workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === projectId);
  const ruleIdMap = new Map<string, string>();
  const ruleSetIdMap = new Map<string, string>();

  for (const ruleSet of sourceRuleSets) {
    ruleSetIdMap.set(ruleSet.id, createId("ruleset"));
    for (const ruleId of ruleSet.ruleIds) {
      if (!ruleIdMap.has(ruleId)) {
        ruleIdMap.set(ruleId, createId("rule"));
      }
    }
  }

  const projectNames = workspace.projects.map((project) => project.name);
  const project: Project = {
    ...sourceProject,
    id: nextProjectId,
    name: createCopyName(sourceProject.name, projectNames),
    siteHosts: [...sourceProject.siteHosts],
    siteMatchPatterns: sourceProject.siteMatchPatterns ? [...sourceProject.siteMatchPatterns] : undefined,
    tags: [...sourceProject.tags],
    createdAt: now,
    updatedAt: now,
  };

  const ruleSets = sourceRuleSets.map((ruleSet) => ({
    ...ruleSet,
    id: ruleSetIdMap.get(ruleSet.id)!,
    projectId: nextProjectId,
    ruleIds: ruleSet.ruleIds.map((ruleId) => ruleIdMap.get(ruleId)).filter((id): id is string => Boolean(id)),
    createdAt: now,
    updatedAt: now,
  }));

  const sourceRuleIds = new Set(ruleIdMap.keys());
  const rules = workspace.rules
    .filter((rule) => sourceRuleIds.has(rule.id))
    .map((rule) => ({
      ...rule,
      id: ruleIdMap.get(rule.id)!,
      match: {
        ...rule.match,
        host: [...rule.match.host],
        resourceType: rule.match.resourceType ? [...rule.match.resourceType] : undefined,
        method: rule.match.method ? [...rule.match.method] : undefined,
        tabScope: rule.match.tabScope
          ? rule.match.tabScope.mode === "tabIds"
            ? { mode: "tabIds" as const, tabIds: [...rule.match.tabScope.tabIds] }
            : { mode: "all" as const }
          : undefined,
      },
      target: cloneTarget(rule),
      tags: [...rule.tags],
      createdAt: now,
      updatedAt: now,
    }));

  return { project, ruleSets, rules };
}

function createCopyName(sourceName: string, existingNames: string[]): string {
  const base = `${sourceName} 副本`;
  if (!existingNames.includes(base)) {
    return base;
  }

  let index = 2;
  while (existingNames.includes(`${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

function cloneTarget(rule: Rule): Rule["target"] {
  if (rule.kind === "asset_redirect") {
    return { redirectUrl: rule.target.redirectUrl };
  }

  const profile = rule.target.forwardProfile;
  return {
    forwardProfile: profile
      ? {
          ...profile,
          pathRewrite: profile.pathRewrite?.map((rewrite) => ({ ...rewrite })),
          headers: profile.headers ? { ...profile.headers } : undefined,
          headerPolicy: profile.headerPolicy
            ? {
                strip: profile.headerPolicy.strip ? [...profile.headerPolicy.strip] : undefined,
                passthrough: profile.headerPolicy.passthrough ? [...profile.headerPolicy.passthrough] : undefined,
              }
            : undefined,
        }
      : undefined,
  };
}
