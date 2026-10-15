import { describe, expect, it } from "vitest";
import { siteScopeSpecificity } from "./site-matching.js";

const url = "https://co-dev-office-18.shimorelease.com/sdk/demo/shimo-files/2e8259efe5674995";

describe("siteScopeSpecificity", () => {
  it("ranks an exact URL pattern above a wildcard pattern for the same page", () => {
    const exact = siteScopeSpecificity(["https://co-dev-office-18.shimorelease.com/sdk/demo/shimo-files/2e8259efe5674995"], url);
    const broad = siteScopeSpecificity(["https://co-dev-office-18.shimorelease.com/sdk/demo/shimo-files/*"], url);

    expect(exact).toBeGreaterThan(broad);
  });

  it("ignores patterns that do not match the page", () => {
    const value = siteScopeSpecificity(
      [
        "https://other.example.com/very/long/non/matching/path/segment",
        "https://co-dev-office-18.shimorelease.com/sdk/demo/shimo-files/*",
      ],
      url,
    );
    const broadOnly = siteScopeSpecificity(["https://co-dev-office-18.shimorelease.com/sdk/demo/shimo-files/*"], url);

    expect(value).toBe(broadOnly);
  });

  it("returns -1 when no pattern matches", () => {
    expect(siteScopeSpecificity(["https://nope.example.com/*"], url)).toBe(-1);
  });

  it("returns -1 for an empty pattern list", () => {
    expect(siteScopeSpecificity([], url)).toBe(-1);
  });
});
