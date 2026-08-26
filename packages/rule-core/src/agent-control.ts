import type { Project, ProjectSubtree, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { mergeWorkspaces } from "./workspace-mutations.js";

const AGENT_MANAGED_TAG = "agent-managed";
const SWITCH_GROUP_PREFIX = "switch-group:";

export function isAgentManagedProject(project: Project): boolean {
  return project.tags.includes(AGENT_MANAGED_TAG);
}

export function getSwitchGroup(project: Project): string | undefined {
  const tag = project.tags.find(
    (value) => value.startsWith(SWITCH_GROUP_PREFIX) && value.length > SWITCH_GROUP_PREFIX.length,
  );
  return tag?.slice(SWITCH_GROUP_PREFIX.length);
}

export function validateProjectSubtree(workspace: WorkspaceSnapshot, subtree: ProjectSubtree): void {
  const projectId = subtree.project.id;
  const currentProject = workspace.projects.find((project) => project.id === projectId);
  if (currentProject && isAgentManagedProject(currentProject) !== isAgentManagedProject(subtree.project)) {
    throw new Error(`Project ownership is immutable: ${projectId}`);
  }

  const ruleSetIds = new Set<string>();
  const referencedRuleIds = new Set<string>();
  for (const ruleSet of subtree.ruleSets) {
    if (ruleSet.projectId !== projectId) {
      throw new Error(`Rule set ${ruleSet.id} points to another project.`);
    }
    if (ruleSetIds.has(ruleSet.id)) {
      throw new Error(`Duplicate rule set id: ${ruleSet.id}`);
    }
    ruleSetIds.add(ruleSet.id);
    for (const ruleId of ruleSet.ruleIds) {
      if (referencedRuleIds.has(ruleId)) {
        throw new Error(`Rule ${ruleId} is referenced by multiple rule sets.`);
      }
      referencedRuleIds.add(ruleId);
    }
  }

  const suppliedRuleIds = new Set<string>();
  for (const rule of subtree.rules) {
    if (suppliedRuleIds.has(rule.id)) {
      throw new Error(`Duplicate rule id: ${rule.id}`);
    }
    suppliedRuleIds.add(rule.id);
  }
  for (const ruleId of referencedRuleIds) {
    if (!suppliedRuleIds.has(ruleId)) {
      throw new Error(`Rule ${ruleId} is referenced but missing from the subtree.`);
    }
  }
  for (const ruleId of suppliedRuleIds) {
    if (!referencedRuleIds.has(ruleId)) {
      throw new Error(`Rule ${ruleId} is not referenced by a rule set.`);
    }
  }

  const previousRuleSetIds = new Set(
    workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === projectId).map((ruleSet) => ruleSet.id),
  );
  const previousRuleIds = new Set(
    workspace.ruleSets.filter((ruleSet) => previousRuleSetIds.has(ruleSet.id)).flatMap((ruleSet) => ruleSet.ruleIds),
  );
  const reservedProjectIds = new Set(workspace.agentReservations?.projectIds ?? []);
  const reservedRuleSetIds = new Set(workspace.agentReservations?.ruleSetIds ?? []);
  const reservedRuleIds = new Set(workspace.agentReservations?.ruleIds ?? []);
  const sameAgentProject = Boolean(
    currentProject && isAgentManagedProject(currentProject) && isAgentManagedProject(subtree.project),
  );
  const ruleSetOwners = workspace.agentReservations?.ruleSetOwners ?? {};
  const ruleOwners = workspace.agentReservations?.ruleOwners ?? {};
  if (reservedProjectIds.has(projectId) && !currentProject) {
    throw new Error(`Agent-managed project id is reserved: ${projectId}`);
  }
  for (const ruleSetId of ruleSetIds) {
    if (reservedRuleSetIds.has(ruleSetId) && !previousRuleSetIds.has(ruleSetId) && !(sameAgentProject && ruleSetOwners[ruleSetId] === projectId)) {
      throw new Error(`Agent-managed rule set id is reserved: ${ruleSetId}`);
    }
  }
  for (const ruleId of suppliedRuleIds) {
    if (reservedRuleIds.has(ruleId) && !previousRuleIds.has(ruleId) && !(sameAgentProject && ruleOwners[ruleId] === projectId)) {
      throw new Error(`Agent-managed rule id is reserved: ${ruleId}`);
    }
  }
  for (const ruleSet of workspace.ruleSets) {
    if (!previousRuleSetIds.has(ruleSet.id) && ruleSetIds.has(ruleSet.id)) {
      throw new Error(`Rule set id is already owned by another project: ${ruleSet.id}`);
    }
  }
  for (const rule of workspace.rules) {
    if (!previousRuleIds.has(rule.id) && suppliedRuleIds.has(rule.id)) {
      throw new Error(`Rule id is already owned by another project: ${rule.id}`);
    }
  }
}

