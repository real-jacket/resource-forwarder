import type {
  ExportWorkspaceResponse,
  ForwardRequestPayload,
  HitRecord,
  ImportWorkspacePayload,
  LogsResponse,
  MutationResponse,
  RuleSet,
  RuntimeState,
  ServiceHealthResponse,
  ServiceWorkspaceResponse,
  SiteContextPayload,
  UpsertProjectPayload,
  UpsertRulePayload,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import {
  applyPendingDeletions,
  applyUpsertProject,
  applyUpsertRule,
  applyUpsertRuleSet,
  assertWorkspace,
  collectWorkspaceWarnings,
  createEmptyWorkspace,
  emptyPendingDeletions,
  isAgentManagedProject,
  isPendingDeletionsEmpty,
  mergePendingDeletions,
  mergeUserOwnedSlice,
  parseWorkspace,
  planDeleteProject,
  planDeleteRule,
  planDeleteRuleSet,
  resolveRuleBinding,
  serializeWorkspace,
  trimWorkspaceForUrl,
  workspaceWithoutAgentManaged,
  type PendingDeletions,
} from "@resource-forwarder/rule-core";
import { needsPageBridge } from "./page-bridge-policy.js";
import type { DashboardState, RuntimeRequest } from "./shared/messages.js";
import { DEFAULT_SERVICE_URL, SERVICE_OFFLINE_SENTINEL, STORAGE_KEYS } from "./shared/constants.js";
import { buildDynamicRuleUpdatePlan, buildScopedDnrRuleGroups } from "./dnr.js";
import { normalizeProxyRequestError } from "./shared/service-errors.js";
import { buildCookieHeader, shouldAttachBrowserCookies } from "./cookie-forwarding.js";
import {
  chooseForwardExecution,
  executeInBrowser,
  resolveForwardBinding,
  STREAMING_UNSUPPORTED,
} from "./forward-executor.js";
import { reconcileAgentManagedSubtrees, replaceUserOwnedSlice, userOwnedSlice } from "./agent-reconciliation.js";

// ── Runtime state ────────────────────────────────────────────────────────

let runtimeState: RuntimeState = {
  serviceUrl: DEFAULT_SERVICE_URL,
  health: null,
  workspace: createEmptyWorkspace(),
};
let runtimeWarnings: string[] = [];
let lastServiceRevision: number | undefined;
let lastAppliedDnrFingerprint: string | undefined;
let browserLogChain: Promise<void> = Promise.resolve();
let localRuntimeHydrated = false;
let localRuntimeHydration: Promise<void> | undefined;
let syncWorkspacePromise: Promise<RuntimeState & { warnings: string[] }> | undefined;

// Serialize write handlers so two concurrent runtime messages can't read the
// same base workspace and clobber each other's edits. Read paths (proxyRequest,
// buildSiteContext, getDashboardState, syncWorkspace) intentionally stay out
// of this lock so an in-flight upsert never delays a forwarded request.
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

// ── Extension lifecycle ──────────────────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) {
    void chrome.sidePanel.open({ tabId: tab.id });
  }
});

// MV3 service workers are killed after ~30s of idleness, so in-memory DNR
// fingerprints, AbortControllers, and timers disappear on restart. Wake-up
// handling therefore reconciles persistent DNR state and pending workspace
// sync; aborts remain intentionally limited to the current worker lifetime.
const RECONCILE_ALARM = "resource-forwarder:reconcile";

chrome.runtime.onInstalled.addListener(() => {
  void onWorkerWake("install");
});

chrome.runtime.onStartup.addListener(() => {
  void onWorkerWake("startup");
});

void chrome.alarms.create(RECONCILE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONCILE_ALARM) {
    void onWorkerWake("alarm");
  }
});

async function onWorkerWake(reason: "install" | "startup" | "alarm"): Promise<void> {
  // Force a DNR reconcile on every wake even if the workspace hasn't changed —
  // chrome.declarativeNetRequest is persistent and a previous worker incarnation
  // may have left stale rules (e.g. apply failed before the worker died, or the
  // rule set was authored externally). Module-level state is already undefined
  // here, but we set it explicitly to keep the contract clear for future readers
  // / refactors that might move this state elsewhere.
  lastAppliedDnrFingerprint = undefined;
  // Always sync on wake so dirty pending ops eventually drain even if no UI
  // surface has triggered a manual sync. The alarm path makes this a soft
  // periodic retry; install/startup runs once at the obvious points.
  await syncWorkspace().catch(() => undefined);
  void reason;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    void refreshDnrForNavigation(tabId, changeInfo.url);
  } else if (changeInfo.status === "loading") {
    scheduleDnrRefresh();
  }
});

chrome.tabs.onRemoved.addListener(() => {
  scheduleDnrRefresh();
});

// SPA route changes don't fire tabs.onUpdated, so refresh the content script in
// the exact frame that navigated. DNR tab eligibility is page-level and only
// needs recalculation for the main frame.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0) void refreshDnrForNavigation(details.tabId, details.url);
  void chrome.tabs.sendMessage(
    details.tabId,
    { type: "refresh-site-context" },
    { frameId: details.frameId },
  ).catch(() => undefined);
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  if (details.frameId === 0) void refreshDnrForNavigation(details.tabId, details.url);
  void chrome.tabs.sendMessage(
    details.tabId,
    { type: "refresh-site-context" },
    { frameId: details.frameId },
  ).catch(() => undefined);
});

