import { prepareMatcher } from "@resource-forwarder/rule-core";
import type { MatcherCache } from "@resource-forwarder/rule-core";
import type { ForwardRequestPayload, ForwardResponsePayload, SiteContextPayload, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { FORWARD_BODY_LIMIT_BYTES, PAYLOAD_TOO_LARGE_SENTINEL, SERVICE_OFFLINE_SENTINEL, STREAMING_UNSUPPORTED_SENTINEL, WINDOW_SOURCE } from "./shared/constants.js";
import { getWindowPostMessageTargetOrigin } from "./shared/window-messaging.js";

interface ProxyPending {
  resolve: (response: ForwardResponsePayload) => void;
  reject: (reason?: unknown) => void;
}

interface XhrState {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  intercepted: boolean;
  aborted: boolean;
  requestId?: string;
  readyState: number;
  status: number;
  statusText: string;
  responseType: XMLHttpRequestResponseType;
  responseText: string;
  response: XMLHttpRequest["response"];
  responseURL: string;
  responseHeaders: Record<string, string>;
}

const pageWindow = window as Window & { __RESOURCE_FORWARDER_PATCHED__?: boolean };
const pending = new Map<string, ProxyPending>();
const xhrState = new WeakMap<XMLHttpRequest, XhrState>();

/**
 * Generate a request id usable for correlating proxy requests across the
 * page-bridge → content-script → background hops.
 *
 * `crypto.randomUUID()` is the right answer wherever it exists, but page
 * bridges run inside arbitrary host pages — older Chromium-based PWAs, some
 * embedded webviews, and any insecure context that hasn't enabled the WebCrypto
 * API will throw "crypto.randomUUID is not a function". Falling back to a
 * Math.random()-derived id keeps the proxy working in those environments at
 * the cost of weaker uniqueness (collision risk is still negligible at the
 * volumes we route through here).
 */
function randomRequestId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Some environments throw on access (e.g. crypto stub without randomUUID);
    // fall through to the polyfill.
  }
  // RFC 4122-like 16-byte random hex; not cryptographically strong but unique
  // enough for in-process correlation. Don't use this for anything security-
  // sensitive (we only need request id correlation here).
  const bytes = new Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  // Set version (4) and variant bits to keep the format recognisable.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
let state: SiteContextPayload = {
  serviceUrl: "",
  workspace: { version: 1, updatedAt: new Date().toISOString(), projects: [], ruleSets: [], rules: [] },
  currentUrl: location.href,
  warnings: [],
};
// Compiled matcher rebuilt only when the workspace snapshot changes, so the
// hot fetch/XHR path doesn't pay the regex-construction tax on every request.
let matcher: MatcherCache = prepareMatcher(state.workspace as WorkspaceSnapshot);

// configReady gates rule matching until the content-script delivers the workspace.
// Without this gate, requests fired during the patch/handshake window would skip
// every rule and silently fall through to the native implementation.
//
// Now that page-bridge ships as its own document_start content_script (world:
// "MAIN"), the isolated-world content-script kicks off the site-context
// roundtrip in parallel with us — there is no script-tag fetch to wait on.
// 300 ms is plenty for the chrome.runtime.sendMessage hop + storage reads.
// On timeout we resolve and let in-flight requests fall through to native; we
// do NOT block the page longer than necessary.
const CONFIG_READY_TIMEOUT_MS = 300;
let configReceived = false;
let resolveConfigReady: () => void = () => {};
const configReady = new Promise<void>((resolve) => {
  resolveConfigReady = resolve;
});
const configReadyTimer = window.setTimeout(() => {
  if (!configReceived) {
    resolveConfigReady();
  }
}, CONFIG_READY_TIMEOUT_MS);

if (!pageWindow.__RESOURCE_FORWARDER_PATCHED__) {
  pageWindow.__RESOURCE_FORWARDER_PATCHED__ = true;
  installFetchPatch();
  installXhrPatch();
  // Announce ourselves and wait for the isolated-world content-script to hand
  // back a private MessagePort. Until that lands every message we want to send
  // sits in `pendingPortMessages`; messages received from the port are routed
  // to the same handler as the legacy `window.postMessage` path.
  window.addEventListener("message", handleHandshakeMessage);
  window.postMessage(
    { source: WINDOW_SOURCE, type: "bridge-ready" },
    getWindowPostMessageTargetOrigin(location.origin),
  );
}

