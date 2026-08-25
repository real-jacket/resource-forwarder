import type {
  ExportWorkspaceResponse,
  ForwardRequestPayload,
  HitRecord,
  ImportWorkspacePayload,
  LogsResponse,
  ProjectsResponse,
  RuleSet,
  RulesResponse,
  RuntimeState,
  ServiceHealthResponse,
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
  isPendingDeletionsEmpty,
  mergePendingDeletions,
  mergeWorkspaces,
  parseWorkspace,
  planDeleteProject,
  planDeleteRule,
  planDeleteRuleSet,
  resolveRuleBinding,
  serializeWorkspace,
  trimWorkspaceForUrl,
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

// ── Runtime state ────────────────────────────────────────────────────────

let runtimeState: RuntimeState = {
  serviceUrl: DEFAULT_SERVICE_URL,
  health: null,
  workspace: createEmptyWorkspace(),
};
let runtimeWarnings: string[] = [];
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
      return handleUpsertRuleSet(message.payload.ruleSet);
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

async function isDirty(): Promise<boolean> {
  return (await readPendingPushOps()).length > 0;
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

async function clearPendingDeletions(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.pendingDeletes]: emptyPendingDeletions() });
}

/**
 * Persist workspace, then update runtimeState, then apply DNR rules and notify
 * tabs. This is the single place to "commit" a workspace change.
 *
 * Persistence intentionally happens BEFORE the in-memory state mutation: if
 * chrome.storage.local fails (quota exceeded, transient error), runtimeState
 * keeps the last known-good snapshot and the failure surfaces as a warning,
 * so a subsequent syncWorkspace can recover instead of advertising a broken
 * snapshot to UI consumers.
 */
async function commitWorkspace(
  workspace: WorkspaceSnapshot,
  serviceUrl: string,
  health: ServiceHealthResponse | null,
): Promise<RuntimeState & { warnings: string[] }> {
  const warnings = collectWorkspaceWarnings(workspace);

  let persisted = true;
  try {
    await writeLocalWorkspace(workspace);
  } catch (e) {
    persisted = false;
    warnings.push(`本地存储写入失败：${e instanceof Error ? e.message : String(e)}`);
  }

  if (persisted) {
    runtimeState = { serviceUrl, health, workspace };
  } else {
    runtimeState = { ...runtimeState, serviceUrl, health };
  }
  runtimeWarnings = warnings;
  localRuntimeHydrated = true;

  try {
    await applyDynamicRules(runtimeState.workspace);
  } catch (e) {
    runtimeWarnings.push(`DNR 规则应用失败：${e instanceof Error ? e.message : String(e)}`);
  }
  void notifyTabsToRefresh();

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
  runtimeState.serviceUrl = serviceUrl;
  runtimeState.health = health;

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
  const hasPendingDeletions = !isPendingDeletionsEmpty(pendingDeletions);
  const dirty = await isDirty();

  // Service is reachable — push dirty local changes first.
  // When deletions are queued we MUST push as `merge: false` (replace mode):
  // a merge import only adds/updates entries, so deleted rules would silently
  // resurrect on the next pull. With `merge: true` the service would still
  // hold the deleted rule, we'd pull it back, and the user's "delete" would
  // appear to never have happened. This is the heart of the offline-resurrect
  // bug, fixed by preferring replace whenever pendingDeletions is non-empty.
  if (dirty || hasPendingDeletions) {
    const localWithDeletions = applyPendingDeletions(localWorkspace, pendingDeletions);
    try {
      await serviceJson(`/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        serviceUrl,
        body: JSON.stringify({
          content: serializeWorkspace(localWithDeletions, "json"),
          format: "json",
          merge: !hasPendingDeletions,
        } satisfies ImportWorkspacePayload),
      });
      await mutatePendingPushOps(() => []);
      if (hasPendingDeletions) await clearPendingDeletions();
    } catch {
      // Push failed — keep dirty/pending state, surface local data.
      return commitWorkspace(localWithDeletions, serviceUrl, health);
    }
  }

  // Pull latest from service — fall back to local if service goes away mid-sync.
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

  return commitWorkspace(workspace, serviceUrl, health);
}

// ── Write handlers: local-first, then best-effort push to service ────────

async function handleImportWorkspace(payload: ImportWorkspacePayload): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
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
    schedulePush((opId) => pushToService(serviceUrl, payload).then((health) => recordPushResult(opId, health)));
    return result;
  });
}

async function handleUpsertProject(payload: UpsertProjectPayload): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const nextWorkspace = applyUpsertProject(localWorkspace, payload);
    const serviceUrl = await getServiceUrl();

    const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);
    schedulePush((opId) =>
      tryServiceCall(serviceUrl, async () => {
        await serviceJson(`/projects/${payload.project.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          serviceUrl,
          body: JSON.stringify(payload),
        });
      }).then((health) => recordPushResult(opId, health)),
    );
    return result;
  });
}

