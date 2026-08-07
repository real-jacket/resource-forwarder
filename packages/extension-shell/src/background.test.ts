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
  const localStorage = { [STORAGE_KEYS.workspace]: workspace };
  const emptyEvent = () => createEvent(passiveListeners);
  const noop = vi.fn(async () => undefined);
  const openSidePanel = vi.fn(async () => undefined);

  vi.stubGlobal("chrome", {
    sidePanel: { open: openSidePanel },
    runtime: {
      onInstalled: emptyEvent(),
      onStartup: emptyEvent(),
      onMessage: createEvent(runtimeListeners),
    },
    action: { onClicked: createEvent(actionListeners) },
    alarms: { create: noop, onAlarm: emptyEvent() },
    tabs: {
      onUpdated: emptyEvent(),
      onRemoved: emptyEvent(),
      query: vi.fn(async (query?: chrome.tabs.QueryInfo) =>
        query?.active ? [{ id: 1, url: "https://example.com/" }] : [],
      ),
      get: vi.fn(async () => ({ id: 1, url: "https://example.com/" })),
      sendMessage: noop,
    },
    webNavigation: {
      onHistoryStateUpdated: emptyEvent(),
      onReferenceFragmentUpdated: emptyEvent(),
    },
    storage: {
      local: createStorageArea(localStorage),
      session: createStorageArea({}),
    },
    declarativeNetRequest: {
      getDynamicRules: vi.fn(async () => []),
      getSessionRules: vi.fn(async () => []),
      updateDynamicRules: noop,
      updateSessionRules: noop,
    },
    cookies: { getAll: vi.fn(async () => []) },
  });

  return {
    openSidePanel,
    clickAction(tab: Pick<chrome.tabs.Tab, "id">) {
      const listener = actionListeners[0];
      if (!listener) throw new Error("Background action listener was not registered.");
      listener(tab);
    },
    async send(message: unknown) {
      const listener = runtimeListeners[0];
      if (!listener) throw new Error("Background runtime listener was not registered.");
      return new Promise<unknown>((resolve) => {
        listener(message, {}, resolve);
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
