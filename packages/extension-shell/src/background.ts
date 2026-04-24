import type {
  ExportWorkspaceResponse,
  ForwardRequestPayload,
  ImportWorkspacePayload,
  LogsResponse,
  ProjectsResponse,
  RulesResponse,
  RuleSet,
  RuntimeState,
  ServiceHealthResponse,
  SiteContextPayload,
  UpsertProjectPayload,
  UpsertRulePayload,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import {
  assertWorkspace,
  collectWorkspaceWarnings,
  createEmptyWorkspace,
  parseWorkspace,
  serializeWorkspace,
  toDynamicNetRequestRules,
  trimWorkspaceForUrl,
} from "@resource-forwarder/rule-core";
import type { DashboardState, RuntimeRequest } from "./shared/messages.js";
import { DEFAULT_SERVICE_URL, STORAGE_KEYS } from "./shared/constants.js";

// ── Runtime state ────────────────────────────────────────────────────────

let runtimeState: RuntimeState = {
  serviceUrl: DEFAULT_SERVICE_URL,
  health: null,
  workspace: createEmptyWorkspace(),
};
let runtimeWarnings: string[] = [];

// ── Extension lifecycle ──────────────────────────────────────────────────

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(() => {
  void syncWorkspace();
});

chrome.runtime.onStartup.addListener(() => {
  void syncWorkspace();
});

chrome.runtime.onMessage.addListener((message: RuntimeRequest, sender, sendResponse) => {
  void handleRuntimeMessage(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => {
      const raw = error instanceof Error ? error.message : "Unknown extension error.";
      const friendly = raw.includes("Failed to fetch")
        ? "操作已保存到本地，但服务端同步失败（服务离线）。"
        : raw;
      sendResponse({ __error: friendly });
    });
  return true;
});

// ── Message handler ──────────────────────────────────────────────────────

async function handleRuntimeMessage(message: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case "get-dashboard-state":
      return getDashboardState(message.tabId);
    case "sync-workspace":
      return syncWorkspace();
    case "set-service-url":
      await chrome.storage.local.set({ [STORAGE_KEYS.serviceUrl]: message.serviceUrl });
      runtimeState.serviceUrl = message.serviceUrl;
      return syncWorkspace();
    case "upsert-project":
      return handleUpsertProject(message.payload);
    case "delete-project":
      return handleDeleteProject(message.projectId);
    case "upsert-rule":
      return handleUpsertRule(message.payload);
    case "delete-rule":
      return handleDeleteRule(message.ruleId);
    case "get-logs":
      return serviceJson<LogsResponse>(
        `/logs?limit=${message.limit ?? 50}${message.projectId ? `&projectId=${encodeURIComponent(message.projectId)}` : ""}`,
      ).catch(() => ({ logs: [] }));
    case "import-workspace":
      return handleImportWorkspace(message.payload);
    case "export-workspace":
      return handleExportWorkspace(message.projectIds, message.format);
    case "get-site-context":
      return buildSiteContext(message.url, message.tabId ?? sender.tab?.id);
    case "proxy-request":
      return proxyRequest(message.payload);
    default:
      return null;
  }
}

// ── Local workspace CRUD (chrome.storage.local) ──────────────────────────

async function readLocalWorkspace(): Promise<WorkspaceSnapshot> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.workspace);
  const raw = stored[STORAGE_KEYS.workspace];
  if (raw && typeof raw === "object") {
    try {
      return assertWorkspace(raw);
    } catch { /* fall through */ }
  }
  return createEmptyWorkspace();
}

async function writeLocalWorkspace(workspace: WorkspaceSnapshot): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.workspace]: workspace });
}

async function isDirty(): Promise<boolean> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.workspaceDirty);
  return stored[STORAGE_KEYS.workspaceDirty] === true;
}

async function markDirty(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.workspaceDirty]: true });
}

async function clearDirty(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.workspaceDirty]: false });
}

interface PendingDelete {
  projectId: string;
  ruleIds: string[];
  ruleSetIds: string[];
}

async function readPendingDeletes(): Promise<PendingDelete[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.pendingDeletes);
  const raw = stored[STORAGE_KEYS.pendingDeletes];
  return Array.isArray(raw) ? raw : [];
}

async function appendPendingDelete(entry: PendingDelete): Promise<void> {
  const existing = await readPendingDeletes();
  existing.push(entry);
  await chrome.storage.local.set({ [STORAGE_KEYS.pendingDeletes]: existing });
}

