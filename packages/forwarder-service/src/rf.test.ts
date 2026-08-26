import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { runCli } from "./rf.js";

const ts = "2026-08-26T00:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});


function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function emptyWorkspace(revision = 0): WorkspaceSnapshot {
  return { version: 1, revision, updatedAt: ts, projects: [], ruleSets: [], rules: [] };
}

describe("rf CLI", () => {
  it("reads token and honors PORT for service status", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      calls.push(input.toString());
      return response({ ok: true, version: "test" });
    });
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    const stdout: string[] = [];
    const code = await runCli(["service", "status"], {
      env: { RF_STORAGE_ROOT: root, PORT: "5189" },
      fetchImpl,
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(calls[0]).toBe("http://127.0.0.1:5189/health");
    expect(stdout[0]).toContain("service ok");
  });

  it("lists projects and exposes ownership and revision as JSON", async () => {
    const workspace = emptyWorkspace(4);
    const fetchImpl = vi.fn(async () => response({ workspace, revision: workspace.revision }));
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    const stdout: string[] = [];
    const code = await runCli(["project", "list", "--json"], {
      env: { RF_STORAGE_ROOT: root },
      fetchImpl,
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ revision: 4, projects: [] });
  });

  it("project up performs local DNR dry-run, validates, and commits a subtree", async () => {
    const workspace = emptyWorkspace(0);
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      paths.push(url.pathname);
      if (url.pathname === "/workspace") return response({ workspace, revision: workspace.revision });
      if (url.pathname === "/rules/validate") return response({ valid: true, warnings: [], conflicts: [] });
      if (url.pathname.endsWith("/subtree")) return response({ workspace: { ...workspace, revision: 1 }, revision: 1, warnings: [] });
      throw new Error(`unexpected ${url.pathname} ${String(init?.body)}`);
    });
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    const stdout: string[] = [];
    const code = await runCli([
      "project", "up", "--name", "zebra/feat-x", "--site", "app.example.com", "--dev-port", "8080",
      "--asset", "https://cdn.example.com/app.js => /assets/app.js", "--enable",
    ], { env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: (value) => stdout.push(value), stderr: () => undefined });

    expect(code).toBe(0);
    expect(paths).toContain("/rules/validate");
    expect(stdout.some((line) => line.includes("dry-run"))).toBe(true);
    expect(stdout.some((line) => line.includes("project zebra/feat-x persisted"))).toBe(true);
  });
  it("derives distinct stable IDs for lossy-slug names", async () => {
    const workspace = emptyWorkspace(0);
    const ids: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/workspace") return response({ workspace, revision: 0 });
      if (url.pathname.endsWith("/subtree")) {
        const body = JSON.parse(String(init?.body)) as { project: { id: string } };
        ids.push(body.project.id);
        return response({ workspace: { ...workspace, revision: ids.length }, revision: ids.length, warnings: [] });
      }
      throw new Error(url.pathname);
    });
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    for (const name of ["foo/bar", "foo-bar"]) {
      expect(await runCli(["project", "up", "--name", name, "--site", "app.example.com", "--dev-port", "8080"], {
        env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: () => undefined, stderr: () => undefined,
      })).toBe(0);
    }

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("retries project up once after a stale revision", async () => {
    const workspace = emptyWorkspace(2);
    let subtreeCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/workspace") return response({ workspace, revision: workspace.revision });
      if (url.pathname.endsWith("/subtree")) {
        subtreeCalls += 1;
        if (subtreeCalls === 1) return response({ code: "REVISION_CONFLICT", currentRevision: 3 }, 409);
        return response({ workspace: { ...workspace, revision: 4 }, revision: 4, warnings: [] });
      }
      return response({ valid: true, warnings: [], conflicts: [] });
    });
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    const code = await runCli(["project", "up", "--name", "app", "--site", "app.example.com", "--dev-port", "8080"], {
      env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: () => undefined, stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(subtreeCalls).toBe(2);
  });

  it("wait-applied succeeds against the persisted applied revision", async () => {
    const workspace = emptyWorkspace(7);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/workspace") return response({ workspace, revision: 7 });
      if (path === "/applied") return response({ appliedRevision: 7 });
      throw new Error(path);
    });
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    const stdout: string[] = [];
    const code = await runCli(["wait-applied", "--timeout", "1s"], {
      env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: (value) => stdout.push(value), stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout.join(" ")).toContain("applied revision 7");
  });

  it("returns the required timeout wording when browser ACK lags", async () => {
    const workspace = emptyWorkspace(7);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      return path === "/workspace" ? response({ workspace, revision: 7 }) : response({ appliedRevision: 0 });
    });
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    const stderr: string[] = [];
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    const code = await runCli(["wait-applied", "--timeout", "1ms"], {
      env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: () => undefined, stderr: (value) => stderr.push(value), sleep: async () => undefined,
    });

    expect(code).toBe(1);
    expect(stderr.join(" ")).toContain("persisted but not browser-applied");
    vi.restoreAllMocks();
  });
});