let bridgePort: MessagePort | undefined;
const pendingPortMessages: Array<{ type: string; payload?: unknown }> = [];

function handleHandshakeMessage(event: MessageEvent): void {
  if (event.source !== window) {
    return;
  }
  const data = event.data as { source?: string; type?: string };
  if (data?.source !== WINDOW_SOURCE) {
    return;
  }
  if (data.type !== "bridge-port" || bridgePort) {
    return;
  }
  const port = event.ports[0];
  if (!port) {
    return;
  }
  bridgePort = port;
  bridgePort.onmessage = handleBridgePortMessage;
  // We only need the global listener to capture the one-shot handshake; once
  // we have the port any other listener on `window.message` is irrelevant.
  window.removeEventListener("message", handleHandshakeMessage);
  for (const buffered of pendingPortMessages.splice(0)) {
    bridgePort.postMessage(buffered);
  }
}

function postToBridge(message: { type: string; payload?: unknown }): void {
  const envelope = { source: WINDOW_SOURCE, ...message };
  if (bridgePort) {
    bridgePort.postMessage(envelope);
    return;
  }
  pendingPortMessages.push(envelope);
}

function handleBridgePortMessage(event: MessageEvent): void {
  const data = event.data as { source?: string; type?: string; payload?: unknown };
  if (data?.source !== WINDOW_SOURCE) {
    return;
  }
  routeBridgeMessage(data);
}

function routeBridgeMessage(data: { type?: string; payload?: unknown }): void {
  if (data.type === "config") {
    const next = data.payload as SiteContextPayload;
    state = next;
    // SPA navigations resend the same workspace many times in a row. Skipping
    // prepareMatcher when the underlying workspace hasn't changed turns the
    // hot path on history-state-update into a no-op (we keep the existing
    // matcher closures).
    const fingerprint = workspaceFingerprint(next.workspace as WorkspaceSnapshot);
    if (fingerprint !== lastWorkspaceFingerprint) {
      matcher = prepareMatcher(next.workspace as WorkspaceSnapshot);
      lastWorkspaceFingerprint = fingerprint;
    }
    configReceived = true;
    window.clearTimeout(configReadyTimer);
    resolveConfigReady();
    return;
  }

  if (data.type === "proxy-response") {
    const payload = data.payload as { id: string; response: ForwardResponsePayload };
    const request = pending.get(payload.id);
    if (request) {
      request.resolve(payload.response);
      pending.delete(payload.id);
    }
    return;
  }

  if (data.type === "proxy-error") {
    const payload = data.payload as { id: string; error: string };
    const request = pending.get(payload.id);
    if (request) {
      request.reject(new Error(payload.error));
      pending.delete(payload.id);
    }
  }
}

let lastWorkspaceFingerprint: string | undefined;
function workspaceFingerprint(workspace: WorkspaceSnapshot): string {
  // updatedAt is bumped on every persist, so for a server-driven flow this
  // discriminates exactly when matcher behaviour can change. The lengths are
  // a cheap defence against backends that forget to bump updatedAt; without
  // them, an apparent no-op message could mask a structural change.
  return `${workspace.updatedAt}|${workspace.projects.length}|${workspace.ruleSets.length}|${workspace.rules.length}`;
}

function installFetchPatch(): void {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await configReady;

    // Pull the abort signal from either init or the Request itself; init wins
    // because the user may pass a fresh signal alongside an existing Request.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) {
      throw signalAbortReason(signal);
    }

    const request = new Request(input, init);
    const match = matcher.pick(buildContext(request.url, request.method, "fetch"), "api_forward");
    if (!match) {
      return nativeFetch(input, init);
    }

    // Pre-flight body size check. Cheap path: if init.body has a synchronously
    // knowable size (string / Blob / typed array / URLSearchParams) and exceeds
    // the limit, skip forwarding entirely so we never read it into memory.
    const initSize = approximateBodySize(init?.body);
    if (initSize > FORWARD_BODY_LIMIT_BYTES) {
      warnPayloadTooLarge(request.url, initSize);
      return nativeFetch(input, init);
    }

    try {
      const payload = await createForwardPayload(request, "fetch", match.rule.id);
      const requestId = randomRequestId();
      const forwarded = await dispatchProxyRequest(requestId, payload, signal);
      return createBrowserResponse(forwarded);
    } catch (error) {
      if (isServiceOfflineError(error) || isPayloadTooLargeError(error) || isStreamingUnsupportedError(error)) {
        return nativeFetch(input, init);
      }
      throw error;
    }
  };
}