async function clearPendingDeletes(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.pendingDeletes]: [] });
}

function applyPendingDeletesToWorkspace(workspace: WorkspaceSnapshot, deletes: PendingDelete[]): WorkspaceSnapshot {
  if (deletes.length === 0) return workspace;
  const projectIds = new Set(deletes.map((d) => d.projectId));
  const ruleIds = new Set(deletes.flatMap((d) => d.ruleIds));
  const ruleSetIds = new Set(deletes.flatMap((d) => d.ruleSetIds));
  return {
    ...workspace,
    projects: workspace.projects.filter((p) => !projectIds.has(p.id)),
    ruleSets: workspace.ruleSets.filter((rs) => !ruleSetIds.has(rs.id)),
    rules: workspace.rules.filter((r) => !ruleIds.has(r.id)),
  };
}

/**
 * Write workspace to local storage, update runtimeState, apply DNR rules,
 * and notify tabs. This is the single place to "commit" a workspace change.
 */
async function commitWorkspace(workspace: WorkspaceSnapshot, serviceUrl: string, health: ServiceHealthResponse | null): Promise<RuntimeState & { warnings: string[] }> {
  // Update in-memory state immediately so callers always get fresh data
  runtimeState = { serviceUrl, health, workspace };
  runtimeWarnings = collectWorkspaceWarnings(workspace);

  try { await writeLocalWorkspace(workspace); } catch (e) {
    runtimeWarnings.push(`本地存储写入失败：${e instanceof Error ? e.message : String(e)}`);
  }
  try { await applyDynamicRules(workspace); } catch (e) {
    runtimeWarnings.push(`DNR 规则应用失败：${e instanceof Error ? e.message : String(e)}`);
  }
  void notifyTabsToRefresh();

  return { ...runtimeState, warnings: runtimeWarnings };
}

// ── Sync: local-first, then try remote service ───────────────────────────

async function syncWorkspace(): Promise<RuntimeState & { warnings: string[] }> {
  const serviceUrl = await getServiceUrl();
  const health = await getHealth(serviceUrl);
  runtimeState.serviceUrl = serviceUrl;
  runtimeState.health = health;

  const localWorkspace = await readLocalWorkspace();

  if (!health) {
    runtimeWarnings = [
      localWorkspace.rules.length > 0
        ? `离线模式：使用浏览器本地存储的 ${localWorkspace.rules.length} 条规则。服务 ${serviceUrl} 不可用。`
        : `未连接到本地服务 ${serviceUrl}，请检查服务是否启动。`,
    ];
    return commitWorkspace(localWorkspace, serviceUrl, null);
  }

  const pendingDeletes = await readPendingDeletes();
  const hasPendingDeletes = pendingDeletes.length > 0;

  // Service is reachable — push dirty local changes first (merge mode preserves service-side edits)
  if (await isDirty()) {
    try {
      await serviceJson(`/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        serviceUrl,
        body: JSON.stringify({
          content: serializeWorkspace(localWorkspace, "json"),
          format: "json",
          merge: true,
        } satisfies ImportWorkspacePayload),
      });
      await clearDirty();
    } catch {
      // Push failed — keep dirty flag, use local data
      return commitWorkspace(localWorkspace, serviceUrl, health);
    }
  }

  // Pull latest from service — fall back to local if service goes away mid-sync
  let workspace: WorkspaceSnapshot;
  try {
    const [projects, rules] = await Promise.all([
      serviceJson<ProjectsResponse>("/projects", { serviceUrl }),
      serviceJson<RulesResponse>("/rules", { serviceUrl }),
    ]);
    workspace = {
      version: 1,
      updatedAt: maxUpdatedAt(projects.updatedAt, rules.updatedAt),
      projects: projects.projects,
      ruleSets: projects.ruleSets,
      rules: rules.rules,
    };
  } catch {
    return commitWorkspace(localWorkspace, serviceUrl, health);
  }

  // Apply pending deletes to the merged workspace, then push the clean result back
  if (hasPendingDeletes) {
    workspace = applyPendingDeletesToWorkspace(workspace, pendingDeletes);
    try {
      await serviceJson(`/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        serviceUrl,
        body: JSON.stringify({
          content: serializeWorkspace(workspace, "json"),
          format: "json",
          merge: false,
        } satisfies ImportWorkspacePayload),
      });
      await clearPendingDeletes();
    } catch {
      // Could not push deletes — keep them for next sync
    }
  }

  return commitWorkspace(workspace, serviceUrl, health);
}

