import { describe, expect, it } from "vitest";
import { createEmptyWorkspace, serializeWorkspace } from "@resource-forwarder/rule-core";
import { detectImportSource } from "./import-source.js";

describe("detectImportSource", () => {
  it("recognizes exported workspace json", () => {
    const content = serializeWorkspace(createEmptyWorkspace(), "json");
    expect(detectImportSource(content)).toBe("workspace");
  });

  it("recognizes exported workspace yaml", () => {
    const content = serializeWorkspace(createEmptyWorkspace(), "yaml");
    expect(detectImportSource(content)).toBe("workspace");
  });

  it("recognizes resource override exports", () => {
    const content = JSON.stringify({ v: 1, data: [] });
    expect(detectImportSource(content)).toBe("resource-override");
  });

  it("returns null for unrecognized content", () => {
    expect(detectImportSource("not a valid import payload")).toBeNull();
  });
});
