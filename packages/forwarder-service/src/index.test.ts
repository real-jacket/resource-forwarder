import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  app = buildServer({ storage });

  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  await storage.importWorkspace({
    format: "json",
    merge: false,
    content: JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: [
        {
          id: "project-1",
          name: "App",
          enabled: true,
          siteHosts: ["app.example.com"],
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      ruleSets: [
        {
          id: "ruleset-1",
          projectId: "project-1",
          name: "Default",
          enabled: true,
          ruleIds: ["rule-api"],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  await app.close();
  await rm(tempRoot, { recursive: true, force: true });
});

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
});