// ── Write handlers: local-first, then best-effort push to service ────────

async function handleImportWorkspace(payload: ImportWorkspacePayload): Promise<RuntimeState & { warnings: string[] }> {
  let nextWorkspace: WorkspaceSnapshot;
  try {
    const imported = parseWorkspace(payload.content, payload.format ?? "json");
    const localWorkspace = await readLocalWorkspace();
    nextWorkspace = payload.merge ? mergeWorkspaces(localWorkspace, imported) : imported;
  } catch (e) {
    throw new Error(`解析导入数据失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const serviceUrl = await getServiceUrl();
  const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);

  // Fire-and-forget: push to service in background
  void pushToService(serviceUrl, payload).then(async (health) => {
    if (!health) { await markDirty(); } else { await clearDirty(); runtimeState.health = health; }
  }).catch(() => void markDirty());

  return result;
}

async function handleUpsertProject(payload: UpsertProjectPayload): Promise<RuntimeState & { warnings: string[] }> {
  const localWorkspace = await readLocalWorkspace();
  const nextWorkspace = applyUpsertProject(localWorkspace, payload);
  const serviceUrl = await getServiceUrl();

  const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);

  void tryServiceCall(serviceUrl, async () => {
    await serviceJson(`/projects/${payload.project.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      serviceUrl,
      body: JSON.stringify(payload),
    });
  }).then(async (health) => {
    if (!health) { await markDirty(); } else { await clearDirty(); runtimeState.health = health; }
  }).catch(() => markDirty());

  return result;
}

async function handleDeleteProject(projectId: string): Promise<RuntimeState & { warnings: string[] }> {
  const localWorkspace = await readLocalWorkspace();

  const affectedRuleSets = localWorkspace.ruleSets.filter((rs) => rs.projectId === projectId);
  const ruleIdsToRemove = new Set(affectedRuleSets.flatMap((rs) => rs.ruleIds));

  const pendingEntry: PendingDelete = {
    projectId,
    ruleIds: [...ruleIdsToRemove],
    ruleSetIds: affectedRuleSets.map((rs) => rs.id),
  };

  const nextWorkspace: WorkspaceSnapshot = {
    ...localWorkspace,
    projects: localWorkspace.projects.filter((p) => p.id !== projectId),
    ruleSets: localWorkspace.ruleSets.filter((rs) => rs.projectId !== projectId),
    rules: localWorkspace.rules.filter((r) => !ruleIdsToRemove.has(r.id)),
  };

  const serviceUrl = await getServiceUrl();

  const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);

  void pushWorkspaceReplace(serviceUrl, nextWorkspace).then(async (health) => {
    if (!health) {
      await appendPendingDelete(pendingEntry);
      await markDirty();
    } else {
      await clearPendingDeletes();
      await clearDirty();
      runtimeState.health = health;
    }
  }).catch(async () => {
    await appendPendingDelete(pendingEntry);
    await markDirty();
  });

  return result;
}