function installXhrPatch(): void {
  const xhrPrototype = XMLHttpRequest.prototype;
  const nativeOpen = xhrPrototype.open;
  const nativeSend = xhrPrototype.send;
  const nativeSetRequestHeader = xhrPrototype.setRequestHeader;
  const nativeAbort = xhrPrototype.abort;
  const nativeGetAllResponseHeaders = xhrPrototype.getAllResponseHeaders;
  const nativeGetResponseHeader = xhrPrototype.getResponseHeader;
  const descriptors = {
    readyState: Object.getOwnPropertyDescriptor(xhrPrototype, "readyState"),
    status: Object.getOwnPropertyDescriptor(xhrPrototype, "status"),
    statusText: Object.getOwnPropertyDescriptor(xhrPrototype, "statusText"),
    responseText: Object.getOwnPropertyDescriptor(xhrPrototype, "responseText"),
    response: Object.getOwnPropertyDescriptor(xhrPrototype, "response"),
    responseURL: Object.getOwnPropertyDescriptor(xhrPrototype, "responseURL"),
    responseType: Object.getOwnPropertyDescriptor(xhrPrototype, "responseType"),
  };

  xhrPrototype.open = function open(method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null): void {
    xhrState.set(this, {
      method,
      url: new URL(url.toString(), location.href).toString(),
      requestHeaders: {},
      intercepted: false,
      aborted: false,
      readyState: 1,
      status: 0,
      statusText: "",
      responseType: "",
      responseText: "",
      response: null,
      responseURL: "",
      responseHeaders: {},
    });
    nativeOpen.call(this, method, url.toString(), async ?? true, username ?? undefined, password ?? undefined);
  };

  xhrPrototype.setRequestHeader = function setRequestHeader(name: string, value: string): void {
    // Defer native application until send() decides whether this XHR will be
    // forwarded or executed natively. Eagerly calling nativeSetRequestHeader
    // here pollutes the native XHR's header list even on requests we end up
    // intercepting, which makes debugging confusing and has no upside since
    // the forwarded request reads from current.requestHeaders.
    //
    // Spec deviation: native setRequestHeader throws InvalidStateError when
    // called after send(); this patched version silently records the header
    // instead. In practice no real code relies on that throw, and the
    // alternative (replicating the state machine) is not worth the surface.
    const current = getOrCreateXhrState(this);
    current.requestHeaders[name] = value;
  };

  xhrPrototype.send = function send(body?: Document | XMLHttpRequestBodyInit | null): void {
    const current = getOrCreateXhrState(this);
    const xhr = this;

    const sendNative = (): void => {
      replayHeadersToNative(xhr, current, nativeSetRequestHeader);
      nativeSend.call(xhr, body ?? null);
    };

    void (async () => {
      await configReady;
      if (current.aborted) {
        return;
      }

      const match = matcher.pick(buildContext(current.url, current.method, "xmlhttprequest"), "api_forward");
      if (!match) {
        sendNative();
        return;
      }

      // Pre-flight body size check (same rationale as fetch path).
      const bodySize = approximateBodySize(body ?? undefined);
      if (bodySize > FORWARD_BODY_LIMIT_BYTES) {
        warnPayloadTooLarge(current.url, bodySize);
        sendNative();
        return;
      }

      try {
        const payload = await createForwardPayloadFromBody(current, body ?? undefined, match.rule.id);
        if (current.aborted) {
          return;
        }
        current.intercepted = true;
        current.requestId = randomRequestId();
        const forwarded = await dispatchProxyRequest(current.requestId, payload);
        if (current.aborted) {
          return;
        }
        applyXhrResponse(xhr, current, forwarded);
      } catch {
        if (current.aborted) {
          return;
        }
        // Forwarding failed — fall back to native and let the original XHR
        // surface its own success/error events. Reset `intercepted` so the
        // native readyState/status getters take over again.
        current.intercepted = false;
        sendNative();
      }
    })();
  };

  xhrPrototype.abort = function abort(): void {
    const current = xhrState.get(this);
    if (!current?.intercepted) {
      if (current) {
        current.aborted = true;
        current.readyState = 0;
      }
      nativeAbort.call(this);
      return;
    }

    current.aborted = true;
    current.readyState = 0;
    if (current.requestId) {
      sendAbortMessage(current.requestId);
    }
    dispatchXhrEvent(this, "abort");
    dispatchXhrEvent(this, "loadend");
  };

  xhrPrototype.getAllResponseHeaders = function getAllResponseHeaders(): string {
    const current = xhrState.get(this);
    if (!current?.intercepted) {
      return nativeGetAllResponseHeaders.call(this);
    }
    // Per spec, each header is terminated by CRLF (including the last one).
    // Joining with "\r\n" omits the trailing CRLF and breaks parsers that
    // split on it (notably libraries that do `headers.split('\r\n').slice(0,-1)`
    // expecting a trailing empty entry).
    let result = "";
    for (const [name, value] of Object.entries(current.responseHeaders)) {
      result += `${name}: ${value}\r\n`;
    }
    return result;
  };

  xhrPrototype.getResponseHeader = function getResponseHeader(name: string): string | null {
    const current = xhrState.get(this);
    if (!current?.intercepted) {
      return nativeGetResponseHeader.call(this, name);
    }
    return current.responseHeaders[name.toLowerCase()] ?? null;
  };

  Object.defineProperties(xhrPrototype, {
    readyState: {
      get() {
        const current = xhrState.get(this as XMLHttpRequest);
        return current?.intercepted ? current.readyState : descriptors.readyState?.get?.call(this as XMLHttpRequest);
      },
    },
    status: {
      get() {
        const current = xhrState.get(this as XMLHttpRequest);
        return current?.intercepted ? current.status : descriptors.status?.get?.call(this as XMLHttpRequest);
      },
    },
    statusText: {
      get() {
        const current = xhrState.get(this as XMLHttpRequest);
        return current?.intercepted ? current.statusText : descriptors.statusText?.get?.call(this as XMLHttpRequest);
      },
    },
    responseText: {
      get() {
        const current = xhrState.get(this as XMLHttpRequest);
        return current?.intercepted ? current.responseText : descriptors.responseText?.get?.call(this as XMLHttpRequest);
      },
    },
    response: {
      get() {
        const current = xhrState.get(this as XMLHttpRequest);
        return current?.intercepted ? current.response : descriptors.response?.get?.call(this as XMLHttpRequest);
      },
    },
    responseURL: {
      get() {
        const current = xhrState.get(this as XMLHttpRequest);
        return current?.intercepted ? current.responseURL : descriptors.responseURL?.get?.call(this as XMLHttpRequest);
      },
    },
    responseType: {
      get() {
        const current = xhrState.get(this as XMLHttpRequest);
        return current?.responseType ?? descriptors.responseType?.get?.call(this as XMLHttpRequest) ?? "";
      },
      set(value: XMLHttpRequestResponseType) {
        const current = getOrCreateXhrState(this as XMLHttpRequest);
        current.responseType = value;
        descriptors.responseType?.set?.call(this as XMLHttpRequest, value);
      },
    },
  });
}

