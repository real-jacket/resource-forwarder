#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AppliedRevisionResponse,
  MatchResourceType,
  MatchResponse,
  MutationResponse,
  Project,
  ProjectSubtree,
  RequestContext,
  Rule,
  RuleSet,
  ServiceHealthResponse,
  ServiceWorkspaceResponse,
  SubtreePayload,
  SwitchProjectsPayload,
  ValidateRuleResponse,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import {
  collectRuleConflicts,
  deriveSiteHosts,
  getSwitchGroup,
  isAgentManagedProject,
  pickMatchingRule,
  projectSubtree,
  replaceProjectSubtree,
  resolveRuleBinding,
  toDynamicRule,
  validateProjectSubtree,
} from "@resource-forwarder/rule-core";
import { parse as parseYaml } from "yaml";
import { resolveStorageRoot } from "./defaults.js";

interface CliEnvironment {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface CliOutput {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

interface AgentSubtreeInput {
  project: Project;
  ruleSets: RuleSet[];
  rules: Rule[];
}

class CliHttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(typeof body.message === "string" ? body.message : `Service request failed with ${status}.`);
    this.name = "CliHttpError";
  }
}

class CliClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(new URL(path, this.baseUrl), { ...init, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new CliHttpError(response.status, body as Record<string, unknown>);
    return body as T;
  }

  async workspace(): Promise<WorkspaceSnapshot> {
    const response = await this.request<ServiceWorkspaceResponse>("/workspace");
    return response.workspace;
  }
}