export function replaceProjectSubtree(workspace: WorkspaceSnapshot, subtree: ProjectSubtree): WorkspaceSnapshot {
  validateProjectSubtree(workspace, subtree);
  const currentProject = workspace.projects.find((project) => project.id === subtree.project.id);
  const oldRuleSetIds = new Set(
    workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === subtree.project.id).map((ruleSet) => ruleSet.id),
  );
  const oldRuleIds = new Set(
    workspace.ruleSets.filter((ruleSet) => oldRuleSetIds.has(ruleSet.id)).flatMap((ruleSet) => ruleSet.ruleIds),
  );
  const incomingRuleSetIds = new Set(subtree.ruleSets.map((ruleSet) => ruleSet.id));
  const incomingRuleIds = new Set(subtree.rules.map((rule) => rule.id));
  const next: WorkspaceSnapshot = {
    ...workspace,
    projects: [...workspace.projects.filter((project) => project.id !== subtree.project.id), subtree.project],
    ruleSets: [...workspace.ruleSets.filter((ruleSet) => ruleSet.projectId !== subtree.project.id), ...subtree.ruleSets],
    rules: [...workspace.rules.filter((rule) => !oldRuleIds.has(rule.id)), ...subtree.rules],
  };
  if (currentProject && isAgentManagedProject(currentProject)) {
    const removedRuleSetIds = [...oldRuleSetIds].filter((id) => !incomingRuleSetIds.has(id));
    const removedRuleIds = [...oldRuleIds].filter((id) => !incomingRuleIds.has(id));
    if (removedRuleSetIds.length > 0 || removedRuleIds.length > 0) {
      return reserveAgentManagedIds(next, [], removedRuleSetIds, removedRuleIds, subtree.project.id);
    }
  }
  return next;
}

export function switchProjectGroup(
  workspace: WorkspaceSnapshot,
  targetProjectId: string,
  enabled: boolean,
): WorkspaceSnapshot {
  const target = workspace.projects.find((project) => project.id === targetProjectId);
  if (!target) throw new Error(`Project not found: ${targetProjectId}`);
  const switchGroup = getSwitchGroup(target);
  const now = new Date().toISOString();

  return {
    ...workspace,
    projects: workspace.projects.map((project) => {
      if (project.id === targetProjectId) return { ...project, enabled, updatedAt: now };
      if (enabled && switchGroup && project.enabled && getSwitchGroup(project) === switchGroup) {
        return { ...project, enabled: false, updatedAt: now };
      }
      return project;
    }),
  };
}

export function projectSubtree(workspace: WorkspaceSnapshot, projectId: string): ProjectSubtree {
  const project = workspace.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const ruleSets = workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === projectId);
  const ruleIds = new Set(ruleSets.flatMap((ruleSet) => ruleSet.ruleIds));
  return {
    project,
    ruleSets,
    rules: workspace.rules.filter((rule) => ruleIds.has(rule.id)),
  };
}

