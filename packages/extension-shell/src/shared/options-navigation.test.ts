import { describe, expect, it } from "vitest";
import { buildOptionsNavigationUrl, parseOptionsNavigation } from "./options-navigation.js";

describe("options navigation", () => {
  it("builds a rules deep link with project and rule-set context", () => {
    expect(
      buildOptionsNavigationUrl("chrome-extension://example/options.html", {
        projectId: "project-1",
        ruleSetId: "ruleset-1",
      }),
    ).toBe(
      "chrome-extension://example/options.html?view=rules&project=project-1&ruleSet=ruleset-1",
    );
  });

  it("parses supported views and falls back to the rules view", () => {
    expect(parseOptionsNavigation("?view=about&project=p1&ruleSet=rs1")).toEqual({
      view: "about",
      projectId: "p1",
      ruleSetId: "rs1",
    });
    expect(parseOptionsNavigation("?view=unknown")).toEqual({
      view: "rules",
      projectId: "",
      ruleSetId: "",
    });
  });
});
