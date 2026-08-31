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
  it("prints help without a token or service", async () => {
    const stdout: string[] = [];
    const code = await runCli(["--help"], {
      env: { RF_STORAGE_ROOT: "/missing" },
      fetchImpl: vi.fn(),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(stdout.join("")).toContain("--rule <rule.json|yaml>");
    expect(stdout.join("")).toContain("wait-applied");
  });

  it("checks public health without a token and honors PORT", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(input.toString());
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return response({ ok: true, version: "test" });
    });
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
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

  it("exposes the live schema as JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    const stdout: string[] = [];
    const code = await runCli(["schema", "get", "--json"], {
      env: { RF_STORAGE_ROOT: root },
      fetchImpl: vi.fn(async () => response({ serviceVersion: "test", schemas: { rule: { type: "object" } } })),
      stdout: (value) => stdout.push(value),
      stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ serviceVersion: "test", schemas: { rule: { type: "object" } } });
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

  it("skips an unchanged project up without advancing revision", async () => {
    let workspace = emptyWorkspace(0);
    let subtreeCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/workspace") return response({ workspace, revision: workspace.revision });
      if (url.pathname === "/rules/validate") return response({ valid: true, warnings: [], conflicts: [] });
      if (url.pathname.endsWith("/subtree")) {
        subtreeCalls += 1;
        const body = JSON.parse(String(init?.body)) as { project: WorkspaceSnapshot["projects"][number]; ruleSets: WorkspaceSnapshot["ruleSets"]; rules: WorkspaceSnapshot["rules"] };
        workspace = { ...workspace, revision: 1, projects: [body.project], ruleSets: body.ruleSets, rules: body.rules };
        return response({ workspace, revision: 1, warnings: [] });
      }
      throw new Error(url.pathname);
    });
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    const command = ["project", "up", "--name", "app", "--site", "app.example.com", "--dev-port", "8080"];

    expect(await runCli(command, { env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: () => undefined, stderr: () => undefined })).toBe(0);
    expect(await runCli(command, { env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: () => undefined, stderr: () => undefined })).toBe(0);

    expect(subtreeCalls).toBe(1);
    expect(workspace.revision).toBe(1);
  });

  it("project up atomically includes full API rules and keeps JSON stdout clean", async () => {
    const workspace = emptyWorkspace(0);
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    const ruleFile = join(root, "api-rule.yaml");
    await writeFile(ruleFile, [
      "id: users-api",
      "name: Local users",
      "kind: api_forward",
      "match:",
      "  host: [app.example.com]",
      "  pathGlob: /api/users/**",
      "  method: [GET]",
      "  resourceType: [fetch]",
      "  tabScope: { mode: all }",
      "target:",
      "  forwardProfile:",
      "    targetBaseUrl: /api/users",
      "    responsePolicy:",
      "      jsonMergePatch: { source: local }",
    ].join("\n"), "utf8");
    let subtree: { project: { id: string }; rules: Array<{ id: string; kind: string; match: { host: string[]; pathGlob: string }; target: unknown }> } | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/workspace") return response({ workspace, revision: 0 });
      if (url.pathname === "/rules/validate") return response({ valid: true, warnings: [], conflicts: [] });
      if (url.pathname.endsWith("/subtree")) {
        subtree = JSON.parse(String(init?.body));
        return response({ workspace: { ...workspace, revision: 1 }, revision: 1, warnings: [] });
      }
      throw new Error(url.pathname);
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli([
      "project", "up", "--name", "zebra/api", "--site", "app.example.com", "--dev-port", "8080",
      "--asset", "https://*.cdn.example.com/assets/*.js => /assets/app.js", "--rule", ruleFile, "--json",
    ], {
      env: { RF_STORAGE_ROOT: root }, fetchImpl,
      stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ revision: 1 });
    expect(stderr.join("")).toContain("2 rules (1 DNR)");
    expect(subtree?.rules.map((rule) => rule.kind)).toEqual(["asset_redirect", "api_forward"]);
    expect(subtree?.rules[0].match).toMatchObject({ host: ["*.cdn.example.com"], pathGlob: "/assets/*.js" });
    expect(subtree?.rules[1].id).toContain(`${subtree?.project.id}-custom-users-api-`);
    expect(subtree?.rules[1].target).toMatchObject({ forwardProfile: { responsePolicy: { jsonMergePatch: { source: "local" } } } });
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

  it("recreates a deleted project name with a fresh generation and uses the dedicated delete route", async () => {
    let workspace = emptyWorkspace(0);
    const ids: string[] = [];
    const deletePaths: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/workspace") return response({ workspace, revision: workspace.revision });
      if (url.pathname === "/rules/validate") return response({ valid: true, warnings: [], conflicts: [] });
      if (url.pathname.endsWith("/subtree") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { project: WorkspaceSnapshot["projects"][number]; ruleSets: WorkspaceSnapshot["ruleSets"]; rules: WorkspaceSnapshot["rules"] };
        ids.push(body.project.id);
        workspace = { ...workspace, revision: workspace.revision + 1, projects: [body.project], ruleSets: body.ruleSets, rules: body.rules };
        return response({ workspace, revision: workspace.revision, warnings: [] });
      }
      if (url.pathname.endsWith("/subtree") && init?.method === "DELETE") {
        deletePaths.push(url.pathname);
        const removed = workspace.projects[0];
        workspace = {
          ...emptyWorkspace(workspace.revision + 1),
          agentReservations: {
            projectIds: removed ? [removed.id] : [],
            ruleSetIds: workspace.ruleSets.map((ruleSet) => ruleSet.id),
            ruleIds: workspace.rules.map((rule) => rule.id),
          },
        };
        return response({ workspace, revision: workspace.revision, warnings: [] });
      }
      throw new Error(`${url.pathname} ${init?.method}`);
    });
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    const common = ["--name", "zebra/recreate", "--site", "app.example.com", "--dev-port", "8080"];

    expect(await runCli(["project", "up", ...common], { env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: () => undefined, stderr: () => undefined })).toBe(0);
    expect(await runCli(["project", "down", "zebra/recreate"], { env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: () => undefined, stderr: () => undefined })).toBe(0);
    expect(await runCli(["project", "up", ...common], { env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: () => undefined, stderr: () => undefined })).toBe(0);

    expect(deletePaths[0]).toMatch(/\/projects\/[^/]+\/subtree$/);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(`${ids[0]}-2`);
  });

  it("uses the service match trace with headers and tab id", async () => {
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    let body: unknown;
    const stdout: string[] = [];
    const code = await runCli([
      "rule", "match", "--url", "https://app.example.com/api/users", "--page-url", "https://app.example.com/home",
      "--header", "X-Debug: yes", "--tab-id", "7", "--json",
    ], {
      env: { RF_STORAGE_ROOT: root },
      fetchImpl: vi.fn(async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return response({ matched: true, binding: { ruleId: "api", ruleName: "API", kind: "api_forward" }, rewrittenUrl: "http://127.0.0.1:8080/api/users", trace: [{ ruleId: "api" }] });
      }),
      stdout: (value) => stdout.push(value), stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(body).toMatchObject({ headers: { "X-Debug": "yes" }, tabId: 7 });
    expect(JSON.parse(stdout.join(""))).toMatchObject({ matched: true, rewrittenUrl: "http://127.0.0.1:8080/api/users" });
  });

  it("reads filtered hit logs for runtime verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");
    let requestedUrl = "";
    const stdout: string[] = [];
    const code = await runCli(["logs", "--limit", "5", "--project", "agent-1", "--json"], {
      env: { RF_STORAGE_ROOT: root },
      fetchImpl: vi.fn(async (input) => {
        requestedUrl = input.toString();
        return response({ logs: [] });
      }),
      stdout: (value) => stdout.push(value), stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(requestedUrl).toContain("/logs?limit=5&projectId=agent-1");
    expect(JSON.parse(stdout.join(""))).toEqual({ logs: [] });
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

  it("wait-applied can target the caller's exact revision", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/applied") return response({ appliedRevision: 1 });
      throw new Error(`unexpected ${path}`);
    });
    const root = await mkdtemp(join(tmpdir(), "rf-cli-"));
    roots.push(root);
    await writeFile(join(root, "token"), "test-token\n", "utf8");

    const code = await runCli(["wait-applied", "--revision", "1", "--timeout", "1s"], {
      env: { RF_STORAGE_ROOT: root }, fetchImpl, stdout: () => undefined, stderr: () => undefined,
    });

    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects misspelled options as structured JSON before reading a token", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli([
      "project", "up", "--name", "app", "--site", "app.example.com", "--dev-port", "8080", "--enbale", "--json",
    ], {
      env: { RF_STORAGE_ROOT: "/missing" }, fetchImpl: vi.fn(),
      stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value),
    });

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toMatchObject({ ok: false, message: expect.stringContaining("--enbale") });
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