export async function runCli(argv = process.argv.slice(2), options: CliEnvironment = {}): Promise<number> {
  const output: CliOutput = {
    stdout: options.stdout ?? ((text) => process.stdout.write(text)),
    stderr: options.stderr ?? ((text) => process.stderr.write(text)),
  };
  try {
    const args = parseArgs(argv);
    const env = options.env ?? process.env;
    const storageRoot = env.RF_STORAGE_ROOT ?? resolveStorageRoot();
    const token = (await readFile(join(storageRoot, "token"), "utf8")).trim();
    if (!token) throw new Error(`Missing bearer token at ${join(storageRoot, "token")}.`);
    const port = env.PORT ?? "5178";
    const client = new CliClient(`http://127.0.0.1:${port}`, token, options.fetchImpl ?? fetch);
    const command = args.positionals.join(" ");
    if (args.positionals[0] === "service" && args.positionals[1] === "status") {
      return await runServiceStatus(client, args, output);
    }
    if (args.positionals[0] === "workspace" && args.positionals[1] === "get") {
      return await runWorkspaceGet(client, args, output);
    }
    if (args.positionals[0] === "project") {
      return await runProjectCommand(client, args, output, options.sleep);
    }
    if (args.positionals[0] === "rule") {
      return await runRuleCommand(client, args, output);
    }
    if (args.positionals[0] === "wait-applied") {
      return await runWaitApplied(client, args, output, options.sleep);
    }
    throw new Error(`Unknown command: ${command || "(none)"}.`);
  } catch (error) {
    output.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function runServiceStatus(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const health = await client.request<ServiceHealthResponse>("/health");
  printResult(args, output, health, `service ${health.ok ? "ok" : "unhealthy"} (${health.version})`);
  return 0;
}

async function runWorkspaceGet(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const workspace = await client.workspace();
  printResult(args, output, { workspace, revision: workspace.revision }, `revision ${workspace.revision}`);
  return 0;
}

async function runProjectCommand(
  client: CliClient,
  args: ParsedArgs,
  output: CliOutput,
  sleepOverride?: (milliseconds: number) => Promise<void>,
): Promise<number> {
  const action = args.positionals[1];
  if (action === "list") return runProjectList(client, args, output);
  if (action === "up") return runProjectUp(client, args, output);
  if (action === "enable" || action === "disable") return runProjectEnable(client, args, output, action === "enable");
  if (action === "switch") return runProjectSwitch(client, args, output);
  if (action === "down") return runProjectDown(client, args, output);
  if (action === undefined) throw new Error("Missing project subcommand.");
  void sleepOverride;
  throw new Error(`Unknown project command: ${action}.`);
}

async function runProjectList(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const workspace = await client.workspace();
  const projects = workspace.projects.map((project) => ({
    id: project.id,
    name: project.name,
    ownership: isAgentManagedProject(project) ? "agent-managed" : "user-owned",
    enabled: project.enabled,
    switchGroup: getSwitchGroup(project),
  }));
  printResult(args, output, { revision: workspace.revision, projects }, projects.map((item) => `${item.name}\t${item.ownership}\t${item.enabled ? "enabled" : "disabled"}${item.switchGroup ? `\t${item.switchGroup}` : ""}`).join("\n"));
  return 0;
}

async function runProjectUp(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const name = requiredOption(args, "name");
  const site = requiredOption(args, "site");
  const devPort = parsePort(requiredOption(args, "dev-port"));
  const assets = optionValues(args, "asset").map(parseAssetSpec);
  const force = args.flags.has("force");
  let workspace = await client.workspace();
  let printedDryRun = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = workspace.projects.find((project) => project.name === name);
    if (existing && !isAgentManagedProject(existing)) {
      throw new Error(`Project "${name}" is user-owned; ownership transfer requires delete/recreate.`);
    }
    const subtree = buildAgentSubtree(name, site, devPort, assets, args, existing);
    validateProjectSubtree(workspace, subtree);
    const candidate = replaceProjectSubtree(workspace, subtree);
    if (!printedDryRun) {
      printedDryRun = true;
      output.stdout(`dry-run revision ${workspace.revision}: ${candidate.rules.length} asset rules\n`);
      for (const rule of candidate.rules) {
        output.stdout(`${JSON.stringify(toDynamicRule(rule, candidate.projects.find((project) => project.id === subtree.project.id)?.siteHosts))}\n`);
      }
    }
    for (const rule of subtree.rules) {
      const validation = await client.request<ValidateRuleResponse>("/rules/validate", {
        method: "POST",
        body: JSON.stringify({ rule }),
      });
      if (validation.warnings.length > 0 || validation.conflicts.length > 0) {
        output.stdout(`validation ${rule.id}: ${JSON.stringify({ warnings: validation.warnings, conflicts: validation.conflicts })}\n`);
      }
    }

    try {
      const response = await guardedMutation<MutationResponse>(client, `/projects/${encodeURIComponent(subtree.project.id)}/subtree`, "PUT", (revision: number) => ({
        ...subtree,
        ...(force ? {} : { ifRevision: revision }),
      } satisfies SubtreePayload), force, workspace.revision);
      printResult(args, output, response, `project ${name} persisted at revision ${response.revision}`);
      return 0;
    } catch (error) {
      if (!(error instanceof CliHttpError) || error.status !== 409 || attempt > 0) throw error;
      workspace = await client.workspace();
    }
  }
  throw new Error("project up retry exhausted.");
}

async function runProjectEnable(client: CliClient, args: ParsedArgs, output: CliOutput, enabled: boolean): Promise<number> {
  const name = requiredPositional(args, 2);
  const force = args.flags.has("force");
  let workspace = await client.workspace();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const project = workspace.projects.find((candidate) => candidate.name === name);
    if (!project) throw new Error(`Project "${name}" not found.`);
    if (!isAgentManagedProject(project)) throw new Error(`Project "${name}" is user-owned.`);
    const subtree = projectSubtree(workspace, project.id);
    const payload: ProjectSubtree = { ...subtree, project: { ...subtree.project, enabled } };
    try {
      const response = await guardedMutation<MutationResponse>(client, `/projects/${encodeURIComponent(project.id)}/subtree`, "PUT", (revision: number) => ({
        ...payload,
        ...(force ? {} : { ifRevision: revision }),
      } satisfies SubtreePayload), force, workspace.revision);
      printResult(args, output, response, `${name} ${enabled ? "enabled" : "disabled"} at revision ${response.revision}`);
      return 0;
    } catch (error) {
      if (!(error instanceof CliHttpError) || error.status !== 409 || attempt > 0) throw error;
      workspace = await client.workspace();
    }
  }
  throw new Error("project enable/disable retry exhausted.");
}

