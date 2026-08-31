import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type {
  AppliedRevisionPayload,
  AppliedRevisionResponse,
  ForwardRequestPayload,
  ImportWorkspacePayload,
  LogsResponse,
  MatchRequestPayload,
  MatchResponse,
  MatchTraceEntry,
  MutationResponse,
  ProjectsResponse,
  RequestContext,
  RevisionGuard,
  RuleBinding,
  RuleSet,
  RulesResponse,
  SchemaResponse,
  ServiceHealthResponse,
  ServiceWorkspaceResponse,
  SubtreePayload,
  SupportedExportFormat,
  SwitchProjectsPayload,
  UpsertProjectPayload,
  UpsertRulePayload,
  WorkspaceSnapshot,
  ValidateRuleResponse,
} from "@resource-forwarder/shared-types";
import {
  applyUpsertProject,
  applyUpsertRule,
  applyUpsertRuleSet,
  collectRuleConflicts,
  collectUnsupportedRuleWarnings,
  collectWorkspaceWarnings,
  getSwitchGroup,
  isAgentManagedProject,
  matchesHeaders,
  matchesHost,
  matchesMethod,
  matchesPath,
  matchesProjectSite,
  matchesQuery,
  matchesResourceType,
  matchesRule,
  matchesRuleSetSite,
  matchesTabScope,
  mergeUserOwnedSlice,
  parseWorkspace,
  pickMatchingRule,
  planDeleteProject,
  planDeleteRule,
  planDeleteRuleSet,
  resolveForwardProfile,
  resolveRuleBinding,
  resolveRuleTargetValue,
  reserveAgentManagedIds,
  workspaceWithoutAgentManaged,
  validateProjectSubtree,
} from "@resource-forwarder/rule-core";
import { buildForwardTargetUrl, createRequestContext, forwardThroughRule, STREAMING_UNSUPPORTED } from "./proxy.js";
import {
  InvalidAppliedRevisionError,
  RevisionConflictError,
  RevisionRequiredError,
  WorkspaceStorage,
} from "./storage.js";
import { HitLogger } from "./hit-logger.js";

export const SERVICE_VERSION = "0.1.0";

// Headroom above the extension-side FORWARD_BODY_LIMIT_BYTES (2 MiB) to allow
// for base64 expansion (~33%) plus envelope overhead (headers JSON, URL).
const REQUEST_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export interface BuildServerOptions {
  storage: WorkspaceStorage;
  /** Override the structured logger config; pass `false` to disable. */
  logger?: BuildLoggerOption;
  /** Disable rate limiting (only useful in tests). */
  disableRateLimit?: boolean;
  /** Override default rate-limit knobs (tests dial these down to verify behaviour). */
  rateLimit?: {
    global?: { max?: number; timeWindow?: string | number };
    forward?: { max?: number; timeWindow?: string | number };
  };
  /**
   * Bearer token required on all routes except `/health`. When omitted (e.g.
   * from tests that pre-date this feature) auth is disabled — production
   * launches go through cli.ts which always supplies a token.
   */
  authToken?: string;
  /**
   * Pin the extension's chrome-extension://<id> origin so we can grant CORS
   * access to one specific extension instead of every chrome-extension origin
   * that happens to be installed. Read from `RF_EXTENSION_ID` env var by the
   * CLI; tests can pass it directly. When unset we fall back to the looser
   * "any chrome-extension://" rule but log a warning at startup.
   */
  extensionId?: string;
}

type BuildLoggerOption = boolean | { level?: string };

const DEFAULT_GLOBAL_RATE_LIMIT = { max: 600, timeWindow: "1 minute" } as const;
const DEFAULT_FORWARD_RATE_LIMIT = { max: 300, timeWindow: "1 minute" } as const;

export function buildServer({ storage, logger, disableRateLimit, rateLimit: rateLimitOptions, authToken, extensionId }: BuildServerOptions) {
  const app = Fastify({
    // Default to a real structured logger so production gets request ids,
    // levels, and JSON output for downstream collectors. Tests pass
    // `logger: false` to keep stdout clean.
    logger: resolveLogger(logger),
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
  });

  if (!extensionId) {
    app.log.warn(
      "RF_EXTENSION_ID is not set; CORS will accept any chrome-extension origin. Set it to your extension's id (manifest.json `key`-derived id) for stricter origin checking.",
    );
  }

  const globalRateLimit = { ...DEFAULT_GLOBAL_RATE_LIMIT, ...rateLimitOptions?.global };
  const forwardRateLimit = { ...DEFAULT_FORWARD_RATE_LIMIT, ...rateLimitOptions?.forward };

  const hitLogger = new HitLogger({
    storage,
    onError: (error) => {
      app.log.error({ err: error }, "hit-logger flush failed");
    },
  });

  // Drain pending hit logs before the process exits so we don't lose the last
  // 50ms of telemetry in tests or graceful shutdowns.
  app.addHook("onClose", async () => {
    await hitLogger.close();
  });

  // Host header allowlist: the local service binds to 127.0.0.1 only, but a
  // DNS-rebound `evil.com` page can still reach the loopback socket and the
  // browser will set `Host: evil.com` on its requests. Rejecting non-loopback
  // host headers is the canonical defence-in-depth for that class of attack.
  app.addHook("preHandler", async (request, reply) => {
    const hostHeader = request.headers.host ?? "";
    if (!isAllowedHostHeader(hostHeader)) {
      void reply.code(403).send({ message: "Host header not in localhost allowlist." });
    }
  });

  // Bearer token check. /health is intentionally exempt so the extension can
  // probe service liveness even before the user has pasted the token.
  if (authToken) {
    app.addHook("preHandler", async (request, reply) => {
      if (request.url === "/health" || request.url.startsWith("/health?")) return;
      const header = request.headers.authorization ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
      if (presented !== authToken) {
        void reply.code(401).send({ message: "Missing or invalid bearer token." });
      }
    });
  }

  if (!disableRateLimit) {
    void app.register(rateLimit, {
      max: globalRateLimit.max,
      timeWindow: globalRateLimit.timeWindow,
      // Use the X-Forwarded-For aware key only if the user explicitly proxies;
      // we run on localhost by default, so request.ip is the right key.
      keyGenerator: (request) => request.ip,
    });
  }

  void app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedCorsOrigin(origin, extensionId));
    },
  });

  // Register routes inside a child plugin so they run AFTER rate-limit is
  // fully loaded. Top-level app.post(...) calls are processed eagerly, before
  // the plugin's onRoute hook is installed, which means the per-route
  // `config.rateLimit` overrides silently never take effect. Encapsulating
  // the routes guarantees the plugin sees them.
  void app.register(async (scoped) => {
    registerRoutes(scoped, { storage, hitLogger, forwardRateLimit, disableRateLimit });
  });

  return app;
}

