import type { ForwardRequestPayload, SiteContextPayload } from "@resource-forwarder/shared-types";
import { WINDOW_SOURCE } from "./shared/constants.js";

let bridgeInjected = false;

injectBridge();
void refreshSiteContext();
window.addEventListener("message", handleWindowMessage);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "refresh-site-context") {
    void refreshSiteContext();
  }
});

function injectBridge(): void {
  if (bridgeInjected) {
    return;
  }
  bridgeInjected = true;
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-bridge.js");
  script.dataset.resourceForwarder = "true";
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

async function refreshSiteContext(): Promise<void> {
  try {
    const payload = (await chrome.runtime.sendMessage({
      type: "get-site-context",
      url: location.href,
    })) as SiteContextPayload | { __error?: string };

    if (payload && typeof payload === "object" && "__error" in payload && payload.__error) {
      throw new Error(payload.__error);
    }

    window.postMessage({ source: WINDOW_SOURCE, type: "config", payload }, location.origin);
  } catch (error) {
    window.postMessage(
      {
        source: WINDOW_SOURCE,
        type: "proxy-error",
        payload: {
          id: "site-context",
          error: error instanceof Error ? error.message : "Failed to load site context.",
        },
      },
      location.origin,
    );
  }
}

async function handleWindowMessage(event: MessageEvent): Promise<void> {
  if (event.source !== window) {
    return;
  }

  const data = event.data as { source?: string; type?: string; payload?: unknown };
  if (data?.source !== WINDOW_SOURCE) {
    return;
  }

  if (data.type === "bridge-ready") {
    await refreshSiteContext();
    return;
  }

  if (data.type === "proxy-abort") {
    const payload = data.payload as { id: string };
    if (payload?.id) {
      void chrome.runtime.sendMessage({ type: "proxy-abort", requestId: payload.id }).catch(() => undefined);
    }
    return;
  }

  if (data.type !== "proxy-request") {
    return;
  }

  const payload = data.payload as { id: string; request: ForwardRequestPayload };

  try {
    const response = await chrome.runtime.sendMessage({
      type: "proxy-request",
      requestId: payload.id,
      payload: payload.request,
    });

    if (response && typeof response === "object" && "__error" in response && typeof response.__error === "string") {
      throw new Error(response.__error);
    }

    window.postMessage(
      {
        source: WINDOW_SOURCE,
        type: "proxy-response",
        payload: {
          id: payload.id,
          response,
        },
      },
      location.origin,
    );
  } catch (error) {
    window.postMessage(
      {
        source: WINDOW_SOURCE,
        type: "proxy-error",
        payload: {
          id: payload.id,
          error: error instanceof Error ? error.message : "Proxy request failed.",
        },
      },
      location.origin,
    );
  }
}
