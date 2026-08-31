import { describe, expect, it, vi } from "vitest";
import type { ForwardProfile, ForwardRequestPayload, RuleBinding } from "@resource-forwarder/shared-types";
import { createRequestContext, executeForward } from "./index.js";

const payload: ForwardRequestPayload = {
  url: "https://app.example.com/api/users",
  pageUrl: "https://app.example.com/dashboard",
  method: "GET",
  headers: {},
  resourceType: "fetch",
};

function binding(profile: ForwardProfile): RuleBinding {
  return {
    rule: {
      id: "rule-forward-core",
      name: "forward core test",
      enabled: true,
      kind: "api_forward",
      priority: 100,
      match: { host: ["app.example.com"], pathGlob: "/api/**", tabScope: { mode: "all" } },
      target: { forwardProfile: profile },
      tags: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  };
}

describe("executeForward", () => {
  it("normalizes request hosts without custom ports", () => {
    expect(createRequestContext({
      url: "http://127.0.0.1:9080/api/users",
      method: "GET",
    }).host).toBe("127.0.0.1");
  });

  it("serves inline JSON without an upstream fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await executeForward(
      binding({ targetBaseUrl: "", responsePolicy: { mode: "mock_json", mockJson: { ok: true } } }),
      payload,
      { fetch: fetchMock },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.targetUrl).toBe("mock:inline-json");
    expect(JSON.parse(result.response.body ?? "")).toEqual({ ok: true });
  });

  it("delegates mock files to the host adapter", async () => {
    const mockFile = vi.fn(async () => ({ value: { source: "browser-handle" }, displayName: "users.json" }));
    const result = await executeForward(
      binding({ targetBaseUrl: "", responsePolicy: { mode: "mock_file", mockFilePath: "handle:users" } }),
      payload,
      { mockFile },
    );

    expect(mockFile).toHaveBeenCalledWith("handle:users");
    expect(result.targetUrl).toBe("mock-file:users.json");
    expect(JSON.parse(result.response.body ?? "")).toEqual({ source: "browser-handle" });
  });

  it("encodes binary upstream responses without Node Buffer", async () => {
    const result = await executeForward(
      binding({ targetBaseUrl: "https://upstream.example.com" }),
      payload,
      {
        fetch: vi.fn(async () =>
          new Response(new Uint8Array([0, 1, 2, 255]), {
            headers: { "content-type": "application/octet-stream" },
          }),
        ),
      },
    );

    expect(result.response.bodyEncoding).toBe("base64");
    expect(result.response.body).toBe("AAEC/w==");
  });
});
