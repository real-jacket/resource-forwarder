/**
 * Public entry point for @resource-forwarder/rule-core.
 *
 * Implementation lives in topic-specific files; this barrel keeps the public
 * surface stable while letting the internals be split for readability and
 * isolated testing:
 *   - workspace.ts            schema validation + (de)serialisation + helpers
 *   - matchers.ts             rule-matching primitives + selection
 *   - dnr.ts                  Chrome declarativeNetRequest conversion
 *   - resource-override.ts    Resource Override export importer
 *   - warnings.ts             config sanity warnings + RuleConflict shape
 *   - glob.ts                 glob → regex / DNR urlFilter primitives
 *   - workspace-mutations.ts  pure mutation helpers + pending-deletions queue
 *   - matcher-cache.ts        pre-compiled matcher used by hot paths
 */

// Workspace utilities
export {
  assertWorkspace,
  createEmptyWorkspace,
  deriveSiteHosts,
  detectFormat,
  isTextualContentType,
  matchesProjectSite,
  matchesRuleSetSite,
  normalizeImportedHost,
  parseWorkspace,
  serializeWorkspace,
  trimWorkspaceForUrl,
} from "./workspace.js";

// Matchers
export {
  collectRuleConflicts,
  getEnabledRuleBindings,
  matchesHost,
  matchesMethod,
  matchesPath,
  matchesResourceType,
  matchesRule,
  matchesTabScope,
  normalizeMethod,
  pickMatchingRule,
  resolveRuleBinding,
  sortRules,
} from "./matchers.js";

// DNR conversion
export { toDynamicNetRequestRules, toDynamicRule } from "./dnr.js";

// Glob/regex primitives — exported because page-bridge / matcher-cache need
// access to the same compilation logic the matchers use.
export { buildRegexFilter, globToPathRegexSource, sanitizePathGlob } from "./glob.js";

// Resource Override import
export { parseResourceOverrideExport } from "./resource-override.js";
export type { ResourceOverrideImportReport } from "./resource-override.js";

// Warnings
export {
  collectProjectWarnings,
  collectUnsupportedRuleWarnings,
  collectWorkspaceWarnings,
} from "./warnings.js";
export type { RuleConflict } from "./warnings.js";

// Workspace mutations + pending deletions
export {
  applyPendingDeletions,
  applyUpsertProject,
  applyUpsertRule,
  applyUpsertRuleSet,
  emptyPendingDeletions,
  isPendingDeletionsEmpty,
  mergePendingDeletions,
  mergeWorkspaces,
  planDeleteProject,
  planDeleteRule,
  planDeleteRuleSet,
  stampUpdated,
  upsertById,
} from "./workspace-mutations.js";
export type { PendingDeletions } from "./workspace-mutations.js";

// Matcher cache (pre-compiled matchers for hot paths)
export { prepareMatcher } from "./matcher-cache.js";
export type { MatcherCache } from "./matcher-cache.js";