async function handleDeleteProject(projectId: string): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const { workspace: nextWorkspace, deletions } = planDeleteProject(localWorkspace, projectId);

    const serviceUrl = await getServiceUrl();
    const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);

    schedulePush((opId) =>
      pushWorkspaceReplace(serviceUrl, nextWorkspace).then(async (health) => {
        if (!health) {
          await appendPendingDeletions(deletions);
          await markPushFailed(opId);
        } else {
          await clearPendingPushOp(opId);
          runtimeState.health = health;
        }
      }),
    );
    return result;
  });
}

async function handleUpsertRule(payload: UpsertRulePayload): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const nextWorkspace = applyUpsertRule(localWorkspace, payload);
    const serviceUrl = await getServiceUrl();

    const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);
    schedulePush((opId) =>
      tryServiceCall(serviceUrl, async () => {
        await serviceJson(`/rules/${payload.rule.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          serviceUrl,
          body: JSON.stringify(payload),
        });
      }).then((health) => recordPushResult(opId, health)),
    );
    return result;
  });
}

async function handleDeleteRule(ruleId: string): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const { workspace: nextWorkspace, deletions } = planDeleteRule(localWorkspace, ruleId);

    const serviceUrl = await getServiceUrl();
    const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);

    schedulePush((opId) =>
      pushWorkspaceReplace(serviceUrl, nextWorkspace).then(async (health) => {
        if (!health) {
          // Persist the deleted rule id so that even after a future merge-pull
          // brings the rule back from the service, syncWorkspace knows to
          // re-apply the removal before pushing replace mode.
          await appendPendingDeletions(deletions);
          await markPushFailed(opId);
        } else {
          await clearPendingPushOp(opId);
          runtimeState.health = health;
        }
      }),
    );
    return result;
  });
}

async function handleUpsertRuleSet(ruleSet: RuleSet): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const nextWorkspace = applyUpsertRuleSet(localWorkspace, ruleSet);
    const serviceUrl = await getServiceUrl();

    const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);
    schedulePush((opId) =>
      tryServiceCall(serviceUrl, async () => {
        await serviceJson(`/rule-sets/${ruleSet.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          serviceUrl,
          body: JSON.stringify({ ruleSet }),
        });
      }).then((health) => recordPushResult(opId, health)),
    );
    return result;
  });
}

async function handleDeleteRuleSet(ruleSetId: string): Promise<RuntimeState & { warnings: string[] }> {
  return withWriteLock(async () => {
    const localWorkspace = await readLocalWorkspace();
    const { workspace: nextWorkspace, deletions } = planDeleteRuleSet(localWorkspace, ruleSetId);

    const serviceUrl = await getServiceUrl();
    const result = await commitWorkspace(nextWorkspace, serviceUrl, runtimeState.health);

    schedulePush((opId) =>
      pushWorkspaceReplace(serviceUrl, nextWorkspace).then(async (health) => {
        if (!health) {
          await appendPendingDeletions(deletions);
          await markPushFailed(opId);
        } else {
          await clearPendingPushOp(opId);
          runtimeState.health = health;
        }
      }),
    );
    return result;
  });
}

/**
 * Wrap a fire-and-forget push: register a unique op id under the dirty key,
 * await the work, and let the push callback decide whether to clear or keep
 * the op id. Failures inside the push are still treated as "dirty" so we do
 * not lose track of unsynchronised local state.
 */
function schedulePush(work: (opId: string) => Promise<void>): void {
  const opId = createOpId();
  void mutatePendingPushOps((ops) => [...ops, opId])
    .then(() => work(opId))
    .catch(() => markPushFailed(opId));
}

async function recordPushResult(opId: string, health: ServiceHealthResponse | null): Promise<void> {
  if (!health) {
    await markPushFailed(opId);
    return;
  }
  await clearPendingPushOp(opId);
  runtimeState.health = health;
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

async function hydrateRuntimeStateFromLocal(): Promise<void> {
  if (localRuntimeHydrated) return;
  if (!localRuntimeHydration) {
    localRuntimeHydration = Promise.all([readLocalWorkspace(), getServiceUrl()])
      .then(([workspace, serviceUrl]) => {
        if (!localRuntimeHydrated) {
          runtimeState = { ...runtimeState, serviceUrl, workspace };
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

async function serviceJson<T>(path: string, init?: RequestInit & { serviceUrl?: string }): Promise<T> {
  const response = await serviceFetch(path, init);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    if (response.status === 401) {
      throw new Error("服务 token 校验失败，请在设置页重新粘贴 token。");
    }
    throw new Error(error.message || `Service request failed with ${response.status}.`);
  }
  return (await response.json()) as T;
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
