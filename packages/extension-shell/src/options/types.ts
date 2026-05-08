import type { MatchResourceType, Rule } from "@resource-forwarder/shared-types";

/** The four top-level tabs in the options page. */
export type AppView = "rules" | "import-export" | "settings" | "about";

/** Whether the right-hand side panel is showing the single or batch rule editor. */
export type PanelMode = "rule" | "rule-batch" | null;

/** Which tab inside the single-rule panel is currently active. */
export type RulePanelTab = "basic" | "advanced";

/** Status filter for the rule list view. */
export type RuleStatusTab = "all" | "enabled" | "disabled";

/** Which payload format the import view is parsing. */
export type ImportSource = "workspace" | "resource-override";

/**
 * Form-friendly mirror of `Project`. Strings are stored verbatim (e.g. comma
 * lists are kept un-split) so partial input doesn't get clobbered as the user
 * types — the conversion happens once on save.
 */
export interface ProjectDraft {
  id: string;
  name: string;
  siteMatchPatterns: string;
  envLabel: string;
  note: string;
  enabled: boolean;
}

/**
 * Form-friendly mirror of `Rule`. Same string-bag rationale as ProjectDraft;
 * fields like `host`, `method`, `tags` are CSV strings while in the editor.
 */
export interface RuleDraft {
  id: string;
  ruleSetId: string;
  name: string;
  kind: Rule["kind"];
  enabled: boolean;
  priority: number;
  host: string;
  pathGlob: string;
  resourceType: string;
  method: string;
  redirectUrl: string;
  targetBaseUrl: string;
  stripPrefix: string;
  headersJson: string;
  tags: string;
  note: string;
}

/**
 * One row in the batch-rule editor — same as RuleDraft plus a stable React key
 * so re-orders / deletions don't blow away DOM-level focus state.
 */
export interface BatchRuleDraft extends RuleDraft {
  localId: string;
}

/** A click-to-fill template surfaced in the rule editor. */
export interface RuleTemplatePreset {
  id: string;
  kind: Rule["kind"];
  label: string;
  description: string;
  patch: Partial<RuleDraft>;
}

/** Banner shown after an import attempt completes (success or partial). */
export interface ImportFeedback {
  title: string;
  details: string[];
}

/** Re-export so option-page-only constants live alongside the types. */
export const defaultApiTypes: MatchResourceType[] = ["fetch", "xmlhttprequest"];
export const defaultAssetTypes: MatchResourceType[] = ["script", "stylesheet", "image", "font"];

/**
 * Source / issue tracker URL shown on the About page.
 *
 * Empty string hides the buttons (the previous "https://github.com/your/..."
 * placeholder shipped a dead link in the published extension). Set this when
 * the project has a real public repo to expose to users.
 */
export const ABOUT_REPO_URL = "";
