import type {
  Project,
  Rule,
  RuleSet,
  UpsertProjectPayload,
  UpsertRulePayload,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";

/**
 * Pending deletions accumulated locally while the upstream service was
 * unreachable. After the service comes back online, these need to be re-played
 * against the freshly pulled workspace to guarantee deletes are not silently
 * resurrected by a merge import.
 *
 * The shape is intentionally normalized (flat id sets) so producers can
 * accumulate any combination of delete kinds without bookkeeping the order.
 */
export interface PendingDeletions {
  projectIds: string[];
  ruleSetIds: string[];
  ruleIds: string[];
}

export function emptyPendingDeletions(): PendingDeletions {
  return { projectIds: [], ruleSetIds: [], ruleIds: [] };
}

export function isPendingDeletionsEmpty(deletions: PendingDeletions): boolean {
  return (
    deletions.projectIds.length === 0 &&
    deletions.ruleSetIds.length === 0 &&
    deletions.ruleIds.length === 0
  );
}

/** Merge two PendingDeletions, deduplicating ids. */
export function mergePendingDeletions(
  base: PendingDeletions,
  next: Partial<PendingDeletions>,
): PendingDeletions {
  return {
    projectIds: dedupeStrings(base.projectIds, next.projectIds),
    ruleSetIds: dedupeStrings(base.ruleSetIds, next.ruleSetIds),
    ruleIds: dedupeStrings(base.ruleIds, next.ruleIds),
  };
}

function dedupeStrings(left: string[], right?: string[]): string[] {
  if (!right || right.length === 0) return left.slice();
  const set = new Set(left);
  for (const item of right) set.add(item);
  return Array.from(set);
}

export function applyPendingDeletions(
  workspace: WorkspaceSnapshot,
  deletions: PendingDeletions,
): WorkspaceSnapshot {
  if (isPendingDeletionsEmpty(deletions)) return workspace;

  const projectIds = new Set(deletions.projectIds);
  const ruleSetIds = new Set(deletions.ruleSetIds);
  const ruleIds = new Set(deletions.ruleIds);

  return {
    ...workspace,
    projects: workspace.projects.filter((project) => !projectIds.has(project.id)),
    ruleSets: workspace.ruleSets
      .filter((ruleSet) => !ruleSetIds.has(ruleSet.id) && !projectIds.has(ruleSet.projectId))
      .map((ruleSet) => ({ ...ruleSet, ruleIds: ruleSet.ruleIds.filter((id) => !ruleIds.has(id)) })),
    rules: workspace.rules.filter((rule) => !ruleIds.has(rule.id)),
  };
}

/**
 * Compute the cascade of deletions a project removal entails, without mutating
 * the workspace. Used by callers that need both the resulting snapshot and the
 * exact id set to remember in PendingDeletions.
 */
export function planDeleteProject(
  workspace: WorkspaceSnapshot,
  projectId: string,
): { workspace: WorkspaceSnapshot; deletions: PendingDeletions } {
  const ruleSetsToRemove = workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === projectId);
  const ruleSetIds = ruleSetsToRemove.map((ruleSet) => ruleSet.id);
  const ruleIds = Array.from(new Set(ruleSetsToRemove.flatMap((ruleSet) => ruleSet.ruleIds)));
  const deletions: PendingDeletions = { projectIds: [projectId], ruleSetIds, ruleIds };
  return { workspace: applyPendingDeletions(workspace, deletions), deletions };
}

export function planDeleteRule(
  workspace: WorkspaceSnapshot,
  ruleId: string,
): { workspace: WorkspaceSnapshot; deletions: PendingDeletions } {
  const deletions: PendingDeletions = { projectIds: [], ruleSetIds: [], ruleIds: [ruleId] };
  return {
    workspace: {
      ...workspace,
      ruleSets: workspace.ruleSets.map((ruleSet) => ({
        ...ruleSet,
        ruleIds: ruleSet.ruleIds.filter((id) => id !== ruleId),
      })),
      rules: workspace.rules.filter((rule) => rule.id !== ruleId),
      updatedAt: new Date().toISOString(),
    },
    deletions,
  };
}

