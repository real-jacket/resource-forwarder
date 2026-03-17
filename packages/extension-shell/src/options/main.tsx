import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { collectRuleConflicts, collectUnsupportedRuleWarnings } from "@resource-forwarder/rule-core";
import type { Project, Rule, RuleSet, WorkspaceSnapshot } from "@resource-forwarder/shared-types";
import { createId, joinCsv, splitCsv } from "../shared/helpers.js";
import type { DashboardState, GetDashboardStateResponse, SyncWorkspaceResponse, UpsertMutationResponse } from "../shared/messages.js";
import { runtimeRequest } from "../shared/messages.js";

type ProjectDraft = {
  id: string;
  name: string;
  siteHosts: string;
  envLabel: string;
  note: string;
  enabled: boolean;
};

type RuleDraft = {
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
};

const emptyProjectDraft: ProjectDraft = {
  id: "",
  name: "",
  siteHosts: "",
  envLabel: "",
  note: "",
  enabled: true,
};

function createEmptyRuleDraft(workspace?: WorkspaceSnapshot): RuleDraft {
  const defaultRuleSet = workspace?.ruleSets[0];
  return {
    id: "",
    ruleSetId: defaultRuleSet?.id ?? "",
    name: "",
    kind: "api_forward",
    enabled: true,
    priority: 100,
    host: defaultRuleSet ? joinCsv(workspace?.projects.find((project) => project.id === defaultRuleSet.projectId)?.siteHosts) : "",
    pathGlob: "/api/**",
    resourceType: "fetch, xmlhttprequest",
    method: "GET, POST",
    redirectUrl: "",
    targetBaseUrl: "",
    stripPrefix: "",
    headersJson: "{}",
    tags: "",
    note: "",
  };
}