async function runProjectSwitch(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const name = requiredPositional(args, 2);
  const force = args.flags.has("force");
  let workspace = await client.workspace();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const project = workspace.projects.find((candidate) => candidate.name === name);
    if (!project) throw new Error(`Project "${name}" not found.`);
    if (!isAgentManagedProject(project)) throw new Error(`Project "${name}" is user-owned.`);
    const payload: SwitchProjectsPayload = {
      projectId: project.id,
      switchGroup: getSwitchGroup(project),
      enabled: true,
      ...(force ? {} : { ifRevision: workspace.revision }),
    };
    try {
      const response = await client.request<MutationResponse>(withForce(`/projects/switch`, force), {
        method: "POST",
        headers: force ? undefined : { "if-match": String(workspace.revision) },
        body: JSON.stringify(payload),
      });
      printResult(args, output, response, `${name} switched at revision ${response.revision}`);
      return 0;
    } catch (error) {
      if (!(error instanceof CliHttpError) || error.status !== 409 || attempt > 0) throw error;
      workspace = await client.workspace();
    }
  }
  throw new Error("project switch retry exhausted.");
}

async function runProjectDown(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const name = requiredPositional(args, 2);
  const force = args.flags.has("force");
  let workspace = await client.workspace();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const project = workspace.projects.find((candidate) => candidate.name === name);
    if (!project) throw new Error(`Project "${name}" not found.`);
    if (!isAgentManagedProject(project)) throw new Error(`Project "${name}" is user-owned.`);
    try {
      const response = await guardedMutation<MutationResponse>(client, `/projects/${encodeURIComponent(project.id)}`, "DELETE", () => undefined, force, workspace.revision);
      printResult(args, output, response, `${name} deleted at revision ${response.revision}`);
      return 0;
    } catch (error) {
      if (!(error instanceof CliHttpError) || error.status !== 409 || attempt > 0) throw error;
      workspace = await client.workspace();
    }
  }
  throw new Error("project down retry exhausted.");
}

async function runRuleCommand(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const action = args.positionals[1];
  if (action === "list") return runRuleList(client, args, output);
  if (action === "validate") return runRuleValidate(client, args, output);
  if (action === "match") return runRuleMatch(client, args, output);
  if (action === "add") return runRuleAdd(client, args, output);
  throw new Error(`Unknown rule command: ${action ?? "(none)"}.`);
}

async function runRuleList(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const workspace = await client.workspace();
  const projectId = option(args, "project");
  const rows = workspace.rules
    .map((rule) => ({ rule, binding: resolveRuleBinding(workspace, rule.id) }))
    .filter(({ binding }) => !projectId || binding?.project?.id === projectId)
    .map(({ rule, binding }) => ({
      id: rule.id,
      name: rule.name,
      kind: rule.kind,
      projectId: binding?.project?.id,
      ruleSetId: binding?.ruleSet?.id,
      ownership: binding?.project && isAgentManagedProject(binding.project) ? "agent-managed" : "user-owned",
    }));
  printResult(args, output, { revision: workspace.revision, rules: rows }, rows.map((row) => `${row.id}\t${row.ownership}\t${row.name}`).join("\n"));
  return 0;
}

async function runRuleValidate(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const rule = await readRuleFile(requiredOption(args, "file"));
  assertRuleShape(rule);
  const localWorkspace = await client.workspace();
  const response = await client.request<ValidateRuleResponse>("/rules/validate", { method: "POST", body: JSON.stringify({ rule }) });
  const local = { warnings: [], conflicts: collectRuleConflicts(localWorkspace, rule) };
  printResult(args, output, { ...response, local }, `valid=${response.valid} warnings=${response.warnings.length} conflicts=${response.conflicts.length}`);
  return response.valid ? 0 : 1;
}

async function runRuleMatch(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const workspace = await client.workspace();
  const url = requiredOption(args, "url");
  const method = option(args, "method") ?? "GET";
  const resourceType = (option(args, "resource-type") ?? "fetch") as MatchResourceType;
  const parsed = new URL(url);
  const context: RequestContext = {
    url,
    pageUrl: option(args, "page-url"),
    method,
    host: parsed.hostname,
    pathname: parsed.pathname,
    query: Object.fromEntries([...parsed.searchParams.keys()].map((key) => [key, parsed.searchParams.getAll(key)])),
    resourceType,
    headers: {},
  };
  const binding = pickMatchingRule(workspace, context);
  const response: MatchResponse = binding
    ? { matched: true, binding: { ruleId: binding.rule.id, ruleName: binding.rule.name, kind: binding.rule.kind, projectId: binding.project?.id, ruleSetId: binding.ruleSet?.id }, trace: [] }
    : { matched: false, trace: [] };
  printResult(args, output, response, binding ? `matched ${binding.rule.id}` : "unmatched");
  return binding ? 0 : 1;
}

