import Fastify from "fastify";
import cors from "@fastify/cors";
import type {
  ForwardRequestPayload,
  ImportWorkspacePayload,
  LogsResponse,
  ProjectsResponse,
  RulesResponse,
  ServiceHealthResponse,
  SupportedExportFormat,
  UpsertProjectPayload,
  UpsertRulePayload,
} from "@resource-forwarder/shared-types";
import { collectWorkspaceWarnings, pickMatchingRule } from "@resource-forwarder/rule-core";
import { createRequestContext, forwardThroughRule } from "./proxy.js";
import { WorkspaceStorage } from "./storage.js";

export const SERVICE_VERSION = "0.1.0";

export interface BuildServerOptions {
  storage: WorkspaceStorage;
}

export function buildServer({ storage }: BuildServerOptions) {
  const app = Fastify({ logger: false });

  void app.register(cors, {
    origin: true,
  });

  app.get("/health", async (): Promise<ServiceHealthResponse> => ({
    ok: true,
    version: SERVICE_VERSION,
    storagePath: storage.rootDir,
  }));

  app.get("/projects", async (): Promise<ProjectsResponse> => {
    const workspace = await storage.readWorkspace();
    return {
      projects: workspace.projects,
      ruleSets: workspace.ruleSets,
      updatedAt: workspace.updatedAt,
    };
  });

  app.put<{ Params: { id: string }; Body: UpsertProjectPayload }>("/projects/:id", async (request, reply) => {
    if (request.params.id !== request.body.project.id) {
      return reply.status(400).send({ message: "Project id mismatch." });
    }

    const workspace = await storage.upsertProject(request.body);
    return { workspace, warnings: collectWorkspaceWarnings(workspace) };
  });

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

  app.put<{ Params: { id: string }; Body: UpsertRulePayload }>("/rules/:id", async (request, reply) => {
    if (request.params.id !== request.body.rule.id) {
      return reply.status(400).send({ message: "Rule id mismatch." });
    }

    const workspace = await storage.upsertRule(request.body);
    return { workspace, warnings: collectWorkspaceWarnings(workspace) };
  });

  app.post<{ Body: ForwardRequestPayload }>("/forward", async (request, reply) => {
    const workspace = await storage.readWorkspace();
    const context = createRequestContext(request.body);
    const binding = pickMatchingRule(workspace, context, "api_forward");
    const startedAt = Date.now();

    if (!binding) {
      await storage.appendHit({
        requestUrl: request.body.url,
        projectId: undefined,
        ruleSetId: undefined,
        ruleId: "unmatched",
        target: request.body.url,
        durationMs: Date.now() - startedAt,
        outcome: "error",
        errorMessage: "No matching api_forward rule.",
        method: request.body.method,
        resourceType: request.body.resourceType ?? "fetch",
      });
      return reply.status(404).send({ message: "No matching api_forward rule." });
    }

    try {
      const { response, targetUrl } = await forwardThroughRule(binding, request.body);
      await storage.appendHit({
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
      await storage.appendHit({
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
  });

  app.get<{ Querystring: { limit?: string; projectId?: string } }>("/logs", async (request): Promise<LogsResponse> => {
    const limit = Number.parseInt(request.query.limit ?? "100", 10);
    return {
      logs: await storage.listLogs(limit, request.query.projectId),
    };
  });

  app.post<{ Body: ImportWorkspacePayload }>("/import", async (request) => {
    const workspace = await storage.importWorkspace(request.body);
    return { workspace, warnings: collectWorkspaceWarnings(workspace) };
  });

  app.get<{ Params: { projectId: string }; Querystring: { format?: SupportedExportFormat } }>(
    "/export/:projectId",
    async (request, reply) => {
      const format = request.query.format ?? "json";
      const exported = await storage.exportWorkspace(request.params.projectId, format);
      reply.type(format === "json" ? "application/json" : "application/yaml");
      return exported;
    },
  );

  return app;
}
