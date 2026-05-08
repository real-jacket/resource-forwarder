import { describe, expect, it } from "vitest";
import { getWindowPostMessageTargetOrigin } from "./window-messaging.js";

describe("window messaging helpers", () => {
  it("uses the concrete origin for normal pages", () => {
    expect(getWindowPostMessageTargetOrigin("https://co-dev-17.shimorelease.com")).toBe("https://co-dev-17.shimorelease.com");
  });

  it("falls back to wildcard target origin for opaque origins", () => {
    expect(getWindowPostMessageTargetOrigin("null")).toBe("*");
  });
});
