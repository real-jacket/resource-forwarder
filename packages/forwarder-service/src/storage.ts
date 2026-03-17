import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ExportWorkspaceResponse,
  HitRecord,
  ImportWorkspacePayload,
  Project,
  Rule,
  RuleSet,
  SupportedExportFormat,
  UpsertProjectPayload,
  UpsertRulePayload,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import { createEmptyWorkspace, parseWorkspace, serializeWorkspace } from "@resource-forwarder/rule-core";

export class WorkspaceStorage {
  private readonly workspaceFile: string;
  private readonly logsDir: string;

  constructor(readonly rootDir: string) {
    this.workspaceFile = join(rootDir, "workspace.json");
    this.logsDir = join(rootDir, "logs");
  }

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(dirname(this.workspaceFile), { recursive: true });
    await mkdir(this.logsDir, { recursive: true });

    try {
      await readFile(this.workspaceFile, "utf8");
    } catch {
      await this.writeWorkspace(createEmptyWorkspace());
    }
  }

  async readWorkspace(): Promise<WorkspaceSnapshot> {
    await this.init();
    const raw = await readFile(this.workspaceFile, "utf8");
    return parseWorkspace(raw, "json");
  }

  async writeWorkspace(workspace: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    const normalized: WorkspaceSnapshot = {
      ...workspace,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(this.workspaceFile, serializeWorkspace(normalized, "json"), "utf8");
    return normalized;
  }

  async upsertProject(payload: UpsertProjectPayload): Promise<WorkspaceSnapshot> {
    return this.mutateWorkspace((workspace) => {
      const projects = upsertById(workspace.projects, stampUpdated(payload.project));
      let ruleSets = workspace.ruleSets;

      if (payload.ruleSets) {
        for (const ruleSet of payload.ruleSets.map(stampUpdated)) {
          ruleSets = upsertById(ruleSets, ensureProjectId(ruleSet, payload.project.id));
        }
      }

      return {
        ...workspace,
        projects,
        ruleSets,
      };
    });
  }

  async upsertRule(payload: UpsertRulePayload): Promise<WorkspaceSnapshot> {
    return this.mutateWorkspace((workspace) => {
      const rules = upsertById(workspace.rules, stampUpdated(payload.rule));
      let ruleSets = workspace.ruleSets.map((ruleSet) => ({
        ...ruleSet,
        ruleIds: ruleSet.ruleIds.filter((ruleId) => ruleId !== payload.rule.id),
      }));

      if (payload.ruleSetId) {
        ruleSets = ruleSets.map((ruleSet) =>
          ruleSet.id === payload.ruleSetId
            ? stampUpdated({
                ...ruleSet,
                ruleIds: [...ruleSet.ruleIds, payload.rule.id],
              })
            : ruleSet,
        );
      }

      return {
        ...workspace,
        rules,
        ruleSets,
      };
    });
  }

  async importWorkspace(payload: ImportWorkspacePayload): Promise<WorkspaceSnapshot> {
    const imported = parseWorkspace(payload.content, payload.format);
    if (!payload.merge) {
      return this.writeWorkspace(imported);
    }

    return this.mutateWorkspace((workspace) => mergeWorkspaces(workspace, imported));
  }

  async exportWorkspace(projectId: string, format: SupportedExportFormat): Promise<ExportWorkspaceResponse> {
    const workspace = await this.readWorkspace();
    const scopedRuleSets = workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === projectId);
    const allowedRuleIds = new Set(scopedRuleSets.flatMap((ruleSet) => ruleSet.ruleIds));
    const scopedWorkspace: WorkspaceSnapshot = {
      version: workspace.version,
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
    const timestamp = new Date();
    const enriched: HitRecord = {
      ...record,
      id: randomUUID(),
      occurredAt: timestamp.toISOString(),
    };
    const file = join(this.logsDir, `${timestamp.toISOString().slice(0, 10)}.jsonl`);
    await appendFile(file, `${JSON.stringify(enriched)}\n`, "utf8");
    return enriched;
  }

  async listLogs(limit = 100, projectId?: string): Promise<HitRecord[]> {
    await this.init();
    const names = (await readdir(this.logsDir)).sort().reverse();
    const logs: HitRecord[] = [];

    for (const name of names) {
      const raw = await readFile(join(this.logsDir, name), "utf8");
      const entries = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as HitRecord)
        .filter((entry) => (projectId ? entry.projectId === projectId : true));
      logs.push(...entries.reverse());
      if (logs.length >= limit) {
        break;
      }
    }

    return logs.slice(0, limit);
  }

  private async mutateWorkspace(mutator: (workspace: WorkspaceSnapshot) => WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    const current = await this.readWorkspace();
    return this.writeWorkspace(mutator(current));
  }
}

function mergeWorkspaces(current: WorkspaceSnapshot, imported: WorkspaceSnapshot): WorkspaceSnapshot {
  return {
    version: Math.max(current.version, imported.version),
    updatedAt: new Date().toISOString(),
    projects: mergeArray(current.projects, imported.projects),
    ruleSets: mergeArray(current.ruleSets, imported.ruleSets),
    rules: mergeArray(current.rules, imported.rules),
  };
}

function mergeArray<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of current) {
    map.set(item.id, item);
  }
  for (const item of incoming) {
    map.set(item.id, item);
  }
  return Array.from(map.values());
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) {
    return [...items, item];
  }

  const next = [...items];
  next[index] = item;
  return next;
}

function stampUpdated<T extends { createdAt: string; updatedAt: string }>(item: T): T {
  const now = new Date().toISOString();
  return {
    ...item,
    createdAt: item.createdAt || now,
    updatedAt: now,
  };
}

function ensureProjectId(ruleSet: RuleSet, projectId: string): RuleSet {
  return {
    ...ruleSet,
    projectId,
  };
}