async function runRuleAdd(client: CliClient, args: ParsedArgs, output: CliOutput): Promise<number> {
  const projectId = requiredOption(args, "project");
  const ruleSetId = requiredOption(args, "ruleset");
  const rule = await readRuleFile(requiredOption(args, "file"));
  assertRuleShape(rule);
  let workspace = await client.workspace();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const project = workspace.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project "${projectId}" not found.`);
    if (isAgentManagedProject(project)) throw new Error("Generic rule add cannot edit agent-managed projects.");
    try {
      const response = await guardedMutation<MutationResponse>(client, `/rules/${encodeURIComponent(rule.id)}`, "PUT", (revision: number) => ({ rule, ruleSetId, ifRevision: revision }), args.flags.has("force"), workspace.revision);
      printResult(args, output, response, `rule ${rule.id} persisted at revision ${response.revision}`);
      return 0;
    } catch (error) {
      if (!(error instanceof CliHttpError) || error.status !== 409 || attempt > 0) throw error;
      workspace = await client.workspace();
    }
  }
  throw new Error("rule add retry exhausted.");
}

async function runWaitApplied(
  client: CliClient,
  args: ParsedArgs,
  output: CliOutput,
  sleepOverride?: (milliseconds: number) => Promise<void>,
): Promise<number> {
  const timeout = parseDuration(option(args, "timeout") ?? "30000");
  const sleep = sleepOverride ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const writtenRevision = (await client.workspace()).revision;
  const started = Date.now();
  while (Date.now() - started <= timeout) {
    const applied = await client.request<AppliedRevisionResponse>("/applied");
    if (applied.appliedRevision >= writtenRevision) {
      printResult(args, output, applied, `applied revision ${applied.appliedRevision}`);
      return 0;
    }
    await sleep(Math.min(100, Math.max(1, timeout - (Date.now() - started))));
  }
  output.stderr("persisted but not browser-applied\n");
  return 1;
}

type MutationBody = unknown | ((revision: number) => unknown);

async function guardedMutation<T extends MutationResponse>(
  client: CliClient,
  path: string,
  method: string,
  bodyFactory: MutationBody,
  force: boolean,
  revision?: number,
): Promise<T> {
  const currentRevision = revision ?? (await client.workspace()).revision;
  const body = typeof bodyFactory === "function" ? bodyFactory(currentRevision) : bodyFactory;
  const target = withForce(path, force);
  const headers = force ? undefined : { "if-match": String(currentRevision) };
  return client.request<T>(target, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function buildAgentSubtree(
  name: string,
  site: string,
  devPort: number,
  assets: Array<{ urlGlob: string; devPath: string }>,
  args: ParsedArgs,
  existing?: Project,
): AgentSubtreeInput {
  const now = new Date().toISOString();
  const slug = slugify(name);
  const stablePrefix = `agent-${slug}-${stableNameHash(name)}`;
  const projectId = existing?.id ?? stablePrefix;
  const sitePattern = site.includes("://") || site.includes("*") ? site : `https://${site}/*`;
  const switchGroup = option(args, "switch-group") ?? (existing ? getSwitchGroup(existing) : undefined);
  const tags = ["agent-managed", ...(switchGroup ? [`switch-group:${switchGroup}`] : [])];
  const rules = assets.map((asset, index) => buildAssetRule(asset, projectId, stablePrefix, index, devPort, sitePattern, now));
  const ruleSetId = `${stablePrefix}-rules`;
  return {
    project: {
      id: projectId,
      name,
      enabled: args.flags.has("enable") || existing?.enabled === true,
      siteHosts: deriveSiteHosts([sitePattern]),
      siteMatchPatterns: [sitePattern],
      baseUrl: `http://127.0.0.1:${devPort}`,
      tags,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
    ruleSets: [{
      id: ruleSetId,
      projectId,
      name: `${name} agent rules`,
      enabled: true,
      ruleIds: rules.map((rule) => rule.id),
      createdAt: now,
      updatedAt: now,
    }],
    rules,
  };
}

function buildAssetRule(
  asset: { urlGlob: string; devPath: string },
  projectId: string,
  stablePrefix: string,
  index: number,
  devPort: number,
  sitePattern: string,
  now: string,
): Rule {
  const url = new URL(asset.urlGlob.replace(/\*/g, "asset"));
  const pathGlob = url.pathname.replace(/asset/g, "*");
  return {
    id: `${stablePrefix}-asset-${index}`,
    name: `asset ${index + 1}: ${asset.urlGlob}`,
    enabled: true,
    kind: "asset_redirect",
    priority: 100,
    match: {
      host: [url.hostname],
      pathGlob,
      resourceType: resourceTypesForPath(pathGlob),
      tabScope: { mode: "all" },
    },
    target: { redirectUrl: `http://127.0.0.1:${devPort}${asset.devPath.startsWith("/") ? asset.devPath : `/${asset.devPath}`}` },
    note: `agent project ${projectId} for ${sitePattern}`,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

function resourceTypesForPath(path: string): MatchResourceType[] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".css")) return ["stylesheet"];
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return ["image"];
  if (/\.(woff2?|ttf|otf|eot)$/.test(lower)) return ["font"];
  return ["script"];
}

