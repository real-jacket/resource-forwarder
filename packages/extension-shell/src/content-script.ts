import type { ForwardRequestPayload, SiteContextPayload } from "@resource-forwarder/shared-types";
import { needsPageBridge } from "./page-bridge-policy.js";
import { WINDOW_SOURCE } from "./shared/constants.js";
import { getWindowPostMessageTargetOrigin } from "./shared/window-messaging.js";

// content-script runs in the isolated world; background injects page-bridge.js
// into the main world only when the current frame has an enabled API rule.
// They share the DOM but not the JS realm, so we negotiate a private
// MessagePort to carry every business message after handshake.

let port: MessagePort | undefined;
const pendingMessages: Array<{ type: string; payload?: unknown }> = [];
let bridgeExpected = false;
let refreshVersion = 0;
let latestSiteContext: SiteContextPayload | undefined;

window.addEventListener("message", handleHandshakeMessage);

void refreshSiteContext();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "refresh-site-context") {
    void refreshSiteContext();
  }
});

function handleHandshakeMessage(event: MessageEvent): void {
  if (event.source !== window) {
    return;
  }
  const data = event.data as { source?: string; type?: string };
  if (data?.source !== WINDOW_SOURCE) {
    return;
  }

  if (data.type === "bridge-ready" && !port) {
    // The bridge announces itself by posting `bridge-ready`. We respond by
    // creating the channel and transferring port2 to the bridge — once
    // accepted, no other listener (even one that grabbed a reference to
    // event.ports right after this call) can post on the bridge's end.
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = handlePortMessage;
    window.postMessage(
      { source: WINDOW_SOURCE, type: "bridge-port" },
      getWindowPostMessageTargetOrigin(location.origin),
      [channel.port2],
    );
    const hadPendingConfig = pendingMessages.some((message) => message.type === "config");
    for (const buffered of pendingMessages.splice(0)) {
      port.postMessage(buffered);
    }
    if (!hadPendingConfig && latestSiteContext) {
      port.postMessage({ source: WINDOW_SOURCE, type: "config", payload: latestSiteContext });
    }
  }
}

async function refreshSiteContext(): Promise<void> {
  const version = ++refreshVersion;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "get-site-context",
      url: location.href,
      bridgeInstalled: Boolean(port) || bridgeExpected,
    })) as SiteContextPayload | { __error?: string };

    if (version !== refreshVersion) {
      return;
    }
    if ("__error" in response) {
      if (response.__error) throw new Error(response.__error);
      return;
    }

    const payload = response as SiteContextPayload;
    latestSiteContext = payload;
    bridgeExpected = needsPageBridge(payload.workspace);
    if (!bridgeExpected && !port) {
      removePendingConfig();
      return;
    }
    sendToBridge({ type: "config", payload });
  } catch (error) {
    if (version !== refreshVersion || !port) {
      return;
    }
    sendToBridge({
      type: "proxy-error",
      payload: {
        id: "site-context",
        error: error instanceof Error ? error.message : "Failed to load site context.",
      },
    });
  }
}

function sendToBridge(message: { type: string; payload?: unknown }): void {
  const envelope = { source: WINDOW_SOURCE, ...message };
  if (port) {
    port.postMessage(envelope);
    return;
  }
  if (message.type === "config") {
    removePendingConfig();
  }
  pendingMessages.push(envelope);
}

function removePendingConfig(): void {
  const index = pendingMessages.findIndex((message) => message.type === "config");
  if (index !== -1) {
    pendingMessages.splice(index, 1);
  }
}

function handlePortMessage(event: MessageEvent): void {
  const data = event.data as { source?: string; type?: string; payload?: unknown };
  if (data?.source !== WINDOW_SOURCE) {
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

  void forwardProxyRequest(data.payload as { id: string; request: ForwardRequestPayload });
}

async function forwardProxyRequest(payload: { id: string; request: ForwardRequestPayload }): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "proxy-request",
      requestId: payload.id,
      payload: payload.request,
    });

    if (response && typeof response === "object" && "__error" in response && typeof response.__error === "string") {
      throw new Error(response.__error);
    }

    sendToBridge({ type: "proxy-response", payload: { id: payload.id, response } });
  } catch (error) {
    sendToBridge({
      type: "proxy-error",
      payload: {
        id: payload.id,
        error: error instanceof Error ? error.message : "Proxy request failed.",
      },
    });
  }
}
