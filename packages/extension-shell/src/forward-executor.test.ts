import { describe, expect, it, vi } from "vitest";
import type { ForwardProfile, ForwardRequestPayload, RuleBinding, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { chooseForwardExecution, executeInBrowser, resolveForwardBinding } from "./forward-executor.js";

const payload: ForwardRequestPayload = {
  url: "https://app.example.com/api/users",
  pageUrl: "https://app.example.com/dashboard",
  method: "GET",
  headers: {},
  resourceType: "fetch",
  matchedRuleId: "rule-1",
};

function binding(profile: ForwardProfile): RuleBinding {
  return {
    project: {
      id: "project-1",
      name: "App",
      enabled: true,
      siteHosts: ["app.example.com"],
      siteMatchPatterns: ["https://app.example.com/**"],
      tags: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    ruleSet: {
      id: "set-1",
      projectId: "project-1",
      name: "API",
      enabled: true,
      ruleIds: ["rule-1"],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    rule: {
      id: "rule-1",
      name: "Users",
      enabled: true,
      kind: "api_forward",
      priority: 100,
      match: { host: ["app.example.com"], pathGlob: "/api/**", method: ["GET"], resourceType: ["fetch"] },
      target: { forwardProfile: profile },
      tags: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  };
}

function workspace(item: RuleBinding): WorkspaceSnapshot {
  return {
    version: 1,
    updatedAt: "2025-01-01T00:00:00.000Z",
    projects: [item.project!],
    ruleSets: [item.ruleSet!],
    rules: [item.rule],
  };
}

describe("forward execution routing", () => {
  it("uses the browser for ordinary auto rules", () => {
    expect(chooseForwardExecution(binding({ targetBaseUrl: "https://api.example.com" }))).toEqual({
      location: "browser",
      reason: "browser-default",
    });
  });

  it("routes local file and restricted cookie rules to the companion", () => {
    expect(chooseForwardExecution(binding({
      targetBaseUrl: "",
      responsePolicy: { mode: "mock_file", mockFilePath: "/tmp/users.json" },
    })).location).toBe("local");
    expect(chooseForwardExecution(binding({
      targetBaseUrl: "https://api.example.com",
      headerPolicy: { passthrough: ["cookie"] },
    })).location).toBe("local");
  });

  it("rejects local-only capabilities when browser mode is forced", () => {
    expect(() => chooseForwardExecution(binding({
      executionMode: "browser",
      targetBaseUrl: "",
      responsePolicy: { mode: "mock_file", mockFilePath: "/tmp/users.json" },
    }))).toThrow(/BROWSER_CAPABILITY_UNSUPPORTED/);
  });

  it("does not trust a stale or mismatched page hint", () => {
    const item = binding({ targetBaseUrl: "https://api.example.com" });
    expect(resolveForwardBinding(workspace(item), payload).rule.id).toBe("rule-1");
    expect(() => resolveForwardBinding(workspace(item), { ...payload, url: "https://evil.example/api/users" })).toThrow(
      /no longer matches/,
    );
  });

  it("executes inline JSON without a local service", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const result = await executeInBrowser(binding({
      executionMode: "browser",
      targetBaseUrl: "",
      responsePolicy: { mode: "mock_json", status: 200, mockJson: { ok: true } },
    }), payload);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(result.response.body ?? "")).toEqual({ ok: true });
    fetchMock.mockRestore();
  });
});
