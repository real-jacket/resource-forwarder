import React from "react";
import { matchesProjectSite } from "@resource-forwarder/rule-core";
import type { Project } from "@resource-forwarder/shared-types";
import type { DashboardState } from "../../shared/messages.js";
import type { AppView } from "../types.js";
import { formatProjectScopeSummary, formatTimestamp, localizeWarning } from "../formatters.js";

/**
 * Props are grouped by feature (service, filters, selection, …) instead of
 * passed flat — there are ~25 dependencies and a flat list would obscure
 * intent. Each group's responsibility maps to one card on the page.
 */
export interface SettingsViewProps {
  /** Snapshot data used in headers, banners, lists. */
  data: {
    dashboard: DashboardState | null;
    projects: Project[];
    selectedProject: Project | undefined;
    currentUrl: string;
    /** Logs already filtered to the current project (or unfiltered). */
    logs: DashboardState["logs"];
    /** Map projectId → rule count, derived in the parent for O(1) lookups. */
    ruleCountByProjectId: Map<string, number>;
    /** Set of project IDs flagged as duplicates by name+host hash. */
    duplicateProjectIds: Set<string>;
    busy: boolean;
  };

  /** Local service connection card. */
  service: {
    url: string;
    setUrl: (value: string) => void;
    save: () => void | Promise<void>;
    refresh: () => void | Promise<void>;
    port: string;
    /** Current value typed into the token input (cleared after save). */
    tokenInput: string;
    setTokenInput: (value: string) => void;
    /** Whether a token is already persisted in chrome.storage.local. */
    tokenSaved: boolean;
    saveToken: () => void | Promise<void>;
  };

  /** Filter & search bar over the site list. */
  filters: {
    status: "all" | "enabled" | "disabled";
    setStatus: (status: "all" | "enabled" | "disabled") => void;
    query: string;
    setQuery: (value: string) => void;
    /** Deferred copy of `query.toLowerCase().trim()`. */
    deferredQuery: string;
    filtered: Project[];
    enabledCount: number;
    disabledCount: number;
  };

  /** Multi-select state and bulk actions. */
  selection: {
    ids: Set<string>;
    setIds: (ids: Set<string>) => void;
    toggle: (id: string) => void;
    toggleAll: () => void;
    batchToggle: (enable: boolean) => void | Promise<void>;
    batchDelete: () => void | Promise<void>;
  };

  /** Per-row actions and navigation. */
  actions: {
    openProjectModal: (project?: Project) => void;
    toggleProject: (project: Project) => void | Promise<void>;
    duplicateProject: (project: Project) => void | Promise<void>;
    deleteProject: (project: Project) => void | Promise<void>;
    /** Switches the top-level view (e.g. jump to rules with this project). */
    setSelectedProjectId: (id: string) => void;
    setView: (view: AppView) => void;
  };
}

export function SettingsView(props: SettingsViewProps) {
  const { data, service, filters, selection, actions } = props;

  return (
    <>
      <div className="page-header">
        <div className="page-title">设置</div>
        <div className="page-subtitle">配置本地服务地址和管理站点</div>
      </div>

      <div className="settings-page">
        <WarningBanner warnings={data.dashboard?.warnings ?? []} />
        <ServiceCard service={service} dashboard={data.dashboard} busy={data.busy} />
        <SitesCard
          projects={data.projects}
          filters={filters}
          selection={selection}
          actions={actions}
          duplicateProjectIds={data.duplicateProjectIds}
          ruleCountByProjectId={data.ruleCountByProjectId}
          currentUrl={data.currentUrl}
          busy={data.busy}
        />
        <HitLogsCard logs={data.logs} selectedProject={data.selectedProject} />
      </div>
    </>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────

function WarningBanner({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="settings-warning-banner" role="alert">
      <div className="settings-warning-banner-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <div className="settings-warning-banner-body">
        <div className="settings-warning-banner-title">配置告警 · {warnings.length} 条</div>
        {warnings.map((w) => (
          <div className="settings-warning-banner-item" key={w}>{localizeWarning(w)}</div>
        ))}
      </div>
    </div>
  );
}

function ServiceCard({
  service,
  dashboard,
  busy,
}: {
  service: SettingsViewProps["service"];
  dashboard: DashboardState | null;
  busy: boolean;
}) {
  const [showToken, setShowToken] = React.useState(false);
  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-title">通用设置</div>
        <div className="settings-card-desc">配置本地转发服务地址与鉴权 token</div>
      </div>
      <div className="settings-card-body">
        <div className="settings-field-row">
          <div className="form-group">
            <label className="form-label">本地服务地址</label>
            <input
              className="form-input"
              value={service.url}
              onChange={(e) => service.setUrl(e.target.value)}
              placeholder="http://127.0.0.1:5178"
            />
          </div>
          <button className="btn btn-primary" onClick={() => void service.save()} disabled={busy}>
            保存
          </button>
          <button className="btn btn-default" onClick={() => void service.refresh()} disabled={busy}>
            立即同步
          </button>
        </div>

        <div className="settings-field-row">
          <div className="form-group">
            <label className="form-label">
              服务 token
              <span style={{ color: "var(--muted)", fontWeight: "normal", marginLeft: 8 }}>
                {service.tokenSaved ? "已保存（粘贴新值会覆盖）" : "首次启动 service 后从 ~/.resource-forwarder/token 复制"}
              </span>
            </label>
            <input
              className="form-input"
              type={showToken ? "text" : "password"}
              value={service.tokenInput}
              onChange={(e) => service.setTokenInput(e.target.value)}
              placeholder={service.tokenSaved ? "••••••••（已保存）" : "粘贴 token 内容"}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button
            className="btn btn-default"
            onClick={() => setShowToken((v) => !v)}
            type="button"
            title={showToken ? "隐藏" : "显示"}
          >
            {showToken ? "隐藏" : "显示"}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void service.saveToken()}
            disabled={busy || service.tokenInput.trim().length === 0}
          >
            保存 token
          </button>
        </div>

        <div className={`service-status-bar ${dashboard?.health ? "online" : "offline"}`}>
          <span className="service-status-dot" />
          <span className="service-status-text">
            {dashboard?.health ? `服务在线 · 端口 ${service.port}` : "服务离线 · 数据仅保存在本地"}
          </span>
        </div>
      </div>
    </div>
  );
}

