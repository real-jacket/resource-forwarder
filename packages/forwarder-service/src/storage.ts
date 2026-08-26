import { mkdir, readFile, readdir, writeFile, appendFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppliedRevisionResponse,
  ExportWorkspaceResponse,
  HitRecord,
  ImportWorkspacePayload,
  ProjectSubtree,
  RuleSet,
  SupportedExportFormat,
  SwitchProjectsPayload,
  UpsertProjectPayload,
  UpsertRulePayload,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import {
  applyUpsertProject,
  applyUpsertRule,
  applyUpsertRuleSet,
  createEmptyWorkspace,
  isAgentManagedProject,
  mergeWorkspaces,
  parseWorkspace,
  planDeleteRuleSet,
  replaceProjectSubtree,
  reserveAgentManagedIds,
  serializeWorkspace,
  switchProjectGroup,
} from "@resource-forwarder/rule-core";
import { SecretsManager } from "./secrets.js";

export class RevisionRequiredError extends Error {
  readonly statusCode = 428;
  readonly code = "REVISION_REQUIRED";

  constructor(readonly currentRevision: number) {
    super("A revision guard is required for this mutation.");
    this.name = "RevisionRequiredError";
  }
}

export class RevisionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "REVISION_CONFLICT";

  constructor(readonly currentRevision: number, readonly workspace: WorkspaceSnapshot) {
    super(`Revision ${currentRevision} is current; the requested revision is stale.`);
    this.name = "RevisionConflictError";
  }
}

export class InvalidAppliedRevisionError extends Error {
  readonly statusCode = 409;
  readonly code = "INVALID_APPLIED_REVISION";

  constructor(readonly currentRevision: number, readonly requestedRevision: number) {
    super(`Applied revision ${requestedRevision} is not persisted at revision ${currentRevision}.`);
    this.name = "InvalidAppliedRevisionError";
  }
}

export class WorkspaceStorage {
  private readonly workspaceFile: string;
  private readonly appliedRevisionFile: string;
  private readonly logsDir: string;
  private readonly secrets: SecretsManager;

  constructor(readonly rootDir: string) {
    this.workspaceFile = join(rootDir, "workspace.json");
    this.appliedRevisionFile = join(rootDir, "applied-revision.json");
    this.logsDir = join(rootDir, "logs");
    this.secrets = new SecretsManager(rootDir);
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.runInit();
    return this.initPromise;
  }

  private async runInit(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(dirname(this.workspaceFile), { recursive: true });
    await mkdir(this.logsDir, { recursive: true });

    try {
      await readFile(this.workspaceFile, "utf8");
    } catch {
      await this.atomicWriteWorkspace(createEmptyWorkspace());
    }

    try {
      await readFile(this.appliedRevisionFile, "utf8");
    } catch {
      await this.atomicWriteAppliedRevision(0);
    }
  }

  async readWorkspace(): Promise<WorkspaceSnapshot> {
    await this.init();
    return this.serialize(() => this.readWorkspaceSafely());
  }

  async readAppliedRevision(): Promise<number> {
    await this.init();
    return this.serialize(async () => {
      const workspace = await this.readWorkspaceSafely();
      return this.readAppliedRevisionSafely(workspace.revision);
    });
  }