async function handleUpsertRule(payload: UpsertRulePayload): Promise<RuntimeState & { warnings: string[] }> {
  const localWorkspace = await readLocalWorkspace();
  const nextWorkspace = applyUpsertRule(localWorkspace, payload);
  const serviceUrl = await getServiceUrl();

  const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);

  void tryServiceCall(serviceUrl, async () => {
    await serviceJson(`/rules/${payload.rule.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      serviceUrl,
      body: JSON.stringify(payload),
    });
  }).then(async (health) => {
    if (!health) { await markDirty(); } else { await clearDirty(); runtimeState.health = health; }
  }).catch(() => markDirty());

  return result;
}

async function handleDeleteRule(ruleId: string): Promise<RuntimeState & { warnings: string[] }> {
  const localWorkspace = await readLocalWorkspace();
  const nextWorkspace: WorkspaceSnapshot = {
    ...localWorkspace,
    ruleSets: localWorkspace.ruleSets.map((rs) => ({
      ...rs,
      ruleIds: rs.ruleIds.filter((id) => id !== ruleId),
    })),
    rules: localWorkspace.rules.filter((r) => r.id !== ruleId),
    updatedAt: new Date().toISOString(),
  };

  const serviceUrl = await getServiceUrl();
  const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);

  void pushWorkspaceReplace(serviceUrl, nextWorkspace).then(async (health) => {
    if (!health) { await markDirty(); } else { await clearDirty(); runtimeState.health = health; }
  }).catch(() => markDirty());

  return result;
}

async function handleExportWorkspace(projectIds: string[], format: "json" | "yaml"): Promise<ExportWorkspaceResponse> {
  const workspace = await readLocalWorkspace();
  const exportAll = projectIds.length === 0;

  if (!exportAll && projectIds.length === 1) {
    try {
      return await serviceJson<ExportWorkspaceResponse>(
        `/export/${encodeURIComponent(projectIds[0])}?format=${encodeURIComponent(format)}`,
      );
    } catch { /* service unavailable, fall back to local */ }
  }

  const projectIdSet = new Set(projectIds);
  const scopedProjects = exportAll ? workspace.projects : workspace.projects.filter((p) => projectIdSet.has(p.id));
  const scopedProjectIds = new Set(scopedProjects.map((p) => p.id));
  const scopedRuleSets = workspace.ruleSets.filter((rs) => scopedProjectIds.has(rs.projectId));
  const allowedRuleIds = new Set(scopedRuleSets.flatMap((rs) => rs.ruleIds));
  const scopedWorkspace: WorkspaceSnapshot = {
    version: workspace.version,
    updatedAt: workspace.updatedAt,
    projects: scopedProjects,
    ruleSets: scopedRuleSets,
    rules: workspace.rules.filter((r) => allowedRuleIds.has(r.id)),
  };
  return { format, content: serializeWorkspace(scopedWorkspace, format) };
}

/**
 * Try a service call, return health if succeeded, null if failed.
 */
async function tryServiceCall(serviceUrl: string, fn: () => Promise<void>): Promise<ServiceHealthResponse | null> {
  const health = await getHealth(serviceUrl);
  if (!health) return null;
  try {
    await fn();
    return health;
  } catch {
    return null;
  }
}

async function pushToService(serviceUrl: string, payload: ImportWorkspacePayload): Promise<ServiceHealthResponse | null> {
  return tryServiceCall(serviceUrl, async () => {
    await serviceJson(`/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      serviceUrl,
      body: JSON.stringify(payload),
    });
  });
}

async function pushWorkspaceReplace(serviceUrl: string, workspace: WorkspaceSnapshot): Promise<ServiceHealthResponse | null> {
  return pushToService(serviceUrl, {
    content: serializeWorkspace(workspace, "json"),
    format: "json",
    merge: false,
  });
}

// ── Dashboard state ──────────────────────────────────────────────────────

async function getDashboardState(tabId?: number): Promise<DashboardState> {
  if (runtimeState.workspace.rules.length === 0) {
    try { await syncWorkspace(); } catch { /* use whatever runtimeState has */ }
  }

  const [{ logs }, currentTab] = await Promise.all([
    runtimeState.health
      ? serviceJson<LogsResponse>("/logs?limit=20").catch(() => ({ logs: [] as LogsResponse["logs"] }))
      : { logs: [] as LogsResponse["logs"] },
    getTabSnapshot(tabId),
  ]);

  return {
    ...runtimeState,
    warnings: runtimeWarnings,
    logs,
    currentTab,
  };
}

// ── Site context / proxy ─────────────────────────────────────────────────

async function buildSiteContext(url: string, tabId?: number): Promise<SiteContextPayload> {
  if (runtimeState.workspace.rules.length === 0 && runtimeState.health === null) {
    await syncWorkspace().catch(() => undefined);
  }

  const scopedWorkspace = trimWorkspaceForUrl(runtimeState.workspace, url, tabId);
  return {
    serviceUrl: runtimeState.serviceUrl,
    workspace: scopedWorkspace,
    currentUrl: url,
    tabId,
    warnings: collectWorkspaceWarnings(scopedWorkspace),
  };
}

async function proxyRequest(payload: ForwardRequestPayload) {
  const response = await serviceFetch(`/forward`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `Forward request failed with ${response.status}.`);
  }

  return response.json();
}

// ── Tab / health / service helpers ───────────────────────────────────────

