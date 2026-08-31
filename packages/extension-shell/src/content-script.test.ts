import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteContextPayload, WorkspaceSnapshot } from "@resource-forwarder/shared-types";

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

const workspace: WorkspaceSnapshot = {
  version: 1,
  revision: 1,
  updatedAt: "2026-08-31T00:00:00.000Z",
  projects: [],
  ruleSets: [],
  rules: [],
};

const siteContext: SiteContextPayload = {
  serviceUrl: "http://127.0.0.1:5178",
  workspace,
  currentUrl: "https://example.com/",
  tabId: 1,
  warnings: [],
};

describe("content-script refresh acknowledgement", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("keeps the message channel open until the refreshed config is ready", async () => {
    const listeners: RuntimeListener[] = [];
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<SiteContextPayload>((resolve) => {
      releaseRefresh = () => resolve(siteContext);
    });
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(siteContext)
      .mockImplementationOnce(() => refreshGate);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      postMessage: vi.fn(),
    });
    vi.stubGlobal("location", { href: siteContext.currentUrl, origin: "https://example.com" });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        onMessage: {
          addListener(listener: RuntimeListener) {
            listeners.push(listener);
          },
        },
      },
    });

    await import("./content-script.js");
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const sendResponse = vi.fn();
    const keepChannelOpen = listeners[0]?.({ type: "refresh-site-context" }, {}, sendResponse);

    expect(keepChannelOpen).toBe(true);
    expect(sendResponse).not.toHaveBeenCalled();
    releaseRefresh();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
  });
});