// Coalesce bulk events that do not carry a destination URL, such as tab-close
// bursts and loading notifications. URL-bearing navigation events update DNR
// immediately with their destination URL.
const DNR_REFRESH_DEBOUNCE_MS = 200;
let dnrRefreshTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleDnrRefresh(): void {
  if (dnrRefreshTimer !== undefined) {
    clearTimeout(dnrRefreshTimer);
  }
  dnrRefreshTimer = setTimeout(() => {
    dnrRefreshTimer = undefined;
    void refreshDnrForTabs();
  }, DNR_REFRESH_DEBOUNCE_MS);
}

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
    case "get-sidepanel-state":
      return getSidepanelState(message.tabId);
    case "sync-workspace":
      return syncWorkspace();
    case "set-service-url":
      await chrome.storage.local.set({ [STORAGE_KEYS.serviceUrl]: message.serviceUrl });
      runtimeState.serviceUrl = message.serviceUrl;
      return syncWorkspace();
    case "set-service-token":
      await chrome.storage.local.set({ [STORAGE_KEYS.serviceToken]: message.token });
      // The new token may unblock previously-401'd /import or /forward retries —
      // sync immediately so the user sees the effect on the dashboard.
      return syncWorkspace();
    case "upsert-project":
      return handleUpsertProject(message.payload);
    case "delete-project":
      return handleDeleteProject(message.projectId);
    case "upsert-rule":
      return handleUpsertRule(message.payload);
    case "delete-rule":
      return handleDeleteRule(message.ruleId);
    case "upsert-rule-set":
      return handleUpsertRuleSet(message.payload);
    case "delete-rule-set":
      return handleDeleteRuleSet(message.ruleSetId);
    case "get-logs":
      return getCombinedLogs(message.limit ?? 50, message.projectId);
    case "diagnose-match":
      return serviceJson("/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message.payload),
      });
    case "import-workspace":
      return handleImportWorkspace(message.payload);
    case "export-workspace":
      return handleExportWorkspace(message.projectIds, message.format);
    case "get-site-context":
      return buildSiteContext(message.url, sender, message.bridgeInstalled);
    case "proxy-request":
      return proxyRequest(message.requestId, message.payload);
    case "proxy-abort":
      abortInflight(message.requestId);
      return null;
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

// Pending push tracking. Each scheduled async push gets a unique id stored in
// chrome.storage. Dirty == set non-empty. Critical: a boolean flag conflates
// multiple in-flight pushes — if push A succeeds while push B is still running
// (or has already failed), clearing the flag would falsely advertise a clean
// state. Tracking individual ops removes that race entirely.
async function readPendingPushOps(): Promise<string[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.workspaceDirty);
  const raw = stored[STORAGE_KEYS.workspaceDirty];
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string");
  // Backwards compat: old boolean value gets folded into a single sentinel op
  // so a freshly upgraded extension still treats existing dirty state as dirty.
  if (raw === true) return ["__legacy_dirty__"];
  return [];
}


async function clearPendingPushOp(opId: string): Promise<void> {
  await mutatePendingPushOps((ops) => ops.filter((id) => id !== opId));
}

async function markPushFailed(opId: string): Promise<void> {
  // Keep the op alive so the next syncWorkspace knows there is still pending
  // local state to push. The op id is opaque — only the count matters.
  await mutatePendingPushOps((ops) => (ops.includes(opId) ? ops : [...ops, opId]));
}

async function mutatePendingPushOps(updater: (ops: string[]) => string[]): Promise<void> {
  // Mutations have to be serialized against each other because chrome.storage
  // does not give us a CAS primitive. The writeChain already guarantees no two
  // mutators interleave their read-modify-write.
  return withWriteLock(async () => {
    const current = await readPendingPushOps();
    const next = updater(current);
    await chrome.storage.local.set({ [STORAGE_KEYS.workspaceDirty]: next });
  });
}

function createOpId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function readPendingDeletions(): Promise<PendingDeletions> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.pendingDeletes);
  const raw = stored[STORAGE_KEYS.pendingDeletes];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const candidate = raw as Partial<PendingDeletions>;
    return {
      projectIds: Array.isArray(candidate.projectIds) ? candidate.projectIds : [],
      ruleSetIds: Array.isArray(candidate.ruleSetIds) ? candidate.ruleSetIds : [],
      ruleIds: Array.isArray(candidate.ruleIds) ? candidate.ruleIds : [],
    };
  }
  // Backwards compat: previous shape was PendingDelete[] keyed on projectId.
  if (Array.isArray(raw)) {
    let merged = emptyPendingDeletions();
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      merged = mergePendingDeletions(merged, {
        projectIds: typeof entry.projectId === "string" ? [entry.projectId] : [],
        ruleSetIds: Array.isArray(entry.ruleSetIds) ? entry.ruleSetIds : [],
        ruleIds: Array.isArray(entry.ruleIds) ? entry.ruleIds : [],
      });
    }
    return merged;
  }
  return emptyPendingDeletions();
}

async function appendPendingDeletions(extra: Partial<PendingDeletions>): Promise<void> {
  // Read-modify-write under the write lock: two concurrent .catch handlers
  // from different delete operations would otherwise overwrite each other.
  return withWriteLock(async () => {
    const current = await readPendingDeletions();
    await chrome.storage.local.set({
      [STORAGE_KEYS.pendingDeletes]: mergePendingDeletions(current, extra),
    });
  });
}

async function clearPendingDeletions(completed: PendingDeletions): Promise<void> {
  return withWriteLock(async () => {
    const current = await readPendingDeletions();
    const completedProjects = new Set(completed.projectIds);
    const completedRuleSets = new Set(completed.ruleSetIds);
    const completedRules = new Set(completed.ruleIds);
    await chrome.storage.local.set({
      [STORAGE_KEYS.pendingDeletes]: {
        projectIds: current.projectIds.filter((id) => !completedProjects.has(id)),
        ruleSetIds: current.ruleSetIds.filter((id) => !completedRuleSets.has(id)),
        ruleIds: current.ruleIds.filter((id) => !completedRules.has(id)),
      },
    });
  });
}

async function clearPendingPushOps(completed: string[]): Promise<void> {
  if (completed.length === 0) return;
  const completedSet = new Set(completed);
  await mutatePendingPushOps((ops) => ops.filter((id) => !completedSet.has(id)));
}

