import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { isAgentManagedProject, workspaceWithoutAgentManaged } from "@resource-forwarder/rule-core";

interface AgentOwnershipIds {
  projectIds: Set<string>;
  ruleSetIds: Set<string>;
  ruleIds: Set<string>;
}

export function reconcileAgentManagedSubtrees(
  local: WorkspaceSnapshot,
  service: WorkspaceSnapshot,
): WorkspaceSnapshot {
  const localUser = stripReservedReferences(workspaceWithoutAgentManaged(local), agentOwnershipIds(local));
  const serviceAgents = agentManagedSlice(service);
  const serviceAgentIds = new Set(serviceAgents.projects.map((project) => project.id));
  const serviceRuleSetIds = new Set(serviceAgents.ruleSets.map((ruleSet) => ruleSet.id));
  const serviceRuleIds = new Set(serviceAgents.rules.map((rule) => rule.id));
  return {
    ...localUser,
    version: service.version,
    revision: service.revision,
    updatedAt: service.updatedAt,
    agentReservations: service.agentReservations ?? local.agentReservations,
    projects: [
      ...localUser.projects.filter((project) => !serviceAgentIds.has(project.id)),
      ...serviceAgents.projects,
    ],
    ruleSets: [
      ...localUser.ruleSets.filter((ruleSet) => !serviceRuleSetIds.has(ruleSet.id)),
      ...serviceAgents.ruleSets,
    ],
    rules: [
      ...localUser.rules.filter((rule) => !serviceRuleIds.has(rule.id)),
      ...serviceAgents.rules,
    ],
  };
}

export function replaceUserOwnedSlice(
  local: WorkspaceSnapshot,
  imported: WorkspaceSnapshot,
): WorkspaceSnapshot {
  const localAgents = agentManagedSlice(local);
  const ownership = agentOwnershipIds(local);
  const importedUser = workspaceWithoutAgentManaged(imported);
  assertNoAgentReferences(importedUser, ownership);
  return {
    ...importedUser,
    agentReservations: local.agentReservations,
    revision: local.revision,
    projects: [...localAgents.projects, ...importedUser.projects],
    ruleSets: [...localAgents.ruleSets, ...importedUser.ruleSets],
    rules: [...localAgents.rules, ...importedUser.rules],
  };
}

/** User-owned import payloads must not expose internal reservation metadata. */
export function userOwnedSlice(workspace: WorkspaceSnapshot): WorkspaceSnapshot {
  const ownership = agentOwnershipIds(workspace);
  const user = stripReservedReferences(workspaceWithoutAgentManaged(workspace), ownership);
  const { agentReservations: _agentReservations, ...withoutReservations } = user;
  return withoutReservations;
}

function assertNoAgentReferences(workspace: WorkspaceSnapshot, ownership: AgentOwnershipIds): void {
  for (const project of workspace.projects) {
    if (ownership.projectIds.has(project.id)) throw new Error(`Imported project is agent-owned or reserved: ${project.id}`);
  }
  for (const ruleSet of workspace.ruleSets) {
    if (ownership.ruleSetIds.has(ruleSet.id) || ownership.projectIds.has(ruleSet.projectId)) {
      throw new Error(`Imported rule set references agent ownership: ${ruleSet.id}`);
    }
    for (const ruleId of ruleSet.ruleIds) {
      if (ownership.ruleIds.has(ruleId)) throw new Error(`Imported rule references agent ownership: ${ruleId}`);
    }
  }
  for (const rule of workspace.rules) {
    if (ownership.ruleIds.has(rule.id)) throw new Error(`Imported rule is agent-owned or reserved: ${rule.id}`);
  }
}

function stripReservedReferences(workspace: WorkspaceSnapshot, ownership: AgentOwnershipIds): WorkspaceSnapshot {
  const projects = workspace.projects.filter((project) => !ownership.projectIds.has(project.id));
  const ruleSets = workspace.ruleSets.filter(
    (ruleSet) => !ownership.ruleSetIds.has(ruleSet.id) && !ownership.projectIds.has(ruleSet.projectId),
  );
  const rules = workspace.rules.filter((rule) => !ownership.ruleIds.has(rule.id));
  return { ...workspace, projects, ruleSets, rules };
}

function agentOwnershipIds(workspace: WorkspaceSnapshot): AgentOwnershipIds {
  const active = agentManagedSlice(workspace);
  return {
    projectIds: new Set([
      ...(workspace.agentReservations?.projectIds ?? []),
      ...active.projects.map((project) => project.id),
    ]),
    ruleSetIds: new Set([
      ...(workspace.agentReservations?.ruleSetIds ?? []),
      ...active.ruleSets.map((ruleSet) => ruleSet.id),
    ]),
    ruleIds: new Set([
      ...(workspace.agentReservations?.ruleIds ?? []),
      ...active.rules.map((rule) => rule.id),
    ]),
  };
}

function agentManagedSlice(workspace: WorkspaceSnapshot): Pick<WorkspaceSnapshot, "projects" | "ruleSets" | "rules"> {
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
