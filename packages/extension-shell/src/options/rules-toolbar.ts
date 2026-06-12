export interface SiteActionMenuItem {
  key: "delete";
  label: string;
  danger?: boolean;
}

export const TOOLBAR_CONTROL_HEIGHT = 30;

export interface ToolbarLayoutFlags {
  showSiteActions: boolean;
  showGroupActions: boolean;
  canCreateRule: boolean;
}

export interface SiteTogglePresentation {
  label: string;
  title: string;
  tone: "primary" | "neutral";
}

export function buildSiteActionMenuItems(_enabled: boolean): SiteActionMenuItem[] {
  return [{ key: "delete", label: "删除站点", danger: true }];
}

export function getToolbarLayoutFlags(input: {
  hasSelectedProject: boolean;
  hasSelectedRuleSet: boolean;
}): ToolbarLayoutFlags {
  return {
    showSiteActions: input.hasSelectedProject,
    showGroupActions: input.hasSelectedProject,
    canCreateRule: input.hasSelectedProject && input.hasSelectedRuleSet,
  };
}

export function getSiteTogglePresentation(enabled: boolean): SiteTogglePresentation {
  return enabled
    ? {
        label: "已启用",
        title: "点击停用站点",
        tone: "primary",
      }
    : {
        label: "已停用",
        title: "点击启用站点",
        tone: "neutral",
      };
}
