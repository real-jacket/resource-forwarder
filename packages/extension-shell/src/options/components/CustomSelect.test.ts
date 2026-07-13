import { describe, expect, it } from "vitest";
import { resolveMenuHorizontalLayout } from "./CustomSelect.js";

describe("resolveMenuHorizontalLayout", () => {
  it("uses the intrinsic menu width when content is wider than the trigger", () => {
    expect(resolveMenuHorizontalLayout({
      triggerLeft: 100,
      triggerWidth: 120,
      menuWidth: 280,
      viewportWidth: 1024,
    })).toEqual({ left: 100, width: 280 });
  });

  it("never makes the menu narrower than the trigger", () => {
    expect(resolveMenuHorizontalLayout({
      triggerLeft: 100,
      triggerWidth: 240,
      menuWidth: 120,
      viewportWidth: 1024,
    })).toEqual({ left: 100, width: 240 });
  });

  it("caps wide content to the viewport and keeps the menu inside its padding", () => {
    expect(resolveMenuHorizontalLayout({
      triggerLeft: 220,
      triggerWidth: 180,
      menuWidth: 600,
      viewportWidth: 320,
    })).toEqual({ left: 8, width: 304 });
  });
});
