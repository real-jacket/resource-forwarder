import type { ForwardRequestPayload, SiteContextPayload } from "@resource-forwarder/shared-types";
import { WINDOW_SOURCE } from "./shared/constants.js";
import { getWindowPostMessageTargetOrigin } from "./shared/window-messaging.js";

// content-script runs in the isolated world; the page-bridge lives in the main
// world (now a separate `world: "MAIN"` content_script entry). They share the
// DOM but not the JS realm, so we negotiate a private MessagePort to carry
// every business message after handshake. Unlike `window.postMessage` (which
// fans out to every listener including page scripts), a MessagePort is a
// 1-to-1 channel that can only be addressed by its holders — so a page-side
// attacker who happened to be listening at handshake time cannot spoof
// proxy-response or sniff config payloads.

let port: MessagePort | undefined;
const pendingMessages: Array<{ type: string; payload?: unknown }> = [];

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
    // Drain anything we tried to send before the bridge announced itself —
    // primarily the initial `config` payload.
    for (const buffered of pendingMessages.splice(0)) {
      port.postMessage(buffered);
    }
  }
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

    sendToBridge({ type: "config", payload });
  } catch (error) {
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
  pendingMessages.push(envelope);
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
