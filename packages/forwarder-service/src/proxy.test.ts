import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForwardProfile, ForwardRequestPayload, RuleBinding } from "@resource-forwarder/shared-types";
import {
  buildForwardResponseHeaders,
  buildForwardTargetUrl,
  createRequestContext,
  forwardThroughRule,
} from "./proxy.js";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "rf-response-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tempRoot, { recursive: true, force: true });
});

const payload: ForwardRequestPayload = {
  url: "https://app.example.com/api/users/42",
  pageUrl: "https://app.example.com/dashboard",
  method: "GET",
  headers: {},
  resourceType: "fetch",
};

function createBinding(profile: ForwardProfile): RuleBinding {
  return {
    rule: {
      id: "rule-response",
      name: "response test",
      enabled: true,
      kind: "api_forward",
      priority: 100,
      match: {
        host: ["app.example.com"],
        pathGlob: "/api/**",
        resourceType: ["fetch"],
        tabScope: { mode: "all" },
      },
      target: { forwardProfile: profile },
      tags: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  };
}

describe("proxy transforms", () => {
  it("merges and rewrites multi-value query parameters in a deterministic order", () => {
    const profile: ForwardProfile = {
      targetBaseUrl: "http://localhost:3000/base?from=target&keep=1",
      stripPrefix: "/api",
      pathRewrite: [{ from: "/users", to: "/v1/users" }],
      queryPolicy: {
        remove: ["token"],
        set: { env: "local" },
        append: { tag: ["debug", "frontend"] },
      },
    };

    const target = buildForwardTargetUrl(
      profile,
      new URL("https://api.example.com/api/users/me?token=secret&tag=source&tag=two"),
    );

    expect(target.pathname).toBe("/base/v1/users/me");
    expect(target.searchParams.get("token")).toBeNull();
    expect(target.searchParams.get("env")).toBe("local");
    expect(target.searchParams.getAll("tag")).toEqual(["source", "two", "debug", "frontend"]);
    expect(target.searchParams.get("keep")).toBe("1");
  });

  it("strips and overrides response headers case-insensitively", () => {
    const profile: ForwardProfile = {
      targetBaseUrl: "http://localhost:3000",
      responseHeaderPolicy: {
        strip: ["content-security-policy"],
        set: { "cache-control": "no-store", "x-forwarded-by": "resource-forwarder" },
      },
    };
    const headers = buildForwardResponseHeaders(
      new Headers({
        "Content-Security-Policy": "default-src 'self'",
        "Cache-Control": "max-age=3600",
      }),
      profile,
    );

    expect(headers["content-security-policy"]).toBeUndefined();
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-forwarded-by"]).toBe("resource-forwarder");
  });

  it("creates normalized query and header context for matching", () => {
    const context = createRequestContext({
      url: "https://api.example.com/users?tag=a&tag=b",
      method: "GET",
      headers: { "X-Client": "Web" },
      resourceType: "fetch",
    });
    expect(context.query).toEqual({ tag: ["a", "b"] });
    expect(context.headers).toEqual({ "x-client": "Web" });
  });

  it("returns inline JSON without calling the upstream", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const result = await forwardThroughRule(
      createBinding({
        targetBaseUrl: "",
        responsePolicy: {
          mode: "mock_json",
          status: 201,
          statusText: "Created for UI",
          mockJson: { code: 0, data: { id: 42 } },
        },
      }),
      payload,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.targetUrl).toBe("mock:inline-json");
    expect(result.response.status).toBe(201);
    expect(result.response.statusText).toBe("Created for UI");
    expect(JSON.parse(result.response.body ?? "")).toEqual({ code: 0, data: { id: 42 } });
    expect(result.response.responseUrl).toBe(payload.url);
  });

  it("returns a local JSON file and only exposes its basename in diagnostics", async () => {
    const filePath = join(tempRoot, "user-detail.json");
    await writeFile(filePath, JSON.stringify({ user: { id: 7, name: "Local" } }), "utf8");

    const result = await forwardThroughRule(
      createBinding({
        targetBaseUrl: "",
        responsePolicy: { mode: "mock_file", mockFilePath: filePath },
      }),
      payload,
    );

    expect(result.targetUrl).toBe("mock-file:user-detail.json");
    expect(JSON.parse(result.response.body ?? "")).toEqual({ user: { id: 7, name: "Local" } });
    expect(result.response.responseUrl).toBe(payload.url);
  });

  it("rejects unsafe or unusable mock files with bounded error messages", async () => {
    const wrongExtension = join(tempRoot, "response.txt");
    const invalidJson = join(tempRoot, "invalid.json");
    const tooLarge = join(tempRoot, "large.json");
    await writeFile(wrongExtension, "{}", "utf8");
    await writeFile(invalidJson, "{broken", "utf8");
    await writeFile(tooLarge, "x".repeat(4 * 1024 * 1024 + 1), "utf8");

    await expect(
      forwardThroughRule(
        createBinding({ targetBaseUrl: "", responsePolicy: { mode: "mock_file", mockFilePath: wrongExtension } }),
        payload,
      ),
    ).rejects.toThrow(/\.json extension/);
    await expect(
      forwardThroughRule(
        createBinding({ targetBaseUrl: "", responsePolicy: { mode: "mock_file", mockFilePath: invalidJson } }),
        payload,
      ),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      forwardThroughRule(
        createBinding({ targetBaseUrl: "", responsePolicy: { mode: "mock_file", mockFilePath: tooLarge } }),
        payload,
      ),
    ).rejects.toThrow(/large\.json exceeds/);
  });

  it("applies recursive JSON merge patch and removes null fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: 42, name: "Upstream", role: "admin" }, keep: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "999",
          "content-encoding": "gzip",
          "transfer-encoding": "chunked",
        },
      }),
    ));

    const result = await forwardThroughRule(
      createBinding({
        targetBaseUrl: "http://upstream.test",
        responsePolicy: {
          mode: "forward",
          status: 202,
          jsonMergePatch: { data: { name: "Local", role: null }, debug: true },
        },
      }),
      payload,
    );

    expect(result.response.status).toBe(202);
    expect(JSON.parse(result.response.body ?? "")).toEqual({
      data: { id: 42, name: "Local" },
      keep: true,
      debug: true,
    });
    expect(result.response.headers["content-length"]).toBeUndefined();
    expect(result.response.headers["content-encoding"]).toBeUndefined();
    expect(result.response.headers["transfer-encoding"]).toBeUndefined();
  });

  it("does not return a body for statuses that forbid one", async () => {
    const result = await forwardThroughRule(
      createBinding({
        targetBaseUrl: "",
        responsePolicy: { mode: "mock_json", status: 204, mockJson: { ignored: true } },
      }),
      payload,
    );
    expect(result.response.status).toBe(204);
    expect(result.response.statusText).toBe("No Content");
    expect(result.response.body).toBeUndefined();
  });
});