  private async readWorkspaceSafely(): Promise<WorkspaceSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.workspaceFile, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code !== "ENOENT") throw error;
      return createEmptyWorkspace();
    }

    try {
      const parsed = parseWorkspace(raw, "json");
      const hydrated = await this.secrets.hydrateWorkspace(parsed);
      let persistedRevision: unknown;
      try {
        persistedRevision = (JSON.parse(raw) as { revision?: unknown }).revision;
      } catch {
        persistedRevision = undefined;
      }
      if (persistedRevision !== parsed.revision) await this.atomicWriteWorkspace(hydrated);
      return hydrated;
    } catch (parseError) {
      const quarantineFile = `${this.workspaceFile}.corrupt.${Date.now()}`;
      try {
        await writeFile(quarantineFile, raw, "utf8");
      } catch {
        // Preserve the usable in-memory fallback even if quarantine fails.
      }
      const fresh = createEmptyWorkspace();
      await this.atomicWriteWorkspace(fresh);
      // eslint-disable-next-line no-console
      console.error(
        `[forwarder-service] workspace.json was unparseable; quarantined to ${quarantineFile} and reset to empty.`,
        parseError,
      );
      return fresh;
    }
  }

  async applyMutation(
    ifRevision: number | undefined,
    force: boolean,
    mutator: (workspace: WorkspaceSnapshot) => WorkspaceSnapshot | Promise<WorkspaceSnapshot>,
  ): Promise<WorkspaceSnapshot> {
    await this.init();
    return this.serialize(async () => {
      const current = await this.readWorkspaceSafely();
      this.assertRevisionGuard(current, ifRevision, force);
      const mutated = await mutator(current);
      const next: WorkspaceSnapshot = {
        ...mutated,
        version: 1,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.atomicWriteWorkspace(next);
      return next;
    });
  }

  async replaceProjectSubtree(
    projectId: string,
    subtree: ProjectSubtree,
    ifRevision: number | undefined,
    force: boolean,
  ): Promise<WorkspaceSnapshot> {
    if (subtree.project.id !== projectId) throw new Error("Project id mismatch.");
    return this.applyMutation(ifRevision, force, (workspace) => replaceProjectSubtree(workspace, subtree));
  }

  async switchProjects(
    payload: SwitchProjectsPayload,
    ifRevision: number | undefined,
    force: boolean,
  ): Promise<WorkspaceSnapshot> {
    return this.applyMutation(ifRevision, force, (workspace) => switchProjectGroup(workspace, payload.projectId, payload.enabled));
  }

  async deleteProject(projectId: string, ifRevision: number | undefined, force: boolean): Promise<WorkspaceSnapshot> {
    return this.applyMutation(ifRevision, force, (workspace) => deleteProjectInWorkspace(workspace, projectId));
  }

  async deleteRule(ruleId: string, ifRevision: number | undefined, force: boolean): Promise<WorkspaceSnapshot> {
    return this.applyMutation(ifRevision, force, (workspace) => deleteRuleInWorkspace(workspace, ruleId));
  }

  async recordAppliedRevision(revision: number): Promise<AppliedRevisionResponse> {
    await this.init();
    return this.serialize(async () => {
      const workspace = await this.readWorkspaceSafely();
      if (!Number.isInteger(revision) || revision < 0 || revision > workspace.revision) {
        throw new InvalidAppliedRevisionError(workspace.revision, revision);
      }
      const current = await this.readAppliedRevisionSafely(workspace.revision);
      const appliedRevision = Math.max(current, revision);
      if (appliedRevision !== current) await this.atomicWriteAppliedRevision(appliedRevision);
      return { appliedRevision };
    });
  }

  async writeWorkspace(workspace: WorkspaceSnapshot, ifRevision?: number, force = false): Promise<WorkspaceSnapshot> {
    return this.applyMutation(ifRevision, force, () => workspace);
  }

  // Legacy direct storage helpers remain for internal callers and tests. HTTP
  // mutation routes use applyMutation so they cannot bypass CAS.
  async upsertProject(payload: UpsertProjectPayload): Promise<WorkspaceSnapshot> {
    return this.mutateWorkspace((workspace) => applyUpsertProject(workspace, payload));
  }

  async upsertRule(payload: UpsertRulePayload): Promise<WorkspaceSnapshot> {
    return this.mutateWorkspace((workspace) => applyUpsertRule(workspace, payload));
  }

  async upsertRuleSet(ruleSet: RuleSet): Promise<WorkspaceSnapshot> {
    return this.mutateWorkspace((workspace) => applyUpsertRuleSet(workspace, ruleSet));
  }

  async deleteRuleSet(ruleSetId: string): Promise<WorkspaceSnapshot> {
    return this.mutateWorkspace((workspace) => planDeleteRuleSet(workspace, ruleSetId).workspace);
  }

  async importWorkspace(payload: ImportWorkspacePayload): Promise<WorkspaceSnapshot> {
    const imported = parseWorkspace(payload.content, payload.format);
    const force = payload.ifRevision === undefined;
    if (!payload.merge) return this.writeWorkspace(imported, payload.ifRevision, force);
    return this.applyMutation(payload.ifRevision, force, (workspace) => mergeWorkspaces(workspace, imported));
  }

  async appendHits(records: Array<Omit<HitRecord, "id" | "occurredAt">>): Promise<HitRecord[]> {
    if (records.length === 0) return [];
    const enriched = records.map((record) => ({
      ...record,
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
    }));
    const grouped = new Map<string, HitRecord[]>();
    for (const entry of enriched) {
      const key = entry.occurredAt.slice(0, 10);
      const bucket = grouped.get(key) ?? [];
      bucket.push(entry);
      grouped.set(key, bucket);
    }
    for (const [day, bucket] of grouped) {
      const file = join(this.logsDir, `${day}.jsonl`);
      const payload = bucket.map((entry) => `${JSON.stringify(entry)}\n`).join("");
      await appendFile(file, payload, "utf8");
    }
    return enriched;
  }

  async exportWorkspace(projectId: string, format: SupportedExportFormat): Promise<ExportWorkspaceResponse> {
    const workspace = await this.readWorkspace();
    const scopedRuleSets = workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === projectId);
    const allowedRuleIds = new Set(scopedRuleSets.flatMap((ruleSet) => ruleSet.ruleIds));
    const scopedWorkspace: WorkspaceSnapshot = {
      version: workspace.version,
      revision: workspace.revision,
      updatedAt: workspace.updatedAt,
      projects: workspace.projects.filter((project) => project.id === projectId),
      ruleSets: scopedRuleSets,
      rules: workspace.rules.filter((rule) => allowedRuleIds.has(rule.id)),
    };

    return {
      format,
      content: serializeWorkspace(scopedWorkspace, format),
    };
  }

  async appendHit(record: Omit<HitRecord, "id" | "occurredAt">): Promise<HitRecord> {
    const [enriched] = await this.appendHits([record]);
    return enriched;
  }

  async listLogs(limit = 100, projectId?: string): Promise<HitRecord[]> {
    await this.init();
    const effectiveLimit = Math.max(0, Math.min(limit, MAX_LOGS_PAGE_SIZE));
    if (effectiveLimit === 0) return [];

    const names = (await readdir(this.logsDir)).sort().reverse();
    const logs: HitRecord[] = [];

    for (const name of names) {
      const raw = await readFile(join(this.logsDir, name), "utf8");
      const entries: HitRecord[] = [];
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as HitRecord;
          if (projectId && parsed.projectId !== projectId) continue;
          entries.push(parsed);
          if (logs.length + entries.length >= effectiveLimit) break;
        } catch {
          // Tolerate truncated tail lines from a crash mid-write.
        }
      }
      logs.push(...entries);
      if (logs.length >= effectiveLimit) break;
    }

    return logs.slice(0, effectiveLimit);
  }

  private async mutateWorkspace(mutator: (workspace: WorkspaceSnapshot) => WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    return this.applyMutation(undefined, true, mutator);
  }

  private assertRevisionGuard(workspace: WorkspaceSnapshot, ifRevision: number | undefined, force: boolean): void {
    if (force) return;
    if (typeof ifRevision !== "number" || !Number.isInteger(ifRevision) || ifRevision < 0) {
      throw new RevisionRequiredError(workspace.revision);
    }
    if (ifRevision !== workspace.revision) {
      throw new RevisionConflictError(workspace.revision, workspace);
    }
  }

  private async readAppliedRevisionSafely(currentRevision: number): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.appliedRevisionFile, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return 0;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as { appliedRevision?: unknown };
      const revision = parsed.appliedRevision;
      if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return 0;
      return Math.min(revision, currentRevision);
    } catch {
      return 0;
    }
  }

  private initPromise: Promise<void> | undefined;
  private writeChain: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async atomicWriteWorkspace(workspace: WorkspaceSnapshot): Promise<void> {
    const redacted = await this.secrets.redactWorkspace(workspace);
    const tmp = `${this.workspaceFile}.${process.pid}.tmp`;
    await writeFile(tmp, serializeWorkspace(redacted, "json"), "utf8");
    await rename(tmp, this.workspaceFile);
  }

  private async atomicWriteAppliedRevision(revision: number): Promise<void> {
    const tmp = `${this.appliedRevisionFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ appliedRevision: revision }, null, 2), "utf8");
    await rename(tmp, this.appliedRevisionFile);
  }
}
function deleteProjectInWorkspace(workspace: WorkspaceSnapshot, projectId: string): WorkspaceSnapshot {
  const project = workspace.projects.find((candidate) => candidate.id === projectId);
  const ruleSetIds = new Set(workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === projectId).map((ruleSet) => ruleSet.id));
  const ruleIds = new Set(
    workspace.ruleSets.filter((ruleSet) => ruleSetIds.has(ruleSet.id)).flatMap((ruleSet) => ruleSet.ruleIds),
  );
  const next: WorkspaceSnapshot = {
    ...workspace,
    projects: workspace.projects.filter((candidate) => candidate.id !== projectId),
    ruleSets: workspace.ruleSets.filter((ruleSet) => !ruleSetIds.has(ruleSet.id)),
    rules: workspace.rules.filter((rule) => !ruleIds.has(rule.id)),
  };
  return project && isAgentManagedProject(project)
    ? reserveAgentManagedIds(next, [projectId], [...ruleSetIds], [...ruleIds], projectId)
    : next;
}

function deleteRuleInWorkspace(workspace: WorkspaceSnapshot, ruleId: string): WorkspaceSnapshot {
  const agentOwnerId = workspace.ruleSets.find((ruleSet) => {
    if (!ruleSet.ruleIds.includes(ruleId)) return false;
    const project = workspace.projects.find((candidate) => candidate.id === ruleSet.projectId);
    return Boolean(project && isAgentManagedProject(project));
  })?.projectId;
  const next: WorkspaceSnapshot = {
    ...workspace,
    ruleSets: workspace.ruleSets.map((ruleSet) => ({
      ...ruleSet,
      ruleIds: ruleSet.ruleIds.filter((id) => id !== ruleId),
    })),
    rules: workspace.rules.filter((rule) => rule.id !== ruleId),
  };
  return agentOwnerId ? reserveAgentManagedIds(next, [], [], [ruleId], agentOwnerId) : next;
}

const MAX_LOGS_PAGE_SIZE = 1000;

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}
