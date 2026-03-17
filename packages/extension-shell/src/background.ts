import type {
  ExportWorkspaceResponse,
  ForwardRequestPayload,
  LogsResponse,
  ProjectsResponse,
  RulesResponse,
  RuntimeState,
  ServiceHealthResponse,
  SiteContextPayload,
  UpsertProjectPayload,
  UpsertRulePayload,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import {
  collectWorkspaceWarnings,
  createEmptyWorkspace,
  toDynamicNetRequestRules,
  trimWorkspaceForUrl,
} from "@resource-forwarder/rule-core";
import type { DashboardState, RuntimeRequest } from "./shared/messages.js";
import { DEFAULT_SERVICE_URL, STORAGE_KEYS } from "./shared/constants.js";

let runtimeState: RuntimeState = {
  serviceUrl: DEFAULT_SERVICE_URL,
  health: null,
  workspace: createEmptyWorkspace(),
};
let runtimeWarnings: string[] = [];

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
      sendResponse({ __error: error instanceof Error ? error.message : "Unknown extension error." });
    });
  return true;
});

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
      await serviceJson(`/projects/${message.payload.project.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message.payload),
      });
      return syncWorkspace();
    case "upsert-rule":
      await serviceJson(`/rules/${message.payload.rule.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message.payload),
      });
      return syncWorkspace();
    case "get-logs":
      return serviceJson<LogsResponse>(`/logs?limit=${message.limit ?? 50}${message.projectId ? `&projectId=${encodeURIComponent(message.projectId)}` : ""}`);
    case "import-workspace":
      await serviceJson(`/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message.payload),
      });
      return syncWorkspace();
    case "export-workspace":
      return serviceJson<ExportWorkspaceResponse>(
        `/export/${encodeURIComponent(message.projectId)}?format=${encodeURIComponent(message.format)}`,
      );
    case "get-site-context":
      return buildSiteContext(message.url, message.tabId ?? sender.tab?.id);
    case "proxy-request":
      return proxyRequest(message.payload);
    default:
      return null;
  }
}

async function getDashboardState(tabId?: number): Promise<DashboardState> {
  const [{ logs }, currentTab] = await Promise.all([
    serviceJson<LogsResponse>("/logs?limit=20").catch(() => ({ logs: [] })),
    getTabSnapshot(tabId),
    runtimeState.health ? Promise.resolve(runtimeState) : syncWorkspace().catch(() => runtimeState),
  ]);

  return {
    ...runtimeState,
    warnings: runtimeWarnings,
    logs,
    currentTab,
  };
}

async function syncWorkspace(): Promise<RuntimeState & { warnings: string[] }> {
  const serviceUrl = await getServiceUrl();
  const health = await getHealth(serviceUrl);
  runtimeState.serviceUrl = serviceUrl;
  runtimeState.health = health;

  if (!health) {
    runtimeWarnings = [`Unable to reach local service at ${serviceUrl}.`];
    return {
      ...runtimeState,
      warnings: runtimeWarnings,
    };
  }

  const [projects, rules] = await Promise.all([
    serviceJson<ProjectsResponse>("/projects", { serviceUrl }),
    serviceJson<RulesResponse>("/rules", { serviceUrl }),
  ]);

  const workspace: WorkspaceSnapshot = {
    version: 1,
    updatedAt: maxUpdatedAt(projects.updatedAt, rules.updatedAt),
    projects: projects.projects,
    ruleSets: projects.ruleSets,
    rules: rules.rules,
  };

  runtimeState = {
    serviceUrl,
    health,
    workspace,
  };
  runtimeWarnings = collectWorkspaceWarnings(workspace);
  await applyDynamicRules(workspace);
  await notifyTabsToRefresh();

  return {
    ...runtimeState,
    warnings: runtimeWarnings,
  };
}

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