async function readRuleFile(path: string): Promise<Rule> {
  const content = await readFile(path, "utf8");
  const parsed = content.trim().startsWith("{") ? JSON.parse(content) : parseYaml(content);
  const candidate = parsed && typeof parsed === "object" && "rule" in parsed ? parsed.rule : parsed;
  return candidate as Rule;
}

function assertRuleShape(rule: Rule): void {
  if (!rule || typeof rule !== "object" || typeof rule.id !== "string" || typeof rule.name !== "string" || !rule.match || !rule.target) {
    throw new Error("Rule file must contain id, name, match, and target.");
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > -1) {
      const key = token.slice(2, equals);
      addOption(values, key, token.slice(equals + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      addOption(values, key, next);
      index += 1;
    } else {
      flags.add(key);
    }
  }
  return { positionals, values, flags };
}

function addOption(values: Map<string, string[]>, key: string, value: string): void {
  const current = values.get(key) ?? [];
  current.push(value);
  values.set(key, current);
}

function option(args: ParsedArgs, key: string): string | undefined {
  return args.values.get(key)?.at(-1);
}

function stableNameHash(name: string): string {
  return createHash("sha256").update(name, "utf8").digest("hex").slice(0, 12);
}
function optionValues(args: ParsedArgs, key: string): string[] {
  return args.values.get(key) ?? [];
}

function requiredOption(args: ParsedArgs, key: string): string {
  const value = option(args, key);
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}

function requiredPositional(args: ParsedArgs, index: number): string {
  const value = args.positionals[index];
  if (!value) throw new Error("Missing command argument.");
  return value;
}

function parseAssetSpec(value: string): { urlGlob: string; devPath: string } {
  const separator = value.indexOf("=>");
  if (separator < 1) throw new Error(`Invalid --asset "${value}"; expected <urlGlob> => <devPath>.`);
  return { urlGlob: value.slice(0, separator).trim(), devPath: value.slice(separator + 2).trim() };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid dev port: ${value}.`);
  return port;
}

function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) throw new Error(`Invalid timeout: ${value}.`);
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "ms";
  return unit === "m" ? amount * 60_000 : unit === "s" ? amount * 1_000 : amount;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

function withForce(path: string, force: boolean): string {
  return force ? `${path}${path.includes("?") ? "&" : "?"}force=true` : path;
}

function printResult(args: ParsedArgs, output: CliOutput, value: unknown, human: string): void {
  if (args.flags.has("json")) output.stdout(`${JSON.stringify(value, null, 2)}\n`);
  else output.stdout(`${human}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runCli().then((code) => {
    process.exitCode = code;
  });
}
