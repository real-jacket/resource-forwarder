import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Rule, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { SERVICE_AUTH_REQUIRED_SENTINEL, WINDOW_SOURCE } from "./shared/constants.js";

interface FakeBridgePort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message?: unknown) => unknown;
}

interface PageGlobals {
  pageWindow: { fetch: typeof fetch };
  nativeFetch: typeof fetch;
  nativeOpen: XMLHttpRequest["open"];
  readonly messageHandler: ((event: MessageEvent) => void) | undefined;
  xhrPrototype: XMLHttpRequest;
}

const now = "2026-08-15T00:00:00.000Z";

function workspace(rules: Rule[]): WorkspaceSnapshot {
  return {
    version: 1,
    revision: 0,
    updatedAt: now,
    projects: [{
      id: "project",
      name: "Project",
      enabled: true,
      siteHosts: ["example.com"],
      siteMatchPatterns: ["https://example.com/*"],
      tags: [],
      createdAt: now,
      updatedAt: now,
    }],
    ruleSets: [{
      id: "ruleset",
      projectId: "project",
      name: "Rules",
      enabled: true,
      ruleIds: rules.map((rule) => rule.id),
      createdAt: now,
      updatedAt: now,
    }],
    rules,
  };
}

const apiRule: Rule = {
  id: "api",
  name: "API",
  enabled: true,
  kind: "api_forward",
  priority: 100,
  match: { host: ["example.com"], pathGlob: "/api/**", tabScope: { mode: "all" } },
  target: { forwardProfile: { targetBaseUrl: "https://upstream.example.com" } },
  tags: [],
  createdAt: now,
  updatedAt: now,
};

