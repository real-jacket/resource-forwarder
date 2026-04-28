import { describe, expect, it } from "vitest";
import { SERVICE_OFFLINE_SENTINEL } from "./constants.js";
import { normalizeProxyRequestError } from "./service-errors.js";

describe("service error helpers", () => {
  it("maps service network failures to the offline sentinel", () => {
    const normalized = normalizeProxyRequestError(new TypeError("Failed to fetch"));

    expect(normalized).toBeInstanceOf(Error);
    expect((normalized as Error).message).toBe(SERVICE_OFFLINE_SENTINEL);
  });

  it("preserves abort errors so cancelled requests stay cancelled", () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");

    expect(normalizeProxyRequestError(abort)).toBe(abort);
  });
});
