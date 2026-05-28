import { mkdir, readFile, readdir, writeFile, appendFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ExportWorkspaceResponse,
  HitRecord,
  ImportWorkspacePayload,
  RuleSet,
  SupportedExportFormat,
  UpsertProjectPayload,
  UpsertRulePayload,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import {
  applyUpsertProject,
  applyUpsertRule,
  applyUpsertRuleSet,
  createEmptyWorkspace,
  mergeWorkspaces,
  parseWorkspace,
  planDeleteRuleSet,
  serializeWorkspace,
} from "@resource-forwarder/rule-core";
import { SecretsManager } from "./secrets.js";

export class WorkspaceStorage {
  private readonly workspaceFile: string;
  private readonly logsDir: string;
  private readonly secrets: SecretsManager;

  constructor(readonly rootDir: string) {
    this.workspaceFile = join(rootDir, "workspace.json");
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
      // First-time setup: write an empty snapshot directly. This cannot deadlock
      // on the writeChain because init() runs before any handler is registered.
      await this.atomicWriteWorkspace(createEmptyWorkspace());
    }
  }

  async readWorkspace(): Promise<WorkspaceSnapshot> {
    await this.init();
    return this.readWorkspaceSafely();
  }

  /**
   * Read + parse with crash-recovery semantics. If workspace.json was somehow
   * truncated (process killed mid-write before tmp+rename landed in 0.x, a
   * corrupted backup restored over the top, manual edit gone wrong) we MUST
   * NOT 5xx every subsequent request — that turns a recoverable file issue
   * into a service outage. Instead, snapshot the bad file aside for forensics,
   * write a fresh empty workspace, and continue serving.
   */
  private async readWorkspaceSafely(): Promise<WorkspaceSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.workspaceFile, "utf8");
    } catch (error) {
      // ENOENT after init() is unexpected (init creates the file) but recover
      // gracefully anyway — the next mutation will recreate it.
      if (isNodeError(error) && error.code !== "ENOENT") throw error;
      return createEmptyWorkspace();
    }

    try {
      const parsed = parseWorkspace(raw, "json");
      // Hydrate `secret:<id>` refs back to cleartext for in-process callers.
      // The proxy + matcher always see the real Authorization values; the
      // redaction is purely a disk-format concern.
      return await this.secrets.hydrateWorkspace(parsed);
    } catch (parseError) {
      const quarantineFile = `${this.workspaceFile}.corrupt.${Date.now()}`;
      try {
        await writeFile(quarantineFile, raw, "utf8");
      } catch {
        // If we can't even write the quarantine file the disk is hopeless —
        // there's nothing useful to do but still return a usable snapshot.
      }
      const fresh = createEmptyWorkspace();
      await this.atomicWriteWorkspace(fresh);
      // Surface this loudly so an operator notices in the service log; the
      // route handlers still see a valid workspace and won't 5xx.
      // eslint-disable-next-line no-console
      console.error(
        `[forwarder-service] workspace.json was unparseable; quarantined to ${quarantineFile} and reset to empty.`,
        parseError,
      );
      return fresh;
    }
  }

  async writeWorkspace(workspace: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
    await this.init();
    const normalized: WorkspaceSnapshot = {
      ...workspace,
      updatedAt: new Date().toISOString(),
    };
    // Two concurrent route handlers (e.g. PUT /projects + POST /import) hit the
    // same file. Without serialization they read the same baseline and one
    // commit silently disappears. Funneling through writeChain guarantees
    // last-write-wins reflects only sequential state transitions.
    return this.serialize(async () => {
      await this.atomicWriteWorkspace(normalized);
      return normalized;
    });
  }

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
    if (!payload.merge) {
      return this.writeWorkspace(imported);
    }

    return this.mutateWorkspace((workspace) => mergeWorkspaces(workspace, imported));
  }

  async appendHits(records: Array<Omit<HitRecord, "id" | "occurredAt">>): Promise<HitRecord[]> {
    if (records.length === 0) return [];
    const enriched = records.map((record) => ({
      ...record,
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
    }));
    // Group by daily file so we minimise filesystem syscalls when the queue
    // straddles midnight (rare, but cheap to guard against).
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
    // Clamp to a hard upper bound so a malicious or accidental ?limit=10000000
    // can't force the service to slurp every JSONL file into memory.
    const effectiveLimit = Math.max(0, Math.min(limit, MAX_LOGS_PAGE_SIZE));
    if (effectiveLimit === 0) return [];

    const names = (await readdir(this.logsDir)).sort().reverse();
    const logs: HitRecord[] = [];

    for (const name of names) {
      const raw = await readFile(join(this.logsDir, name), "utf8");
      const entries: HitRecord[] = [];
      // Iterate from the tail so we can early-exit before parsing the whole
      // day. JSONL is append-only so newest records sit at the bottom.
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
    await this.init();
    return this.serialize(async () => {
      // Read inside the serialize block so we observe the result of any
      // previously serialized write — otherwise two concurrent mutateWorkspace
      // calls can both read the same baseline and the second would clobber
      // the first. readWorkspaceSafely also handles a corrupted file by
      // resetting to empty, which is what we want for a fresh mutate cycle.
      const current = await this.readWorkspaceSafely();
      const next: WorkspaceSnapshot = {
        ...mutator(current),
        updatedAt: new Date().toISOString(),
      };
      await this.atomicWriteWorkspace(next);
      return next;
    });
  }

  // ── Internal serialization & atomic IO ────────────────────────────────

  private initPromise: Promise<void> | undefined;
  private writeChain: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Persist the workspace snapshot via tmp + rename so a crash or process kill
   * mid-write cannot leave behind a half-written workspace.json. POSIX rename
   * is atomic on the same filesystem, which all sensible storage layouts are.
   */
  private async atomicWriteWorkspace(workspace: WorkspaceSnapshot): Promise<void> {
    // Move sensitive header values out to secrets.json before serialising.
    // This must happen INSIDE atomicWriteWorkspace so the redaction always
    // matches the bytes we land on disk — no caller can accidentally bypass it.
    const redacted = await this.secrets.redactWorkspace(workspace);
    const tmp = `${this.workspaceFile}.${process.pid}.tmp`;
    await writeFile(tmp, serializeWorkspace(redacted, "json"), "utf8");
    await rename(tmp, this.workspaceFile);
  }
}

const MAX_LOGS_PAGE_SIZE = 1000;

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}
