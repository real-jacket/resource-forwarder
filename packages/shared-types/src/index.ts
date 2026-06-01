export type RuleKind = "asset_redirect" | "api_forward";

export type MatchResourceType =
  | "script"
  | "stylesheet"
  | "image"
  | "font"
  | "fetch"
  | "xmlhttprequest"
  | "other";

export type SupportedExportFormat = "json" | "yaml";

export type TabScope =
  | {
      mode: "all";
    }
  | {
      mode: "tabIds";
      tabIds: number[];
    };

export interface Project {
  id: string;
  name: string;
  enabled: boolean;
  siteHosts: string[];
  siteMatchPatterns?: string[];
  envLabel?: string;
  tags: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuleSet {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  ruleIds: string[];
  /**
   * Optional URL match patterns scoping this group below the parent project.
   * When non-empty, this group only "activates" (shows in sidepanel, surfaces
   * in the current-tab views) when the current URL matches one of these
   * patterns AND the parent project also matches. When empty or undefined,
   * the group inherits the project's siteMatchPatterns — keeping the legacy
   * single-group projects working without migration.
   */
  siteMatchPatterns?: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MatchCondition {
  host: string[];
  pathGlob: string;
  resourceType?: MatchResourceType[];
  method?: string[];
  tabScope?: TabScope;
}

export interface PathRewrite {
  from: string;
  to: string;
}

export interface ForwardProfile {
  targetBaseUrl: string;
  stripPrefix?: string;
  pathRewrite?: PathRewrite[];
  headers?: Record<string, string>;
  headerPolicy?: ForwardHeaderPolicy;
  timeoutMs?: number;
}

export interface ForwardHeaderPolicy {
  /**
   * Header names to strip from the forwarded request in addition to the
   * built-in defaults (host, content-length, cookie, cookie2, origin, referer).
   * Names are matched case-insensitively.
   */
  strip?: string[];
  /**
   * Header names that should be forwarded even if they appear in the strip
   * list (built-in or user-provided). Useful when a particular target needs
   * the original Cookie or Authorization despite the safer default.
   */
  passthrough?: string[];
}

export interface Target {
  redirectUrl?: string;
  forwardProfile?: ForwardProfile;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  kind: RuleKind;
  priority: number;
  match: MatchCondition;
  target: Target;
  note?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSnapshot {
  version: number;
  updatedAt: string;
  projects: Project[];
  ruleSets: RuleSet[];
  rules: Rule[];
}

export interface RuleBinding {
  project?: Project;
  ruleSet?: RuleSet;
  rule: Rule;
}

export interface RequestContext {
  url: string;
  method: string;
  host: string;
  pathname: string;
  tabId?: number;
  resourceType: MatchResourceType;
  headers?: Record<string, string>;
}

export interface HitRecord {
  id: string;
  occurredAt: string;
  requestUrl: string;
  projectId?: string;
  ruleSetId?: string;
  ruleId: string;
  target: string;
  durationMs: number;
  outcome: "matched" | "passed" | "error";
  statusCode?: number;
  errorMessage?: string;
  method: string;
  resourceType: MatchResourceType;
}

export interface ForwardRequestPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  bodyEncoding?: "utf8" | "base64";
  tabId?: number;
  resourceType?: "fetch" | "xmlhttprequest";
  /**
   * Rule the client (background or page-bridge) already matched against. If
   * present and resolvable in the service-side workspace, the service skips
   * its own match step — eliminating the inconsistency window where the two
   * workspaces have drifted. Falls back to pickMatchingRule when absent.
   */
  matchedRuleId?: string;
}

export interface ForwardResponsePayload {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: string;
  bodyEncoding: "utf8" | "base64";
  responseUrl: string;
  matchedRuleId?: string;
}

export interface UpsertProjectPayload {
  project: Project;
  ruleSets?: RuleSet[];
}

export interface UpsertRulePayload {
  rule: Rule;
  ruleSetId?: string;
}

export interface ImportWorkspacePayload {
  format?: SupportedExportFormat;
  content: string;
  merge?: boolean;
}

export interface ExportWorkspaceResponse {
  format: SupportedExportFormat;
  content: string;
}

export interface ServiceHealthResponse {
  ok: boolean;
  version: string;
  /**
   * Optional and intentionally not exposed by /health to avoid leaking the
   * filesystem layout to anyone who can hit the loose-CORS endpoint. Callers
   * that need it should read it from their local WorkspaceStorage instance.
   */
  storagePath?: string;
}

export interface ProjectsResponse {
  projects: Project[];
  ruleSets: RuleSet[];
  updatedAt: string;
}

export interface RulesResponse {
  rules: Rule[];
  updatedAt: string;
}

export interface LogsResponse {
  logs: HitRecord[];
}

export interface ServiceWorkspaceResponse {
  workspace: WorkspaceSnapshot;
}

export interface SiteContextPayload {
  serviceUrl: string;
  workspace: WorkspaceSnapshot;
  currentUrl: string;
  tabId?: number;
  warnings: string[];
}

export interface RuntimeState {
  serviceUrl: string;
  health: ServiceHealthResponse | null;
  workspace: WorkspaceSnapshot;
}

// --- AI-facing analysis endpoints (/match, /rules/validate, /schema) ---
// Read-only, side-effect-free contracts that let an agent (or any script)
// complete the "pull contract -> draft rule -> validate -> dry-run match" loop
// without writing to disk or hitting an upstream.

/**
 * Body for `POST /match`: a read-only subset of {@link ForwardRequestPayload}
 * (no `body` — the request is never replayed upstream). `resourceType` widens
 * to the full {@link MatchResourceType} set so asset_redirect rules (which key
 * off script/stylesheet/image/font) can be dry-run too.
 */
export interface MatchRequestPayload {
  url: string;
  method: string;
  resourceType?: MatchResourceType;
  tabId?: number;
  headers?: Record<string, string>;
}

/** The rule `POST /match` selected, flattened to ids for an external caller. */
export interface MatchedRuleBinding {
  ruleId: string;
  ruleName: string;
  kind: RuleKind;
  projectId?: string;
  ruleSetId?: string;
}

/**
 * Per-rule diagnostic emitted by `POST /match`. Covers EVERY rule (not just the
 * enabled ones that participate in selection) so a caller debugging "why didn't
 * my rule fire" can see exactly which condition — or the enabled chain — failed.
 */
export interface MatchTraceEntry {
  ruleId: string;
  ruleName: string;
  kind: RuleKind;
  /** Combined rule + ruleSet + project enabled chain. */
  enabled: boolean;
  conditions: {
    host: boolean;
    path: boolean;
    method: boolean;
    resourceType: boolean;
    tabScope: boolean;
  };
  /** `enabled` && every condition passed. */
  wouldMatch: boolean;
}

export interface MatchResponse {
  matched: boolean;
  binding?: MatchedRuleBinding;
  /**
   * For api_forward: the rewritten upstream URL (via the same builder `/forward`
   * uses). For asset_redirect: the redirect target. Undefined when unmatched or
   * not computable (e.g. malformed forward profile).
   */
  rewrittenUrl?: string;
  trace: MatchTraceEntry[];
}

/**
 * Mirror of rule-core's `RuleConflict` shape, inlined here so shared-types keeps
 * its one-way dependency direction (it must not import from rule-core).
 */
export interface RuleConflictInfo {
  ruleId: string;
  reason: string;
}

/**
 * Response for `POST /rules/validate`. warnings/conflicts are advisory, not
 * errors, so `valid` stays true for a structurally sound rule — only a payload
 * that fails the route's ajv schema is rejected (400) before reaching here.
 */
export interface ValidateRuleResponse {
  valid: boolean;
  warnings: string[];
  conflicts: RuleConflictInfo[];
}

/** Response for `GET /schema`: the service's request-body ajv schemas, verbatim. */
export interface SchemaResponse {
  serviceVersion: string;
  schemas: Record<string, unknown>;
}

export interface DynamicRedirectRule {
  id: number;
  priority: number;
  action: {
    type: "redirect";
    redirect: {
      url?: string;
      regexSubstitution?: string;
    };
  };
  condition: {
    regexFilter?: string;
    urlFilter?: string;
    requestDomains?: string[];
    initiatorDomains?: string[];
    tabIds?: number[];
    resourceTypes?: Array<"script" | "stylesheet" | "image" | "font">;
  };
}