function getOrCreateXhrState(xhr: XMLHttpRequest): XhrState {
  const current = xhrState.get(xhr);
  if (current) {
    return current;
  }
  const created: XhrState = {
    method: "GET",
    url: location.href,
    requestHeaders: {},
    intercepted: false,
    aborted: false,
    readyState: 0,
    status: 0,
    statusText: "",
    responseType: "",
    responseText: "",
    response: null,
    responseURL: "",
    responseHeaders: {},
  };
  xhrState.set(xhr, created);
  return created;
}

function buildContext(urlString: string, method: string, resourceType: "fetch" | "xmlhttprequest") {
  const url = new URL(urlString, location.href);
  return {
    url: url.toString(),
    pageUrl: state.currentUrl,
    method,
    host: url.host,
    pathname: url.pathname,
    tabId: state.tabId,
    resourceType,
  };
}

async function createForwardPayload(request: Request, resourceType: "fetch" | "xmlhttprequest", matchedRuleId: string): Promise<ForwardRequestPayload> {
  const bodyBuffer = await readBody(request.clone());
  if (bodyBuffer && bodyBuffer.byteLength > FORWARD_BODY_LIMIT_BYTES) {
    warnPayloadTooLarge(request.url, bodyBuffer.byteLength);
    throw new Error(PAYLOAD_TOO_LARGE_SENTINEL);
  }
  return {
    url: request.url,
    pageUrl: state.currentUrl,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: bodyBuffer ? bytesToBase64(bodyBuffer) : undefined,
    bodyEncoding: bodyBuffer ? "base64" : undefined,
    tabId: state.tabId,
    resourceType,
    matchedRuleId,
  };
}