export function planDeleteRuleSet(
  workspace: WorkspaceSnapshot,
  ruleSetId: string,
): { workspace: WorkspaceSnapshot; deletions: PendingDeletions } {
  const target = workspace.ruleSets.find((ruleSet) => ruleSet.id === ruleSetId);
  const ruleIds = target ? Array.from(new Set(target.ruleIds)) : [];
  const deletions: PendingDeletions = { projectIds: [], ruleSetIds: [ruleSetId], ruleIds };
  return { workspace: applyPendingDeletions(workspace, deletions), deletions };
}

export function applyUpsertProject(
  workspace: WorkspaceSnapshot,
  payload: UpsertProjectPayload,
): WorkspaceSnapshot {
  const projects = upsertById(workspace.projects, stampUpdated(payload.project));
  let ruleSets = workspace.ruleSets;
  if (payload.ruleSets) {
    for (const ruleSet of payload.ruleSets.map(stampUpdated)) {
      ruleSets = upsertById(ruleSets, ensureProjectId(ruleSet, payload.project.id));
    }
  }
  return { ...workspace, projects, ruleSets, updatedAt: new Date().toISOString() };
}

export function applyUpsertRule(
  workspace: WorkspaceSnapshot,
  payload: UpsertRulePayload,
): WorkspaceSnapshot {
  const rules = upsertById(workspace.rules, stampUpdated(payload.rule));
  let ruleSets = workspace.ruleSets.map((ruleSet) => ({
    ...ruleSet,
    ruleIds: ruleSet.ruleIds.filter((ruleId) => ruleId !== payload.rule.id),
  }));
  if (payload.ruleSetId) {
    ruleSets = ruleSets.map((ruleSet) =>
      ruleSet.id === payload.ruleSetId
        ? stampUpdated({ ...ruleSet, ruleIds: [...ruleSet.ruleIds, payload.rule.id] })
        : ruleSet,
    );
  }
  return { ...workspace, rules, ruleSets, updatedAt: new Date().toISOString() };
}

/**
 * Upsert a single rule set without touching the surrounding project. Mirrors
 * applyUpsertRule so callers (sidepanel toggles, options group editors) can
 * push a focused mutation rather than re-sending the project's full ruleSets
 * array via applyUpsertProject — which would bump updatedAt on every sibling
 * group and could fight last-write-wins merges later.
 */
export function applyUpsertRuleSet(
  workspace: WorkspaceSnapshot,
  ruleSet: RuleSet,
): WorkspaceSnapshot {
  const ruleSets = upsertById(workspace.ruleSets, stampUpdated(ruleSet));
  return { ...workspace, ruleSets, updatedAt: new Date().toISOString() };
}

export function mergeWorkspaces(
  current: WorkspaceSnapshot,
  imported: WorkspaceSnapshot,
): WorkspaceSnapshot {
  return {
    version: Math.max(current.version, imported.version),
    updatedAt: new Date().toISOString(),
    projects: mergeArray(current.projects, imported.projects),
    ruleSets: mergeArray(current.ruleSets, imported.ruleSets),
    rules: mergeArray(current.rules, imported.rules),
  };
}

export function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

export function stampUpdated<T extends { createdAt: string; updatedAt: string }>(item: T): T {
  const now = new Date().toISOString();
  return { ...item, createdAt: item.createdAt || now, updatedAt: now };
}

function ensureProjectId(ruleSet: RuleSet, projectId: string): RuleSet {
  return { ...ruleSet, projectId };
}

function mergeArray<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of current) map.set(item.id, item);
  for (const item of incoming) map.set(item.id, item);
  return Array.from(map.values());
}

// Re-export concrete types so consumers can import from one place.
export type { Project, Rule, RuleSet };