function SitesCard({
  projects,
  filters,
  selection,
  actions,
  duplicateProjectIds,
  ruleCountByProjectId,
  currentUrl,
  busy,
}: {
  projects: Project[];
  filters: SettingsViewProps["filters"];
  selection: SettingsViewProps["selection"];
  actions: SettingsViewProps["actions"];
  duplicateProjectIds: Set<string>;
  ruleCountByProjectId: Map<string, number>;
  currentUrl: string;
  busy: boolean;
}) {
  return (
    <div className="settings-card">
      <div className="settings-card-header site-mgr-header">
        <div className="site-mgr-title-area">
          <div className="settings-card-title">站点管理</div>
          <div className="settings-card-desc">
            共 {projects.length} 个站点 · {filters.enabledCount} 个启用
            {(filters.status !== "all" || filters.deferredQuery) && ` · 筛选出 ${filters.filtered.length} 个`}
          </div>
        </div>
        <div className="site-mgr-header-actions">
          {selection.ids.size > 0 && (
            <>
              <span className="site-mgr-selection-count">已选 {selection.ids.size}</span>
              <button className="btn btn-default btn-sm" disabled={busy} onClick={() => void selection.batchToggle(true)}>
                启用
              </button>
              <button className="btn btn-default btn-sm" disabled={busy} onClick={() => void selection.batchToggle(false)}>
                停用
              </button>
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void selection.batchDelete()}>
                删除
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => selection.setIds(new Set())}>
                取消
              </button>
              <div className="site-mgr-divider" />
            </>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => actions.openProjectModal()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 12, height: 12 }}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            新建
          </button>
        </div>
      </div>

      {projects.length > 0 && (
        <div className="site-mgr-filters">
          <div className="site-mgr-status-tabs">
            <button
              className={`site-mgr-tab${filters.status === "all" ? " active" : ""}`}
              onClick={() => filters.setStatus("all")}
            >
              全部 <span className="site-mgr-tab-count">{projects.length}</span>
            </button>
            <button
              className={`site-mgr-tab${filters.status === "enabled" ? " active" : ""}`}
              onClick={() => filters.setStatus("enabled")}
            >
              启用 <span className="site-mgr-tab-count">{filters.enabledCount}</span>
            </button>
            <button
              className={`site-mgr-tab${filters.status === "disabled" ? " active" : ""}`}
              onClick={() => filters.setStatus("disabled")}
            >
              停用 <span className="site-mgr-tab-count">{filters.disabledCount}</span>
            </button>
          </div>
          <div className="site-mgr-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              className="site-mgr-search-input"
              value={filters.query}
              onChange={(e) => filters.setQuery(e.target.value)}
              placeholder="搜索站点名称、域名"
            />
            {filters.query && (
              <button className="site-mgr-search-clear" onClick={() => filters.setQuery("")}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      <div className="site-list">
        {filters.filtered.length > 0 && (
          <div className="site-list-head">
            <label className="site-list-checkbox">
              <input
                type="checkbox"
                checked={selection.ids.size === filters.filtered.length && filters.filtered.length > 0}
                onChange={selection.toggleAll}
              />
            </label>
            <span className="site-list-head-label">全选</span>
          </div>
        )}
        {projects.length === 0 && (
          <div className="site-list-empty">还没有站点，点击「新建」开始添加。</div>
        )}
        {projects.length > 0 && filters.filtered.length === 0 && (
          <div className="site-list-empty">
            没有匹配的站点。
            <button
              className="btn btn-ghost btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => {
                filters.setStatus("all");
                filters.setQuery("");
              }}
            >
              清除筛选
            </button>
          </div>
        )}
        {filters.filtered.map((project) => (
          <SiteRow
            key={project.id}
            project={project}
            ruleCount={ruleCountByProjectId.get(project.id) ?? 0}
            isActive={currentUrl ? matchesProjectSite(project, currentUrl) : false}
            isChecked={selection.ids.has(project.id)}
            isDuplicate={duplicateProjectIds.has(project.id)}
            busy={busy}
            actions={actions}
            onToggleSelect={() => selection.toggle(project.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SiteRow({
  project,
  ruleCount,
  isActive,
  isChecked,
  isDuplicate,
  busy,
  actions,
  onToggleSelect,
}: {
  project: Project;
  ruleCount: number;
  isActive: boolean;
  isChecked: boolean;
  isDuplicate: boolean;
  busy: boolean;
  actions: SettingsViewProps["actions"];
  onToggleSelect: () => void;
}) {
  return (
    <div className={`site-list-item${isChecked ? " is-selected" : ""}${!project.enabled ? " is-disabled" : ""}`}>
      <label className="site-list-checkbox">
        <input type="checkbox" checked={isChecked} onChange={onToggleSelect} />
      </label>
      <div className="site-list-info">
        <div className="site-list-name-row">
          <span className="site-list-name">{project.name}</span>
          {project.envLabel && <span className="site-list-badge env">{project.envLabel}</span>}
          {isDuplicate && (
            <span className="site-list-badge duplicate" title="存在同名同域名的站点">
              重复 #{project.id.slice(-6)}
            </span>
          )}
          {!project.enabled && <span className="site-list-badge disabled">已停用</span>}
          {isActive && <span className="site-list-badge active">当前页面</span>}
        </div>
        <div className="site-list-meta">
          <span className="site-list-hosts">
            {formatProjectScopeSummary(project)}
          </span>
          <span className="site-list-dot">·</span>
          <span>{ruleCount} 条规则</span>
        </div>
      </div>
      <div className="site-list-actions">
        <button
          className="btn-icon"
          title="查看规则"
          onClick={() => {
            actions.setSelectedProjectId(project.id);
            actions.setView("rules");
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
        </button>
        <button className="btn-icon" title="编辑" onClick={() => actions.openProjectModal(project)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
            <path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z" />
          </svg>
        </button>
        <button className="btn-icon" title="复制" onClick={() => void actions.duplicateProject(project)} disabled={busy}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        </button>
        <button
          className={`btn-icon${project.enabled ? "" : " is-off"}`}
          title={project.enabled ? "停用" : "启用"}
          onClick={() => void actions.toggleProject(project)}
          disabled={busy}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
            <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
        </button>
        <button
          className="btn-icon btn-icon-danger"
          title="删除"
          onClick={() => void actions.deleteProject(project)}
          disabled={busy}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function HitLogsCard({
  logs,
  selectedProject,
}: {
  logs: DashboardState["logs"];
  selectedProject: Project | undefined;
}) {
  // Filter to the currently selected project. The parent could pre-filter
  // and pass `logs` ready, but keeping the rule here lets the parent expose
  // the raw logs to other consumers without a separate prop.
  const filtered = logs.filter((log) => (selectedProject ? log.projectId === selectedProject.id : true));
  if (filtered.length === 0) return null;

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <div className="settings-card-title">命中日志</div>
        <div className="settings-card-desc">最近 {filtered.length} 条命中记录</div>
      </div>
      <div className="settings-card-body" style={{ gap: 8 }}>
        {filtered.slice(0, 8).map((log) => (
          <div
            key={log.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              padding: "8px 12px",
              background: "var(--surface-soft)",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--border)",
              fontSize: 12,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {log.method} {log.requestUrl}
              </div>
              <div style={{ color: "var(--muted)", marginTop: 2 }}>
                {log.outcome === "matched"
                  ? "已命中"
                  : log.outcome === "error"
                    ? "执行失败"
                    : "未处理"}
                {` · ${log.statusCode ?? "-"} · ${log.durationMs} ms`}
              </div>
            </div>
            <span style={{ color: "var(--muted)", marginLeft: 12, flexShrink: 0 }}>
              {formatTimestamp(log.occurredAt)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