async function createForwardPayloadFromBody(xhr: XhrState, body: Document | XMLHttpRequestBodyInit | null | undefined, matchedRuleId: string): Promise<ForwardRequestPayload> {
  const buffer = body ? await readBody(new Request(xhr.url, { method: xhr.method, body: body as BodyInit }).clone()) : undefined;
  if (buffer && buffer.byteLength > FORWARD_BODY_LIMIT_BYTES) {
    warnPayloadTooLarge(xhr.url, buffer.byteLength);
    throw new Error(PAYLOAD_TOO_LARGE_SENTINEL);
  }
  return {
    url: xhr.url,
    pageUrl: state.currentUrl,
    method: xhr.method,
    headers: xhr.requestHeaders,
    body: buffer ? bytesToBase64(buffer) : undefined,
    bodyEncoding: buffer ? "base64" : undefined,
    tabId: state.tabId,
    resourceType: "xmlhttprequest",
    matchedRuleId,
  };
}

async function dispatchProxyRequest(
  id: string,
  payload: ForwardRequestPayload,
  signal?: AbortSignal,
): Promise<ForwardResponsePayload> {
  return new Promise<ForwardResponsePayload>((resolve, reject) => {
    const onAbort = () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      sendAbortMessage(id);
      cleanup();
      reject(signalAbortReason(signal));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    // Wrap resolve/reject so the listener is always removed exactly once,
    // regardless of which path completes the promise. Long-lived AbortSignals
    // reused across many requests would otherwise accumulate listeners.
    pending.set(id, {
      resolve: (value) => { cleanup(); resolve(value); },
      reject: (reason) => { cleanup(); reject(reason); },
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }

    postToBridge({ type: "proxy-request", payload: { id, request: payload } });
  });
}

function sendAbortMessage(id: string): void {
  postToBridge({ type: "proxy-abort", payload: { id } });
}

function signalAbortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function createBrowserResponse(forwarded: ForwardResponsePayload): Response {
  return new Response(toArrayBuffer(decodeForwardBody(forwarded)), {
    status: forwarded.status,
    statusText: forwarded.statusText,
    headers: forwarded.headers,
  });
}

function applyXhrResponse(xhr: XMLHttpRequest, current: XhrState, forwarded: ForwardResponsePayload): void {
  current.intercepted = true;
  current.status = forwarded.status;
  current.statusText = forwarded.statusText;
  current.responseHeaders = normalizeHeaders(forwarded.headers);
  current.responseURL = forwarded.responseUrl;

  // HEADERS_RECEIVED — handlers reading status/getAllResponseHeaders here
  // expect them to be populated, so fill state before the dispatch.
  current.readyState = 2;
  dispatchXhrEvent(xhr, "readystatechange");

  const body = decodeForwardBody(forwarded);
  const responseType = current.responseType || "text";
  if (responseType === "arraybuffer") {
    current.response = toArrayBuffer(body);
    current.responseText = "";
  } else if (responseType === "blob") {
    current.response = new Blob([toArrayBuffer(body)], { type: current.responseHeaders["content-type"] });
    current.responseText = "";
  } else {
    const text = new TextDecoder().decode(body);
    current.responseText = text;
    current.response = responseType === "json" ? safeJsonParse(text) : text;
  }

  // LOADING — many libraries (axios <0.27, fetch polyfills) gate response body
  // reading on readyState >= 3, and progress bars need the progress event.
  // Dispatching synthesised LOADING + a single progress event matches what a
  // local upstream that returned the whole body in one chunk would look like.
  current.readyState = 3;
  dispatchXhrEvent(xhr, "readystatechange");
  dispatchProgressEvent(xhr, "progress", body.byteLength);

  current.readyState = 4;
  dispatchXhrEvent(xhr, "readystatechange");
  dispatchProgressEvent(xhr, "load", body.byteLength);
  dispatchProgressEvent(xhr, "loadend", body.byteLength);
}

function dispatchXhrEvent(xhr: XMLHttpRequest, type: string): void {
  const event = new Event(type);
  xhr.dispatchEvent(event);
  const handler = (xhr as unknown as Record<string, unknown>)[`on${type}`];
  if (typeof handler === "function") {
    handler.call(xhr, event);
  }
}

function dispatchProgressEvent(xhr: XMLHttpRequest, type: string, total: number): void {
  // ProgressEvent is the spec-correct event class for progress/load/loadend.
  // It also exposes upload progress hooks via xhr.upload, but the page bridge
  // only ever fires download progress so we skip that path.
  const event =
    typeof ProgressEvent === "function"
      ? new ProgressEvent(type, { lengthComputable: total > 0, loaded: total, total })
      : new Event(type);
  xhr.dispatchEvent(event);
  const handler = (xhr as unknown as Record<string, unknown>)[`on${type}`];
  if (typeof handler === "function") {
    handler.call(xhr, event);
  }
}

function decodeForwardBody(forwarded: ForwardResponsePayload): Uint8Array {
  if (!forwarded.body) {
    return new Uint8Array();
  }
  if (forwarded.bodyEncoding === "base64") {
    return base64ToBytes(forwarded.body);
  }
  return new TextEncoder().encode(forwarded.body);
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function readBody(request: Request): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const buffer = await request.arrayBuffer();
  return buffer.byteLength ? new Uint8Array(buffer) : undefined;
}

// Chunk size chosen so String.fromCharCode.apply doesn't blow the call stack
// (most JS engines cap at ~120k args). 0x8000 keeps each apply call cheap and
// the GC happy for very large bodies (multi-MB upload XHRs).
const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  // The previous implementation appended one char at a time inside .forEach,
  // which produced a String of length ~N with ~N intermediate allocations.
  // Chunked apply produces ~N/CHUNK intermediate strings concatenated once at
  // the end — measurable on multi-MB JSON bodies (>10× faster in practice).
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const length = binary.length;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isServiceOfflineError(error: unknown): boolean {
  return error instanceof Error && error.message === SERVICE_OFFLINE_SENTINEL;
}

function isPayloadTooLargeError(error: unknown): boolean {
  return error instanceof Error && error.message === PAYLOAD_TOO_LARGE_SENTINEL;
}

function isStreamingUnsupportedError(error: unknown): boolean {
  return error instanceof Error && error.message === STREAMING_UNSUPPORTED_SENTINEL;
}

/**
 * Best-effort body size for the synchronous-sized BodyInit variants.
 * Returns -1 for ReadableStream / FormData / Document — sizes that can only
 * be known after fully consuming the body, so we let the request through and
 * rely on the post-read check inside createForwardPayload.
 */
function approximateBodySize(body: unknown): number {
  if (body == null) return 0;
  if (typeof body === "string") return body.length;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return body.toString().length;
  return -1;
}

function warnPayloadTooLarge(url: string, size: number): void {
  console.warn(
    `[resource-forwarder] body for ${url} is ${size} bytes (limit ${FORWARD_BODY_LIMIT_BYTES}); falling back to native request.`,
  );
}

function replayHeadersToNative(
  xhr: XMLHttpRequest,
  current: XhrState,
  nativeSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader,
): void {
  for (const [name, value] of Object.entries(current.requestHeaders)) {
    try {
      nativeSetRequestHeader.call(xhr, name, value);
    } catch {
      // setRequestHeader can throw for forbidden header names; ignore so a
      // single bad header doesn't take down the whole request.
    }
  }
}
