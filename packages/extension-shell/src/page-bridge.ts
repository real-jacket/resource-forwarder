import { pickMatchingRule } from "@resource-forwarder/rule-core";
import type { ForwardRequestPayload, ForwardResponsePayload, SiteContextPayload, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { WINDOW_SOURCE } from "./shared/constants.js";

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
let state: SiteContextPayload = {
  serviceUrl: "",
  workspace: { version: 1, updatedAt: new Date().toISOString(), projects: [], ruleSets: [], rules: [] },
  currentUrl: location.href,
  warnings: [],
};

if (!pageWindow.__RESOURCE_FORWARDER_PATCHED__) {
  pageWindow.__RESOURCE_FORWARDER_PATCHED__ = true;
  installFetchPatch();
  installXhrPatch();
  window.addEventListener("message", handleBridgeMessage);
  window.postMessage({ source: WINDOW_SOURCE, type: "bridge-ready" }, location.origin);
}

function handleBridgeMessage(event: MessageEvent): void {
  if (event.source !== window) {
    return;
  }

  const data = event.data as { source?: string; type?: string; payload?: unknown };
  if (data?.source !== WINDOW_SOURCE) {
    return;
  }

  if (data.type === "config") {
    state = data.payload as SiteContextPayload;
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

function installFetchPatch(): void {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const match = pickMatchingRule(state.workspace as WorkspaceSnapshot, buildContext(request.url, request.method, "fetch"), "api_forward");
    if (!match) {
      return nativeFetch(input, init);
    }

    const payload = await createForwardPayload(request, "fetch");
    const forwarded = await dispatchProxyRequest(payload);
    return createBrowserResponse(forwarded);
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
    const current = getOrCreateXhrState(this);
    current.requestHeaders[name] = value;
    if (!current.intercepted) {
      nativeSetRequestHeader.call(this, name, value);
    }
  };

  xhrPrototype.send = function send(body?: Document | XMLHttpRequestBodyInit | null): void {
    const current = getOrCreateXhrState(this);
    const match = pickMatchingRule(state.workspace as WorkspaceSnapshot, buildContext(current.url, current.method, "xmlhttprequest"), "api_forward");
    if (!match) {
      nativeSend.call(this, body ?? null);
      return;
    }

    void (async () => {
      try {
        const payload = await createForwardPayloadFromBody(current, body ?? undefined);
        current.intercepted = true;
        const forwarded = await dispatchProxyRequest(payload);
        if (current.aborted) {
          return;
        }
        applyXhrResponse(this, current, forwarded);
      } catch {
        nativeSend.call(this, body ?? null);
      }
    })();
  };

  xhrPrototype.abort = function abort(): void {
    const current = xhrState.get(this);
    if (!current?.intercepted) {
      nativeAbort.call(this);
      return;
    }

    current.aborted = true;
    current.readyState = 0;
    dispatchXhrEvent(this, "abort");
    dispatchXhrEvent(this, "loadend");
  };

  xhrPrototype.getAllResponseHeaders = function getAllResponseHeaders(): string {
    const current = xhrState.get(this);
    if (!current?.intercepted) {
      return nativeGetAllResponseHeaders.call(this);
    }
    return Object.entries(current.responseHeaders)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n");
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
    method,
    host: url.host,
    pathname: url.pathname,
    tabId: state.tabId,
    resourceType,
  };
}

async function createForwardPayload(request: Request, resourceType: "fetch" | "xmlhttprequest"): Promise<ForwardRequestPayload> {
  const bodyBuffer = await readBody(request.clone());
  return {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: bodyBuffer ? bytesToBase64(bodyBuffer) : undefined,
    bodyEncoding: bodyBuffer ? "base64" : undefined,
    tabId: state.tabId,
    resourceType,
  };
}

async function createForwardPayloadFromBody(xhr: XhrState, body?: Document | XMLHttpRequestBodyInit | null): Promise<ForwardRequestPayload> {
  const buffer = body ? await readBody(new Request(xhr.url, { method: xhr.method, body: body as BodyInit }).clone()) : undefined;
  return {
    url: xhr.url,
    method: xhr.method,
    headers: xhr.requestHeaders,
    body: buffer ? bytesToBase64(buffer) : undefined,
    bodyEncoding: buffer ? "base64" : undefined,
    tabId: state.tabId,
    resourceType: "xmlhttprequest",
  };
}

async function dispatchProxyRequest(payload: ForwardRequestPayload): Promise<ForwardResponsePayload> {
  const id = crypto.randomUUID();
  return new Promise<ForwardResponsePayload>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage(
      {
        source: WINDOW_SOURCE,
        type: "proxy-request",
        payload: { id, request: payload },
      },
      location.origin,
    );
  });
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
  current.readyState = 2;
  current.status = forwarded.status;
  current.statusText = forwarded.statusText;
  current.responseHeaders = normalizeHeaders(forwarded.headers);
  current.responseURL = forwarded.responseUrl;
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

  current.readyState = 4;
  dispatchXhrEvent(xhr, "readystatechange");
  dispatchXhrEvent(xhr, "load");
  dispatchXhrEvent(xhr, "loadend");
}

function dispatchXhrEvent(xhr: XMLHttpRequest, type: string): void {
  const event = new Event(type);
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
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