type MutationQuery = { force?: boolean | string };

type RuleSetMutationPayload = RevisionGuard & { ruleSet: RuleSet };

class AgentManagedMutationError extends Error {
  readonly statusCode = 403;
  readonly code = "AGENT_MANAGED_READ_ONLY";

  constructor() {
    super("Agent-managed projects can only be changed through dedicated agent control routes.");
    this.name = "AgentManagedMutationError";
  }
}

class AgentManagedProjectRequiredError extends Error {
  readonly statusCode = 403;
  readonly code = "AGENT_MANAGED_REQUIRED";

  constructor() {
    super("This route only accepts agent-managed projects.");
    this.name = "AgentManagedProjectRequiredError";
  }
}

class RuleSetNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "RULE_SET_NOT_FOUND";

  constructor(ruleSetId: string) {
    super(`Rule set not found: ${ruleSetId}`);
    this.name = "RuleSetNotFoundError";
  }
}

function mutationResponse(workspace: WorkspaceSnapshot): MutationResponse {
  return {
    workspace,
    revision: workspace.revision,
    warnings: collectWorkspaceWarnings(workspace),
  };
}

function readRevisionGuard(body: RevisionGuard, header: string | string[] | undefined): number | undefined {
  if (typeof body.ifRevision === "number") return body.ifRevision;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const normalized = raw.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function forceRequested(query: MutationQuery | undefined): boolean {
  return query?.force === true || query?.force === "true";
}

function sendMutationError(reply: FastifyReply, error: unknown): void {
  const candidate = error as {
    code?: unknown;
    currentRevision?: unknown;
    message?: unknown;
    statusCode?: unknown;
    workspace?: unknown;
  };
  const status = typeof candidate.statusCode === "number" && candidate.statusCode >= 400
    ? candidate.statusCode
    : 409;
  const body: Record<string, unknown> = {
    code: typeof candidate.code === "string" ? candidate.code : "MUTATION_REJECTED",
    message: typeof candidate.message === "string" ? candidate.message : "Mutation rejected.",
  };
  if (typeof candidate.currentRevision === "number") body.currentRevision = candidate.currentRevision;
  if (candidate.workspace && typeof candidate.workspace === "object") body.workspace = candidate.workspace;
  void reply.status(status).send(body);
}

function assertGenericProjectWriteAllowed(
  workspace: WorkspaceSnapshot,
  project: UpsertProjectPayload["project"],
  nestedRuleSets: RuleSet[] = [],
): void {
  const existing = workspace.projects.find((candidate) => candidate.id === project.id);
  if (isAgentManagedProject(project) || (existing && isAgentManagedProject(existing)) || isReservedProjectId(workspace, project.id)) {
    throw new AgentManagedMutationError();
  }
  for (const ruleSet of nestedRuleSets) {
    const existingRuleSet = workspace.ruleSets.find((candidate) => candidate.id === ruleSet.id);
    const referencedProject = workspace.projects.find((candidate) => candidate.id === ruleSet.projectId);
    if (
      isReservedRuleSetId(workspace, ruleSet.id) ||
      (existingRuleSet && isProjectAgentOwned(workspace, existingRuleSet.projectId)) ||
      (referencedProject && isAgentManagedProject(referencedProject)) ||
      isReservedProjectId(workspace, ruleSet.projectId)
    ) {
      throw new AgentManagedMutationError();
    }
    for (const ruleId of ruleSet.ruleIds) {
      const binding = resolveRuleBinding(workspace, ruleId);
      if (isReservedRuleId(workspace, ruleId) || (binding?.project && isAgentManagedProject(binding.project))) {
        throw new AgentManagedMutationError();
      }
    }
  }
}

function isProjectAgentOwned(workspace: WorkspaceSnapshot, projectId: string): boolean {
  const project = workspace.projects.find((candidate) => candidate.id === projectId);
  return Boolean(project && isAgentManagedProject(project));
}

function isReservedProjectId(workspace: WorkspaceSnapshot, id: string): boolean {
  return workspace.agentReservations?.projectIds.includes(id) ?? false;
}

function isReservedRuleSetId(workspace: WorkspaceSnapshot, id: string): boolean {
  return workspace.agentReservations?.ruleSetIds.includes(id) ?? false;
}

function isReservedRuleId(workspace: WorkspaceSnapshot, id: string): boolean {
  return workspace.agentReservations?.ruleIds.includes(id) ?? false;
}

function assertGenericRuleWriteAllowed(workspace: WorkspaceSnapshot, payload: UpsertRulePayload): void {
  const existing = resolveRuleBinding(workspace, payload.rule.id);
  const targetRuleSet = payload.ruleSetId
    ? workspace.ruleSets.find((ruleSet) => ruleSet.id === payload.ruleSetId)
    : undefined;
  if (isReservedRuleId(workspace, payload.rule.id) || (existing?.project && isAgentManagedProject(existing.project))) {
    throw new AgentManagedMutationError();
  }
  if (payload.ruleSetId && !targetRuleSet) throw new RuleSetNotFoundError(payload.ruleSetId);
  const targetProject = targetRuleSet
    ? workspace.projects.find((project) => project.id === targetRuleSet.projectId)
    : undefined;
  if (targetProject && isAgentManagedProject(targetProject)) throw new AgentManagedMutationError();
  if (targetRuleSet && isReservedRuleSetId(workspace, targetRuleSet.id)) throw new AgentManagedMutationError();
}

function assertGenericRuleSetWriteAllowed(workspace: WorkspaceSnapshot, ruleSet: RuleSet): void {
  const existing = workspace.ruleSets.find((candidate) => candidate.id === ruleSet.id);
  const existingProject = existing ? workspace.projects.find((candidate) => candidate.id === existing.projectId) : undefined;
  const project = workspace.projects.find((candidate) => candidate.id === ruleSet.projectId);
  if (
    isReservedRuleSetId(workspace, ruleSet.id) ||
    (existingProject && isAgentManagedProject(existingProject)) ||
    (project && isAgentManagedProject(project)) ||
    isReservedProjectId(workspace, ruleSet.projectId)
  ) {
    throw new AgentManagedMutationError();
  }
  for (const ruleId of ruleSet.ruleIds) {
    const binding = resolveRuleBinding(workspace, ruleId);
    if (isReservedRuleId(workspace, ruleId) || (binding?.project && isAgentManagedProject(binding.project))) {
      throw new AgentManagedMutationError();
    }
  }
}

function replaceUserOwnedWorkspace(current: WorkspaceSnapshot, imported: WorkspaceSnapshot): WorkspaceSnapshot {
  const agentProjects = current.projects.filter(isAgentManagedProject);
  const agentProjectIds = new Set([
    ...(current.agentReservations?.projectIds ?? []),
    ...agentProjects.map((project) => project.id),
  ]);
  const agentRuleSets = current.ruleSets.filter((ruleSet) => agentProjects.some((project) => project.id === ruleSet.projectId));
  const agentRuleSetIds = new Set([
    ...(current.agentReservations?.ruleSetIds ?? []),
    ...agentRuleSets.map((ruleSet) => ruleSet.id),
  ]);
  const agentRuleIds = new Set([
    ...(current.agentReservations?.ruleIds ?? []),
    ...agentRuleSets.flatMap((ruleSet) => ruleSet.ruleIds),
  ]);
  const importedUser = workspaceWithoutAgentManaged(imported);
  return {
    ...importedUser,
    agentReservations: current.agentReservations,
    projects: [...agentProjects, ...importedUser.projects.filter((project) => !agentProjectIds.has(project.id))],
    ruleSets: [...agentRuleSets, ...importedUser.ruleSets.filter((ruleSet) => !agentRuleSetIds.has(ruleSet.id) && !agentProjectIds.has(ruleSet.projectId))],
    rules: [...current.rules.filter((rule) => agentRuleIds.has(rule.id)), ...importedUser.rules.filter((rule) => !agentRuleIds.has(rule.id))],
    revision: current.revision,
  };
}
function assertImportedWorkspaceOwnership(workspace: WorkspaceSnapshot, imported: WorkspaceSnapshot): void {
  if (imported.agentReservations && (
    imported.agentReservations.projectIds.length > 0 ||
    imported.agentReservations.ruleSetIds.length > 0 ||
    imported.agentReservations.ruleIds.length > 0
  )) {
    throw new AgentManagedMutationError();
  }
  for (const project of imported.projects) {
    if (isAgentManagedProject(project) || isReservedProjectId(workspace, project.id) || isProjectAgentOwned(workspace, project.id)) {
      throw new AgentManagedMutationError();
    }
  }
  for (const ruleSet of imported.ruleSets) {
    if (isReservedRuleSetId(workspace, ruleSet.id) || isReservedProjectId(workspace, ruleSet.projectId) || isProjectAgentOwned(workspace, ruleSet.projectId)) {
      throw new AgentManagedMutationError();
    }
    for (const ruleId of ruleSet.ruleIds) {
      const binding = resolveRuleBinding(workspace, ruleId);
      if (isReservedRuleId(workspace, ruleId) || (binding?.project && isAgentManagedProject(binding.project))) {
        throw new AgentManagedMutationError();
      }
    }
  }
  for (const rule of imported.rules) {
    const binding = resolveRuleBinding(workspace, rule.id);
    if (isReservedRuleId(workspace, rule.id) || (binding?.project && isAgentManagedProject(binding.project))) {
      throw new AgentManagedMutationError();
    }
  }
}

// All HTTP route handlers in one place so they share lifecycle with the parent
// Fastify instance and can be registered inside a child plugin (see above).
function registerRoutes(
  app: FastifyInstance,
  ctx: {
    storage: WorkspaceStorage;
    hitLogger: HitLogger;
    forwardRateLimit: { max: number; timeWindow: string | number };
    disableRateLimit?: boolean;
  },
): void {
  const { storage, hitLogger, forwardRateLimit, disableRateLimit } = ctx;

  app.get("/health", async (): Promise<ServiceHealthResponse> => ({
    ok: true,
    version: SERVICE_VERSION,
    // Intentionally no storagePath: an attacker reading the health endpoint
    // (it has the loosest CORS) shouldn't learn where workspace.json lives on
    // disk. Internal callers that genuinely need the path can read it from
    // the WorkspaceStorage instance directly.
  }));

  app.get("/workspace", async (): Promise<ServiceWorkspaceResponse> => {
    const workspace = await storage.readWorkspace();
    return { workspace, revision: workspace.revision };
  });

  app.get("/projects", async (): Promise<ProjectsResponse> => {
    const workspace = await storage.readWorkspace();
    return {
      projects: workspace.projects,
      ruleSets: workspace.ruleSets,
      updatedAt: workspace.updatedAt,
      revision: workspace.revision,
    };
  });

  app.put<{ Params: { id: string }; Querystring: MutationQuery; Body: UpsertProjectPayload }>(
    "/projects/:id",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] },
        querystring: mutationQuerySchema,
        body: upsertProjectBodySchema,
      },
    },
    async (request, reply) => {
      if (request.params.id !== request.body.project.id) {
        return reply.status(400).send({ code: "PROJECT_ID_MISMATCH", message: "Project id mismatch." });
      }
      try {
        const workspace = await storage.readWorkspace();
        assertGenericProjectWriteAllowed(workspace, request.body.project, request.body.ruleSets ?? []);
        const next = await storage.applyMutation(
          readRevisionGuard(request.body, request.headers["if-match"]),
          forceRequested(request.query),
          (current) => {
            assertGenericProjectWriteAllowed(current, request.body.project, request.body.ruleSets ?? []);
            return applyUpsertProject(current, request.body);
          },
        );
        return mutationResponse(next);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.put<{ Params: { id: string }; Querystring: MutationQuery; Body: SubtreePayload }>(
    "/projects/:id/subtree",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] },
        querystring: mutationQuerySchema,
        body: subtreeBodySchema,
      },
    },
    async (request, reply) => {
      if (request.params.id !== request.body.project.id) {
        return reply.status(400).send({ code: "PROJECT_ID_MISMATCH", message: "Project id mismatch." });
      }
      if (!isAgentManagedProject(request.body.project)) {
        return reply.status(403).send({ code: "AGENT_MANAGED_REQUIRED", message: "Subtree control requires agent-managed ownership." });
      }
      const subtree = {
        project: request.body.project,
        ruleSets: request.body.ruleSets,
        rules: request.body.rules,
      };
      try {
        validateProjectSubtree(await storage.readWorkspace(), subtree);
        const next = await storage.replaceProjectSubtree(
          request.params.id,
          subtree,
          readRevisionGuard(request.body, request.headers["if-match"]),
          forceRequested(request.query),
        );
        return mutationResponse(next);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.post<{ Querystring: MutationQuery; Body: SwitchProjectsPayload }>(
    "/projects/switch",
    {
      schema: { querystring: mutationQuerySchema, body: switchProjectsBodySchema },
    },
    async (request, reply) => {
      try {
        const workspace = await storage.readWorkspace();
        const target = workspace.projects.find((project) => project.id === request.body.projectId);
        if (!target) return reply.status(404).send({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
        if (!isAgentManagedProject(target)) throw new AgentManagedMutationError();
        if (request.body.switchGroup !== undefined && getSwitchGroup(target) !== request.body.switchGroup) {
          return reply.status(409).send({ code: "SWITCH_GROUP_MISMATCH", message: "Target project is not in the requested switch group." });
        }
        const next = await storage.switchProjects(
          request.body,
          readRevisionGuard(request.body, request.headers["if-match"]),
          forceRequested(request.query),
        );
        return mutationResponse(next);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string }; Querystring: MutationQuery }>(
    "/projects/:id/subtree",
    { schema: { params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] }, querystring: mutationQuerySchema } },
    async (request, reply) => {
      try {
        const next = await storage.applyMutation(
          readRevisionGuard({}, request.headers["if-match"]),
          forceRequested(request.query),
          (current) => {
            const project = current.projects.find((candidate) => candidate.id === request.params.id);
            if (!project || !isAgentManagedProject(project)) throw new AgentManagedProjectRequiredError();
            const { workspace, deletions } = planDeleteProject(current, request.params.id);
            return reserveAgentManagedIds(
              workspace,
              deletions.projectIds,
              deletions.ruleSetIds,
              deletions.ruleIds,
              request.params.id,
            );
          },
        );
        return mutationResponse(next);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string }; Querystring: MutationQuery }>(
    "/projects/:id",
    { schema: { params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] }, querystring: mutationQuerySchema } },
    async (request, reply) => {
      try {
        const next = await storage.applyMutation(
          readRevisionGuard({}, request.headers["if-match"]),
          forceRequested(request.query),
          (current) => {
            const project = current.projects.find((candidate) => candidate.id === request.params.id);
            if ((project && isAgentManagedProject(project)) || isReservedProjectId(current, request.params.id)) {
              throw new AgentManagedMutationError();
            }
            return planDeleteProject(current, request.params.id).workspace;
          },
        );
        return mutationResponse(next);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.get<{ Querystring: { kind?: string } }>("/rules", async (request): Promise<RulesResponse> => {
    const workspace = await storage.readWorkspace();
    const rules = request.query.kind
      ? workspace.rules.filter((rule) => rule.kind === request.query.kind)
      : workspace.rules;

    return {
      rules,
      updatedAt: workspace.updatedAt,
      revision: workspace.revision,
    };
  });

  app.put<{ Params: { id: string }; Querystring: MutationQuery; Body: UpsertRulePayload }>(
    "/rules/:id",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] },
        querystring: mutationQuerySchema,
        body: upsertRuleBodySchema,
      },
    },
    async (request, reply) => {
      if (request.params.id !== request.body.rule.id) {
        return reply.status(400).send({ code: "RULE_ID_MISMATCH", message: "Rule id mismatch." });
      }
      try {
        const workspace = await storage.readWorkspace();
        assertGenericRuleWriteAllowed(workspace, request.body);
        const next = await storage.applyMutation(
          readRevisionGuard(request.body, request.headers["if-match"]),
          forceRequested(request.query),
          (current) => {
            assertGenericRuleWriteAllowed(current, request.body);
            return applyUpsertRule(current, request.body);
          },
        );
        return mutationResponse(next);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string }; Querystring: MutationQuery }>(
    "/rules/:id",
    { schema: { params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] }, querystring: mutationQuerySchema } },
    async (request, reply) => {
      try {
        const next = await storage.applyMutation(
          readRevisionGuard({}, request.headers["if-match"]),
          forceRequested(request.query),
          (current) => {
            const agentOwned = current.ruleSets.some((ruleSet) => {
              if (!ruleSet.ruleIds.includes(request.params.id)) return false;
              const project = current.projects.find((candidate) => candidate.id === ruleSet.projectId);
              return Boolean(project && isAgentManagedProject(project));
            });
            if (agentOwned || isReservedRuleId(current, request.params.id)) throw new AgentManagedMutationError();
            return planDeleteRule(current, request.params.id).workspace;
          },
        );
        return mutationResponse(next);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.put<{ Params: { id: string }; Querystring: MutationQuery; Body: RuleSetMutationPayload }>(
    "/rule-sets/:id",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] },
        querystring: mutationQuerySchema,
        body: upsertRuleSetBodySchema,
      },
    },
    async (request, reply) => {
      if (request.params.id !== request.body.ruleSet.id) {
        return reply.status(400).send({ code: "RULE_SET_ID_MISMATCH", message: "Rule set id mismatch." });
      }
      try {
        const workspace = await storage.readWorkspace();
        assertGenericRuleSetWriteAllowed(workspace, request.body.ruleSet);
        const next = await storage.applyMutation(
          readRevisionGuard(request.body, request.headers["if-match"]),
          forceRequested(request.query),
          (current) => {
            assertGenericRuleSetWriteAllowed(current, request.body.ruleSet);
            return applyUpsertRuleSet(current, request.body.ruleSet);
          },
        );
        return mutationResponse(next);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string }; Querystring: MutationQuery }>(
    "/rule-sets/:id",
    { schema: { params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] }, querystring: mutationQuerySchema } },
    async (request, reply) => {
      try {
        const next = await storage.applyMutation(
          readRevisionGuard({}, request.headers["if-match"]),
          forceRequested(request.query),
          (current) => {
            const target = current.ruleSets.find((ruleSet) => ruleSet.id === request.params.id);
            const project = target
              ? current.projects.find((candidate) => candidate.id === target.projectId)
              : undefined;
            if ((project && isAgentManagedProject(project)) || isReservedRuleSetId(current, request.params.id)) {
              throw new AgentManagedMutationError();
            }
            return planDeleteRuleSet(current, request.params.id).workspace;
          },
        );
        return mutationResponse(next);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.post<{ Body: AppliedRevisionPayload }>(
    "/applied",
    { schema: { body: appliedRevisionBodySchema } },
    async (request, reply): Promise<AppliedRevisionResponse | void> => {
      try {
        return await storage.recordAppliedRevision(request.body.revision);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.get("/applied", async (): Promise<AppliedRevisionResponse> => ({
    appliedRevision: await storage.readAppliedRevision(),
  }));

  app.post<{ Body: ForwardRequestPayload }>(
    "/forward",
    {
      schema: { body: forwardRequestBodySchema },
      // /forward is the most expensive route (proxies to a real upstream) and
      // the easiest to accidentally hammer (a misconfigured useEffect can
      // spin out thousands per second). Tightening at the route level keeps
      // dashboard CRUD on the global bucket while throttling the proxy path.
      config: disableRateLimit ? undefined : { rateLimit: forwardRateLimit },
    },
    async (request, reply) => {
      const workspace = await storage.readWorkspace();
      const context = createRequestContext(request.body);
      const startedAt = Date.now();

      // Treat the client-provided matchedRuleId as a hint only. The service is
      // the final boundary, so it must re-check enablement and request matching.
      const hintedBinding =
        request.body.matchedRuleId !== undefined
          ? resolveRuleBinding(workspace, request.body.matchedRuleId)
          : undefined;
      const binding =
        request.body.matchedRuleId !== undefined
          ? hintedBinding && isUsableForwardBinding(hintedBinding, context)
            ? hintedBinding
            : undefined
          : pickMatchingRule(workspace, context, "api_forward");
      if (!binding) {
        const rejectReason = describeForwardRejection(request.body.matchedRuleId, hintedBinding);
        // record() is fire-and-forget; HitLogger batches and persists out of band
        // so we never make the client wait on disk IO to learn we returned 404.
        hitLogger.record({
          requestUrl: request.body.url,
          projectId: undefined,
          ruleSetId: undefined,
          ruleId: "unmatched",
          target: request.body.url,
          durationMs: Date.now() - startedAt,
          outcome: "error",
          errorMessage: rejectReason,
          method: request.body.method,
          resourceType: request.body.resourceType ?? "fetch",
        });
        return reply.status(404).send({ message: rejectReason });
      }

      try {
        const { response, targetUrl } = await forwardThroughRule(binding, request.body);
        hitLogger.record({
          requestUrl: request.body.url,
          projectId: binding.project?.id,
          ruleSetId: binding.ruleSet?.id,
          ruleId: binding.rule.id,
          target: targetUrl,
          durationMs: Date.now() - startedAt,
          outcome: "matched",
          statusCode: response.status,
          method: request.body.method,
          resourceType: request.body.resourceType ?? "fetch",
        });
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Forwarding failed.";
        if (message === STREAMING_UNSUPPORTED) {
          // Tell the extension: don't proxy, retry natively. Logging the hit
          // as `passed` (rather than `error`) keeps the dashboard clean — this
          // is an expected design outcome, not a failure.
          hitLogger.record({
            requestUrl: request.body.url,
            projectId: binding.project?.id,
            ruleSetId: binding.ruleSet?.id,
            ruleId: binding.rule.id,
            target: binding.rule.target.forwardProfile?.targetBaseUrl ?? request.body.url,
            durationMs: Date.now() - startedAt,
            outcome: "passed",
            method: request.body.method,
            resourceType: request.body.resourceType ?? "fetch",
          });
          return reply.status(409).send({
            message: "Upstream response is streaming or too large to buffer; retry natively.",
            code: "stream-unsupported",
          });
        }
        // Log the upstream error at warn so operators can see *why* a 502 was
        // returned without having to grep the JSONL hit log.
        request.log.warn(
          { err: error, ruleId: binding.rule.id, target: binding.rule.target.forwardProfile?.targetBaseUrl },
          "forward failed",
        );
        hitLogger.record({
          requestUrl: request.body.url,
          projectId: binding.project?.id,
          ruleSetId: binding.ruleSet?.id,
          ruleId: binding.rule.id,
          target: binding.rule.target.forwardProfile?.targetBaseUrl ?? request.body.url,
          durationMs: Date.now() - startedAt,
          outcome: "error",
          errorMessage: message,
          method: request.body.method,
          resourceType: request.body.resourceType ?? "fetch",
        });
        return reply.status(502).send({ message });
      }
    },
  );

  app.get<{ Querystring: { limit?: string; projectId?: string } }>(
    "/logs",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string", pattern: "^[0-9]{1,5}$" },
            projectId: { type: "string", maxLength: 200 },
          },
        },
      },
    },
    async (request): Promise<LogsResponse> => {
      // storage.listLogs already clamps to MAX_LOGS_PAGE_SIZE; default to 100
      // for backwards compatibility with the previous handler.
      const parsed = Number.parseInt(request.query.limit ?? "100", 10);
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
      // Wait one tick on pending hit logs so a fresh forwarded request shows
      // up immediately when the user reloads /logs in the dashboard.
      await hitLogger.flush();
      return {
        logs: await storage.listLogs(limit, request.query.projectId),
      };
    },
  );

  app.post<{ Querystring: MutationQuery; Body: ImportWorkspacePayload }>(
    "/import",
    {
      schema: { querystring: mutationQuerySchema, body: importWorkspaceBodySchema },
    },
    async (request, reply) => {
      try {
        const imported = parseWorkspace(request.body.content, request.body.format);
        assertImportedWorkspaceOwnership(await storage.readWorkspace(), imported);
        const next = await storage.applyMutation(
          readRevisionGuard(request.body, request.headers["if-match"]),
          forceRequested(request.query),
          (current) => {
            assertImportedWorkspaceOwnership(current, imported);
            return request.body.merge
              ? mergeUserOwnedSlice(current, imported)
              : replaceUserOwnedWorkspace(current, imported);
          },
        );
        return mutationResponse(next);
      } catch (error) {
        sendMutationError(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { format?: SupportedExportFormat } }>(
    "/export/:projectId",
    async (request, reply) => {
      const format = request.query.format ?? "json";
      const exported = await storage.exportWorkspace(request.params.projectId, format);
      reply.type(format === "json" ? "application/json" : "application/yaml");
      return exported;
    },
  );

  // --- AI-facing analysis endpoints --------------------------------------
  // Read-only and side-effect-free: an agent can pull the request contract,
  // validate a draft rule, and dry-run a match without writing to disk or
  // touching an upstream. All three live inside this scoped plugin, so they
  // inherit the same bearer-token + host-header guards as every non-/health
  // route — no special-casing required.

  app.get("/schema", async (): Promise<SchemaResponse> => ({
    serviceVersion: SERVICE_VERSION,
    schemas: {
      project: projectSchema,
      rule: ruleSchema,
      ruleSet: ruleSetSchema,
      forward: forwardRequestBodySchema,
      import: importWorkspaceBodySchema,
    },
  }));

  app.post<{ Body: UpsertRulePayload }>(
    "/rules/validate",
    { schema: { body: upsertRuleBodySchema } },
    async (request): Promise<ValidateRuleResponse> => {
      // Reuse the upsert body schema so "valid here" implies "upsertable": ajv
      // rejects a structurally broken rule (e.g. missing target) with a 400
      // before we reach this handler. warnings/conflicts are advisory — a sound
      // rule stays valid:true even when they're non-empty.
      const workspace = await storage.readWorkspace();
      const { rule } = request.body;
      return {
        valid: true,
        warnings: collectUnsupportedRuleWarnings(rule),
        conflicts: collectRuleConflicts(workspace, rule),
      };
    },
  );

  app.post<{ Body: MatchRequestPayload }>(
    "/match",
    { schema: { body: matchRequestBodySchema } },
    async (request, reply) => {
      let context: RequestContext;
      try {
        context = createRequestContext({
          url: request.body.url,
          pageUrl: request.body.pageUrl,
          method: request.body.method,
          headers: request.body.headers ?? {},
          tabId: request.body.tabId,
          resourceType: request.body.resourceType,
        });
      } catch {
        // createRequestContext throws on a non-absolute / malformed url; the
        // ajv schema only checks it's a bounded string. Surface the parse
        // failure as a 400 rather than letting it become a 500.
        return reply.status(400).send({ message: `Invalid url: ${request.body.url}` });
      }

      const workspace = await storage.readWorkspace();
      // No kind filter: dry-run both asset_redirect and api_forward selection.
      const binding = pickMatchingRule(workspace, context);

      // Trace EVERY rule (not just enabled ones) with per-condition booleans so
      // a caller can pinpoint exactly why a rule did not fire — the core value
      // of /match for an agent iterating on a draft. Reuses the same matcher
      // primitives selection uses, so the trace can't drift from reality.
      const trace: MatchTraceEntry[] = workspace.rules.map((rule) => {
        const resolved = resolveRuleBinding(workspace, rule.id);
        const hierarchy = Boolean(resolved?.ruleSet && resolved.project);
        const projectScope = hierarchy && context.pageUrl
          ? matchesProjectSite(resolved!.project!, context.pageUrl)
          : hierarchy;
        const ruleSetScope = hierarchy && context.pageUrl
          ? matchesRuleSetSite(resolved!.ruleSet!, resolved!.project!, context.pageUrl)
          : hierarchy;
        const enabled =
          hierarchy &&
          rule.enabled &&
          resolved!.ruleSet!.enabled &&
          resolved!.project!.enabled;
        const conditions = {
          hierarchy,
          projectScope,
          ruleSetScope,
          host: matchesHost(rule.match.host, context.host),
          path: matchesPath(rule.match.pathGlob, context.pathname),
          query: matchesQuery(rule.match, context.query),
          headers: matchesHeaders(rule.match, context.headers),
          method: matchesMethod(rule.match, context.method),
          resourceType: matchesResourceType(rule.match, context.resourceType),
          tabScope: matchesTabScope(rule.match, context.tabId),
        };
        const wouldMatch =
          enabled &&
          conditions.hierarchy &&
          conditions.projectScope &&
          conditions.ruleSetScope &&
          conditions.host &&
          conditions.path &&
          conditions.query &&
          conditions.headers &&
          conditions.method &&
          conditions.resourceType &&
          conditions.tabScope;
        return { ruleId: rule.id, ruleName: rule.name, kind: rule.kind, enabled, conditions, wouldMatch };
      });

      if (!binding) {
        const miss: MatchResponse = { matched: false, trace };
        return miss;
      }

      // Compute the rewritten URL without issuing the request. Wrapped so a
      // malformed forward profile degrades to "no rewrittenUrl" instead of 500.
      let rewrittenUrl: string | undefined;
      try {
        if (binding.rule.kind === "api_forward" && binding.rule.target.forwardProfile) {
          const profile = resolveForwardProfile(binding);
          if (profile?.responsePolicy?.mode === "mock_json") {
            rewrittenUrl = "mock:inline-json";
          } else if (profile?.responsePolicy?.mode === "mock_file") {
            rewrittenUrl = "mock:local-json-file";
          } else {
            rewrittenUrl = profile
              ? buildForwardTargetUrl(profile, new URL(request.body.url)).toString()
              : undefined;
          }
        } else if (binding.rule.kind === "asset_redirect") {
          rewrittenUrl = resolveRuleTargetValue(binding.rule.target.redirectUrl, binding);
        }
      } catch {
        rewrittenUrl = undefined;
      }

      const hit: MatchResponse = {
        matched: true,
        binding: {
          ruleId: binding.rule.id,
          ruleName: binding.rule.name,
          kind: binding.rule.kind,
          projectId: binding.project?.id,
          ruleSetId: binding.ruleSet?.id,
        },
        rewrittenUrl,
        trace,
      };
      return hit;
    },
  );
}

function isUsableForwardBinding(binding: RuleBinding, context: RequestContext): boolean {
  return (
    binding.rule.kind === "api_forward" &&
    binding.rule.enabled &&
    (binding.ruleSet ? binding.ruleSet.enabled : true) &&
    (binding.project ? binding.project.enabled : true) &&
    (!context.pageUrl || !binding.project || matchesProjectSite(binding.project, context.pageUrl)) &&
    (!context.pageUrl ||
      !binding.ruleSet ||
      matchesRuleSetSite(
        binding.ruleSet,
        binding.project ?? { siteHosts: [], siteMatchPatterns: [] },
        context.pageUrl,
      )) &&
    matchesRule(binding.rule, context)
  );
}

function describeForwardRejection(matchedRuleId: string | undefined, hintedBinding: RuleBinding | undefined): string {
  if (matchedRuleId === undefined) {
    return "No matching api_forward rule.";
  }
  if (!hintedBinding) {
    return `matchedRuleId "${matchedRuleId}" not found in service workspace.`;
  }
  return `matchedRuleId "${hintedBinding.rule.id}" exists but is disabled, wrong kind, or no longer matches the request.`;
}

// Lightweight body schemas. We intentionally validate only the structural
// boundaries the service requires — full domain validation already lives in
// rule-core (parseWorkspace / matchesRule). The goal here is to reject grossly
// malformed payloads early so route handlers can rely on basic shape and so
// errors surface as 4xx instead of unhandled TypeErrors.

const stringArray = { type: "array", items: { type: "string" }, default: [] } as const;
const optionalString = { type: "string" } as const;

const projectSchema = {
  type: "object",
  required: ["id", "name", "enabled"],
  properties: {
    id: { type: "string", maxLength: 200 },
    name: { type: "string", maxLength: 500 },
    description: optionalString,
    enabled: { type: "boolean" },
    siteHosts: { type: "array", items: { type: "string" } },
    siteMatchPatterns: { type: "array", items: { type: "string" } },
    baseUrl: optionalString,
    envLabel: optionalString,
    tags: stringArray,
    createdAt: optionalString,
    updatedAt: optionalString,
  },
  additionalProperties: true,
} as const;

const ruleSetSchema = {
  type: "object",
  required: ["id", "projectId", "name", "ruleIds"],
  properties: {
    id: { type: "string", maxLength: 200 },
    projectId: { type: "string", maxLength: 200 },
    name: { type: "string", maxLength: 500 },
    description: optionalString,
    enabled: { type: "boolean" },
    ruleIds: { type: "array", items: { type: "string" } },
    siteMatchPatterns: { type: "array", items: { type: "string" } },
    baseUrl: optionalString,
    createdAt: optionalString,
    updatedAt: optionalString,
  },
  additionalProperties: true,
} as const;

const ruleSchema = {
  type: "object",
  required: ["id", "name", "kind", "match", "target"],
  properties: {
    id: { type: "string", maxLength: 200 },
    name: { type: "string", maxLength: 500 },
    enabled: { type: "boolean" },
    kind: { type: "string", enum: ["asset_redirect", "api_forward"] },
    priority: { type: "number" },
    match: { type: "object" },
    target: { type: "object" },
    notes: optionalString,
    tags: stringArray,
    createdAt: optionalString,
    updatedAt: optionalString,
  },
  additionalProperties: true,
} as const;

const revisionProperty = { type: "integer", minimum: 0 } as const;

const mutationQuerySchema = {
  type: "object",
  properties: { force: { type: "string", enum: ["true", "false"] } },
  additionalProperties: false,
} as const;

const upsertProjectBodySchema = {
  type: "object",
  required: ["project"],
  properties: {
    project: projectSchema,
    ruleSets: { type: "array", items: ruleSetSchema },
    ifRevision: revisionProperty,
  },
  additionalProperties: false,
} as const;

const subtreeBodySchema = {
  type: "object",
  required: ["project", "ruleSets", "rules"],
  properties: {
    project: projectSchema,
    ruleSets: { type: "array", items: ruleSetSchema },
    rules: { type: "array", items: ruleSchema },
    ifRevision: revisionProperty,
  },
  additionalProperties: false,
} as const;

const switchProjectsBodySchema = {
  type: "object",
  required: ["projectId", "enabled"],
  properties: {
    projectId: { type: "string", maxLength: 200 },
    switchGroup: { type: "string", maxLength: 200 },
    enabled: { type: "boolean" },
    ifRevision: revisionProperty,
  },
  additionalProperties: false,
} as const;

const appliedRevisionBodySchema = {
  type: "object",
  required: ["revision"],
  properties: { revision: revisionProperty },
  additionalProperties: false,
} as const;

const upsertRuleBodySchema = {
  type: "object",
  required: ["rule"],
  properties: {
    rule: ruleSchema,
    ruleSetId: { type: "string", maxLength: 200 },
    ifRevision: revisionProperty,
  },
  additionalProperties: false,
} as const;

const upsertRuleSetBodySchema = {
  type: "object",
  required: ["ruleSet"],
  properties: {
    ruleSet: ruleSetSchema,
    ifRevision: revisionProperty,
  },
  additionalProperties: false,
} as const;

const importWorkspaceBodySchema = {
  type: "object",
  required: ["content", "format"],
  properties: {
    content: { type: "string" },
    format: { type: "string", enum: ["json", "yaml"] },
    merge: { type: "boolean", default: false },
    ifRevision: revisionProperty,
  },
  additionalProperties: false,
} as const;

const forwardRequestBodySchema = {
  type: "object",
  required: ["url", "method"],
  properties: {
    url: { type: "string", maxLength: 8192 },
    pageUrl: optionalString,
    method: { type: "string", maxLength: 16 },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: optionalString,
    resourceType: optionalString,
    matchedRuleId: optionalString,
    tabId: { type: ["number", "null"] },
  },
  additionalProperties: true,
} as const;

// Read-only subset of the forward body for POST /match: no `body` (never
// replayed) and resourceType widens to the full MatchResourceType set so
// asset_redirect rules can be dry-run too. additionalProperties:false keeps the
// AI-facing contract tight — a typo'd field is a 400, not a silent no-op.
const matchRequestBodySchema = {
  type: "object",
  required: ["url", "method"],
  properties: {
    url: { type: "string", maxLength: 8192 },
    pageUrl: optionalString,
    method: { type: "string", maxLength: 16 },
    resourceType: {
      type: "string",
      enum: ["script", "stylesheet", "image", "font", "fetch", "xmlhttprequest", "other"],
    },
    tabId: { type: ["number", "null"] },
    headers: { type: "object", additionalProperties: { type: "string" } },
  },
  additionalProperties: false,
} as const;

function resolveLogger(option: BuildLoggerOption | undefined): boolean | { level: string } {
  if (option === false) return false;
  if (option === true || option === undefined) {
    // pino defaults to JSON output, which is what we want for log aggregators.
    // Level resolves from RF_LOG_LEVEL so operators can crank up debug
    // visibility without a code change.
    return { level: process.env.RF_LOG_LEVEL ?? "info" };
  }
  return { level: option.level ?? process.env.RF_LOG_LEVEL ?? "info" };
}

function isAllowedCorsOrigin(origin: string | undefined, extensionId?: string): boolean {
  if (!origin) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    if (parsed.protocol === "chrome-extension:") {
      // When the operator has pinned the extension id, only that extension's
      // origin is trusted. Without a pin, fall back to the historical "any
      // chrome-extension origin" — printing a warning at startup so this isn't
      // a silent downgrade.
      if (!extensionId) return true;
      return parsed.hostname === extensionId;
    }

    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/**
 * The local service binds to 127.0.0.1, but the kernel still serves any DNS
 * name that resolves to 127.0.0.1 (DNS rebinding). Reject anything other than
 * a loopback host header so a malicious page cannot tunnel requests through a
 * rebound name.
 */
function isAllowedHostHeader(hostHeader: string): boolean {
  if (!hostHeader) return false;
  // host header is `<hostname>` or `<hostname>:<port>`. Strip the port for
  // comparison; a literal IPv6 like `[::1]:5178` is also tolerated.
  const colonIndex = hostHeader.lastIndexOf(":");
  const hostname =
    colonIndex > -1 && !hostHeader.includes("]")
      ? hostHeader.slice(0, colonIndex)
      : hostHeader;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}