/**
 * Persist workspace, update runtime state, apply both DNR buckets, then notify
 * tabs. A service revision is ACKed only when local persistence succeeded and
 * applyDynamicRules resolved; offline/local-only snapshots and either DNR
 * failure never produce a browser-applied ACK.
 */
async function commitWorkspace(
  workspace: WorkspaceSnapshot,
  serviceUrl: string,
  health: ServiceHealthResponse | null,
  ackRevision?: number,
): Promise<RuntimeState & { warnings: string[] }> {
  const knownServiceRevision = lastServiceRevision ?? runtimeState.serviceRevision;
  if (ackRevision !== undefined && knownServiceRevision !== undefined && ackRevision < knownServiceRevision) {
    return { ...runtimeState, warnings: runtimeWarnings };
  }
  const warnings = collectWorkspaceWarnings(workspace);

  try {
    await writeLocalWorkspace(workspace);
  } catch (error) {
    warnings.push(`本地存储写入失败：${error instanceof Error ? error.message : String(error)}`);
    runtimeWarnings = warnings;
    runtimeState = { ...runtimeState, serviceUrl, health };
    localRuntimeHydrated = true;
    return { ...runtimeState, warnings };
  }

  if (ackRevision !== undefined) {
    const accepted = await setLastServiceRevision(ackRevision);
    if (!accepted) return { ...runtimeState, warnings: runtimeWarnings };
  }
  runtimeState = {
    ...runtimeState,
    serviceUrl,
    health,
    workspace,
    serviceRevision: ackRevision ?? lastServiceRevision,
  };
  runtimeWarnings = warnings;
  localRuntimeHydrated = true;

  try {
    await applyDynamicRules(runtimeState.workspace);
  } catch (error) {
    runtimeWarnings.push(`DNR 规则应用失败：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }

  if (health && ackRevision !== undefined) {
    try {
      await postAppliedRevision(serviceUrl, ackRevision);
    } catch (error) {
      runtimeWarnings.push(`浏览器应用 ACK 发送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await notifyTabsToRefresh();
  return { ...runtimeState, warnings: runtimeWarnings };
}

// ── Sync: local-first, then try remote service ───────────────────────────

function syncWorkspace(): Promise<RuntimeState & { warnings: string[] }> {
  if (!syncWorkspacePromise) {
    syncWorkspacePromise = performSyncWorkspace().finally(() => {
      syncWorkspacePromise = undefined;
    });
  }
  return syncWorkspacePromise;
}

async function performSyncWorkspace(): Promise<RuntimeState & { warnings: string[] }> {
  const serviceUrl = await getServiceUrl();
  const health = await getHealth(serviceUrl);
  runtimeState = { ...runtimeState, serviceUrl, health };

  const localWorkspace = await readLocalWorkspace();
  if (!health) {
    runtimeWarnings = [
      localWorkspace.rules.length > 0
        ? `浏览器模式：正在使用本地存储的 ${localWorkspace.rules.length} 条规则；可选 Companion ${serviceUrl} 未连接。`
        : `浏览器模式可直接使用；可选 Companion ${serviceUrl} 当前未连接。`,
    ];
    return commitWorkspace(localWorkspace, serviceUrl, null);
  }

  const pendingDeletions = await readPendingDeletions();
  const pendingPushOps = await readPendingPushOps();
  const dirty = pendingPushOps.length > 0;
  const localWithDeletions = applyPendingDeletions(localWorkspace, pendingDeletions);

  if (dirty || !isPendingDeletionsEmpty(pendingDeletions)) {
    try {
      if (!isPendingDeletionsEmpty(pendingDeletions)) {
        await syncPendingDeletions(serviceUrl, pendingDeletions);
      }
      if (dirty) {
        await sendGuardedMutation<MutationResponse>(serviceUrl, "/import", "POST", (revision) => ({
          content: serializeWorkspace(userOwnedSlice(localWithDeletions), "json"),
          format: "json",
          merge: true,
          ifRevision: revision,
        } satisfies ImportWorkspacePayload));
      }
      await clearPendingPushOps(pendingPushOps);
    } catch {
      try {
        const serviceWorkspace = await pullServiceWorkspace(serviceUrl);
        return commitWorkspace(
          reconcileAgentManagedSubtrees(localWithDeletions, serviceWorkspace),
          serviceUrl,
          health,
        );
      } catch {
        return commitWorkspace(localWithDeletions, serviceUrl, health);
      }
    }
  }

  try {
    const workspace = await pullServiceWorkspace(serviceUrl);
    return commitWorkspace(workspace, serviceUrl, health, workspace.revision);
  } catch {
    return commitWorkspace(reconcileAgentManagedSubtrees(localWorkspace, localWorkspace), serviceUrl, health);
  }
}

async function syncPendingDeletions(serviceUrl: string, pending: PendingDeletions): Promise<void> {
  let serviceWorkspace = await pullServiceWorkspace(serviceUrl);
  for (const projectId of pending.projectIds) {
    const project = serviceWorkspace.projects.find((candidate) => candidate.id === projectId);
    if (!project || isAgentManagedProject(project)) continue;
    const result = await sendGuardedMutation<MutationResponse>(serviceUrl, `/projects/${encodeURIComponent(projectId)}`, "DELETE", () => undefined);
    serviceWorkspace = result.workspace;
  }
  for (const ruleSetId of pending.ruleSetIds) {
    const ruleSet = serviceWorkspace.ruleSets.find((candidate) => candidate.id === ruleSetId);
    const project = ruleSet ? serviceWorkspace.projects.find((candidate) => candidate.id === ruleSet.projectId) : undefined;
    if (!ruleSet || (project && isAgentManagedProject(project))) continue;
    const result = await sendGuardedMutation<MutationResponse>(serviceUrl, `/rule-sets/${encodeURIComponent(ruleSetId)}`, "DELETE", () => undefined);
    serviceWorkspace = result.workspace;
  }
  for (const ruleId of pending.ruleIds) {
    const binding = resolveRuleBinding(serviceWorkspace, ruleId);
    if (!binding || (binding.project && isAgentManagedProject(binding.project))) continue;
    const result = await sendGuardedMutation<MutationResponse>(serviceUrl, `/rules/${encodeURIComponent(ruleId)}`, "DELETE", () => undefined);
    serviceWorkspace = result.workspace;
  }
  await clearPendingDeletions(pending);
}

// ── Write handlers: local-first, then best-effort push to service ────────

async function handleImportWorkspace(payload: ImportWorkspacePayload): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    let imported: WorkspaceSnapshot;
    const localWorkspace = await readLocalWorkspace();
    try {
      imported = parseWorkspace(payload.content, payload.format ?? "json");
    } catch (error) {
      throw new Error(`解析导入数据失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const nextWorkspace = payload.merge
      ? mergeUserOwnedSlice(localWorkspace, imported)
      : replaceUserOwnedSlice(localWorkspace, imported);
    const serviceUrl = await getServiceUrl();
    const result = await commitWorkspaceAndStartPush(
      nextWorkspace,
      serviceUrl,
      (opId) => sendGuardedMutation<MutationResponse>(serviceUrl, "/import", "POST", (revision) => ({
        content: serializeWorkspace(userOwnedSlice(nextWorkspace), "json"),
        format: "json",
        merge: true,
        ifRevision: revision,
      } satisfies ImportWorkspacePayload)).then((response) => recordMutationResult(opId, serviceUrl, response)),
    );
    return result;
  });
}

async function handleUpsertProject(payload: UpsertProjectPayload): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    if (isAgentManagedProject(payload.project)) throw new Error("agent-managed 项目为只读，请使用 agent control。");
    const localWorkspace = await readLocalWorkspace();
    if (localWorkspace.projects.some((project) => project.id === payload.project.id && isAgentManagedProject(project))) {
      throw new Error("agent-managed 项目为只读，请使用 agent control。");
    }
    const nextWorkspace = applyUpsertProject(localWorkspace, payload);
    const serviceUrl = await getServiceUrl();
    const result = await commitWorkspaceAndStartPush(
      nextWorkspace,
      serviceUrl,
      (opId) => sendGuardedMutation<MutationResponse>(serviceUrl, `/projects/${encodeURIComponent(payload.project.id)}`, "PUT", (revision) => ({
        ...payload,
        ifRevision: revision,
      })).then((response) => recordMutationResult(opId, serviceUrl, response)),
    );
    return result;
  });
}

async function handleDeleteProject(projectId: string): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const project = localWorkspace.projects.find((candidate) => candidate.id === projectId);
    if (project && isAgentManagedProject(project)) throw new Error("agent-managed 项目为只读，请使用 agent control。");
    const { workspace: nextWorkspace, deletions } = planDeleteProject(localWorkspace, projectId);
    const serviceUrl = await getServiceUrl();
    const result = await commitWorkspaceAndStartPush(
      nextWorkspace,
      serviceUrl,
      (opId) => sendGuardedMutation<MutationResponse>(serviceUrl, `/projects/${encodeURIComponent(projectId)}`, "DELETE", () => undefined)
        .then((response) => recordMutationResult(opId, serviceUrl, response))
        .catch(async (error) => {
          await appendPendingDeletions({
            projectIds: project && !isAgentManagedProject(project) ? deletions.projectIds : [],
            ruleSetIds: deletions.ruleSetIds,
            ruleIds: deletions.ruleIds,
          });
          throw error;
        }),
    );
    return result;
  });
}

async function handleUpsertRule(payload: UpsertRulePayload): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const existing = resolveRuleBinding(localWorkspace, payload.rule.id);
    const targetRuleSet = payload.ruleSetId
      ? localWorkspace.ruleSets.find((ruleSet) => ruleSet.id === payload.ruleSetId)
      : undefined;
    const targetProject = targetRuleSet
      ? localWorkspace.projects.find((project) => project.id === targetRuleSet.projectId)
      : undefined;
    if ((existing?.project && isAgentManagedProject(existing.project)) || (targetProject && isAgentManagedProject(targetProject))) {
      throw new Error("agent-managed 规则为只读，请使用 agent control。");
    }
    const nextWorkspace = applyUpsertRule(localWorkspace, payload);
    const serviceUrl = await getServiceUrl();
    const result = await commitWorkspaceAndStartPush(
      nextWorkspace,
      serviceUrl,
      (opId) => sendGuardedMutation<MutationResponse>(serviceUrl, `/rules/${encodeURIComponent(payload.rule.id)}`, "PUT", (revision) => ({
        ...payload,
        ifRevision: revision,
      })).then((response) => recordMutationResult(opId, serviceUrl, response)),
    );
    return result;
  });
}

async function handleDeleteRule(ruleId: string): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const binding = resolveRuleBinding(localWorkspace, ruleId);
    if (binding?.project && isAgentManagedProject(binding.project)) throw new Error("agent-managed 规则为只读，请使用 agent control。");
    const { workspace: nextWorkspace, deletions } = planDeleteRule(localWorkspace, ruleId);
    const serviceUrl = await getServiceUrl();
    const result = await commitWorkspaceAndStartPush(
      nextWorkspace,
      serviceUrl,
      (opId) => sendGuardedMutation<MutationResponse>(serviceUrl, `/rules/${encodeURIComponent(ruleId)}`, "DELETE", () => undefined)
        .then((response) => recordMutationResult(opId, serviceUrl, response))
        .catch(async (error) => {
          await appendPendingDeletions({ ruleIds: binding?.project && isAgentManagedProject(binding.project) ? [] : deletions.ruleIds });
          throw error;
        }),
    );
    return result;
  });
}

async function handleUpsertRuleSet(payload: { ruleSet: RuleSet }): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const existing = localWorkspace.ruleSets.find((candidate) => candidate.id === payload.ruleSet.id);
    const project = localWorkspace.projects.find((candidate) => candidate.id === payload.ruleSet.projectId);
    const existingProject = existing ? localWorkspace.projects.find((candidate) => candidate.id === existing.projectId) : undefined;
    if ((project && isAgentManagedProject(project)) || (existingProject && isAgentManagedProject(existingProject))) {
      throw new Error("agent-managed 分组为只读，请使用 agent control。");
    }
    const nextWorkspace = applyUpsertRuleSet(localWorkspace, payload.ruleSet);
    const serviceUrl = await getServiceUrl();
    const result = await commitWorkspaceAndStartPush(
      nextWorkspace,
      serviceUrl,
      (opId) => sendGuardedMutation<MutationResponse>(serviceUrl, `/rule-sets/${encodeURIComponent(payload.ruleSet.id)}`, "PUT", (revision) => ({
        ...payload,
        ifRevision: revision,
      })).then((response) => recordMutationResult(opId, serviceUrl, response)),
    );
    return result;
  });
}

async function handleDeleteRuleSet(ruleSetId: string): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const target = localWorkspace.ruleSets.find((ruleSet) => ruleSet.id === ruleSetId);
    const project = target ? localWorkspace.projects.find((candidate) => candidate.id === target.projectId) : undefined;
    if (project && isAgentManagedProject(project)) throw new Error("agent-managed 分组为只读，请使用 agent control。");
    const { workspace: nextWorkspace, deletions } = planDeleteRuleSet(localWorkspace, ruleSetId);
    const serviceUrl = await getServiceUrl();
    const result = await commitWorkspaceAndStartPush(
      nextWorkspace,
      serviceUrl,
      (opId) => sendGuardedMutation<MutationResponse>(serviceUrl, `/rule-sets/${encodeURIComponent(ruleSetId)}`, "DELETE", () => undefined)
        .then((response) => recordMutationResult(opId, serviceUrl, response))
        .catch(async (error) => {
          await appendPendingDeletions({
            ruleSetIds: project && isAgentManagedProject(project) ? [] : deletions.ruleSetIds,
            ruleIds: deletions.ruleIds,
          });
          throw error;
        }),
    );
    return result;
  });
}

interface RegisteredPush {
  opId: string;
  start: () => void;
}

async function registerPush(work: (opId: string) => Promise<void>): Promise<RegisteredPush> {
  const opId = createOpId();
  const ops = await readPendingPushOps();
  await chrome.storage.local.set({ [STORAGE_KEYS.workspaceDirty]: [...ops, opId] });
  return {
    opId,
    start: () => {
      void work(opId).catch(() => markPushFailed(opId));
    },
  };
}

async function commitWorkspaceAndStartPush(
  workspace: WorkspaceSnapshot,
  serviceUrl: string,
  work: (opId: string) => Promise<void>,
): Promise<RuntimeState & { warnings: string[] }> {
  const registration = await registerPush(work);
  const result = await commitWorkspace(workspace, serviceUrl, runtimeState.health);
  registration.start();
  return result;
}

async function recordMutationResult(opId: string, serviceUrl: string, response: MutationResponse): Promise<void> {
  await clearPendingPushOp(opId);
  const knownRevision = lastServiceRevision ?? runtimeState.serviceRevision ?? runtimeState.workspace.revision;
  if (response.revision < knownRevision) return;
  if (!(await setLastServiceRevision(response.revision))) return;
  const health = runtimeState.health ?? await getHealth(serviceUrl);
  await commitWorkspace(response.workspace, serviceUrl, health, health ? response.revision : undefined);
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
    revision: workspace.revision,
    updatedAt: workspace.updatedAt,
    projects: scopedProjects,
    ruleSets: scopedRuleSets,
    rules: workspace.rules.filter((r) => allowedRuleIds.has(r.id)),
  };
  return { format, content: serializeWorkspace(scopedWorkspace, format) };
}


// ── Dashboard state ──────────────────────────────────────────────────────

async function hydrateRuntimeStateFromLocal(): Promise<void> {
  if (localRuntimeHydrated) return;
  if (!localRuntimeHydration) {
    localRuntimeHydration = Promise.all([readLocalWorkspace(), getServiceUrl(), getLastServiceRevision()])
      .then(([workspace, serviceUrl, serviceRevision]) => {
        if (!localRuntimeHydrated) {
          runtimeState = { ...runtimeState, serviceUrl, workspace, serviceRevision };
          localRuntimeHydrated = true;
        }
      })
      .finally(() => {
        localRuntimeHydration = undefined;
      });
  }
  await localRuntimeHydration;
}

async function getSidepanelState(tabId?: number): Promise<DashboardState> {
  await hydrateRuntimeStateFromLocal();
  const [currentTab, dnrCounts] = await Promise.all([
    getTabSnapshot(tabId),
    readDnrRuleCounts(),
  ]);
  return {
    ...runtimeState,
    warnings: runtimeWarnings,
    logs: [],
    currentTab,
    dnrRuleCount: dnrCounts,
  };
}

async function getDashboardState(tabId?: number): Promise<DashboardState> {
  if (runtimeState.workspace.rules.length === 0) {
    try { await syncWorkspace(); } catch { /* use whatever runtimeState has */ }
  }

  const [{ logs }, currentTab, dnrCounts] = await Promise.all([
    getCombinedLogs(20),
    getTabSnapshot(tabId),
    readDnrRuleCounts(),
  ]);

  return {
    ...runtimeState,
    warnings: runtimeWarnings,
    logs,
    currentTab,
    dnrRuleCount: dnrCounts,
  };
}

async function readDnrRuleCounts(): Promise<{ dynamic: number; session: number }> {
  try {
    const [dynamic, session] = await Promise.all([
      chrome.declarativeNetRequest.getDynamicRules(),
      chrome.declarativeNetRequest.getSessionRules(),
    ]);
    return { dynamic: dynamic.length, session: session.length };
  } catch {
    return { dynamic: 0, session: 0 };
  }
}

// ── Site context / proxy ─────────────────────────────────────────────────
const pendingBridgeInjections = new Map<string, Promise<void>>();

async function buildSiteContext(
  url: string,
  sender: chrome.runtime.MessageSender,
  bridgeInstalled = false,
): Promise<SiteContextPayload> {
  if (runtimeState.workspace.rules.length === 0 && runtimeState.health === null) {
    await syncWorkspace().catch(() => undefined);
  }

  const tabId = sender.tab?.id;
  const scopedWorkspace = trimWorkspaceForUrl(runtimeState.workspace, url, tabId);
  if (needsPageBridge(scopedWorkspace) && !bridgeInstalled) {
    if (typeof tabId !== "number") {
      throw new Error("Cannot inject the page bridge without a sender tab.");
    }
    const frameId = sender.frameId ?? 0;
    const documentId = sender.documentId;
    const key = typeof documentId === "string"
      ? `${tabId}:document:${documentId}`
      : `${tabId}:frame:${frameId}`;
    let injection = pendingBridgeInjections.get(key);
    if (!injection) {
      const target = typeof documentId === "string"
        ? { tabId, documentIds: [documentId] }
        : { tabId, frameIds: [frameId] };
      injection = chrome.scripting.executeScript({
        target,
        files: ["page-bridge.js"],
        world: "MAIN",
      }).then(() => undefined).finally(() => pendingBridgeInjections.delete(key));
      pendingBridgeInjections.set(key, injection);
    }
    await injection;
  }
  return {
    serviceUrl: runtimeState.serviceUrl,
    workspace: scopedWorkspace,
    currentUrl: url,
    tabId,
    warnings: collectWorkspaceWarnings(scopedWorkspace),
  };
}

async function proxyRequest(requestId: string, payload: ForwardRequestPayload) {
  const controller = new AbortController();
  inflightForwards.set(requestId, controller);
  const startedAt = Date.now();
  let binding: ReturnType<typeof resolveForwardBinding> | undefined;
  let target = payload.url;
  let executionLocation: "browser" | "local" | undefined;

  try {
    binding = resolveForwardBinding(runtimeState.workspace, payload);
    const decision = chooseForwardExecution(binding);
    executionLocation = decision.location;
    if (decision.location === "browser") {
      const result = await executeInBrowser(binding, payload, controller.signal);
      target = result.targetUrl;
      void appendBrowserHit({
        requestUrl: payload.url,
        projectId: binding.project?.id,
        ruleSetId: binding.ruleSet?.id,
        ruleId: binding.rule.id,
        target,
        durationMs: Date.now() - startedAt,
        outcome: "matched",
        statusCode: result.response.status,
        method: payload.method,
        resourceType: payload.resourceType ?? "fetch",
      });
      return result.response;
    }

    // Only local-only or explicitly local rules depend on the companion.
    if (!runtimeState.health) {
      const probed = await getHealth(runtimeState.serviceUrl || (await getServiceUrl()));
      if (probed) {
        runtimeState.health = probed;
        void syncWorkspace().catch(() => undefined);
      } else {
        throw new Error(SERVICE_OFFLINE_SENTINEL);
      }
    }

    const enrichedPayload = await attachBrowserCookies(payload);
    const response = await serviceFetch(`/forward`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(enrichedPayload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(error.message || `Forward request failed with ${response.status}.`);
    }

    return await response.json();
  } catch (error) {
    const outcome = chooseOutcome(error);
    if (binding && executionLocation === "browser" && outcome !== undefined) {
      void appendBrowserHit({
        requestUrl: payload.url,
        projectId: binding.project?.id,
        ruleSetId: binding.ruleSet?.id,
        ruleId: binding.rule.id,
        target,
        durationMs: Date.now() - startedAt,
        outcome,
        errorMessage: outcome === "error" ? errorMessage(error) : undefined,
        method: payload.method,
        resourceType: payload.resourceType ?? "fetch",
      });
    }
    throw normalizeProxyRequestError(error);
  } finally {
    inflightForwards.delete(requestId);
  }
}

async function appendBrowserHit(entry: Omit<HitRecord, "id" | "occurredAt">): Promise<void> {
  browserLogChain = browserLogChain.then(async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.browserLogs);
      const current = Array.isArray(stored[STORAGE_KEYS.browserLogs])
        ? stored[STORAGE_KEYS.browserLogs] as HitRecord[]
        : [];
      const record: HitRecord = {
        ...entry,
        id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        occurredAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({
        [STORAGE_KEYS.browserLogs]: [record, ...current].slice(0, 200),
      });
    } catch {
      // Observability must never delay or fail the page request.
    }
  });
  await browserLogChain;
}

async function getCombinedLogs(limit: number, projectId?: string): Promise<LogsResponse> {
  await browserLogChain.catch(() => undefined);
  const stored: Record<string, unknown> = await chrome.storage.local
    .get(STORAGE_KEYS.browserLogs)
    .catch(() => ({}));
  const browserLogs = Array.isArray(stored[STORAGE_KEYS.browserLogs])
    ? stored[STORAGE_KEYS.browserLogs] as HitRecord[]
    : [];
  const serviceLogs = runtimeState.health
    ? await serviceJson<LogsResponse>(
        `/logs?limit=${limit}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`,
      ).then((result) => result.logs).catch(() => [] as HitRecord[])
    : [];
  const filtered = projectId ? browserLogs.filter((entry) => entry.projectId === projectId) : browserLogs;
  return {
    logs: [...filtered, ...serviceLogs]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, Math.max(1, limit)),
  };
}

function chooseOutcome(error: unknown): HitRecord["outcome"] | undefined {
  if (error instanceof DOMException && error.name === "AbortError") return undefined;
  return error instanceof Error && error.message === STREAMING_UNSUPPORTED ? "passed" : "error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Forwarding failed.";
}

async function attachBrowserCookies(payload: ForwardRequestPayload): Promise<ForwardRequestPayload> {
  const binding = payload.matchedRuleId
    ? resolveRuleBinding(runtimeState.workspace, payload.matchedRuleId)
    : undefined;
  if (!shouldAttachBrowserCookies(binding, payload)) return payload;

  try {
    const cookies = await chrome.cookies.getAll({ url: payload.url });
    const cookieHeader = buildCookieHeader(cookies);
    if (!cookieHeader) return payload;
    return {
      ...payload,
      headers: { ...payload.headers, Cookie: cookieHeader },
    };
  } catch {
    // Cookie access is best-effort. A missing permission or restricted scheme
    // must not break the rest of the forwarding path.
    return payload;
  }
}

const inflightForwards = new Map<string, AbortController>();

function abortInflight(requestId: string): void {
  const controller = inflightForwards.get(requestId);
  if (controller) {
    controller.abort();
    inflightForwards.delete(requestId);
  }
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
    const result = (await response.json()) as ServiceHealthResponse;
    // Detect "service just came back online" so dirty pending ops drain
    // automatically instead of waiting for the next user-triggered sync.
    if (!runtimeState.health && result?.ok) {
      void scheduleHealthRecoverySync();
    }
    return result;
  } catch {
    return null;
  }
}

let healthRecoveryScheduled = false;
function scheduleHealthRecoverySync(): void {
  if (healthRecoveryScheduled) return;
  healthRecoveryScheduled = true;
  // Defer to a microtask so the caller of getHealth gets to update
  // runtimeState.health before sync reads it (otherwise the recovery sync
  // would loop forever observing health === null).
  queueMicrotask(() => {
    healthRecoveryScheduled = false;
    void syncWorkspace().catch(() => undefined);
  });
}

async function getServiceUrl(): Promise<string> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.serviceUrl);
  return typeof stored[STORAGE_KEYS.serviceUrl] === "string"
    ? stored[STORAGE_KEYS.serviceUrl]
    : DEFAULT_SERVICE_URL;
}

async function getServiceToken(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.serviceToken);
  const value = stored[STORAGE_KEYS.serviceToken];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

class ServiceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly currentRevision: number | undefined,
    readonly workspace: WorkspaceSnapshot | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ServiceHttpError";
  }
}

async function serviceJson<T>(path: string, init?: RequestInit & { serviceUrl?: string }): Promise<T> {
  const response = await serviceFetch(path, init);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText })) as {
      code?: string;
      currentRevision?: number;
      message?: string;
      workspace?: WorkspaceSnapshot;
    };
    if (response.status === 401) {
      throw new Error("服务 token 校验失败，请在设置页重新粘贴 token。");
    }
    throw new ServiceHttpError(
      response.status,
      error.code,
      error.currentRevision,
      error.workspace,
      error.message || `Service request failed with ${response.status}.`,
    );
  }
  return (await response.json()) as T;
}

async function getLastServiceRevision(): Promise<number> {
  if (lastServiceRevision !== undefined) return lastServiceRevision;
  const stored = await chrome.storage.local.get(STORAGE_KEYS.serviceRevision);
  const value = stored[STORAGE_KEYS.serviceRevision];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    lastServiceRevision = value;
    return value;
  }
  return runtimeState.workspace.revision;
}

async function setLastServiceRevision(revision: number): Promise<boolean> {
  if (lastServiceRevision === undefined) lastServiceRevision = await getLastServiceRevision();
  if (runtimeState.serviceRevision !== undefined && runtimeState.serviceRevision > lastServiceRevision) {
    lastServiceRevision = runtimeState.serviceRevision;
  }
  if (revision < lastServiceRevision) return false;
  if (lastServiceRevision === revision) return true;
  lastServiceRevision = revision;
  await chrome.storage.local.set({ [STORAGE_KEYS.serviceRevision]: revision });
  return true;
}

async function pullServiceWorkspace(serviceUrl: string): Promise<WorkspaceSnapshot> {
  const response = await serviceJson<ServiceWorkspaceResponse>("/workspace", { serviceUrl });
  await setLastServiceRevision(response.revision);
  return response.workspace;
}

async function postAppliedRevision(serviceUrl: string, revision: number): Promise<void> {
  await serviceJson<{ appliedRevision: number }>("/applied", {
    method: "POST",
    headers: { "content-type": "application/json" },
    serviceUrl,
    body: JSON.stringify({ revision }),
  });
}

async function sendGuardedMutation<T extends MutationResponse>(
  serviceUrl: string,
  path: string,
  method: string,
  bodyFactory: (revision: number) => unknown,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revision = await getLastServiceRevision();
    const body = bodyFactory(revision);
    const headers: Record<string, string> = { "if-match": String(revision) };
    const init: RequestInit & { serviceUrl?: string } = { method, headers, serviceUrl };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    try {
      const result = await serviceJson<T>(path, init);
      if (typeof result.revision === "number") await setLastServiceRevision(result.revision);
      return result;
    } catch (error) {
      if (attempt === 0 && error instanceof ServiceHttpError && error.status === 409) {
        await pullServiceWorkspace(serviceUrl);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Service mutation retry exhausted.");
}

async function serviceFetch(path: string, init?: RequestInit & { serviceUrl?: string }): Promise<Response> {
  const serviceUrl = init?.serviceUrl ?? runtimeState.serviceUrl ?? (await getServiceUrl());
  const url = new URL(path, serviceUrl).toString();
  // /health intentionally does NOT require auth so the extension can probe the
  // service before the user has pasted a token. Every other endpoint must
  // attach the bearer.
  const isHealthProbe = path === "/health" || path.startsWith("/health?");
  const baseHeaders = (init?.headers ?? {}) as Record<string, string>;
  let headers: Record<string, string> = baseHeaders;
  if (!isHealthProbe) {
    const token = await getServiceToken();
    if (token) {
      headers = { ...baseHeaders, authorization: `Bearer ${token}` };
    }
  }
  return fetch(url, { ...init, headers });
}

interface PendingDnrApply {
  workspace: WorkspaceSnapshot;
  navigation?: { tabId: number; url: string };
  waiters: Array<{ resolve: () => void; reject: (reason?: unknown) => void }>;
}

let dnrApplyRunning = false;
let pendingDnrApply: PendingDnrApply | undefined;

function applyDynamicRules(
  workspace: WorkspaceSnapshot,
  navigation?: { tabId: number; url: string },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request: PendingDnrApply = { workspace, navigation, waiters: [{ resolve, reject }] };
    if (!dnrApplyRunning) {
      dnrApplyRunning = true;
      runDnrApply(request);
      return;
    }
    if (pendingDnrApply) request.waiters.unshift(...pendingDnrApply.waiters);
    pendingDnrApply = request;
  });
}

function runDnrApply(request: PendingDnrApply): void {
  void applyDynamicRulesNow(request.workspace, request.navigation)
    .then(
      () => request.waiters.forEach(({ resolve }) => resolve()),
      (error) => request.waiters.forEach(({ reject }) => reject(error)),
    )
    .finally(() => {
      const next = pendingDnrApply;
      pendingDnrApply = undefined;
      if (next) runDnrApply(next);
      else dnrApplyRunning = false;
    });
}

async function applyDynamicRulesNow(
  workspace: WorkspaceSnapshot,
  navigation?: { tabId: number; url: string },
): Promise<void> {
  const queriedTabs = await chrome.tabs.query({});
  const tabs = queriedTabs.map((tab) =>
    navigation && tab.id === navigation.tabId ? { ...tab, url: navigation.url } : tab,
  );
  if (navigation && !tabs.some((tab) => tab.id === navigation.tabId)) {
    tabs.push({ id: navigation.tabId, url: navigation.url } as chrome.tabs.Tab);
  }
  const { dynamicRules, sessionRules } = buildScopedDnrRuleGroups(workspace, tabs);

  // Chrome only accepts the `tabIds` condition on session-scoped rules. Keep
  // globally scoped redirects in the dynamic store and page-scoped redirects
  // in the session store so different projects do not share one tabId union.
  const fingerprint = `D|${JSON.stringify(dynamicRules)}|S|${JSON.stringify(sessionRules)}`;
  if (fingerprint === lastAppliedDnrFingerprint) {
    return;
  }

  // Source the IDs to remove from Chrome itself, not local storage. A buggy
  // earlier code path could have left rules installed without updating
  // managedRuleIds — those orphans would otherwise survive every refresh and
  // collide with new addRules entries.
  const [existingDynamic, existingSession] = await Promise.all([
    chrome.declarativeNetRequest.getDynamicRules(),
    chrome.declarativeNetRequest.getSessionRules(),
  ]);

  // Always remove every previously-installed rule before re-adding. Chrome
  // rejects updates with "duplicate rule ID" when an addRules entry conflicts
  // with an existing rule that isn't in removeRuleIds — there is no atomic
  // in-place replace. The fingerprint check above already skips no-op updates.
  const dynamicUpdate = buildDynamicRuleUpdatePlan(
    existingDynamic.map((r) => r.id),
    dynamicRules,
  );
  const sessionUpdate = buildDynamicRuleUpdatePlan(
    existingSession.map((r) => r.id),
    sessionRules,
  );

  // Run dynamic + session updates independently so a Chrome rejection in one
  // bucket (e.g. a single malformed urlFilter) doesn't cancel the other. Each
  // bucket is still all-or-nothing internally — Chrome has no partial-success
  // mode for updateDynamicRules — but at least the unrelated bucket survives.
  const results = await Promise.allSettled([
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: dynamicUpdate.removeRuleIds,
      addRules: dynamicUpdate.addRules as chrome.declarativeNetRequest.Rule[],
    }),
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: sessionUpdate.removeRuleIds,
      addRules: sessionUpdate.addRules as chrome.declarativeNetRequest.Rule[],
    }),
  ]);

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    // Reset the fingerprint so the next commitWorkspace / refreshDnrForTabs
    // tick re-attempts the same plan instead of being short-circuited by the
    // identical-fingerprint check. Without this, a single transient failure
    // (Chrome rate-limit, quota error) would leave DNR permanently out of sync
    // with the workspace until the worker restarts or the workspace changes.
    lastAppliedDnrFingerprint = undefined;
    const reasons = failures.map((f) => f.reason);
    for (const reason of reasons) {
      console.error("[resource-forwarder] DNR update failed:", reason);
    }
    const message = reasons
      .map((r) => (r instanceof Error ? r.message : String(r)))
      .join("; ");
    throw new Error(`DNR update failed: ${message}`);
  }

  lastAppliedDnrFingerprint = fingerprint;
  await chrome.storage.local.set({
    [STORAGE_KEYS.managedRuleIds]: [...dynamicRules, ...sessionRules].map((rule) => rule.id),
  });
}

/**
 * Re-apply DNR rules with updated tabIds based on current tab URLs.
 * Called when tabs navigate or close.
 */
async function refreshDnrForTabs(): Promise<void> {
  try {
    await applyDynamicRules(runtimeState.workspace);
  } catch { /* swallow — will retry on next navigation */ }
}

async function refreshDnrForNavigation(tabId: number, url: string): Promise<void> {
  try {
    await applyDynamicRules(runtimeState.workspace, { tabId, url });
  } catch { /* swallow — will retry on the next navigation or reconcile tick */ }
}

async function notifyTabsToRefresh(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => typeof tab.id === "number" && typeof tab.url === "string" && /^https?:/.test(tab.url))
      .map((tab) => chrome.tabs.sendMessage(tab.id!, { type: "refresh-site-context" }).catch(() => undefined)),
  );
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
