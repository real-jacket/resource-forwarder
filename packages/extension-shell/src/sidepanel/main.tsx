import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { matchesProjectSite, sortRules } from "@resource-forwarder/rule-core";
import type { Project, Rule } from "@resource-forwarder/shared-types";
import { joinCsv } from "../shared/helpers.js";
import type { GetDashboardStateResponse, UpsertMutationResponse } from "../shared/messages.js";
import { runtimeRequest } from "../shared/messages.js";

function App() {
  const [dashboard, setDashboard] = useState<GetDashboardStateResponse | null>(null);
  const [status, setStatus] = useState("正在加载当前页面...");
  const [busy, setBusy] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    // Debounce: tab activation, onUpdated and SPA history nav can fire in a burst.
    const scheduleRefresh = (): void => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void refresh();
      }, 120);
    };

    const onActivated = (_info: chrome.tabs.TabActiveInfo): void => scheduleRefresh();
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ): void => {
      if (!tab.active) return;
      if (changeInfo.url || changeInfo.status === "complete") scheduleRefresh();
    };
    const onWindowFocus = (windowId: number): void => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) scheduleRefresh();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") scheduleRefresh();
    };
    // SPA pushState navigations don't reach tabs.onUpdated reliably.
    const onSpaNav = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
      if (details.frameId !== 0) return;
      scheduleRefresh();
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows?.onFocusChanged.addListener(onWindowFocus);
    document.addEventListener("visibilitychange", onVisibility);
    chrome.webNavigation?.onHistoryStateUpdated.addListener(onSpaNav);
    chrome.webNavigation?.onReferenceFragmentUpdated.addListener(onSpaNav);

    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows?.onFocusChanged.removeListener(onWindowFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      chrome.webNavigation?.onHistoryStateUpdated.removeListener(onSpaNav);
      chrome.webNavigation?.onReferenceFragmentUpdated.removeListener(onSpaNav);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const currentHost = dashboard?.currentTab?.host ?? "";
  const currentUrl = dashboard?.currentTab?.url ?? "";

  const matchedProjects = useMemo(() => {
    if (!dashboard || !currentUrl) {
      return [];
    }
    return dashboard.workspace.projects.filter((project) => matchesProjectSite(project, currentUrl));
  }, [dashboard, currentUrl]);

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

  const activeRuleCount = useMemo(
    () => matchedRules.filter((rule) => rule.enabled).length,
    [matchedRules],
  );

  const dnrRegisteredCount =
    (dashboard?.dnrRuleCount?.dynamic ?? 0) + (dashboard?.dnrRuleCount?.session ?? 0);
  const dnrBadgeTone =
    matchedProjects.length === 0 && dnrRegisteredCount > 0 ? "warning" : "neutral";

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

  const projectRuleCount = (projectId: string) =>
    dashboard?.workspace.ruleSets
      .filter((rs) => rs.projectId === projectId)
      .reduce((sum, rs) => sum + rs.ruleIds.length, 0) ?? 0;

  return (
    <div className="sp">
      {/* Hero */}
      <div className="sp-hero">
        <div className="sp-hero-top">
          <div className="sp-hero-info">
            <span className="sp-hero-label">当前站点</span>
            <span className="sp-hero-host">{currentHost || "未识别"}</span>
          </div>
          <div className="sp-hero-actions">
            <button className="btn btn-default btn-sm" onClick={() => void refresh()} disabled={busy}>刷新</button>
            <button className="btn btn-primary btn-sm" onClick={() => void chrome.runtime.openOptionsPage()}>规则页</button>
          </div>
        </div>
        <div className="sp-hero-url">{currentUrl || "打开一个网页后显示"}</div>
        <div className="sp-hero-badges">
          <span className={`sp-badge ${dashboard?.health ? "online" : "offline"}`}>
            <span className="sp-badge-dot" />
            {dashboard?.health ? "服务在线" : "离线"}
          </span>
          <span className={`sp-badge ${matchedProjects.length > 0 ? "matched" : "unmatched"}`}>
            {matchedProjects.length > 0 ? `${matchedProjects.length} 个站点` : "未匹配"}
          </span>
          <span className="sp-badge neutral">{activeRuleCount} / {matchedRules.length} 条规则生效</span>
          {dnrRegisteredCount > 0 && (
            <span
              className={`sp-badge ${dnrBadgeTone}`}
              title="Chrome 中已注册的 DNR 规则数（asset_redirect 通过浏览器请求层直接重定向，不受当前页面匹配影响）"
            >
              {dnrRegisteredCount} 条 DNR 已注册
            </span>
          )}
        </div>
      </div>

      {/* Matched sites */}
      <div className="sp-section">
        <div className="sp-section-title">命中站点</div>
        {matchedProjects.length === 0 ? (
          <div className="sp-empty">
            当前页面未匹配到任何站点，请在规则页添加 Host。
          </div>
        ) : (
          <div className="sp-site-list">
            {matchedProjects.map((project) => (
              <div className={`sp-site-item${!project.enabled ? " is-off" : ""}`} key={project.id}>
                <div className="sp-site-info">
                  <div className="sp-site-name-row">
                    <span className="sp-site-name">{project.name}</span>
                    <span className={`site-list-badge ${project.enabled ? "active" : "disabled"}`}>
                      {project.enabled ? "启用" : "停用"}
                    </span>
                    {project.envLabel && <span className="site-list-badge disabled">{project.envLabel}</span>}
                  </div>
                  <div className="sp-site-meta">
                    {joinCsv(project.siteMatchPatterns ?? project.siteHosts) || "未填写站点匹配"} · {projectRuleCount(project.id)} 条规则
                  </div>
                </div>
                <div className="sp-site-actions">
                  <button
                    className={`btn btn-ghost btn-sm${!project.enabled ? " is-off" : ""}`}
                    onClick={() => void toggleProject(project)}
                    disabled={busy}
                  >
                    {project.enabled ? "停用" : "启用"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Active rules */}
      <div className="sp-section">
        <div className="sp-section-title">生效规则</div>
        {matchedRules.length === 0 ? (
          <div className="sp-empty">
            {matchedProjects.length > 0 ? "匹配到站点但暂无规则。" : "先匹配站点后显示规则。"}
          </div>
        ) : (
          <div className="sp-rule-list">
            {matchedRules.map((rule) => (
              <div className={`sp-rule-item${rule.enabled ? "" : " is-off"}`} key={rule.id}>
                <label className="toggle-switch toggle-switch-sm">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={() => void toggleRule(rule)}
                    disabled={busy}
                  />
                  <span className="toggle-track" />
                </label>
                <div className="sp-rule-info">
                  <div className="sp-rule-name-row">
                    <span className="sp-rule-name">{rule.name}</span>
                    <span className={`match-badge ${rule.kind === "api_forward" ? "api" : "asset"}`}>
                      {formatKind(rule.kind)}
                    </span>
                  </div>
                  <div className="sp-rule-path">{rule.match.pathGlob}</div>
                  <div className="sp-rule-target">{formatRuleTarget(rule)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status footer */}
      <div className="sp-footer">
        <span className="sp-footer-status">{status}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => void chrome.runtime.openOptionsPage()}>打开工作台</button>
      </div>
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
