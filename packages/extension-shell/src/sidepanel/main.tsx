import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { MatchResourceType, Project } from "@resource-forwarder/shared-types";
import { createId, getPathFromUrl } from "../shared/helpers.js";
import type { GetDashboardStateResponse, UpsertMutationResponse } from "../shared/messages.js";
import { runtimeRequest } from "../shared/messages.js";

function App() {
  const [dashboard, setDashboard] = useState<GetDashboardStateResponse | null>(null);
  const [status, setStatus] = useState("Loading side panel...");
  const [busy, setBusy] = useState(false);
  const [quickKind, setQuickKind] = useState<"api_forward" | "asset_redirect">("api_forward");
  const [quickName, setQuickName] = useState("Quick forward");
  const [quickTarget, setQuickTarget] = useState("http://127.0.0.1:3000");
  const [quickPath, setQuickPath] = useState("/api/**");

  useEffect(() => {
    void refresh();
  }, []);

  const currentHost = dashboard?.currentTab?.host ?? "";
  const relevantProjects = useMemo(() => {
    if (!dashboard) {
      return [];
    }
    const matches = dashboard.workspace.projects.filter((project) => project.siteHosts.includes(currentHost));
    return matches.length > 0 ? matches : dashboard.workspace.projects;
  }, [dashboard, currentHost]);

  const defaultRuleSet = useMemo(() => {
    if (!dashboard) {
      return undefined;
    }
    const projectIds = new Set(relevantProjects.map((project) => project.id));
    return dashboard.workspace.ruleSets.find((ruleSet) => projectIds.has(ruleSet.projectId)) ?? dashboard.workspace.ruleSets[0];
  }, [dashboard, relevantProjects]);

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      const state = await runtimeRequest<GetDashboardStateResponse>({ type: "get-dashboard-state" });
      setDashboard(state);
      setQuickPath(defaultQuickPath(state.currentTab?.url ?? ""));
      setStatus(state.health ? "Side panel ready." : "Local service is not reachable.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load side panel.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleProject(project: Project): Promise<void> {
    if (!dashboard) {
      return;
    }
    setBusy(true);
    try {
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-project",
        payload: {
          project: { ...project, enabled: !project.enabled },
          ruleSets: dashboard.workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === project.id),
        },
      });
      setDashboard({ ...state, logs: dashboard.logs, currentTab: dashboard.currentTab });
      setStatus(`${project.name} ${project.enabled ? "disabled" : "enabled"}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to toggle project.");
    } finally {
      setBusy(false);
    }
  }

  async function createQuickRule(): Promise<void> {
    if (!dashboard || !defaultRuleSet || !dashboard.currentTab?.url) {
      setStatus("Create a project in the options page before using quick rule creation.");
      return;
    }

    setBusy(true);
    try {
      const now = new Date().toISOString();
      const payload = {
        rule: {
          id: createId("rule"),
          name: quickName.trim() || "Quick rule",
          enabled: true,
          kind: quickKind,
          priority: 100,
          match: {
            host: [dashboard.currentTab.host],
            pathGlob: quickPath || defaultQuickPath(dashboard.currentTab.url),
            resourceType:
              (quickKind === "api_forward"
                ? ["fetch", "xmlhttprequest"]
                : ["script", "stylesheet", "image", "font"]) as MatchResourceType[],
            method: quickKind === "api_forward" ? ["GET", "POST"] : undefined,
            tabScope: { mode: "all" as const },
          },
          target:
            quickKind === "asset_redirect"
              ? { redirectUrl: quickTarget.trim() }
              : {
                  forwardProfile: {
                    targetBaseUrl: quickTarget.trim(),
                  },
                },
          tags: ["quick-create"],
          createdAt: now,
          updatedAt: now,
        },
        ruleSetId: defaultRuleSet.id,
      };
      const state = await runtimeRequest<UpsertMutationResponse>({ type: "upsert-rule", payload });
      setDashboard({ ...state, logs: dashboard.logs, currentTab: dashboard.currentTab });
      setStatus(`Created ${payload.rule.kind} rule for ${dashboard.currentTab.host}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to create quick rule.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-shell">
      <section className="hero">
        <span className="kicker">Current tab</span>
        <h2>{dashboard?.currentTab?.host || "No active tab"}</h2>
        <p>{dashboard?.currentTab?.url || "Open a page to inspect matching projects and quick-create rules."}</p>
        <div className="row">
          <span className={`badge ${dashboard?.health ? "" : "danger"}`}>
            {dashboard?.health ? "Service online" : "Service offline"}
          </span>
          <span className="badge">Projects {relevantProjects.length}</span>
        </div>
        <p className="small">{status}</p>
      </section>

      <section className="card">
        <div className="row between">
          <h3>Project toggles</h3>
          <button className="secondary" onClick={() => void refresh()} disabled={busy}>
            Refresh
          </button>
        </div>
        <div className="list">
          {relevantProjects.map((project) => (
            <article className="item" key={project.id}>
              <div className="item-header">
                <div className="stack">
                  <h4>{project.name}</h4>
                  <p className="small">{project.siteHosts.join(", ")}</p>
                </div>
                <button onClick={() => void toggleProject(project)}>{project.enabled ? "Disable" : "Enable"}</button>
              </div>
            </article>
          ))}
          {relevantProjects.length === 0 ? <p className="muted">No matching project yet. Use the options page to define one.</p> : null}
        </div>
      </section>

      <section className="card">
        <div className="row between">
          <h3>Quick rule</h3>
          <button className="ghost" onClick={() => void chrome.runtime.openOptionsPage()}>
            Open options
          </button>
        </div>
        <label className="stack">
          <span className="label">Rule kind</span>
          <select value={quickKind} onChange={(event) => setQuickKind(event.target.value as "api_forward" | "asset_redirect")}>
            <option value="api_forward">api_forward</option>
            <option value="asset_redirect">asset_redirect</option>
          </select>
        </label>
        <label className="stack">
          <span className="label">Rule name</span>
          <input value={quickName} onChange={(event) => setQuickName(event.target.value)} />
        </label>
        <label className="stack">
          <span className="label">Path glob</span>
          <input value={quickPath} onChange={(event) => setQuickPath(event.target.value)} />
        </label>
        <label className="stack">
          <span className="label">{quickKind === "api_forward" ? "Target base URL" : "Redirect URL"}</span>
          <input value={quickTarget} onChange={(event) => setQuickTarget(event.target.value)} placeholder={quickKind === "api_forward" ? "http://127.0.0.1:3000" : "https://cdn.example.com/app.js"} />
        </label>
        <button onClick={() => void createQuickRule()} disabled={busy || !defaultRuleSet}>
          Create quick rule
        </button>
      </section>

      <section className="card">
        <h3>Recent hits</h3>
        <div className="list">
          {(dashboard?.logs ?? []).slice(0, 6).map((log) => (
            <article className="item" key={log.id}>
              <div className="stack">
                <h4>{log.method} {shorten(log.requestUrl)}</h4>
                <p className="small">{log.outcome} · {log.statusCode ?? "-"} · {log.durationMs} ms</p>
              </div>
            </article>
          ))}
          {(dashboard?.logs ?? []).length === 0 ? <p className="muted">No forwarded requests yet.</p> : null}
        </div>
      </section>
    </div>
  );
}

function defaultQuickPath(url: string): string {
  const path = getPathFromUrl(url);
  return path === "/" ? "/api/**" : `${path.replace(/\/$/, "")}/**`;
}

function shorten(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}

const rootElement = document.getElementById("app");
if (!rootElement) {
  throw new Error("Missing app root.");
}

createRoot(rootElement).render(<App />);