export function workspaceWithoutAgentManaged(workspace: WorkspaceSnapshot): WorkspaceSnapshot {
  const agentProjectIds = new Set(
    workspace.projects.filter(isAgentManagedProject).map((project) => project.id),
  );
  const agentRuleSetIds = new Set(
    workspace.ruleSets.filter((ruleSet) => agentProjectIds.has(ruleSet.projectId)).map((ruleSet) => ruleSet.id),
  );
  const agentRuleIds = new Set(
    workspace.ruleSets.filter((ruleSet) => agentRuleSetIds.has(ruleSet.id)).flatMap((ruleSet) => ruleSet.ruleIds),
  );
  return {
    ...workspace,
    projects: workspace.projects.filter((project) => !agentProjectIds.has(project.id)),
    ruleSets: workspace.ruleSets.filter((ruleSet) => !agentRuleSetIds.has(ruleSet.id)),
    rules: workspace.rules.filter((rule) => !agentRuleIds.has(rule.id)),
  };
}

export function mergeUserOwnedSlice(current: WorkspaceSnapshot, imported: WorkspaceSnapshot): WorkspaceSnapshot {
  const currentAgent = workspaceAgentSlice(current);
  const currentUser = workspaceWithoutAgentManaged(current);
  const importedUser = workspaceWithoutAgentManaged(imported);
  const reservedProjectIds = new Set([
    ...(current.agentReservations?.projectIds ?? []),
    ...currentAgent.projects.map((project) => project.id),
  ]);
  const reservedRuleSetIds = new Set([
    ...(current.agentReservations?.ruleSetIds ?? []),
    ...currentAgent.ruleSets.map((ruleSet) => ruleSet.id),
  ]);
  const reservedRuleIds = new Set([
    ...(current.agentReservations?.ruleIds ?? []),
    ...currentAgent.rules.map((rule) => rule.id),
  ]);
  const filteredImported: WorkspaceSnapshot = {
    ...importedUser,
    projects: importedUser.projects.filter((project) => !reservedProjectIds.has(project.id)),
    ruleSets: importedUser.ruleSets.filter((ruleSet) => !reservedRuleSetIds.has(ruleSet.id) && !reservedProjectIds.has(ruleSet.projectId)),
    rules: importedUser.rules.filter((rule) => !reservedRuleIds.has(rule.id)),
  };
  const mergedUser = mergeWorkspaces(currentUser, filteredImported);
  return {
    ...mergedUser,
    projects: [...currentAgent.projects, ...mergedUser.projects],
    ruleSets: [...currentAgent.ruleSets, ...mergedUser.ruleSets],
    rules: [...currentAgent.rules, ...mergedUser.rules],
    revision: current.revision,
  };
}
export function reserveAgentManagedIds(
  workspace: WorkspaceSnapshot,
  projectIds: string[],
  ruleSetIds: string[],
  ruleIds: string[],
  ownerProjectId?: string,
): WorkspaceSnapshot {
  const current = workspace.agentReservations ?? { projectIds: [], ruleSetIds: [], ruleIds: [] };
  const ruleSetOwners = { ...(current.ruleSetOwners ?? {}) };
  const ruleOwners = { ...(current.ruleOwners ?? {}) };
  if (ownerProjectId) {
    for (const ruleSetId of ruleSetIds) ruleSetOwners[ruleSetId] = ownerProjectId;
    for (const ruleId of ruleIds) ruleOwners[ruleId] = ownerProjectId;
  }
  return {
    ...workspace,
    agentReservations: {
      projectIds: [...new Set([...current.projectIds, ...projectIds])],
      ruleSetIds: [...new Set([...current.ruleSetIds, ...ruleSetIds])],
      ruleIds: [...new Set([...current.ruleIds, ...ruleIds])],
      ruleSetOwners,
      ruleOwners,
    },
  };
}

function workspaceAgentSlice(
  workspace: WorkspaceSnapshot,
): Pick<WorkspaceSnapshot, "projects" | "ruleSets" | "rules"> {
  const projects = workspace.projects.filter(isAgentManagedProject);
  const projectIds = new Set(projects.map((project) => project.id));
  const ruleSets = workspace.ruleSets.filter((ruleSet) => projectIds.has(ruleSet.projectId));
  const ruleIds = new Set(ruleSets.flatMap((ruleSet) => ruleSet.ruleIds));
  return {
    projects,
    ruleSets,
    rules: workspace.rules.filter((rule) => ruleIds.has(rule.id)),
  };
}