async function getTabSnapshot(tabId?: number): Promise<DashboardState["currentTab"]> {
  let tab: chrome.tabs.Tab | undefined;
  if (typeof tabId === "number") {
    tab = await chrome.tabs.get(tabId).catch(() => undefined);
  } else {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = activeTab;
  }

  if (!tab?.url) {
    return undefined;
  }

  return {
    id: tab.id,
    url: tab.url,
    host: safeHost(tab.url),
  };
}

async function getHealth(serviceUrl: string): Promise<ServiceHealthResponse | null> {
  try {
    const response = await serviceFetch("/health", { serviceUrl });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as ServiceHealthResponse;
  } catch {
    return null;
  }
}

async function getServiceUrl(): Promise<string> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.serviceUrl);
  return typeof stored[STORAGE_KEYS.serviceUrl] === "string"
    ? stored[STORAGE_KEYS.serviceUrl]
    : DEFAULT_SERVICE_URL;
}

async function serviceJson<T>(path: string, init?: RequestInit & { serviceUrl?: string }): Promise<T> {
  const response = await serviceFetch(path, init);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `Service request failed with ${response.status}.`);
  }
  return (await response.json()) as T;
}

async function serviceFetch(path: string, init?: RequestInit & { serviceUrl?: string }): Promise<Response> {
  const serviceUrl = init?.serviceUrl ?? runtimeState.serviceUrl ?? (await getServiceUrl());
  const url = new URL(path, serviceUrl).toString();
  return fetch(url, init);
}

async function applyDynamicRules(workspace: WorkspaceSnapshot): Promise<void> {
  const nextRules = toDynamicNetRequestRules(workspace);
  const stored = await chrome.storage.local.get(STORAGE_KEYS.managedRuleIds);
  const removeRuleIds = Array.isArray(stored[STORAGE_KEYS.managedRuleIds])
    ? (stored[STORAGE_KEYS.managedRuleIds] as number[])
    : [];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: nextRules as chrome.declarativeNetRequest.Rule[],
  });

  await chrome.storage.local.set({
    [STORAGE_KEYS.managedRuleIds]: nextRules.map((rule) => rule.id),
  });
}

async function notifyTabsToRefresh(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number" && typeof tab.url === "string" && /^https?:/.test(tab.url))
      .map((tab) => chrome.tabs.sendMessage(tab.id!, { type: "refresh-site-context" }).catch(() => undefined)),
  );
}

// ── Pure workspace mutation helpers (ported from forwarder-service) ───────

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
  for (const item of current) map.set(item.id, item);
  for (const item of incoming) map.set(item.id, item);
  return Array.from(map.values());
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((c) => c.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function stampUpdated<T extends { createdAt: string; updatedAt: string }>(item: T): T {
  const now = new Date().toISOString();
  return { ...item, createdAt: item.createdAt || now, updatedAt: now };
}

function ensureProjectId(ruleSet: RuleSet, projectId: string): RuleSet {
  return { ...ruleSet, projectId };
}

function applyUpsertProject(workspace: WorkspaceSnapshot, payload: UpsertProjectPayload): WorkspaceSnapshot {
  const projects = upsertById(workspace.projects, stampUpdated(payload.project));
  let ruleSets = workspace.ruleSets;
  if (payload.ruleSets) {
    for (const rs of payload.ruleSets.map(stampUpdated)) {
      ruleSets = upsertById(ruleSets, ensureProjectId(rs, payload.project.id));
    }
  }
  return { ...workspace, projects, ruleSets, updatedAt: new Date().toISOString() };
}

function applyUpsertRule(workspace: WorkspaceSnapshot, payload: UpsertRulePayload): WorkspaceSnapshot {
  const rules = upsertById(workspace.rules, stampUpdated(payload.rule));
  let ruleSets = workspace.ruleSets.map((rs) => ({
    ...rs,
    ruleIds: rs.ruleIds.filter((id) => id !== payload.rule.id),
  }));
  if (payload.ruleSetId) {
    ruleSets = ruleSets.map((rs) =>
      rs.id === payload.ruleSetId
        ? stampUpdated({ ...rs, ruleIds: [...rs.ruleIds, payload.rule.id] })
        : rs,
    );
  }
  return { ...workspace, rules, ruleSets, updatedAt: new Date().toISOString() };
}

// ── Misc helpers ─────────────────────────────────────────────────────────

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function maxUpdatedAt(...values: string[]): string {
  return values.sort().at(-1) ?? new Date().toISOString();
}
