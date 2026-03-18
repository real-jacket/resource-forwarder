import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { sortRules } from "@resource-forwarder/rule-core";
import type { Project, Rule } from "@resource-forwarder/shared-types";
import { joinCsv } from "../shared/helpers.js";
import type { GetDashboardStateResponse, UpsertMutationResponse } from "../shared/messages.js";
import { runtimeRequest } from "../shared/messages.js";

function App() {
  const [dashboard, setDashboard] = useState<GetDashboardStateResponse | null>(null);
  const [status, setStatus] = useState("正在加载当前页面...");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  const currentHost = dashboard?.currentTab?.host ?? "";
  const currentUrl = dashboard?.currentTab?.url ?? "";

  const matchedProjects = useMemo(() => {
    if (!dashboard || !currentHost) {
      return [];
    }
    return dashboard.workspace.projects.filter((project) => project.siteHosts.includes(currentHost));
  }, [dashboard, currentHost]);

  const matchedProjectIds = useMemo(
    () => new Set(matchedProjects.map((project) => project.id)),
    [matchedProjects],
  );

  const matchedRuleIds = useMemo(() => {
    if (!dashboard) {
      return new Set<string>();
    }
    return new Set(
      dashboard.workspace.ruleSets
        .filter((ruleSet) => matchedProjectIds.has(ruleSet.projectId))
        .flatMap((ruleSet) => ruleSet.ruleIds),
    );
  }, [dashboard, matchedProjectIds]);

  const matchedRules = useMemo(
    () =>
      dashboard
        ? sortRules(dashboard.workspace.rules.filter((rule) => matchedRuleIds.has(rule.id))).sort((left, right) => {
            if (left.enabled !== right.enabled) {
              return left.enabled ? -1 : 1;
            }
            return 0;
          })
        : [],
    [dashboard, matchedRuleIds],
  );

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      const state = await runtimeRequest<GetDashboardStateResponse>({ type: "get-dashboard-state" });
      setDashboard(state);
      if (!state.currentTab?.host) {
        setStatus("当前标签页不可识别，请切到一个正常网页。");
      } else if (!state.health) {
        setStatus("未连接到本地服务，请先启动本地服务。");
      } else {
        setStatus("当前页面状态已同步。");
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "加载侧边栏失败。");
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
      setStatus(`站点「${project.name}」已${project.enabled ? "停用" : "启用"}。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "切换站点状态失败。");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(rule: Rule): Promise<void> {
    if (!dashboard) {
      return;
    }

    setBusy(true);
    try {
      const owningRuleSet = dashboard.workspace.ruleSets.find((ruleSet) => ruleSet.ruleIds.includes(rule.id));
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-rule",
        payload: {
          rule: { ...rule, enabled: !rule.enabled },
          ruleSetId: owningRuleSet?.id,
        },
      });
      setDashboard({ ...state, logs: dashboard.logs, currentTab: dashboard.currentTab });
      setStatus(`规则「${rule.name}」已${rule.enabled ? "停用" : "启用"}。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "切换规则状态失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="minimal-panel-shell">
      <section className="hero minimal-panel-hero">
        <div className="stack compact-gap">
          <span className="kicker">当前页面</span>
          <h2>{currentHost || "未识别标签页"}</h2>
          <p className="muted small mono-line">{currentUrl || "打开一个网页后，这里会显示当前 URL。"}</p>
        </div>
        <div className="row wrap-gap status-row">
          <span className={`badge ${dashboard?.health ? "success" : "danger"}`}>
            {dashboard?.health ? "服务在线" : "服务离线"}
          </span>
          <span className={`badge ${matchedProjects.length > 0 ? "success" : "warning"}`}>
            {matchedProjects.length > 0 ? `已匹配 ${matchedProjects.length} 个站点` : "未匹配站点"}
          </span>
        </div>
        <div className="row wrap-gap">
          <button className="secondary" onClick={() => void refresh()} disabled={busy}>
            刷新
          </button>
          <button className="ghost" onClick={() => void chrome.runtime.openOptionsPage()}>
            打开规则页
          </button>
        </div>
      </section>

      <section className="card compact-card">
        <div className="row between align-start">
          <div className="stack compact-gap">
            <h3>匹配站点</h3>
            <p className="small muted">这里显示当前页面真正命中的站点，而不是全部站点。</p>
          </div>
        </div>

        <div className="site-mini-list">
          {matchedProjects.map((project) => (
            <article className="item compact-item" key={project.id}>
              <div className="item-header">
                <div className="stack compact-gap">
                  <div className="row wrap-gap">
                    <h4>{project.name}</h4>
                    <span className={`badge ${project.enabled ? "success" : "warning"}`}>
                      {project.enabled ? "已启用" : "已停用"}
                    </span>
                    {project.envLabel ? <span className="badge neutral">{project.envLabel}</span> : null}
                  </div>
                  <p className="small muted">{joinCsv(project.siteHosts) || "未填写 Host"}</p>
                </div>
                <button
                  className={project.enabled ? "secondary" : ""}
                  onClick={() => void toggleProject(project)}
                  disabled={busy}
                >
                  {project.enabled ? "停用" : "启用"}
                </button>
              </div>
            </article>
          ))}

          {matchedProjects.length === 0 ? (
            <div className="empty-state">
              当前页面 `{currentHost || "未知 host"}` 还没有匹配到任何站点。去规则页新增一个 Host 后，这里会第一时间显示。
            </div>
          ) : null}
        </div>
      </section>

      <section className="card compact-card">
        <div className="row between align-start">
          <div className="stack compact-gap">
            <h3>当前规则</h3>
            <p className="small muted">只展示当前页面会命中的规则，不在侧边栏放输入表单。</p>
          </div>
        </div>

        <div className="rule-list minimal-rule-list">
          {matchedRules.map((rule) => (
            <article className={`rule-row ${rule.enabled ? "" : "is-muted"}`} key={rule.id}>
              <button
                className={`toggle-chip ${rule.enabled ? "on" : "off"}`}
                onClick={() => void toggleRule(rule)}
                disabled={busy}
              >
                {rule.enabled ? "开" : "关"}
              </button>
              <div className="rule-row-main">
                <div className="row wrap-gap">
                  <h4>{rule.name}</h4>
                  <span className="badge neutral">{formatKind(rule.kind)}</span>
                </div>
                <p className="small muted">{rule.match.pathGlob}</p>
                <p className="target-line">{formatRuleTarget(rule)}</p>
              </div>
            </article>
          ))}

          {matchedRules.length === 0 ? (
            <div className="empty-state">
              {matchedProjects.length > 0
                ? "当前页面虽然匹配到了站点，但还没有可用规则。去规则页补一条规则即可。"
                : "先让当前页面匹配到站点，随后这里才会展示规则。"}
            </div>
          ) : null}
        </div>
      </section>

      <section className="card compact-card">
        <div className="stack compact-gap">
          <span className="label">状态</span>
          <p>{status}</p>
        </div>
      </section>
    </div>
  );
}

function formatKind(kind: Rule["kind"]): string {
  return kind === "api_forward" ? "API 转发" : "资源替换";
}

function formatRuleTarget(rule: Rule): string {
  if (rule.kind === "asset_redirect") {
    return rule.target.redirectUrl || "未填写 HTTPS 地址";
  }
  return rule.target.forwardProfile?.targetBaseUrl || "未填写目标地址";
}

const rootElement = document.getElementById("app");
if (!rootElement) {
  throw new Error("Missing app root.");
}

createRoot(rootElement).render(<App />);
