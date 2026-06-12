import { describe, expect, it } from "vitest";
import {
  TOOLBAR_CONTROL_HEIGHT,
  buildSiteActionMenuItems,
  getToolbarLayoutFlags,
  getSiteTogglePresentation,
} from "./rules-toolbar.js";

describe("buildSiteActionMenuItems", () => {
  it("keeps delete inside the overflow menu", () => {
    expect(buildSiteActionMenuItems(true)).toEqual([
      { key: "delete", label: "删除站点", danger: true },
    ]);
  });
});

describe("getToolbarLayoutFlags", () => {
  it("exposes site and group actions only when a site is selected", () => {
    expect(getToolbarLayoutFlags({ hasSelectedProject: true, hasSelectedRuleSet: true })).toEqual({
      showSiteActions: true,
      showGroupActions: true,
      canCreateRule: true,
    });
    expect(getToolbarLayoutFlags({ hasSelectedProject: true, hasSelectedRuleSet: false }).canCreateRule).toBe(false);
    expect(getToolbarLayoutFlags({ hasSelectedProject: false, hasSelectedRuleSet: false })).toEqual({
      showSiteActions: false,
      showGroupActions: false,
      canCreateRule: false,
    });
  });
});

describe("TOOLBAR_CONTROL_HEIGHT", () => {
  it("keeps the top controls on a shared 30px baseline", () => {
    expect(TOOLBAR_CONTROL_HEIGHT).toBe(30);
  });
});

describe("getSiteTogglePresentation", () => {
  it("expresses current state using only primary and neutral variants", () => {
    expect(getSiteTogglePresentation(true)).toEqual({
      label: "已启用",
      title: "点击停用站点",
      tone: "primary",
    });
    expect(getSiteTogglePresentation(false)).toEqual({
      label: "已停用",
      title: "点击启用站点",
      tone: "neutral",
    });
  });
});