function App() {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>(emptyProjectDraft);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(createEmptyRuleDraft());
  const [serviceUrl, setServiceUrl] = useState("");
  const [importText, setImportText] = useState("");
  const [exportText, setExportText] = useState("");
  const [exportFormat, setExportFormat] = useState<"json" | "yaml">("yaml");
  const [status, setStatus] = useState<string>("Loading workspace...");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  const activeRuleSet = useMemo(
    () => dashboard?.workspace.ruleSets.find((ruleSet) => ruleSet.id === ruleDraft.ruleSetId),
    [dashboard, ruleDraft.ruleSetId],
  );

  const draftRule = useMemo(() => {
    if (!dashboard) {
      return null;
    }
    try {
      return toRule(ruleDraft, dashboard.workspace);
    } catch {
      return null;
    }
  }, [dashboard, ruleDraft]);

  const conflictPreview = useMemo(() => {
    if (!dashboard || !draftRule) {
      return [];
    }
    return collectRuleConflicts(dashboard.workspace, draftRule);
  }, [dashboard, draftRule]);

  const ruleWarnings = useMemo(() => (draftRule ? collectUnsupportedRuleWarnings(draftRule) : []), [draftRule]);

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      const state = await runtimeRequest<GetDashboardStateResponse>({ type: "get-dashboard-state" });
      hydrateDashboard(state);
      setStatus("Workspace synced.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load workspace.");
    } finally {
      setBusy(false);
    }
  }

  function hydrateDashboard(state: DashboardState): void {
    setDashboard(state);
    setServiceUrl(state.serviceUrl);
    setRuleDraft((current) => {
      if (current.ruleSetId) {
        return current;
      }
      return createEmptyRuleDraft(state.workspace);
    });
  }

  async function saveServiceUrl(): Promise<void> {
    setBusy(true);
    try {
      const state = await runtimeRequest<SyncWorkspaceResponse>({ type: "set-service-url", serviceUrl });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setStatus(`Service URL updated to ${serviceUrl}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to update service URL.");
    } finally {
      setBusy(false);
    }
  }

  async function saveProject(): Promise<void> {
    if (!projectDraft.name.trim()) {
      setStatus("Project name is required.");
      return;
    }
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const projectId = projectDraft.id || createId("project");
      const existingRuleSet = dashboard?.workspace.ruleSets.find((ruleSet) => ruleSet.projectId === projectId);
      const payload = {
        project: {
          id: projectId,
          name: projectDraft.name.trim(),
          enabled: projectDraft.enabled,
          siteHosts: splitCsv(projectDraft.siteHosts),
          envLabel: projectDraft.envLabel.trim() || undefined,
          note: projectDraft.note.trim() || undefined,
          tags: [],
          createdAt: findProject(dashboard?.workspace.projects, projectId)?.createdAt ?? now,
          updatedAt: now,
        },
        ruleSets: [
          existingRuleSet ?? {
            id: createId("ruleset"),
            projectId,
            name: `${projectDraft.name.trim()} default`,
            enabled: true,
            ruleIds: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      const state = await runtimeRequest<UpsertMutationResponse>({ type: "upsert-project", payload });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setProjectDraft(emptyProjectDraft);
      setStatus(`Saved project ${payload.project.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save project.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRule(): Promise<void> {
    if (!dashboard) {
      return;
    }
    setBusy(true);
    try {
      const rule = toRule(ruleDraft, dashboard.workspace);
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-rule",
        payload: {
          rule,
          ruleSetId: ruleDraft.ruleSetId,
        },
      });
      hydrateDashboard({ ...state, logs: dashboard.logs, currentTab: dashboard.currentTab });
      setRuleDraft(createEmptyRuleDraft(state.workspace));
      setStatus(`Saved rule ${rule.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save rule.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleProject(project: Project): Promise<void> {
    setBusy(true);
    try {
      const ruleSets = dashboard?.workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === project.id) ?? [];
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-project",
        payload: {
          project: { ...project, enabled: !project.enabled },
          ruleSets,
        },
      });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setStatus(`${project.name} ${project.enabled ? "disabled" : "enabled"}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to toggle project.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(rule: Rule): Promise<void> {
    setBusy(true);
    try {
      const owningRuleSet = dashboard?.workspace.ruleSets.find((ruleSet) => ruleSet.ruleIds.includes(rule.id));
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-rule",
        payload: {
          rule: { ...rule, enabled: !rule.enabled },
          ruleSetId: owningRuleSet?.id,
        },
      });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setStatus(`${rule.name} ${rule.enabled ? "disabled" : "enabled"}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to toggle rule.");
    } finally {
      setBusy(false);
    }
  }

  async function importWorkspace(merge: boolean): Promise<void> {
    if (!importText.trim()) {
      setStatus("Paste JSON or YAML before importing.");
      return;
    }
    setBusy(true);
    try {
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "import-workspace",
        payload: {
          content: importText,
          format: importText.trim().startsWith("{") ? "json" : "yaml",
          merge,
        },
      });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setStatus(merge ? "Merged workspace import." : "Replaced workspace from import.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to import workspace.");
    } finally {
      setBusy(false);
    }
  }

  async function exportWorkspace(projectId: string): Promise<void> {
    setBusy(true);
    try {
      const response = await runtimeRequest<{ format: "json" | "yaml"; content: string }>({
        type: "export-workspace",
        projectId,
        format: exportFormat,
      });
      setExportText(response.content);
      setStatus(`Exported project ${projectId} as ${response.format}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to export workspace.");
    } finally {
      setBusy(false);
    }
  }

  const projects = dashboard?.workspace.projects ?? [];
  const rules = dashboard?.workspace.rules ?? [];
  const warnings = dashboard?.warnings ?? [];

  return (
    <div className="app-shell">
      <section className="hero">
        <div className="row between">
          <div className="stack">
            <span className="kicker">Resource Forwarder</span>
            <h1>Manage redirect and API forwarding rules without Chrome debugger mode.</h1>
            <p>
              Assets use dynamic DNR redirects. API calls are proxied through the local service, which keeps rule storage,
              logs and import/export behavior in one place.
            </p>
          </div>
          <button className="secondary" onClick={() => void refresh()} disabled={busy}>
            Sync now
          </button>
        </div>
        <div className="row">
          <span className={`badge ${dashboard?.health ? "" : "danger"}`}>
            {dashboard?.health ? `Service ok (${dashboard.health.version})` : "Service unavailable"}
          </span>
          <span className="badge">Projects {projects.length}</span>
          <span className="badge">Rules {rules.length}</span>
          {warnings.length > 0 ? <span className="badge warning">Warnings {warnings.length}</span> : null}
        </div>
        <div className="row">
          <input value={serviceUrl} onChange={(event) => setServiceUrl(event.target.value)} placeholder="http://127.0.0.1:5178" />
          <button onClick={() => void saveServiceUrl()} disabled={busy}>
            Save service URL
          </button>
        </div>
        <p className="small">{status}</p>
      </section>

      <section className="grid two">
        <div className="card">
          <div className="row between">
            <h2>Projects</h2>
            <span className="muted small">One project can own multiple rule sets, but v1 defaults to a single set.</span>
          </div>
          <div className="list">
            {projects.map((project) => (
              <article className="item" key={project.id}>
                <div className="item-header">
                  <div className="stack">
                    <h4>{project.name}</h4>
                    <p className="small">{joinCsv(project.siteHosts) || "No hosts yet"}</p>
                  </div>
                  <div className="row">
                    <button className="ghost" onClick={() => setProjectDraft(fromProject(project))}>
                      Edit
                    </button>
                    <button className="secondary" onClick={() => void exportWorkspace(project.id)}>
                      Export
                    </button>
                    <button onClick={() => void toggleProject(project)}>{project.enabled ? "Disable" : "Enable"}</button>
                  </div>
                </div>
              </article>
            ))}
            {projects.length === 0 ? <p className="muted">Create your first project to scope rules by site host.</p> : null}
          </div>
          <div className="grid two">
            <label className="stack">
              <span className="label">Project name</span>
              <input value={projectDraft.name} onChange={(event) => setProjectDraft((value) => ({ ...value, name: event.target.value }))} />
            </label>
            <label className="stack">
              <span className="label">Environment label</span>
              <input value={projectDraft.envLabel} onChange={(event) => setProjectDraft((value) => ({ ...value, envLabel: event.target.value }))} placeholder="staging" />
            </label>
          </div>
          <label className="stack">
            <span className="label">Site hosts</span>
            <input value={projectDraft.siteHosts} onChange={(event) => setProjectDraft((value) => ({ ...value, siteHosts: event.target.value }))} placeholder="app.example.com, admin.example.com" />
          </label>
          <label className="stack">
            <span className="label">Note</span>
            <textarea value={projectDraft.note} onChange={(event) => setProjectDraft((value) => ({ ...value, note: event.target.value }))} />
          </label>
          <div className="row between">
            <label className="row">
              <input type="checkbox" checked={projectDraft.enabled} onChange={(event) => setProjectDraft((value) => ({ ...value, enabled: event.target.checked }))} />
              Enabled by default
            </label>
            <div className="row">
              <button className="ghost" onClick={() => setProjectDraft(emptyProjectDraft)}>
                Reset
              </button>
              <button onClick={() => void saveProject()} disabled={busy}>
                Save project
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="row between">
            <h2>Rules</h2>
            <span className="muted small">Priority wins first; equal priority falls back to creation order.</span>
          </div>
          <div className="list">
            {rules.map((rule) => (
              <article className="item" key={rule.id}>
                <div className="item-header">
                  <div className="stack">
                    <h4>{rule.name}</h4>
                    <p className="small">
                      {rule.kind} · {joinCsv(rule.match.host)} · {rule.match.pathGlob}
                    </p>
                  </div>
                  <div className="row">
                    <button className="ghost" onClick={() => setRuleDraft(fromRule(rule, dashboard?.workspace.ruleSets ?? []))}>
                      Edit
                    </button>
                    <button onClick={() => void toggleRule(rule)}>{rule.enabled ? "Disable" : "Enable"}</button>
                  </div>
                </div>
              </article>
            ))}
            {rules.length === 0 ? <p className="muted">No rules yet. Start with an API forward or HTTPS asset redirect.</p> : null}
          </div>
          <div className="grid two">
            <label className="stack">
              <span className="label">Rule set</span>
              <select value={ruleDraft.ruleSetId} onChange={(event) => setRuleDraft((value) => ({ ...value, ruleSetId: event.target.value }))}>
                <option value="">Select rule set</option>
                {(dashboard?.workspace.ruleSets ?? []).map((ruleSet) => (
                  <option key={ruleSet.id} value={ruleSet.id}>
                    {ruleSet.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack">
              <span className="label">Rule kind</span>
              <select value={ruleDraft.kind} onChange={(event) => setRuleDraft((value) => ({ ...value, kind: event.target.value as Rule["kind"] }))}>
                <option value="api_forward">api_forward</option>
                <option value="asset_redirect">asset_redirect</option>
              </select>
            </label>
          </div>
          <div className="grid two">
            <label className="stack">
              <span className="label">Rule name</span>
              <input value={ruleDraft.name} onChange={(event) => setRuleDraft((value) => ({ ...value, name: event.target.value }))} />
            </label>
            <label className="stack">
              <span className="label">Priority</span>
              <input type="number" value={ruleDraft.priority} onChange={(event) => setRuleDraft((value) => ({ ...value, priority: Number(event.target.value) }))} />
            </label>
          </div>
          <div className="grid two">
            <label className="stack">
              <span className="label">Host patterns</span>
              <input value={ruleDraft.host} onChange={(event) => setRuleDraft((value) => ({ ...value, host: event.target.value }))} placeholder="app.example.com, *.example.com" />
            </label>
            <label className="stack">
              <span className="label">Path glob</span>
              <input value={ruleDraft.pathGlob} onChange={(event) => setRuleDraft((value) => ({ ...value, pathGlob: event.target.value }))} />
            </label>
          </div>
          <div className="grid two">
            <label className="stack">
              <span className="label">Resource types</span>
              <input value={ruleDraft.resourceType} onChange={(event) => setRuleDraft((value) => ({ ...value, resourceType: event.target.value }))} placeholder="fetch, xmlhttprequest" />
            </label>
            <label className="stack">
              <span className="label">Methods</span>
              <input value={ruleDraft.method} onChange={(event) => setRuleDraft((value) => ({ ...value, method: event.target.value }))} placeholder="GET, POST" />
            </label>
          </div>
          {ruleDraft.kind === "asset_redirect" ? (
            <label className="stack">
              <span className="label">Redirect URL</span>
              <input value={ruleDraft.redirectUrl} onChange={(event) => setRuleDraft((value) => ({ ...value, redirectUrl: event.target.value }))} placeholder="https://cdn.example.com/app.js" />
            </label>
          ) : (
            <>
              <div className="grid two">
                <label className="stack">
                  <span className="label">Target base URL</span>
                  <input value={ruleDraft.targetBaseUrl} onChange={(event) => setRuleDraft((value) => ({ ...value, targetBaseUrl: event.target.value }))} placeholder="http://127.0.0.1:3000" />
                </label>
                <label className="stack">
                  <span className="label">Strip prefix</span>
                  <input value={ruleDraft.stripPrefix} onChange={(event) => setRuleDraft((value) => ({ ...value, stripPrefix: event.target.value }))} placeholder="/api" />
                </label>
              </div>
              <label className="stack">
                <span className="label">Injected headers JSON</span>
                <textarea value={ruleDraft.headersJson} onChange={(event) => setRuleDraft((value) => ({ ...value, headersJson: event.target.value }))} />
              </label>
            </>
          )}
          <div className="grid two">
            <label className="stack">
              <span className="label">Tags</span>
              <input value={ruleDraft.tags} onChange={(event) => setRuleDraft((value) => ({ ...value, tags: event.target.value }))} placeholder="team-a, staging" />
            </label>
            <label className="stack">
              <span className="label">Note</span>
              <input value={ruleDraft.note} onChange={(event) => setRuleDraft((value) => ({ ...value, note: event.target.value }))} />
            </label>
          </div>
          <div className="row between">
            <label className="row">
              <input type="checkbox" checked={ruleDraft.enabled} onChange={(event) => setRuleDraft((value) => ({ ...value, enabled: event.target.checked }))} />
              Rule enabled
            </label>
            <div className="row">
              <button className="ghost" onClick={() => setRuleDraft(createEmptyRuleDraft(dashboard?.workspace))}>
                Reset
              </button>
              <button onClick={() => void saveRule()} disabled={busy || !activeRuleSet}>
                Save rule
              </button>
            </div>
          </div>
          {conflictPreview.length > 0 ? (
            <div className="stack">
              <span className="badge warning">Conflict preview</span>
              {conflictPreview.map((conflict) => (
                <p key={conflict.ruleId} className="small muted">
                  {conflict.reason}
                </p>
              ))}
            </div>
          ) : null}
          {ruleWarnings.length > 0 ? (
            <div className="stack">
              <span className="badge warning">Capability warnings</span>
              {ruleWarnings.map((warning) => (
                <p className="small muted" key={warning}>
                  {warning}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid two">
        <div className="card">
          <div className="row between">
            <h2>Import / merge</h2>
            <div className="row">
              <button className="ghost" onClick={() => void importWorkspace(true)} disabled={busy}>
                Merge
              </button>
              <button onClick={() => void importWorkspace(false)} disabled={busy}>
                Replace
              </button>
            </div>
          </div>
          <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="Paste workspace JSON or YAML" />
        </div>

        <div className="card">
          <div className="row between">
            <h2>Export</h2>
            <div className="row">
              <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as "json" | "yaml")}>
                <option value="yaml">YAML</option>
                <option value="json">JSON</option>
              </select>
            </div>
          </div>
          <textarea value={exportText} onChange={(event) => setExportText(event.target.value)} placeholder="Choose a project and click export." />
        </div>
      </section>

      <section className="grid two">
        <div className="card">
          <h2>Workspace warnings</h2>
          <div className="list">
            {warnings.map((warning) => (
              <p className="small muted" key={warning}>
                {warning}
              </p>
            ))}
            {warnings.length === 0 ? <p className="muted">No rule capability warnings in the current workspace.</p> : null}
          </div>
        </div>

        <div className="card">
          <h2>Recent logs</h2>
          <div className="list">
            {(dashboard?.logs ?? []).map((log) => (
              <article className="item" key={log.id}>
                <div className="item-header">
                  <div className="stack">
                    <h4>{log.method} {log.requestUrl}</h4>
                    <p className="small">{log.outcome} · {log.statusCode ?? "-"} · {log.durationMs} ms</p>
                  </div>
                </div>
              </article>
            ))}
            {(dashboard?.logs ?? []).length === 0 ? <p className="muted">Forward hits will appear here after requests start matching rules.</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function findProject(projects: Project[] | undefined, id: string): Project | undefined {
  return projects?.find((project) => project.id === id);
}

function fromProject(project: Project): ProjectDraft {
  return {
    id: project.id,
    name: project.name,
    siteHosts: joinCsv(project.siteHosts),
    envLabel: project.envLabel ?? "",
    note: project.note ?? "",
    enabled: project.enabled,
  };
}

function fromRule(rule: Rule, ruleSets: RuleSet[]): RuleDraft {
  const owningRuleSet = ruleSets.find((ruleSet) => ruleSet.ruleIds.includes(rule.id));
  return {
    id: rule.id,
    ruleSetId: owningRuleSet?.id ?? "",
    name: rule.name,
    kind: rule.kind,
    enabled: rule.enabled,
    priority: rule.priority,
    host: joinCsv(rule.match.host),
    pathGlob: rule.match.pathGlob,
    resourceType: joinCsv(rule.match.resourceType),
    method: joinCsv(rule.match.method),
    redirectUrl: rule.target.redirectUrl ?? "",
    targetBaseUrl: rule.target.forwardProfile?.targetBaseUrl ?? "",
    stripPrefix: rule.target.forwardProfile?.stripPrefix ?? "",
    headersJson: JSON.stringify(rule.target.forwardProfile?.headers ?? {}, null, 2),
    tags: joinCsv(rule.tags),
    note: rule.note ?? "",
  };
}

function toRule(draft: RuleDraft, workspace: WorkspaceSnapshot): Rule {
  if (!draft.ruleSetId) {
    throw new Error("Select a rule set before saving the rule.");
  }
  const now = new Date().toISOString();
  const existing = workspace.rules.find((rule) => rule.id === draft.id);
  const headers = draft.headersJson.trim() ? (JSON.parse(draft.headersJson) as Record<string, string>) : {};

  return {
    id: draft.id || createId("rule"),
    name: draft.name.trim() || "Unnamed rule",
    enabled: draft.enabled,
    kind: draft.kind,
    priority: Number.isFinite(draft.priority) ? draft.priority : 100,
    match: {
      host: splitCsv(draft.host),
      pathGlob: draft.pathGlob || "**",
      resourceType: splitCsv(draft.resourceType) as Rule["match"]["resourceType"],
      method: draft.kind === "api_forward" ? splitCsv(draft.method) : undefined,
      tabScope: { mode: "all" },
    },
    target:
      draft.kind === "asset_redirect"
        ? { redirectUrl: draft.redirectUrl.trim() }
        : {
            forwardProfile: {
              targetBaseUrl: draft.targetBaseUrl.trim(),
              stripPrefix: draft.stripPrefix.trim() || undefined,
              headers,
            },
          },
    note: draft.note.trim() || undefined,
    tags: splitCsv(draft.tags),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

const rootElement = document.getElementById("app");
if (!rootElement) {
  throw new Error("Missing app root.");
}

createRoot(rootElement).render(<App />);