function installPageGlobals(): PageGlobals {
  let messageHandler: ((event: MessageEvent) => void) | undefined;
  const nativeFetch = vi.fn(async () => new Response("native"));
  const pageWindow = {
    fetch: nativeFetch,
    addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
      if (type === "message") messageHandler = handler;
    }),
    removeEventListener: vi.fn(),
    postMessage: vi.fn(),
  };

  class FakeXmlHttpRequest extends EventTarget {
    open(_method: string, _url: string | URL): void {}
    send(_body?: Document | XMLHttpRequestBodyInit | null): void {}
    setRequestHeader(_name: string, _value: string): void {}
    abort(): void {}
    getAllResponseHeaders(): string { return ""; }
    getResponseHeader(_name: string): string | null { return null; }
    override dispatchEvent(event: Event): boolean {
      const result = super.dispatchEvent(event);
      const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`];
      if (typeof handler === "function") handler.call(this, event);
      return result;
    }
  }
  Object.defineProperties(FakeXmlHttpRequest.prototype, {
    readyState: { configurable: true, get: () => 0 },
    status: { configurable: true, get: () => 0 },
    statusText: { configurable: true, get: () => "" },
    responseText: { configurable: true, get: () => "" },
    response: { configurable: true, get: () => null },
    responseURL: { configurable: true, get: () => "" },
    responseType: { configurable: true, get: () => "", set: () => undefined },
  });

  vi.stubGlobal("window", pageWindow);
  vi.stubGlobal("location", { href: "https://example.com/page", origin: "https://example.com" });
  vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest);

  return {
    pageWindow,
    nativeFetch,
    nativeOpen: FakeXmlHttpRequest.prototype.open as XMLHttpRequest["open"],
    get messageHandler() { return messageHandler; },
    xhrPrototype: FakeXmlHttpRequest.prototype as unknown as XMLHttpRequest,
  };
}

async function connectBridge(globals: PageGlobals): Promise<FakeBridgePort> {
  // Dynamic import is required because the bridge installs against per-test globals at module initialization.
  await import("./page-bridge.js");
  const port: FakeBridgePort = { onmessage: null, postMessage: vi.fn() };
  globals.messageHandler?.({
    source: window,
    data: { source: WINDOW_SOURCE, type: "bridge-port" },
    ports: [port as unknown as MessagePort],
  } as unknown as MessageEvent);
  return port;
}

function sendConfig(port: FakeBridgePort, nextWorkspace: WorkspaceSnapshot): void {
  port.onmessage?.({
    data: {
      source: WINDOW_SOURCE,
      type: "config",
      payload: {
        serviceUrl: "",
        workspace: nextWorkspace,
        currentUrl: "https://example.com/page",
        warnings: [],
      },
    },
  } as MessageEvent);
}

function sendProxyResponse(port: FakeBridgePort, id: string, body = "ok"): void {
  port.onmessage?.({
    data: {
      source: WINDOW_SOURCE,
      type: "proxy-response",
      payload: {
        id,
        response: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/plain", "x-test": "yes" },
          body,
          bodyEncoding: "utf8",
          responseUrl: "https://example.com/result",
        },
      },
    },
  } as MessageEvent);
}

function sendProxyError(port: FakeBridgePort, id: string, error: string): void {
  port.onmessage?.({
    data: {
      source: WINDOW_SOURCE,
      type: "proxy-error",
      payload: { id, error },
    },
  } as MessageEvent);
}

describe("page bridge patch lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("keeps fetch and XHR native before the first config", async () => {
    const globals = installPageGlobals();
    await connectBridge(globals);

    expect(window.fetch).toBe(globals.nativeFetch);
    expect(globals.xhrPrototype.open).toBe(globals.nativeOpen);
  });

  it("installs patches after an applicable config", async () => {
    const globals = installPageGlobals();
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));

    expect(window.fetch).not.toBe(globals.nativeFetch);
    expect(globals.xhrPrototype.open).not.toBe(globals.nativeOpen);
  });

  it("matches canonical hosts when requests use a custom port", async () => {
    const globals = installPageGlobals();
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));

    const responsePromise = window.fetch("https://example.com:8443/api/users");
    await Promise.resolve();
    await Promise.resolve();
    const request = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string; payload?: { id: string; request: { matchedRuleId?: string } } })
      .find((message) => message.type === "proxy-request");

    expect(request?.payload?.request.matchedRuleId).toBe(apiRule.id);
    sendProxyResponse(port, request!.payload!.id);
    await responsePromise;
  });

  it("falls back to native fetch when the local service rejects its token", async () => {
    const globals = installPageGlobals();
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));

    const responsePromise = window.fetch("https://example.com/api/users");
    await Promise.resolve();
    await Promise.resolve();
    const request = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string; payload?: { id: string } })
      .find((message) => message.type === "proxy-request");
    sendProxyError(port, request!.payload!.id, SERVICE_AUTH_REQUIRED_SENTINEL);

    const response = await responsePromise;
    expect(await response.text()).toBe("native");
    expect(globals.nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("restores native methods after leaving scope", async () => {
    const globals = installPageGlobals();
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    sendConfig(port, workspace([]));

    expect(window.fetch).toBe(globals.nativeFetch);
    expect(globals.xhrPrototype.open).toBe(globals.nativeOpen);
  });

  it("does not overwrite wrappers installed by the page after our patch", async () => {
    const globals = installPageGlobals();
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    const laterFetch = vi.fn(async () => new Response("later"));
    const laterOpen = vi.fn();
    window.fetch = laterFetch;
    globals.xhrPrototype.open = laterOpen;

    sendConfig(port, workspace([]));

    expect(window.fetch).toBe(laterFetch);
    expect(globals.xhrPrototype.open).toBe(laterOpen);
  });

  it("rebuilds the matcher when equal-sized SPA configs switch rule content", async () => {
    const globals = installPageGlobals();
    const port = await connectBridge(globals);
    const tablesRule: Rule = { ...apiRule, id: "tables", match: { ...apiRule.match, pathGlob: "/tables/**" } };
    const sheetsRule: Rule = { ...apiRule, id: "sheets", match: { ...apiRule.match, pathGlob: "/sheets/**" } };

    sendConfig(port, workspace([tablesRule]));
    const tablesFetch = window.fetch("https://example.com/tables/1");
    await Promise.resolve();
    await Promise.resolve();
    const tablesMessage = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string; payload?: { id: string; request: { matchedRuleId?: string } } })
      .filter((message) => message.type === "proxy-request")
      .at(-1);
    expect(tablesMessage?.payload?.request.matchedRuleId).toBe("tables");
    sendProxyResponse(port, tablesMessage!.payload!.id);
    await tablesFetch;

    sendConfig(port, workspace([sheetsRule]));
    const sheetsFetch = window.fetch("https://example.com/sheets/1");
    await Promise.resolve();
    await Promise.resolve();
    const sheetsMessage = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string; payload?: { id: string; request: { matchedRuleId?: string } } })
      .filter((message) => message.type === "proxy-request")
      .at(-1);
    expect(sheetsMessage?.payload?.request.matchedRuleId).toBe("sheets");
    sendProxyResponse(port, sheetsMessage!.payload!.id);
    await sheetsFetch;
  });

  it("keeps an in-flight intercepted XHR readable after leaving scope", async () => {
    const port = await connectBridge(installPageGlobals());
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/api/users");
    xhr.send();
    await Promise.resolve();
    await Promise.resolve();
    const requestMessage = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string; payload?: { id: string } })
      .filter((message) => message.type === "proxy-request")
      .at(-1);
    expect(requestMessage?.payload?.id).toBeTruthy();

    sendConfig(port, workspace([]));
    sendProxyResponse(port, requestMessage!.payload!.id, "xhr-body");
    await Promise.resolve();
    await Promise.resolve();

    expect(xhr.status).toBe(200);
    expect(xhr.responseText).toBe("xhr-body");
    expect(xhr.getResponseHeader("x-test")).toBe("yes");
  });

  it("keeps deferred headers and send after an opened XHR leaves scope", async () => {
    const globals = installPageGlobals();
    const nativeSetRequestHeader = vi.spyOn(globals.xhrPrototype, "setRequestHeader");
    const nativeSend = vi.spyOn(globals.xhrPrototype, "send");
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/api/users");
    xhr.setRequestHeader("x-before-exit", "yes");
    expect(nativeSetRequestHeader).not.toHaveBeenCalled();

    sendConfig(port, workspace([]));
    xhr.send();
    await Promise.resolve();

    expect(nativeSetRequestHeader).toHaveBeenCalledWith("x-before-exit", "yes");
    expect(nativeSend).toHaveBeenCalledTimes(1);
  });

  it("keeps abort active while request body serialization is pending", async () => {
    const globals = installPageGlobals();
    const nativeAbort = vi.spyOn(globals.xhrPrototype, "abort");
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    let resolveBody!: (value: ArrayBuffer) => void;
    const body = new Promise<ArrayBuffer>((resolve) => { resolveBody = resolve; });
    class DeferredRequest {
      method: string;
      constructor(_input: string, init?: RequestInit) { this.method = init?.method ?? "GET"; }
      clone(): DeferredRequest { return this; }
      arrayBuffer(): Promise<ArrayBuffer> { return body; }
    }
    vi.stubGlobal("Request", DeferredRequest);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "https://example.com/api/users");
    xhr.send("body");
    await Promise.resolve();

    sendConfig(port, workspace([]));
    xhr.abort();
    resolveBody(new ArrayBuffer(4));
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeAbort).toHaveBeenCalledTimes(1);
    const proxyRequests = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string })
      .filter((message) => message.type === "proxy-request");
    expect(proxyRequests).toHaveLength(0);
  });

  it("preserves page-owned instance methods and leaves pinned methods replaceable", async () => {
    const globals = installPageGlobals();
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    const pageSend = vi.fn();
    Object.defineProperty(xhr, "send", { configurable: true, writable: true, value: pageSend });

    xhr.open("GET", "https://example.com/api/users");

    expect(Object.getOwnPropertyDescriptor(xhr, "send")).toMatchObject({ configurable: true, writable: true });
    const abortDescriptor = Object.getOwnPropertyDescriptor(xhr, "abort");
    expect(abortDescriptor).toMatchObject({ configurable: true, writable: true });
    const laterAbort = vi.fn();
    xhr.abort = laterAbort;
    expect(xhr.abort).toBe(laterAbort);

    sendConfig(port, workspace([]));
    xhr.send();
    await Promise.resolve();
    expect(pageSend).toHaveBeenCalledTimes(1);
    expect(xhr.send).toBe(pageSend);
  });

  it("resets a completed intercepted XHR when reused after leaving scope", async () => {
    const globals = installPageGlobals();
    const nativeSetRequestHeader = vi.spyOn(globals.xhrPrototype, "setRequestHeader");
    const nativeSend = vi.spyOn(globals.xhrPrototype, "send");
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/api/users");
    xhr.send();
    await Promise.resolve();
    await Promise.resolve();
    const requestMessage = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string; payload?: { id: string } })
      .filter((message) => message.type === "proxy-request")
      .at(-1)!;
    sendProxyResponse(port, requestMessage.payload!.id, "first");
    await Promise.resolve();
    await Promise.resolve();
    expect(xhr.status).toBe(200);

    sendConfig(port, workspace([]));
    xhr.open("GET", "https://example.com/native");
    xhr.setRequestHeader("x-reused", "yes");
    xhr.send();
    await Promise.resolve();

    expect(xhr.status).toBe(0);
    expect(nativeSetRequestHeader).toHaveBeenCalledWith("x-reused", "yes");
    expect(nativeSend).toHaveBeenCalledTimes(1);
  });

  it("chains a page-owned abort wrapper during deferred serialization", async () => {
    const globals = installPageGlobals();
    const nativeAbort = globals.xhrPrototype.abort;
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    let resolveBody!: (value: ArrayBuffer) => void;
    const body = new Promise<ArrayBuffer>((resolve) => { resolveBody = resolve; });
    class DeferredRequest {
      method: string;
      constructor(_input: string, init?: RequestInit) { this.method = init?.method ?? "GET"; }
      clone(): DeferredRequest { return this; }
      arrayBuffer(): Promise<ArrayBuffer> { return body; }
    }
    vi.stubGlobal("Request", DeferredRequest);
    const xhr = new XMLHttpRequest();
    const pageAbort = vi.fn(function pageAbort(this: XMLHttpRequest) {
      nativeAbort.call(this);
    });
    Object.defineProperty(xhr, "abort", { configurable: true, writable: true, value: pageAbort });
    xhr.open("POST", "https://example.com/api/users");
    xhr.send("body");
    await Promise.resolve();

    sendConfig(port, workspace([]));
    xhr.abort();
    resolveBody(new ArrayBuffer(4));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(pageAbort).toHaveBeenCalledTimes(1);
    const proxyRequests = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string })
      .filter((message) => message.type === "proxy-request");
    expect(proxyRequests).toHaveLength(0);
  });

  it("chains a dynamic page-owned open wrapper and resets reused state", async () => {
    const globals = installPageGlobals();
    const nativeSetRequestHeader = vi.spyOn(globals.xhrPrototype, "setRequestHeader");
    const nativeSend = vi.spyOn(globals.xhrPrototype, "send");
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    const pageOpen = vi.fn(function pageOpen(this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["open"]>) {
      return XMLHttpRequest.prototype.open.call(this, ...args);
    });
    Object.defineProperty(xhr, "open", { configurable: true, writable: true, value: pageOpen });
    xhr.open("GET", "https://example.com/api/users");
    xhr.setRequestHeader("x-old", "stale");
    xhr.send();
    await Promise.resolve();
    await Promise.resolve();
    const requestMessage = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string; payload?: { id: string } })
      .filter((message) => message.type === "proxy-request")
      .at(-1)!;
    sendProxyResponse(port, requestMessage.payload!.id, "first");
    await Promise.resolve();
    await Promise.resolve();
    expect(xhr.status).toBe(200);

    sendConfig(port, workspace([]));
    nativeSetRequestHeader.mockClear();
    nativeSend.mockClear();
    xhr.open("GET", "https://example.com/native");
    xhr.send();
    await Promise.resolve();

    expect(pageOpen).toHaveBeenCalledTimes(2);
    expect(xhr.status).toBe(0);
    expect(nativeSetRequestHeader).not.toHaveBeenCalledWith("x-old", "stale");
    expect(nativeSend).toHaveBeenCalledTimes(1);
  });

  it("releases instance methods so later prototype instrumentation is visible", async () => {
    const globals = installPageGlobals();
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/native");
    xhr.send();
    await Promise.resolve();

    sendConfig(port, workspace([]));
    const laterSend = vi.fn();
    XMLHttpRequest.prototype.send = laterSend;
    xhr.open("GET", "https://example.com/native-again");
    xhr.send();

    expect(laterSend).toHaveBeenCalledTimes(1);
  });

  it("releases settled native XHR instance descriptors while scope remains active", async () => {
    const globals = installPageGlobals();
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://example.com/native");
    xhr.send();
    await Promise.resolve();

    expect(Object.prototype.hasOwnProperty.call(xhr, "open")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xhr, "send")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xhr, "abort")).toBe(false);
  });

  it("chains a page-owned send wrapper without losing deferred headers", async () => {
    const globals = installPageGlobals();
    const nativeSetRequestHeader = vi.spyOn(globals.xhrPrototype, "setRequestHeader");
    const nativeHeader = globals.xhrPrototype.setRequestHeader;
    const nativeSend = vi.spyOn(globals.xhrPrototype, "send");
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    const pageHeader = vi.fn(function pageHeader(this: XMLHttpRequest, name: string, value: string) {
      nativeHeader.call(this, name, value);
    });
    const pageSend = vi.fn(function pageSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      this.setRequestHeader("x-owned-send", "yes");
      XMLHttpRequest.prototype.send.call(this, body ?? null);
    });
    Object.defineProperty(xhr, "setRequestHeader", { configurable: false, writable: true, value: pageHeader });
    Object.defineProperty(xhr, "send", { configurable: true, writable: true, value: pageSend });
    xhr.open("GET", "https://example.com/api/users");
    sendConfig(port, workspace([]));
    xhr.send();
    await Promise.resolve();

    expect(pageSend).toHaveBeenCalledTimes(1);
    expect(pageHeader).toHaveBeenCalledTimes(1);
    expect(nativeSetRequestHeader).toHaveBeenCalledTimes(1);
    expect(nativeSetRequestHeader).toHaveBeenCalledWith("x-owned-send", "yes");
    expect(nativeSend).toHaveBeenCalledTimes(1);
    expect(Object.getOwnPropertyDescriptor(xhr, "send")?.value).toBe(pageSend);
    expect(Object.prototype.hasOwnProperty.call(xhr, "open")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xhr, "abort")).toBe(false);
    expect(Object.getOwnPropertyDescriptor(xhr, "setRequestHeader")).toMatchObject({
      configurable: false,
      value: pageHeader,
    });
  });

  it("runs a page-owned send wrapper before intercepted forwarding", async () => {
    const globals = installPageGlobals();
    const nativeSend = vi.spyOn(globals.xhrPrototype, "send");
    const port = await connectBridge(globals);
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    const pageSend = vi.fn(function pageSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      this.setRequestHeader("x-page-wrapper", "yes");
      XMLHttpRequest.prototype.send.call(this, `${String(body)}-wrapped`);
    });
    Object.defineProperty(xhr, "send", { configurable: true, writable: true, value: pageSend });
    xhr.open("POST", "https://example.com/api/users");

    xhr.send("original");
    const proxyRequests = () => vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as {
        type?: string;
        payload?: { id: string; request: { headers: Record<string, string>; body?: string } };
      })
      .filter((message) => message.type === "proxy-request");
    await vi.waitFor(() => expect(proxyRequests()).toHaveLength(1));
    const requestMessage = proxyRequests()[0]!;
    expect(pageSend).toHaveBeenCalledTimes(1);
    expect(nativeSend).not.toHaveBeenCalled();
    expect(requestMessage.payload!.request.headers).toMatchObject({ "x-page-wrapper": "yes" });
    expect(requestMessage.payload!.request.body).toBe("b3JpZ2luYWwtd3JhcHBlZA==");

    sendProxyResponse(port, requestMessage.payload!.id);
    await Promise.resolve();
    await Promise.resolve();
    sendConfig(port, workspace([]));
    xhr.open("GET", "https://example.com/native");
    expect(Object.getOwnPropertyDescriptor(xhr, "send")?.value).toBe(pageSend);
    expect(Object.prototype.hasOwnProperty.call(xhr, "open")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(xhr, "abort")).toBe(false);
  });

  it("guards a dynamic page-owned abort wrapper against RF re-entry", async () => {
    const port = await connectBridge(installPageGlobals());
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    const pageAbort = vi.fn(function pageAbort(this: XMLHttpRequest) {
      XMLHttpRequest.prototype.abort.call(this);
    });
    Object.defineProperty(xhr, "abort", { configurable: true, writable: true, value: pageAbort });
    const onAbort = vi.fn();
    const onLoadEnd = vi.fn();
    xhr.onabort = onAbort;
    xhr.onloadend = onLoadEnd;
    xhr.open("GET", "https://example.com/api/users");
    xhr.send();
    await Promise.resolve();
    await Promise.resolve();

    xhr.abort();

    const abortMessages = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string })
      .filter((message) => message.type === "proxy-abort");
    expect(pageAbort).toHaveBeenCalledTimes(1);
    expect(abortMessages).toHaveLength(1);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onLoadEnd).toHaveBeenCalledTimes(1);
  });

  it("dispatches XHR IDL property handlers once per synthetic event", async () => {
    const port = await connectBridge(installPageGlobals());
    sendConfig(port, workspace([apiRule]));
    const xhr = new XMLHttpRequest();
    const onReadyStateChange = vi.fn();
    const onLoad = vi.fn();
    const onLoadEnd = vi.fn();
    xhr.onreadystatechange = onReadyStateChange;
    xhr.onload = onLoad;
    xhr.onloadend = onLoadEnd;
    xhr.open("GET", "https://example.com/api/users");
    xhr.send();
    await Promise.resolve();
    await Promise.resolve();
    const requestMessage = vi.mocked(port.postMessage).mock.calls
      .map(([message]) => message as { type?: string; payload?: { id: string } })
      .filter((message) => message.type === "proxy-request")
      .at(-1)!;

    sendProxyResponse(port, requestMessage.payload!.id);
    await Promise.resolve();
    await Promise.resolve();

    expect(onReadyStateChange).toHaveBeenCalledTimes(3);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoadEnd).toHaveBeenCalledTimes(1);
  });
});
