import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type {
  ForwardRequestPayload,
  ImportWorkspacePayload,
  LogsResponse,
  ProjectsResponse,
  RequestContext,
  RuleBinding,
  RuleSet,
  RulesResponse,
  ServiceHealthResponse,
  SupportedExportFormat,
  UpsertProjectPayload,
  UpsertRulePayload,
} from "@resource-forwarder/shared-types";
import { collectWorkspaceWarnings, matchesRule, pickMatchingRule, resolveRuleBinding } from "@resource-forwarder/rule-core";
import { createRequestContext, forwardThroughRule, STREAMING_UNSUPPORTED } from "./proxy.js";
import { WorkspaceStorage } from "./storage.js";
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

  app.get("/projects", async (): Promise<ProjectsResponse> => {
    const workspace = await storage.readWorkspace();
    return {
      projects: workspace.projects,
      ruleSets: workspace.ruleSets,
      updatedAt: workspace.updatedAt,
    };
  });

  app.put<{ Params: { id: string }; Body: UpsertProjectPayload }>(
    "/projects/:id",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] },
        body: upsertProjectBodySchema,
      },
    },
    async (request, reply) => {
      if (request.params.id !== request.body.project.id) {
        return reply.status(400).send({ message: "Project id mismatch." });
      }

      const workspace = await storage.upsertProject(request.body);
      return { workspace, warnings: collectWorkspaceWarnings(workspace) };
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
    };
  });

  app.put<{ Params: { id: string }; Body: UpsertRulePayload }>(
    "/rules/:id",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] },
        body: upsertRuleBodySchema,
      },
    },
    async (request, reply) => {
      if (request.params.id !== request.body.rule.id) {
        return reply.status(400).send({ message: "Rule id mismatch." });
      }

      const workspace = await storage.upsertRule(request.body);
      return { workspace, warnings: collectWorkspaceWarnings(workspace) };
    },
  );

  app.put<{ Params: { id: string }; Body: { ruleSet: RuleSet } }>(
    "/rule-sets/:id",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] },
        body: upsertRuleSetBodySchema,
      },
    },
    async (request, reply) => {
      if (request.params.id !== request.body.ruleSet.id) {
        return reply.status(400).send({ message: "Rule set id mismatch." });
      }

      const workspace = await storage.upsertRuleSet(request.body.ruleSet);
      return { workspace, warnings: collectWorkspaceWarnings(workspace) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/rule-sets/:id",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", maxLength: 200 } }, required: ["id"] },
      },
    },
    async (request) => {
      const workspace = await storage.deleteRuleSet(request.params.id);
      return { workspace, warnings: collectWorkspaceWarnings(workspace) };
    },
  );

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

  app.post<{ Body: ImportWorkspacePayload }>(
    "/import",
    {
      schema: { body: importWorkspaceBodySchema },
    },
    async (request) => {
      const workspace = await storage.importWorkspace(request.body);
      return { workspace, warnings: collectWorkspaceWarnings(workspace) };
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
}

function isUsableForwardBinding(binding: RuleBinding, context: RequestContext): boolean {
  return (
    binding.rule.kind === "api_forward" &&
    binding.rule.enabled &&
    (binding.ruleSet ? binding.ruleSet.enabled : true) &&
    (binding.project ? binding.project.enabled : true) &&
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

const upsertProjectBodySchema = {
  type: "object",
  required: ["project"],
  properties: {
    project: projectSchema,
    ruleSets: { type: "array", items: ruleSetSchema },
  },
  additionalProperties: false,
} as const;

const upsertRuleBodySchema = {
  type: "object",
  required: ["rule"],
  properties: {
    rule: ruleSchema,
    ruleSetId: { type: "string", maxLength: 200 },
  },
  additionalProperties: false,
} as const;

const upsertRuleSetBodySchema = {
  type: "object",
  required: ["ruleSet"],
  properties: {
    ruleSet: ruleSetSchema,
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
  },
  additionalProperties: false,
} as const;

const forwardRequestBodySchema = {
  type: "object",
  required: ["url", "method"],
  properties: {
    url: { type: "string", maxLength: 8192 },
    method: { type: "string", maxLength: 16 },
    headers: { type: "object", additionalProperties: { type: "string" } },
    body: optionalString,
    resourceType: optionalString,
    matchedRuleId: optionalString,
    tabId: { type: ["number", "null"] },
  },
  additionalProperties: true,
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
