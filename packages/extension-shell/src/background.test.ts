import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { STORAGE_KEYS } from "./shared/constants.js";

type Listener = (...args: unknown[]) => unknown;

function createEvent(listeners: Listener[]) {
  return {
    addListener(listener: Listener) {
      listeners.push(listener);
    },
    removeListener() {},
  };
}

function createStorageArea(values: Record<string, unknown>) {
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (typeof keys === "string") return { [keys]: values[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, values[key]]));
      return { ...values };
    },
    async set(next: Record<string, unknown>) {
      Object.assign(values, next);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

function installChromeMock(workspace: WorkspaceSnapshot) {
  const runtimeListeners: Listener[] = [];
  const actionListeners: Listener[] = [];
  const passiveListeners: Listener[] = [];
  const historyListeners: Listener[] = [];
  const fragmentListeners: Listener[] = [];
  const tabsUpdatedListeners: Listener[] = [];
  const localStorage = { [STORAGE_KEYS.workspace]: workspace };
  const emptyEvent = () => createEvent(passiveListeners);
  const noop = vi.fn(async () => undefined);
  const openSidePanel = vi.fn(async () => undefined);
  const executeScript = vi.fn(async () => []);
  const sendMessage = vi.fn(async () => undefined);
  const updateDynamicRules = vi.fn(async () => undefined);
  const updateSessionRules = vi.fn(async (_update: { removeRuleIds?: number[]; addRules?: chrome.declarativeNetRequest.Rule[] }) => undefined);

  vi.stubGlobal("chrome", {
    sidePanel: { open: openSidePanel },
    runtime: {
      onInstalled: emptyEvent(),
      onStartup: emptyEvent(),
      onMessage: createEvent(runtimeListeners),
    },
    action: { onClicked: createEvent(actionListeners) },
    scripting: { executeScript },
    alarms: { create: noop, onAlarm: emptyEvent() },
    tabs: {
      onUpdated: createEvent(tabsUpdatedListeners),
      onRemoved: emptyEvent(),
      query: vi.fn(async (query?: chrome.tabs.QueryInfo) =>
        query?.active ? [{ id: 1, url: "https://example.com/" }] : [],
      ),
      get: vi.fn(async () => ({ id: 1, url: "https://example.com/" })),
      sendMessage,
    },
    webNavigation: {
      onHistoryStateUpdated: createEvent(historyListeners),
      onReferenceFragmentUpdated: createEvent(fragmentListeners),
    },
    storage: {
      local: createStorageArea(localStorage),
      session: createStorageArea({}),
    },
    declarativeNetRequest: {
      getDynamicRules: vi.fn(async () => []),
      getSessionRules: vi.fn(async () => []),
      updateDynamicRules,
      updateSessionRules,
    },
    cookies: { getAll: vi.fn(async () => []) },
  });

  return {
    openSidePanel,
    executeScript,
    sendMessage,
    updateDynamicRules,
    updateSessionRules,
    navigateHistory(details: { tabId: number; frameId: number; url: string }) {
      const listener = historyListeners[0];
      if (!listener) throw new Error("History listener was not registered.");
      listener(details);
    },
    navigateTab(tabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      const listener = tabsUpdatedListeners[0];
      if (!listener) throw new Error("Tab update listener was not registered.");
      listener(tabId, changeInfo, { id: tabId });
    },
    clickAction(tab: Pick<chrome.tabs.Tab, "id">) {
      const listener = actionListeners[0];
      if (!listener) throw new Error("Background action listener was not registered.");
      listener(tab);
    },
    async send(message: unknown, sender: chrome.runtime.MessageSender = {}) {
      const listener = runtimeListeners[0];
      if (!listener) throw new Error("Background runtime listener was not registered.");
      return new Promise<unknown>((resolve) => {
        listener(message, sender, resolve);
      });
    },
  };
}

const workspace: WorkspaceSnapshot = {
  version: 1,
  updatedAt: "2026-08-06T00:00:00.000Z",
  projects: [],
  ruleSets: [],
  rules: [],
};

const apiWorkspace: WorkspaceSnapshot = {
  version: 1,
  updatedAt: "2026-08-06T00:00:00.000Z",
  projects: [{
    id: "project",
    name: "Project",
    enabled: true,
    siteHosts: ["example.com"],
    siteMatchPatterns: ["https://example.com/*"],
    tags: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  }],
  ruleSets: [{
    id: "ruleset",
    projectId: "project",
    name: "Rules",
    enabled: true,
    ruleIds: ["api"],
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  }],
  rules: [{
    id: "api",
    name: "API",
    enabled: true,
    kind: "api_forward",
    priority: 100,
    match: { host: ["example.com"], pathGlob: "/api/**", tabScope: { mode: "all" } },
    target: { forwardProfile: { targetBaseUrl: "https://upstream.example.com" } },
    tags: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  }],
};

const assetWorkspace: WorkspaceSnapshot = {
  version: 1,
  updatedAt: "2026-08-06T00:00:00.000Z",
  projects: [{
    id: "project",
    name: "Project",
    enabled: true,
    siteHosts: ["example.com"],
    siteMatchPatterns: ["https://example.com/tables/*"],
    tags: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  }],
  ruleSets: [{
    id: "ruleset",
    projectId: "project",
    name: "Rules",
    enabled: true,
    ruleIds: ["asset"],
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  }],
  rules: [{
    id: "asset",
    name: "Asset",
    enabled: true,
    kind: "asset_redirect",
    priority: 100,
    match: { host: ["cdn.example.com"], pathGlob: "/app.js", resourceType: ["script"], tabScope: { mode: "all" } },
    target: { redirectUrl: "https://local.example.com/app.js" },
    tags: [],
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  }],
};
async function loadBackgroundWorker(): Promise<void> {
  // Dynamic import is intentional: resetModules + re-evaluation simulates a newly woken MV3 worker.
  await import("./background.js");
}


describe("background sidepanel loading", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("opens the sidepanel directly from an action click after worker startup", async () => {
    const chromeMock = installChromeMock(workspace);
    vi.stubGlobal("fetch", vi.fn());
    await loadBackgroundWorker();
    chromeMock.clickAction({ id: 42 });

    expect(chromeMock.openSidePanel).toHaveBeenCalledWith({ tabId: 42 });
  });

  it("returns local sidepanel state without waiting for the companion", async () => {
    const chromeMock = installChromeMock(workspace);
    const fetchMock = vi.fn(async () => {
      throw new Error("sidepanel state must not access the companion");
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadBackgroundWorker();
    const result = await chromeMock.send({ type: "get-sidepanel-state" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ workspace, logs: [], currentTab: { host: "example.com" } });
  });

  it("injects the page bridge into the sender frame only once", async () => {
    const chromeMock = installChromeMock(apiWorkspace);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await loadBackgroundWorker();

    const sender = { tab: { id: 42 } as chrome.tabs.Tab, frameId: 7 };
    await chromeMock.send({ type: "get-site-context", url: "https://example.com/" }, sender);
    await chromeMock.send({ type: "get-site-context", url: "https://example.com/", bridgeInstalled: true }, sender);

    expect(chromeMock.executeScript).toHaveBeenCalledTimes(1);
    expect(chromeMock.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42, frameIds: [7] },
      files: ["page-bridge.js"],
      world: "MAIN",
    });
  });

  it("deduplicates concurrent bridge injection for the same tab frame", async () => {
    const chromeMock = installChromeMock(apiWorkspace);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await loadBackgroundWorker();
    const sender = { tab: { id: 42 } as chrome.tabs.Tab, frameId: 7 };

    await Promise.all([
      chromeMock.send({ type: "get-site-context", url: "https://example.com/" }, sender),
      chromeMock.send({ type: "get-site-context", url: "https://example.com/" }, sender),
    ]);

    expect(chromeMock.executeScript).toHaveBeenCalledTimes(1);
  });

  it("deduplicates bridge injection per document rather than tab frame", async () => {
    const chromeMock = installChromeMock(apiWorkspace);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await loadBackgroundWorker();
    const releases: Array<() => void> = [];
    chromeMock.executeScript.mockImplementation(() => new Promise((resolve) => {
      releases.push(() => resolve([]));
    }));
    const senderA = { tab: { id: 42 } as chrome.tabs.Tab, frameId: 7, documentId: "document-a" };
    const senderB = { tab: { id: 42 } as chrome.tabs.Tab, frameId: 7, documentId: "document-b" };

    const requests = [
      chromeMock.send({ type: "get-site-context", url: "https://example.com/" }, senderA),
      chromeMock.send({ type: "get-site-context", url: "https://example.com/" }, senderA),
      chromeMock.send({ type: "get-site-context", url: "https://example.com/" }, senderB),
    ];
    await vi.waitFor(() => expect(chromeMock.executeScript).toHaveBeenCalledTimes(2));

    expect(chromeMock.executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 42, documentIds: ["document-a"] },
      files: ["page-bridge.js"],
      world: "MAIN",
    });
    expect(chromeMock.executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 42, documentIds: ["document-b"] },
      files: ["page-bridge.js"],
      world: "MAIN",
    });
    for (const release of releases) release();
    await Promise.all(requests);
  });

  it("does not inject a bridge for membership that only becomes unique after trimming", async () => {
    const ambiguousWorkspace: WorkspaceSnapshot = {
      ...apiWorkspace,
      projects: [{ ...apiWorkspace.projects[0]!, siteMatchPatterns: ["https://example.com/*"] }],
      ruleSets: [
        { ...apiWorkspace.ruleSets[0]!, id: "tables", siteMatchPatterns: ["https://example.com/tables/*"] },
        { ...apiWorkspace.ruleSets[0]!, id: "sheets", siteMatchPatterns: ["https://example.com/sheets/*"] },
      ],
    };
    const chromeMock = installChromeMock(ambiguousWorkspace);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await loadBackgroundWorker();

    const result = await chromeMock.send(
      { type: "get-site-context", url: "https://example.com/tables/abc" },
      { tab: { id: 42 } as chrome.tabs.Tab, frameId: 0 },
    ) as { workspace: WorkspaceSnapshot };

    expect(result.workspace.ruleSets.map((ruleSet) => ruleSet.id)).toEqual(["tables"]);
    expect(result.workspace.rules).toHaveLength(0);
    expect(chromeMock.executeScript).not.toHaveBeenCalled();
  });

  it("refreshes a non-main SPA frame without scheduling a DNR reconcile", async () => {
    vi.useFakeTimers();
    const chromeMock = installChromeMock(workspace);
    vi.stubGlobal("fetch", vi.fn());
    await loadBackgroundWorker();

    chromeMock.navigateHistory({ tabId: 42, frameId: 7, url: "https://example.com/frame/next" });
    await vi.advanceTimersByTimeAsync(0);

    expect(chromeMock.sendMessage).toHaveBeenCalledWith(
      42,
      { type: "refresh-site-context" },
      { frameId: 7 },
    );
    expect(chromeMock.updateDynamicRules).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it.each(["history", "tab"] as const)("updates DNR immediately from the %s destination URL", async (event) => {
    vi.useFakeTimers();
    const chromeMock = installChromeMock(assetWorkspace);
    vi.stubGlobal("fetch", vi.fn());
    await loadBackgroundWorker();
    await chromeMock.send({ type: "get-sidepanel-state" });
    chromeMock.updateDynamicRules.mockClear();
    const updateSessionRules = vi.mocked(chrome.declarativeNetRequest.updateSessionRules);
    updateSessionRules.mockClear();

    const destination = "https://example.com/tables/destination";
    if (event === "history") {
      chromeMock.navigateHistory({ tabId: 42, frameId: 0, url: destination });
    } else {
      chromeMock.navigateTab(42, { url: destination });
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(updateSessionRules).toHaveBeenCalledTimes(1);
    const update = updateSessionRules.mock.calls[0]?.[0];
    expect(update?.addRules?.[0]?.condition.tabIds).toEqual([42]);
    vi.useRealTimers();
  });

  it("keeps the running DNR apply and coalesces pending A → B → C navigation to C", async () => {
    const scopedWorkspace: WorkspaceSnapshot = {
      ...assetWorkspace,
      projects: [{ ...assetWorkspace.projects[0]!, siteMatchPatterns: ["https://example.com/*"] }],
      ruleSets: [
        { ...assetWorkspace.ruleSets[0]!, id: "tables", ruleIds: ["tables"], siteMatchPatterns: ["https://example.com/tables/*"] },
        { ...assetWorkspace.ruleSets[0]!, id: "sheets", ruleIds: ["sheets"], siteMatchPatterns: ["https://example.com/sheets/*"] },
        { ...assetWorkspace.ruleSets[0]!, id: "docs", ruleIds: ["docs"], siteMatchPatterns: ["https://example.com/docs/*"] },
      ],
      rules: [
        { ...assetWorkspace.rules[0]!, id: "tables", target: { redirectUrl: "https://local.example.com/tables.js" } },
        { ...assetWorkspace.rules[0]!, id: "sheets", target: { redirectUrl: "https://local.example.com/sheets.js" } },
        { ...assetWorkspace.rules[0]!, id: "docs", target: { redirectUrl: "https://local.example.com/docs.js" } },
      ],
    };
    const chromeMock = installChromeMock(scopedWorkspace);
    vi.stubGlobal("fetch", vi.fn());
    await loadBackgroundWorker();
    await chromeMock.send({ type: "get-sidepanel-state" });
    chromeMock.updateDynamicRules.mockClear();
    chromeMock.updateSessionRules.mockClear();

    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const appliedTargets: Array<string | undefined> = [];
    chromeMock.updateSessionRules
      .mockImplementationOnce(async (update) => {
        await firstGate;
        appliedTargets.push(update.addRules?.[0]?.action.redirect?.url);
      })
      .mockImplementationOnce(async (update) => {
        appliedTargets.push(update.addRules?.[0]?.action.redirect?.url);
      });

    chromeMock.navigateHistory({ tabId: 42, frameId: 0, url: "https://example.com/tables/a" });
    chromeMock.navigateHistory({ tabId: 42, frameId: 0, url: "https://example.com/sheets/b" });
    chromeMock.navigateHistory({ tabId: 42, frameId: 0, url: "https://example.com/docs/c" });
    await vi.waitFor(() => expect(chromeMock.updateSessionRules).toHaveBeenCalledTimes(1));

    resolveFirst();
    await vi.waitFor(() => expect(chromeMock.updateSessionRules).toHaveBeenCalledTimes(2));

    expect(appliedTargets).toEqual([
      "https://local.example.com/tables.js",
      "https://local.example.com/docs.js",
    ]);
    const finalUpdate = chromeMock.updateSessionRules.mock.calls[1]?.[0];
    expect(finalUpdate?.addRules?.[0]?.condition.tabIds).toEqual([42]);
  });

  it("shares one workspace sync across concurrent requests and health recovery", async () => {
    const chromeMock = installChromeMock(workspace);
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      calls.push(path);
      const body = path === "/health"
        ? { ok: true, workspaceUpdatedAt: workspace.updatedAt }
        : path === "/projects"
          ? { projects: [], ruleSets: [], updatedAt: workspace.updatedAt }
          : { rules: [], updatedAt: workspace.updatedAt };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadBackgroundWorker();
    await Promise.all([
      chromeMock.send({ type: "sync-workspace" }),
      chromeMock.send({ type: "sync-workspace" }),
    ]);

    expect(calls).toEqual(["/health", "/projects", "/rules"]);
  });
});
