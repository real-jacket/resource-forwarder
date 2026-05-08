import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { WorkspaceStorage } from "./storage.js";
import { buildServer } from "./index.js";

let tempRoot = "";
let storage: WorkspaceStorage;
let app: ReturnType<typeof buildServer>;
const fetchMock = vi.fn<typeof fetch>();

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "resource-forwarder-"));
  storage = new WorkspaceStorage(tempRoot);
  await storage.init();
  // logger:false keeps test output clean; disableRateLimit avoids flakey
  // failures when the suite hammers /forward in a tight loop.
  app = buildServer({ storage, logger: false, disableRateLimit: true });

  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  await resetWorkspace();
});

beforeEach(async () => {
  fetchMock.mockClear();
  await resetWorkspace();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  await app.close();
  await rm(tempRoot, { recursive: true, force: true });
});

async function resetWorkspace(): Promise<void> {
  await storage.importWorkspace({
    format: "json",
    merge: false,
    content: JSON.stringify(createWorkspace()),
  });
}

function createWorkspace(): WorkspaceSnapshot {
  const now = new Date().toISOString();
  return {
      version: 1,
      updatedAt: now,
      projects: [
        {
          id: "project-1",
          name: "App",
          enabled: true,
          siteHosts: ["app.example.com"],
          tags: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      ruleSets: [
        {
          id: "ruleset-1",
          projectId: "project-1",
          name: "Default",
          enabled: true,
          ruleIds: ["rule-api", "rule-disabled"],
          createdAt: now,
          updatedAt: now,
        },
      ],
      rules: [
        {
          id: "rule-api",
          name: "Forward API",
          enabled: true,
          kind: "api_forward",
          priority: 100,
          match: {
            host: ["app.example.com"],
            pathGlob: "/api/**",
            resourceType: ["fetch", "xmlhttprequest"],
            method: ["GET", "POST"],
            tabScope: { mode: "all" },
          },
          target: {
            forwardProfile: {
              targetBaseUrl: "http://upstream.test",
            },
          },
          tags: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "rule-disabled",
          name: "Disabled API",
          enabled: false,
          kind: "api_forward",
          priority: 200,
          match: {
            host: ["app.example.com"],
            pathGlob: "/disabled/**",
            resourceType: ["fetch"],
            method: ["GET"],
            tabScope: { mode: "all" },
          },
          target: {
            forwardProfile: {
              targetBaseUrl: "http://disabled-upstream.test",
            },
          },
          tags: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
}

describe("forwarder-service", () => {
  it("responds to health checks", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
  });

  it("forwards matched API requests", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/api/profile?view=full",
        method: "GET",
        headers: {},
        resourceType: "fetch",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://upstream.test/api/profile?view=full");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe(200);
    expect(body.body).toContain('"ok":true');
  });

  it("does not forward through a disabled matchedRuleId", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/disabled/profile",
        method: "GET",
        headers: {},
        resourceType: "fetch",
        matchedRuleId: "rule-disabled",
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(404);
  });

  it("does not fall back to another rule when matchedRuleId is invalid", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/api/profile",
        method: "GET",
        headers: {},
        resourceType: "fetch",
        matchedRuleId: "rule-disabled",
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(404);
  });

  it("does not forward through a matchedRuleId when the request no longer matches it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/other/profile",
        method: "GET",
        headers: {},
        resourceType: "fetch",
        matchedRuleId: "rule-api",
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(404);
  });

  it("does not grant browser CORS access to ordinary web origins", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        origin: "https://evil.example.com",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects malformed /forward bodies with a 400 instead of crashing the route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/forward",
      payload: { method: "GET" },
    });
    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects /import payloads with the wrong format enum value", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/import",
      payload: { content: "{}", format: "csv" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("does not leak storagePath via /health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.json()).toMatchObject({ ok: true });
    expect(response.json()).not.toHaveProperty("storagePath");
  });

  it("clamps /logs?limit to a safe upper bound", async () => {
    const response = await app.inject({ method: "GET", url: "/logs?limit=99999" });
    expect(response.statusCode).toBe(200);
    // Hard cap matches WorkspaceStorage MAX_LOGS_PAGE_SIZE; the response shape
    // doesn't expose the cap directly, so we just make sure the request didn't
    // 500 from trying to allocate a huge buffer.
    expect(Array.isArray(response.json().logs)).toBe(true);
  });

  it("returns 429 once the per-route rate limit is hit", async () => {
    // Dial /forward down to 3 reqs / minute so the test runs quickly while
    // still exercising the same code path production traffic hits at 300/min.
    const limited = buildServer({
      storage,
      logger: false,
      rateLimit: { forward: { max: 3, timeWindow: "1 minute" } },
    });
    // Crucial: ready() must complete before the route's per-route rate-limit
    // config is honoured. If we rely on inject's auto-ready, the plugin and
    // route registrations interleave with subsequent injects in a way that
    // makes the per-route override flake.
    await limited.ready();
    try {
      const responses = [];
      for (let i = 0; i < 6; i += 1) {
        const r = await limited.inject({
          method: "POST",
          url: "/forward",
          payload: {
            url: "https://app.example.com/api/x",
            method: "GET",
            headers: {},
            resourceType: "fetch",
          },
        });
        responses.push({ status: r.statusCode, headers: r.headers });
      }
      // The plugin sets x-ratelimit-* headers on every response it touches,
      // so we can validate it's actively enforcing the limit even before
      // statusCode flips to 429.
      expect(responses[0].headers["x-ratelimit-limit"]).toBe("3");
      expect(responses.slice(0, 3).every((r) => r.status !== 429)).toBe(true);
      expect(responses.slice(3).some((r) => r.status === 429)).toBe(true);
    } finally {
      await limited.close();
    }
  });

  it("appends hit logs out of band so a slow log file can't delay /forward responses", async () => {
    // The shared fetchMock is configured with mockResolvedValue (set once in
    // beforeAll) — each call returns the SAME Response object, whose body is
    // already consumed by an earlier successful test. Provide a fresh one for
    // this test so forwardThroughRule can read the body without throwing.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/api/profile?async=true",
        method: "GET",
        headers: {},
        resourceType: "fetch",
      },
    });
    expect(response.statusCode).toBe(200);

    // /logs awaits hitLogger.flush() before reading the file, which is exactly
    // the contract we need: the request returned without waiting on disk IO,
    // but the record is durable by the time anyone asks for it.
    const logsResponse = await app.inject({ method: "GET", url: "/logs?limit=10" });
    const logs = logsResponse.json().logs as Array<{ requestUrl: string }>;
    expect(logs.some((log) => log.requestUrl.includes("async=true"))).toBe(true);
  });

  it("returns 409 stream-unsupported when upstream is text/event-stream", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("data: hello\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/api/profile",
        method: "GET",
        headers: {},
        resourceType: "fetch",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("stream-unsupported");
  });

  it("preserves Cookie when forwarding to the same host", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );

    // Configure a same-host forward profile so the host comparison matches.
    await storage.upsertRule({
      ruleSetId: "ruleset-1",
      rule: {
        id: "rule-same-host",
        name: "same-host",
        enabled: true,
        kind: "api_forward",
        priority: 500,
        match: {
          host: ["app.example.com"],
          pathGlob: "/echo/**",
          resourceType: ["fetch"],
          method: ["GET"],
          tabScope: { mode: "all" },
        },
        target: { forwardProfile: { targetBaseUrl: "https://app.example.com" } },
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/echo/me",
        method: "GET",
        headers: { cookie: "session=abc" },
        resourceType: "fetch",
      },
    });

    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    const sentHeaders = init?.headers as Headers;
    expect(sentHeaders.get("cookie")).toBe("session=abc");
  });

  it("strips Cookie when forwarding cross-origin", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );

    await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/api/profile",
        method: "GET",
        headers: { cookie: "session=abc" },
        resourceType: "fetch",
      },
    });

    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    const sentHeaders = init?.headers as Headers;
    expect(sentHeaders.get("cookie")).toBeNull();
  });

  describe("auth + host-header guard", () => {
    let secured: ReturnType<typeof buildServer>;

    beforeAll(async () => {
      secured = buildServer({
        storage,
        logger: false,
        disableRateLimit: true,
        authToken: "test-secret-token",
        extensionId: "abcdefghijklmnopabcdefghijklmnop",
      });
      await secured.ready();
    });

    afterAll(async () => {
      await secured.close();
    });

    it("requires a bearer token on /forward", async () => {
      const response = await secured.inject({
        method: "POST",
        url: "/forward",
        headers: { host: "127.0.0.1:5178" },
        payload: {
          url: "https://app.example.com/api/profile",
          method: "GET",
          headers: {},
          resourceType: "fetch",
        },
      });
      expect(response.statusCode).toBe(401);
    });

    it("accepts the request when the bearer token matches", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const response = await secured.inject({
        method: "POST",
        url: "/forward",
        headers: {
          host: "127.0.0.1:5178",
          authorization: "Bearer test-secret-token",
        },
        payload: {
          url: "https://app.example.com/api/profile",
          method: "GET",
          headers: {},
          resourceType: "fetch",
        },
      });
      expect(response.statusCode).toBe(200);
    });

    it("leaves /health reachable without a token", async () => {
      const response = await secured.inject({
        method: "GET",
        url: "/health",
        headers: { host: "127.0.0.1:5178" },
      });
      expect(response.statusCode).toBe(200);
    });

    it("rejects requests with a non-loopback Host header", async () => {
      const response = await secured.inject({
        method: "GET",
        url: "/health",
        headers: { host: "evil.example.com" },
      });
      expect(response.statusCode).toBe(403);
    });

    it("denies CORS to chrome-extension origins that do not match the configured id", async () => {
      const response = await secured.inject({
        method: "GET",
        url: "/health",
        headers: {
          host: "127.0.0.1:5178",
          origin: "chrome-extension://other-extension-id",
        },
      });
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("grants CORS to the pinned chrome-extension origin", async () => {
      const response = await secured.inject({
        method: "GET",
        url: "/health",
        headers: {
          host: "127.0.0.1:5178",
          origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        },
      });
      expect(response.headers["access-control-allow-origin"]).toBe(
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      );
    });
  });
});
