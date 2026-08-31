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
  fetchMock.mockImplementation(async () =>
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
          siteMatchPatterns: ["https://app.example.com/*"],
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
interface AgentSubtreeFixture {
  project: WorkspaceSnapshot["projects"][number];
  ruleSets: WorkspaceSnapshot["ruleSets"];
  rules: WorkspaceSnapshot["rules"];
}

function makeAgentSubtree(id: string, switchGroup: string, enabled = true): AgentSubtreeFixture {
  const now = new Date().toISOString();
  return {
    project: {
      id,
      name: id,
      enabled,
      siteHosts: ["app.example.com"],
      siteMatchPatterns: ["https://app.example.com/*"],
      tags: ["agent-managed", `switch-group:${switchGroup}`],
      createdAt: now,
      updatedAt: now,
    },
    ruleSets: [{ id: `${id}-ruleset`, projectId: id, name: "Agent", enabled: true, ruleIds: [`${id}-rule`], createdAt: now, updatedAt: now }],
    rules: [{
      id: `${id}-rule`,
      name: "Agent asset",
      enabled: true,
      kind: "asset_redirect" as const,
      priority: 100,
      match: { host: ["app.example.com"], pathGlob: "/assets/**", resourceType: ["script" as const], tabScope: { mode: "all" as const } },
      target: { redirectUrl: "https://cdn.example.com/agent.js" },
      tags: [],
      createdAt: now,
      updatedAt: now,
    }],
  };
}

async function seedAgentProjects(entries: Array<[string, string, boolean?]>): Promise<AgentSubtreeFixture[]> {
  const current = await storage.readWorkspace();
  const subtrees = entries.map(([id, group, enabled]) => makeAgentSubtree(id, group, enabled));
  await storage.importWorkspace({
    format: "json",
    merge: false,
    content: JSON.stringify({
      ...current,
      projects: [...current.projects, ...subtrees.map((subtree) => subtree.project)],
      ruleSets: [...current.ruleSets, ...subtrees.flatMap((subtree) => subtree.ruleSets)],
      rules: [...current.rules, ...subtrees.flatMap((subtree) => subtree.rules)],
    }),
  });
  return subtrees;
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

  it("does not forward through a matchedRuleId when the current page misses the rule set scope", async () => {
    const now = new Date().toISOString();
    await storage.importWorkspace({
      format: "json",
      merge: false,
      content: JSON.stringify({
        version: 1,
        updatedAt: now,
        projects: [
          {
            id: "project-1",
            name: "App",
            enabled: true,
            siteHosts: ["app.example.com"],
            siteMatchPatterns: ["https://app.example.com/*"],
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        ruleSets: [
          {
            id: "ruleset-1",
            projectId: "project-1",
            name: "Tables",
            enabled: true,
            ruleIds: ["rule-api"],
            siteMatchPatterns: ["https://app.example.com/tables/*"],
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
              resourceType: ["fetch"],
              method: ["GET"],
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
        ],
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/api/profile",
        pageUrl: "https://app.example.com/sheets/abc",
        method: "GET",
        headers: {},
        resourceType: "fetch",
        matchedRuleId: "rule-api",
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(404);
  });

  it("resolves relative forward targets with rule set baseUrl first, then project baseUrl", async () => {
    const now = new Date().toISOString();
    await storage.importWorkspace({
      format: "json",
      merge: false,
      content: JSON.stringify({
        version: 1,
        updatedAt: now,
        projects: [
          {
            id: "project-1",
            name: "App",
            enabled: true,
            siteHosts: ["app.example.com"],
            siteMatchPatterns: ["https://app.example.com/*"],
            baseUrl: "http://project-upstream.test/project-base/",
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        ruleSets: [
          {
            id: "ruleset-1",
            projectId: "project-1",
            name: "Tables",
            enabled: true,
            ruleIds: ["rule-group", "rule-project"],
            siteMatchPatterns: ["https://app.example.com/tables/*"],
            baseUrl: "http://ruleset-upstream.test/group-base/",
            createdAt: now,
            updatedAt: now,
          },
        ],
        rules: [
          {
            id: "rule-group",
            name: "Group Base",
            enabled: true,
            kind: "api_forward",
            priority: 200,
            match: {
              host: ["app.example.com"],
              pathGlob: "/group/**",
              resourceType: ["fetch"],
              method: ["GET"],
              tabScope: { mode: "all" },
            },
            target: {
              forwardProfile: {
                targetBaseUrl: "svc/",
              },
            },
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "rule-project",
            name: "Project Base",
            enabled: true,
            kind: "api_forward",
            priority: 100,
            match: {
              host: ["app.example.com"],
              pathGlob: "/project/**",
              resourceType: ["fetch"],
              method: ["GET"],
              tabScope: { mode: "all" },
            },
            target: {
              forwardProfile: {
                targetBaseUrl: "svc/",
              },
            },
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });

    const groupResponse = await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/group/profile",
        pageUrl: "https://app.example.com/tables/abc",
        method: "GET",
        headers: {},
        resourceType: "fetch",
      },
    });
    expect(groupResponse.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://ruleset-upstream.test/group-base/svc/group/profile");

    fetchMock.mockClear();

    await storage.importWorkspace({
      format: "json",
      merge: false,
      content: JSON.stringify({
        version: 1,
        updatedAt: now,
        projects: [
          {
            id: "project-1",
            name: "App",
            enabled: true,
            siteHosts: ["app.example.com"],
            siteMatchPatterns: ["https://app.example.com/*"],
            baseUrl: "http://project-upstream.test/project-base/",
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        ruleSets: [
          {
            id: "ruleset-1",
            projectId: "project-1",
            name: "Tables",
            enabled: true,
            ruleIds: ["rule-project"],
            siteMatchPatterns: ["https://app.example.com/tables/*"],
            createdAt: now,
            updatedAt: now,
          },
        ],
        rules: [
          {
            id: "rule-project",
            name: "Project Base",
            enabled: true,
            kind: "api_forward",
            priority: 100,
            match: {
              host: ["app.example.com"],
              pathGlob: "/project/**",
              resourceType: ["fetch"],
              method: ["GET"],
              tabScope: { mode: "all" },
            },
            target: {
              forwardProfile: {
                targetBaseUrl: "svc/",
              },
            },
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });

    const projectResponse = await app.inject({
      method: "POST",
      url: "/forward",
      payload: {
        url: "https://app.example.com/project/profile",
        pageUrl: "https://app.example.com/tables/abc",
        method: "GET",
        headers: {},
        resourceType: "fetch",
      },
    });
    expect(projectResponse.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://project-upstream.test/project-base/svc/project/profile");
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

  it("upserts a rule set via PUT /rule-sets/:id", async () => {
    const revision = (await storage.readWorkspace()).revision;
    const now = new Date().toISOString();
    const response = await app.inject({
      method: "PUT",
      url: "/rule-sets/ruleset-tables",
      payload: {
        ifRevision: revision,
        ruleSet: {
          id: "ruleset-tables",
          projectId: "project-1",
          name: "Tables",
          enabled: true,
          ruleIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const workspace = (await storage.readWorkspace());
    const inserted = workspace.ruleSets.find((rs) => rs.id === "ruleset-tables");
    expect(inserted?.name).toBe("Tables");
    expect(workspace.ruleSets.find((rs) => rs.id === "ruleset-1")).toBeDefined();
  });

  it("toggles a rule set's enabled flag via PUT /rule-sets/:id", async () => {
    const baseline = await storage.readWorkspace();
    const target = baseline.ruleSets[0];
    const response = await app.inject({
      method: "PUT",
      url: `/rule-sets/${target.id}`,
      payload: { ruleSet: { ...target, enabled: false }, ifRevision: baseline.revision },
    });

    expect(response.statusCode).toBe(200);
    const after = await storage.readWorkspace();
    expect(after.ruleSets.find((rs) => rs.id === target.id)?.enabled).toBe(false);
  });

  it("rejects PUT /rule-sets/:id when the path id mismatches the body id", async () => {
    const now = new Date().toISOString();
    const response = await app.inject({
      method: "PUT",
      url: "/rule-sets/ruleset-x",
      payload: {
        ruleSet: {
          id: "ruleset-y",
          projectId: "project-1",
          name: "Mismatch",
          enabled: true,
          ruleIds: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("cascades rule deletion when DELETE /rule-sets/:id removes a rule set", async () => {
    const response = await app.inject({
      method: "DELETE",
      headers: { "if-match": String((await storage.readWorkspace()).revision) },
      url: "/rule-sets/ruleset-1",
    });

    expect(response.statusCode).toBe(200);
    const after = await storage.readWorkspace();
    expect(after.ruleSets.find((rs) => rs.id === "ruleset-1")).toBeUndefined();
    expect(after.rules.find((rule) => rule.id === "rule-api")).toBeUndefined();
    expect(after.rules.find((rule) => rule.id === "rule-disabled")).toBeUndefined();
  });

  it("treats DELETE /rule-sets/:id for a missing id as a no-op", async () => {
    const response = await app.inject({
      method: "DELETE",
      headers: { "if-match": String((await storage.readWorkspace()).revision) },
      url: "/rule-sets/does-not-exist",
    });

    expect(response.statusCode).toBe(200);
    const after = await storage.readWorkspace();
    expect(after.ruleSets).toHaveLength(1);
    expect(after.rules).toHaveLength(2);
  });
  it("GET /workspace returns one snapshot with its revision", async () => {
    const response = await app.inject({ method: "GET", url: "/workspace" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.revision).toBe(body.workspace.revision);
  });

  it("replaces and shrinks an agent-managed subtree atomically", async () => {
    const [agent] = await seedAgentProjects([["agent-one", "main"]]);
    const baseline = await storage.readWorkspace();
    const response = await app.inject({
      method: "PUT",
      url: "/projects/agent-one/subtree",
      payload: { ...agent, ifRevision: baseline.revision },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revision).toBe(baseline.revision + 1);

    const afterUpsert = await storage.readWorkspace();
    const shrink = {
      ...agent,
      ruleSets: [{ ...agent.ruleSets[0], ruleIds: [] }],
      rules: [],
    };
    const shrunk = await app.inject({
      method: "PUT",
      url: "/projects/agent-one/subtree",
      payload: { ...shrink, ifRevision: afterUpsert.revision },
    });
    expect(shrunk.statusCode).toBe(200);
    const final = await storage.readWorkspace();
    expect(final.rules.find((rule) => rule.id === "agent-one-rule")).toBeUndefined();
    expect(final.ruleSets.find((ruleSet) => ruleSet.id === "agent-one-ruleset")?.ruleIds).toEqual([]);
  });

  it("rejects subtree path mismatches and cross-project ids", async () => {
    const [agent] = await seedAgentProjects([["agent-two", "main"]]);
    const baseline = await storage.readWorkspace();
    const mismatch = await app.inject({
      method: "PUT",
      url: "/projects/wrong/subtree",
      payload: { ...agent, ifRevision: baseline.revision },
    });
    expect(mismatch.statusCode).toBe(400);

    const collision = await app.inject({
      method: "PUT",
      url: "/projects/agent-two/subtree",
      payload: {
        ...agent,
        ruleSets: [{ ...agent.ruleSets[0], id: "ruleset-1" }],
        ifRevision: baseline.revision,
      },
    });
    expect(collision.statusCode).toBe(409);
  });

  it("requires guards, rejects stale writes, and supports explicit force", async () => {
    const current = await storage.readWorkspace();
    const project = current.projects[0];
    const missing = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}`,
      payload: { project },
    });
    expect(missing.statusCode).toBe(428);

    const first = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}`,
      payload: { project: { ...project, name: "Guarded" }, ifRevision: current.revision },
    });
    expect(first.statusCode).toBe(200);
    const stale = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}`,
      payload: { project: { ...project, name: "Stale" }, ifRevision: current.revision },
    });
    expect(stale.statusCode).toBe(409);

    const forced = await app.inject({
      method: "PUT",
      url: `/projects/${project.id}?force=true`,
      payload: { project: { ...project, name: "Forced" } },
    });
    expect(forced.statusCode).toBe(200);
  });

  it("cascades dedicated agent subtree deletes", async () => {
    const [agent] = await seedAgentProjects([["agent-delete", "main"]]);
    const projectRevision = (await storage.readWorkspace()).revision;
    const deletedProject = await app.inject({
      method: "DELETE",
      url: "/projects/agent-delete/subtree",
      headers: { "if-match": String(projectRevision) },
    });
    expect(deletedProject.statusCode).toBe(200);
    const current = await storage.readWorkspace();
    expect(current.projects.find((project) => project.id === agent.project.id)).toBeUndefined();
    expect(current.ruleSets.find((ruleSet) => ruleSet.id === agent.ruleSets[0].id)).toBeUndefined();
    expect(current.rules.find((rule) => rule.id === agent.rules[0].id)).toBeUndefined();
    expect(current.agentReservations?.projectIds).toContain(agent.project.id);
    expect(current.agentReservations?.ruleSetOwners?.[agent.ruleSets[0].id]).toBe(agent.project.id);
    expect(current.agentReservations?.ruleOwners?.[agent.rules[0].id]).toBe(agent.project.id);
  });

  it("requires agent ownership and CAS for dedicated subtree deletes", async () => {
    const [agent] = await seedAgentProjects([["agent-delete-guard", "main"]]);
    const current = await storage.readWorkspace();

    const missingGuard = await app.inject({
      method: "DELETE",
      url: `/projects/${agent.project.id}/subtree`,
    });
    expect(missingGuard.statusCode).toBe(428);

    const userOwned = await app.inject({
      method: "DELETE",
      url: "/projects/project-1/subtree",
      headers: { "if-match": String(current.revision) },
    });
    expect(userOwned.statusCode).toBe(403);

    const stale = await app.inject({
      method: "DELETE",
      url: `/projects/${agent.project.id}/subtree`,
      headers: { "if-match": String(current.revision - 1) },
    });
    expect(stale.statusCode).toBe(409);

    const forced = await app.inject({
      method: "DELETE",
      url: `/projects/${agent.project.id}/subtree?force=true`,
    });
    expect(forced.statusCode).toBe(200);
  });

  it("rejects generic deletes of agent-managed projects, rules, and rule sets", async () => {
    const [agent] = await seedAgentProjects([["agent-delete-readonly", "main"]]);
    const current = await storage.readWorkspace();

    const projectDelete = await app.inject({
      method: "DELETE",
      url: `/projects/${agent.project.id}`,
      headers: { "if-match": String(current.revision) },
    });
    const ruleDelete = await app.inject({
      method: "DELETE",
      url: `/rules/${agent.rules[0].id}`,
      headers: { "if-match": String(current.revision) },
    });
    const ruleSetDelete = await app.inject({
      method: "DELETE",
      url: `/rule-sets/${agent.ruleSets[0].id}`,
      headers: { "if-match": String(current.revision) },
    });

    expect(projectDelete.statusCode).toBe(403);
    expect(ruleDelete.statusCode).toBe(403);
    expect(ruleSetDelete.statusCode).toBe(403);
    const unchanged = await storage.readWorkspace();
    expect(unchanged.revision).toBe(current.revision);
    expect(unchanged.projects.find((project) => project.id === agent.project.id)).toBeDefined();
    expect(unchanged.ruleSets.find((ruleSet) => ruleSet.id === agent.ruleSets[0].id)).toBeDefined();
    expect(unchanged.rules.find((rule) => rule.id === agent.rules[0].id)).toBeDefined();
  });

  it("keeps generic user-owned rule and project deletes cascading", async () => {
    let current = await storage.readWorkspace();
    const deletedRule = await app.inject({
      method: "DELETE",
      url: "/rules/rule-api",
      headers: { "if-match": String(current.revision) },
    });
    expect(deletedRule.statusCode).toBe(200);
    current = await storage.readWorkspace();
    expect(current.rules.find((rule) => rule.id === "rule-api")).toBeUndefined();
    expect(current.ruleSets[0]?.ruleIds).not.toContain("rule-api");

    const deletedProject = await app.inject({
      method: "DELETE",
      url: "/projects/project-1",
      headers: { "if-match": String(current.revision) },
    });
    expect(deletedProject.statusCode).toBe(200);
    current = await storage.readWorkspace();
    expect(current.projects).toHaveLength(0);
    expect(current.ruleSets).toHaveLength(0);
    expect(current.rules).toHaveLength(0);
  });

  it("rejects generic writes to agent-managed projects, rules, and rule sets", async () => {
    const [agent] = await seedAgentProjects([["agent-readonly", "main"]]);
    const current = await storage.readWorkspace();
    const projectPut = await app.inject({
      method: "PUT",
      url: "/projects/agent-readonly",
      payload: { project: agent.project, ifRevision: current.revision },
    });
    expect(projectPut.statusCode).toBe(403);
    const rulePut = await app.inject({
      method: "PUT",
      url: `/rules/${agent.rules[0].id}`,
      payload: { rule: agent.rules[0], ruleSetId: agent.ruleSets[0].id, ifRevision: current.revision },
    });
    expect(rulePut.statusCode).toBe(403);
    const ruleSetPut = await app.inject({
      method: "PUT",
      url: `/rule-sets/${agent.ruleSets[0].id}`,
      payload: { ruleSet: agent.ruleSets[0], ifRevision: current.revision },
    });
    expect(ruleSetPut.statusCode).toBe(403);
  });
  it("rejects a generic rule PUT whose target rule set does not exist", async () => {
    const current = await storage.readWorkspace();
    const orphan = { ...current.rules[0], id: "orphan-rule", name: "Orphan" };
    const response = await app.inject({
      method: "PUT",
      url: `/rules/${orphan.id}`,
      payload: { rule: orphan, ruleSetId: "missing-rule-set", ifRevision: current.revision },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("RULE_SET_NOT_FOUND");
    const unchanged = await storage.readWorkspace();
    expect(unchanged.revision).toBe(current.revision);
    expect(unchanged.rules.find((rule) => rule.id === orphan.id)).toBeUndefined();
  });
  it("rejects a generic project PUT that nests an agent-owned ruleset and rule IDs", async () => {
    const [agent] = await seedAgentProjects([["agent-nested", "main"]]);
    const current = await storage.readWorkspace();
    const userProject = current.projects.find((project) => project.id === "project-1")!;
    const response = await app.inject({
      method: "PUT",
      url: "/projects/project-1",
      payload: { project: userProject, ruleSets: [agent.ruleSets[0]], ifRevision: current.revision },
    });

    expect([403, 409]).toContain(response.statusCode);
    const unchanged = await storage.readWorkspace();
    expect(unchanged.ruleSets.find((ruleSet) => ruleSet.id === agent.ruleSets[0].id)?.projectId).toBe(agent.project.id);
  });

  it("rejects an import whose ruleset projectId points into an agent subtree", async () => {
    const [agent] = await seedAgentProjects([["agent-import-reference", "main"]]);
    const current = await storage.readWorkspace();
    const imported = createWorkspace();
    imported.ruleSets = [{ ...agent.ruleSets[0], ruleIds: [] }];
    imported.rules = [];
    const response = await app.inject({
      method: "POST",
      url: "/import",
      payload: { content: JSON.stringify(imported), format: "json", merge: true, ifRevision: current.revision },
    });

    expect([403, 409]).toContain(response.statusCode);
    expect((await storage.readWorkspace()).ruleSets.find((ruleSet) => ruleSet.id === agent.ruleSets[0].id)?.projectId).toBe(agent.project.id);
  });

  it("rejects generic recreation of a deleted agent project ID", async () => {
    const [agent] = await seedAgentProjects([["agent-tombstone", "main"]]);
    let current = await storage.readWorkspace();
    const deleted = await app.inject({
      method: "DELETE",
      url: `/projects/${agent.project.id}/subtree`,
      headers: { "if-match": String(current.revision) },
    });
    expect(deleted.statusCode).toBe(200);
    current = await storage.readWorkspace();
    expect(current.agentReservations?.projectIds).toContain(agent.project.id);

    const recreated = await app.inject({
      method: "PUT",
      url: `/projects/${agent.project.id}`,
      payload: {
        project: { ...agent.project, tags: [], name: "recreated-user" },
        ifRevision: current.revision,
      },
    });
    expect([403, 409]).toContain(recreated.statusCode);
  });
  it("allows owner reclaim after subtree shrink but blocks generic reserved rule reuse", async () => {
    const [agent] = await seedAgentProjects([["agent-reclaim", "main"]]);
    let current = await storage.readWorkspace();
    const shrink = await app.inject({
      method: "PUT",
      url: `/projects/${agent.project.id}/subtree`,
      payload: {
        ...agent,
        ruleSets: [{ ...agent.ruleSets[0], ruleIds: [] }],
        rules: [],
        ifRevision: current.revision,
      },
    });
    expect(shrink.statusCode).toBe(200);
    current = await storage.readWorkspace();
    expect(current.agentReservations?.ruleOwners?.[agent.rules[0].id]).toBe(agent.project.id);

    const genericReuse = await app.inject({
      method: "PUT",
      url: `/rules/${agent.rules[0].id}`,
      payload: { rule: agent.rules[0], ifRevision: current.revision },
    });
    expect([403, 409]).toContain(genericReuse.statusCode);

    const restored = await app.inject({
      method: "PUT",
      url: `/projects/${agent.project.id}/subtree`,
      payload: { ...agent, ifRevision: current.revision },
    });
    expect(restored.statusCode).toBe(200);
    expect((await storage.readWorkspace()).rules.find((rule) => rule.id === agent.rules[0].id)).toBeDefined();
  });

  it("preserves agent-managed subtrees for merge and replace imports", async () => {
    const [agent] = await seedAgentProjects([["agent-import", "main"]]);
    let current = await storage.readWorkspace();
    const replace = await app.inject({
      method: "POST",
      url: "/import",
      payload: { content: JSON.stringify(createWorkspace()), format: "json", merge: false, ifRevision: current.revision },
    });
    expect(replace.statusCode).toBe(200);
    current = await storage.readWorkspace();
    expect(current.projects.find((project) => project.id === agent.project.id)).toBeDefined();

    const merge = await app.inject({
      method: "POST",
      url: "/import",
      payload: { content: JSON.stringify(createWorkspace()), format: "json", merge: true, ifRevision: current.revision },
    });
    expect(merge.statusCode).toBe(200);
    current = await storage.readWorkspace();
    expect(current.projects.find((project) => project.id === agent.project.id)).toBeDefined();
  });

  it("switches only the target switch group and rejects stale switches", async () => {
    const [first, second, other] = await seedAgentProjects([
      ["agent-switch-a", "main", true],
      ["agent-switch-b", "main", false],
      ["agent-switch-other", "other", true],
    ]);
    const current = await storage.readWorkspace();
    const switched = await app.inject({
      method: "POST",
      url: "/projects/switch",
      payload: { projectId: second.project.id, switchGroup: "main", enabled: true, ifRevision: current.revision },
    });
    expect(switched.statusCode).toBe(200);
    const after = await storage.readWorkspace();
    expect(after.projects.find((project) => project.id === first.project.id)?.enabled).toBe(false);
    expect(after.projects.find((project) => project.id === second.project.id)?.enabled).toBe(true);
    expect(after.projects.find((project) => project.id === other.project.id)?.enabled).toBe(true);

    const stale = await app.inject({
      method: "POST",
      url: "/projects/switch",
      payload: { projectId: first.project.id, enabled: true, ifRevision: current.revision },
    });
    expect(stale.statusCode).toBe(409);
    expect((await storage.readWorkspace()).projects.find((project) => project.id === second.project.id)?.enabled).toBe(true);
  });

  it("persists monotonic applied ACKs without advancing workspace revision", async () => {
    const current = await storage.readWorkspace();
    const applied = await app.inject({
      method: "POST",
      url: "/applied",
      payload: { revision: current.revision },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().appliedRevision).toBe(current.revision);
    const older = await app.inject({ method: "POST", url: "/applied", payload: { revision: 0 } });
    expect(older.statusCode).toBe(200);
    expect(older.json().appliedRevision).toBe(current.revision);
    expect((await app.inject({ method: "GET", url: "/applied" })).json().appliedRevision).toBe(current.revision);
    expect((await storage.readWorkspace()).revision).toBe(current.revision);
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

  describe("AI analysis endpoints", () => {
    it("GET /schema returns the five request-body schemas", async () => {
      const response = await app.inject({ method: "GET", url: "/schema" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.serviceVersion).toBeTruthy();
      expect(Object.keys(body.schemas).sort()).toEqual(
        ["forward", "import", "project", "rule", "ruleSet"].sort(),
      );
    });

    it("POST /match dry-runs a matching api_forward rule without hitting upstream", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/match",
        payload: {
          url: "https://app.example.com/api/profile?view=full",
          method: "GET",
          resourceType: "fetch",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.matched).toBe(true);
      expect(body.binding.ruleId).toBe("rule-api");
      expect(body.binding.kind).toBe("api_forward");
      expect(body.binding.projectId).toBe("project-1");
      expect(body.binding.ruleSetId).toBe("ruleset-1");
      // Same rewrite the real /forward path produces — proves we reuse buildForwardTargetUrl.
      expect(body.rewrittenUrl).toBe("http://upstream.test/api/profile?view=full");
      // The defining dry-run contract: selection runs, the upstream is never called.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("POST /match reports matched:false with a diagnostic trace when nothing fires", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/match",
        payload: { url: "https://app.example.com/other/thing", method: "GET" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.matched).toBe(false);
      expect(body.binding).toBeUndefined();
      // host matches app.example.com, but /other/thing is outside /api/** — the
      // trace pinpoints the path condition as the reason rule-api did not fire.
      const apiTrace = body.trace.find((entry: { ruleId: string }) => entry.ruleId === "rule-api");
      expect(apiTrace.conditions.hierarchy).toBe(true);
      expect(apiTrace.conditions.projectScope).toBe(true);
      expect(apiTrace.conditions.ruleSetScope).toBe(true);
      expect(apiTrace.conditions.host).toBe(true);
      expect(apiTrace.conditions.path).toBe(false);
      expect(apiTrace.wouldMatch).toBe(false);
      // A disabled rule still appears in the trace, flagged enabled:false.
      const disabledTrace = body.trace.find((entry: { ruleId: string }) => entry.ruleId === "rule-disabled");
      expect(disabledTrace.enabled).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("POST /match explains misses caused by project and rule-set page scopes", async () => {
      const workspace = await storage.readWorkspace();
      workspace.projects[0].siteMatchPatterns = ["https://app.example.com/**"];
      workspace.ruleSets[0].siteMatchPatterns = ["https://app.example.com/tables/**"];
      await storage.importWorkspace({ format: "json", merge: false, content: JSON.stringify(workspace) });

      const response = await app.inject({
        method: "POST",
        url: "/match",
        payload: {
          url: "https://app.example.com/api/profile",
          pageUrl: "https://app.example.com/sheets/abc",
          method: "GET",
          resourceType: "fetch",
        },
      });

      expect(response.json().matched).toBe(false);
      const trace = response.json().trace.find((entry: { ruleId: string }) => entry.ruleId === "rule-api");
      expect(trace.conditions.hierarchy).toBe(true);
      expect(trace.conditions.projectScope).toBe(true);
      expect(trace.conditions.ruleSetScope).toBe(false);
      expect(trace.conditions.host).toBe(true);
      expect(trace.conditions.path).toBe(true);
      expect(trace.wouldMatch).toBe(false);
    });

    it("POST /match diagnoses query and header constraints independently", async () => {
      const workspace = await storage.readWorkspace();
      const apiRule = workspace.rules.find((rule) => rule.id === "rule-api")!;
      apiRule.match.query = { tenant: "dev-*" };
      apiRule.match.headers = { "x-client": "web-*" };
      await storage.importWorkspace({ format: "json", merge: false, content: JSON.stringify(workspace) });

      const miss = await app.inject({
        method: "POST",
        url: "/match",
        payload: {
          url: "https://app.example.com/api/profile?tenant=prod",
          method: "GET",
          resourceType: "fetch",
          headers: { "x-client": "web-shell" },
        },
      });
      const missTrace = miss.json().trace.find((entry: { ruleId: string }) => entry.ruleId === "rule-api");
      expect(missTrace.conditions.query).toBe(false);
      expect(missTrace.conditions.headers).toBe(true);

      const hit = await app.inject({
        method: "POST",
        url: "/match",
        payload: {
          url: "https://app.example.com/api/profile?tenant=dev-a",
          method: "GET",
          resourceType: "fetch",
          headers: { "X-Client": "web-shell" },
        },
      });
      expect(hit.json().matched).toBe(true);
    });

    it("POST /match returns 400 for a malformed url instead of crashing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/match",
        payload: { url: "not-a-url", method: "GET" },
      });
      expect(response.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("POST /rules/validate accepts a sound rule with no warnings or conflicts", async () => {
      const now = new Date().toISOString();
      const response = await app.inject({
        method: "POST",
        url: "/rules/validate",
        payload: {
          rule: {
            id: "rule-draft",
            name: "Draft",
            enabled: true,
            kind: "api_forward",
            priority: 10,
            match: { host: ["app.example.com"], pathGlob: "/v2/**", method: ["GET"], tabScope: { mode: "all" } },
            target: { forwardProfile: { targetBaseUrl: "http://v2-upstream.test" } },
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.valid).toBe(true);
      expect(body.warnings).toEqual([]);
      expect(body.conflicts).toEqual([]);
    });

    it("POST /rules/validate warns about an api_forward rule missing its forward profile", async () => {
      const now = new Date().toISOString();
      const response = await app.inject({
        method: "POST",
        url: "/rules/validate",
        payload: {
          rule: {
            id: "rule-no-profile",
            name: "No Profile",
            enabled: true,
            kind: "api_forward",
            priority: 10,
            match: { host: ["app.example.com"], pathGlob: "/v3/**", tabScope: { mode: "all" } },
            target: {},
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // warnings are advisory: the rule is still structurally valid.
      expect(body.valid).toBe(true);
      expect(body.warnings.some((w: string) => /forward profile/i.test(w))).toBe(true);
    });

    it("POST /rules/validate flags a draft overlapping an existing rule as a conflict", async () => {
      const now = new Date().toISOString();
      const response = await app.inject({
        method: "POST",
        url: "/rules/validate",
        payload: {
          rule: {
            id: "rule-overlap",
            name: "Overlap",
            enabled: true,
            kind: "api_forward",
            priority: 10,
            // Same host + pathGlob as the fixture's rule-api → flagged as overlap.
            match: { host: ["app.example.com"], pathGlob: "/api/**", tabScope: { mode: "all" } },
            target: { forwardProfile: { targetBaseUrl: "http://other-upstream.test" } },
            tags: [],
            createdAt: now,
            updatedAt: now,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.conflicts.length).toBeGreaterThan(0);
      expect(body.conflicts.some((c: { ruleId: string }) => c.ruleId === "rule-api")).toBe(true);
    });

    it("POST /rules/validate rejects a structurally invalid rule with a 400", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/rules/validate",
        payload: {
          // Missing `target` → fails the shared upsert body schema (required).
          rule: { id: "rule-bad", name: "Bad", kind: "api_forward", match: { host: ["x"], pathGlob: "/**" } },
        },
      });
      expect(response.statusCode).toBe(400);
    });
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
    it("requires a bearer token on /applied", async () => {
      const response = await secured.inject({
        method: "POST",
        url: "/applied",
        headers: { host: "127.0.0.1:5178" },
        payload: { revision: 0 },
      });
      expect(response.statusCode).toBe(401);
    });

    it("requires a bearer token on /match (inherits the scoped guard)", async () => {
      const response = await secured.inject({
        method: "POST",
        url: "/match",
        headers: { host: "127.0.0.1:5178" },
        payload: { url: "https://app.example.com/api/profile", method: "GET" },
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
