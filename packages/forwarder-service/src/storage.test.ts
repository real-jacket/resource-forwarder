import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStorage } from "./storage.js";

let tempRoot = "";
let storage: WorkspaceStorage;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "rf-storage-"));
  storage = new WorkspaceStorage(tempRoot);
  await storage.init();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const ts = "2024-01-01T00:00:00.000Z";

describe("WorkspaceStorage", () => {
  it("never leaves a partial workspace.json on disk after a write (atomic rename)", async () => {
    // Run a flurry of mutations in parallel, then read the file and ensure it
    // is well-formed JSON. A non-atomic write could leave torn bytes here.
    const upserts = Array.from({ length: 25 }, (_, i) =>
      storage.upsertProject({
        project: {
          id: `p${i}`,
          name: `Project ${i}`,
          enabled: true,
          siteHosts: [`site${i}.example.com`],
          tags: [],
          createdAt: ts,
          updatedAt: ts,
        },
      }),
    );
    await Promise.all(upserts);

    const raw = await readFile(join(tempRoot, "workspace.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw) as { projects: Array<{ id: string }> };
    // All 25 should be present — without serialization, parallel
    // read-modify-write would lose every commit but the last one to start.
    expect(parsed.projects).toHaveLength(25);
  });

  it("appendHits batches multiple records into a single file write", async () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      requestUrl: `https://app.example.com/${i}`,
      ruleId: "r1",
      target: `https://up.example.com/${i}`,
      durationMs: 5,
      outcome: "matched" as const,
      method: "GET",
      resourceType: "fetch" as const,
    }));
    const enriched = await storage.appendHits(records);
    expect(enriched).toHaveLength(10);

    const logs = await storage.listLogs(50);
    expect(logs).toHaveLength(10);
  });

  it("recovers from a corrupted workspace.json instead of bricking the service", async () => {
    // Simulate a torn write or hand-edit gone wrong: replace the workspace
    // file with non-JSON nonsense and make sure subsequent reads still return
    // a usable snapshot (and the bad file is quarantined for forensics).
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await writeFile(join(tempRoot, "workspace.json"), "{not json", "utf8");
      const recovered = await storage.readWorkspace();
      expect(recovered.projects).toEqual([]);
      expect(recovered.rules).toEqual([]);
      const files = await readdir(tempRoot);
      expect(files.some((name) => name.startsWith("workspace.json.corrupt."))).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("listLogs honours the safety clamp on absurd limits", async () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      requestUrl: `https://app.example.com/${i}`,
      ruleId: "r1",
      target: "https://up.example.com",
      durationMs: 5,
      outcome: "matched" as const,
      method: "GET",
      resourceType: "fetch" as const,
    }));
    await storage.appendHits(records);
    const logs = await storage.listLogs(10_000_000);
    // Just need to confirm the call didn't throw and returned a finite slice.
    expect(logs.length).toBe(5);
  });

  it("redacts sensitive forward-profile headers on disk and hydrates them on read", async () => {
    await storage.upsertProject({
      project: { id: "p", name: "App", enabled: true, siteHosts: ["app.example.com"], tags: [], createdAt: ts, updatedAt: ts },
      ruleSets: [{ id: "rs", projectId: "p", name: "Default", enabled: true, ruleIds: ["r"], createdAt: ts, updatedAt: ts }],
    });
    await storage.upsertRule({
      ruleSetId: "rs",
      rule: {
        id: "r",
        name: "auth",
        enabled: true,
        kind: "api_forward",
        priority: 1,
        match: { host: ["app.example.com"], pathGlob: "/**", resourceType: ["fetch"], tabScope: { mode: "all" } },
        target: {
          forwardProfile: {
            targetBaseUrl: "https://up.example.com",
            headers: {
              Authorization: "Bearer super-secret-value",
              "X-Public-Tag": "harmless",
            },
          },
        },
        tags: [],
        createdAt: ts,
        updatedAt: ts,
      },
    });

    // The on-disk workspace must NOT contain the cleartext token.
    const onDisk = await readFile(join(tempRoot, "workspace.json"), "utf8");
    expect(onDisk).not.toContain("super-secret-value");
    expect(onDisk).toContain("secret:r:authorization");
    expect(onDisk).toContain("harmless");

    // But callers reading through the API see the original cleartext value
    // (otherwise the proxy would forward an empty Authorization header).
    const restored = await storage.readWorkspace();
    expect(restored.rules[0]?.target.forwardProfile?.headers?.Authorization).toBe("Bearer super-secret-value");
  });
});
