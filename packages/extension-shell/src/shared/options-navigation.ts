export type OptionsNavigationView = "rules" | "debug" | "import-export" | "settings" | "about";

export interface OptionsNavigationTarget {
  view?: OptionsNavigationView;
  projectId?: string;
  ruleSetId?: string;
}

const supportedViews = new Set<OptionsNavigationView>([
  "rules",
  "debug",
  "import-export",
  "settings",
  "about",
]);

export function buildOptionsNavigationUrl(
  optionsPageUrl: string,
  target: OptionsNavigationTarget = {},
): string {
  const url = new URL(optionsPageUrl);
  url.searchParams.set("view", target.view ?? "rules");
  if (target.projectId) url.searchParams.set("project", target.projectId);
  if (target.ruleSetId) url.searchParams.set("ruleSet", target.ruleSetId);
  return url.toString();
}

export function parseOptionsNavigation(search: string): Required<OptionsNavigationTarget> {
  const params = new URLSearchParams(search);
  const requestedView = params.get("view") as OptionsNavigationView | null;
  return {
    view: requestedView && supportedViews.has(requestedView) ? requestedView : "rules",
    projectId: params.get("project") ?? "",
    ruleSetId: params.get("ruleSet") ?? "",
  };
}
