import React from "react";
import type { Project, Rule, RuleSet } from "@resource-forwarder/shared-types";
import type { DashboardState } from "../../shared/messages.js";
import type { AppView, RuleStatusTab } from "../types.js";
import { CustomSelect } from "../components/CustomSelect.js";
import { formatRuleTarget, formatTimestamp } from "../formatters.js";

export interface RuleRow {
  rule: Rule;
  project: Project | null;
}

export interface RulesViewProps {
  /** Bottom statusbar text + dashboard health dot. */
  status: string;
  dashboard: DashboardState | null;
  busy: boolean;

  /** All projects (powers the project filter dropdown). */
  projects: Project[];
  /** The currently selected project (or undefined when filter is "全部"). */
  selectedProject: Project | undefined;
  /** Mirror of selectedProject?.id, used by the filter <CustomSelect>. */
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  /** First ruleSet for the selected project, gates "新建规则" availability. */
  selectedRuleSet: RuleSet | undefined;

  /** Pre-sorted rule rows (all of them; the parent computes filteredRuleRows separately). */
  allRuleRows: RuleRow[];
  /** Rows after status / kind / search filtering. */
  filteredRuleRows: RuleRow[];

  /** Status tab + counts. */
  ruleStatusTab: RuleStatusTab;
  setRuleStatusTab: (tab: RuleStatusTab) => void;
  totalCount: number;
  tabEnabledCount: number;
  tabDisabledCount: number;

  /** Kind + search filters. */
  ruleKindFilter: "all" | Rule["kind"];
  setRuleKindFilter: (value: "all" | Rule["kind"]) => void;
  ruleQuery: string;
  setRuleQuery: (value: string) => void;

  /** Top-level navigation (used by the "去创建站点" empty state). */
  setView: (view: AppView) => void;

  /** Action handlers. */
  actions: {
    refresh: () => void | Promise<void>;
    openProjectModal: (project?: Project) => void;
    openRulePanel: (kind: Rule["kind"], rule?: Rule) => void;
    openBatchRulePanel: (kind?: Rule["kind"]) => void;
    duplicateRule: (rule: Rule) => void;
    deleteRule: (rule: Rule) => void | Promise<void>;
    toggleRule: (rule: Rule) => void | Promise<void>;
    toggleProject: (project: Project) => void | Promise<void>;
    deleteProject: (project: Project) => void | Promise<void>;
  };
}

/**
 * Top-level "Rules" view: project / kind / status filters, the rule table
 * with row-level actions, and the bottom status bar.
 *
 * The component is intentionally presentational — every action and state
 * setter is provided by the parent via `actions` so the same view can be
 * re-mounted without re-running data-fetching logic.
 */
export function RulesView(props: RulesViewProps) {
  const hasRules = props.allRuleRows.length > 0;

  return (
    <>
      <div className="page-header">
        <div className="page-title">规则列表</div>
        <div className="page-subtitle">管理和查看所有本地代理规则</div>
      </div>

      <StatusTabs {...props} />
      <Toolbar {...props} />
      <SiteScopeBanner project={props.selectedProject} />

      <div className="rule-table-container">
        {!hasRules ? (
          <EmptyState
            kind="no-rules"
            projectsExists={props.projects.length > 0}
            canCreateRule={!!props.selectedProject && !!props.selectedRuleSet}
            actions={props.actions}
            setView={props.setView}
          />
        ) : props.filteredRuleRows.length === 0 ? (
          <EmptyState
            kind="no-matches"
            projectsExists
            canCreateRule={false}
            actions={props.actions}
            setView={props.setView}
            onClearFilters={() => {
              props.setRuleQuery("");
              props.setRuleKindFilter("all");
              props.setRuleStatusTab("all");
            }}
          />
        ) : (
          <RuleTable rows={props.filteredRuleRows} busy={props.busy} actions={props.actions} dashboard={props.dashboard} />
        )}
      </div>

      <div className="options-statusbar">
        <span className={`statusbar-dot ${props.dashboard?.health ? "online" : ""}`} />
        {props.status}
      </div>
    </>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────

function StatusTabs(props: RulesViewProps) {
  return (
    <div className="status-tabs">
      <div className="status-tabs-left">
        <button
          className={`status-tab ${props.ruleStatusTab === "all" ? "active" : ""}`}
          onClick={() => props.setRuleStatusTab("all")}
        >
          全部
          <span className="status-tab-count">{props.totalCount}</span>
        </button>
        <button
          className={`status-tab ${props.ruleStatusTab === "enabled" ? "active" : ""}`}
          onClick={() => props.setRuleStatusTab("enabled")}
        >
          启用中
          <span className="status-tab-count">{props.tabEnabledCount}</span>
        </button>
        <button
          className={`status-tab ${props.ruleStatusTab === "disabled" ? "active" : ""}`}
          onClick={() => props.setRuleStatusTab("disabled")}
        >
          已禁用
          <span className="status-tab-count">{props.tabDisabledCount}</span>
        </button>
      </div>
      <button className="btn btn-default btn-sm" onClick={() => props.actions.openProjectModal()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13 }} aria-hidden="true">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          <line x1="12" y1="11" x2="12" y2="17" />
          <line x1="9" y1="14" x2="15" y2="14" />
        </svg>
        新建站点
      </button>
    </div>
  );
}

function Toolbar(props: RulesViewProps) {
  const { selectedProject, projects, busy, actions } = props;
  return (
    <div className="page-toolbar">
      <div className="toolbar-filters">
        <CustomSelect
          className="cs-wide"
          value={props.selectedProjectId}
          options={[
            { value: "", label: "全部分组" },
            ...projects.map((p) => ({
              value: p.id,
              label: `${p.name}${p.enabled ? "" : "（已停用）"}`,
            })),
          ]}
          onChange={props.setSelectedProjectId}
          searchable
          searchPlaceholder="搜索站点..."
        />
        {selectedProject && (
          <div className="toolbar-group-actions">
            <button
              className="btn btn-ghost btn-sm"
              title="编辑分组"
              onClick={() => actions.openProjectModal(selectedProject)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                <path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z" />
              </svg>
            </button>
            <button
              className={`btn btn-ghost btn-sm ${!selectedProject.enabled ? "is-off" : ""}`}
              title={selectedProject.enabled ? "停用分组" : "启用分组"}
              onClick={() => void actions.toggleProject(selectedProject)}
              disabled={busy}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                {!selectedProject.enabled && <line x1="9" y1="9" x2="15" y2="15" />}
              </svg>
            </button>
            <button
              className="btn btn-ghost btn-sm btn-danger"
              title="删除分组"
              onClick={() => void actions.deleteProject(selectedProject)}
              disabled={busy}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </button>
          </div>
        )}

        <CustomSelect
          value={props.ruleKindFilter}
          options={[
            { value: "all", label: "全部类型" },
            { value: "api_forward", label: "API 转发" },
            { value: "asset_redirect", label: "资源替换" },
          ]}
          onChange={(v) => props.setRuleKindFilter(v as "all" | Rule["kind"])}
        />

        <div className="toolbar-divider" />

        <div className="toolbar-search-wrap">
          <svg className="toolbar-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            className="toolbar-search-input"
            value={props.ruleQuery}
            onChange={(e) => props.setRuleQuery(e.target.value)}
            placeholder="搜索规则名称、路径、目标地址"
          />
        </div>
      </div>

      <div className="toolbar-actions">
        <button className="btn btn-default" onClick={() => void actions.refresh()} disabled={busy}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          刷新
        </button>
        <button
          className="btn btn-primary"
          onClick={() => actions.openBatchRulePanel("api_forward")}
          disabled={!selectedProject || !props.selectedRuleSet}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          新建规则
        </button>
      </div>
    </div>
  );
}

function SiteScopeBanner({ project }: { project: Project | undefined }) {
  if (!project) return null;
  const patterns = project.siteMatchPatterns ?? [];
  return (
    <div className={`site-scope-banner${project.enabled ? "" : " is-disabled"}`}>
      <div className="site-scope-label">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z" />
        </svg>
        站点匹配
      </div>
      <div className="site-scope-patterns">
        {patterns.length > 0 ? (
          patterns.map((p, i) => (
            <span className="site-scope-pattern" key={i}>{p}</span>
          ))
        ) : (
          <span className="site-scope-empty">未设置（全局生效）</span>
        )}
      </div>
      {!project.enabled && <span className="site-scope-status">已停用</span>}
    </div>
  );
}

function EmptyState({
  kind,
  projectsExists,
  canCreateRule,
  actions,
  setView,
  onClearFilters,
}: {
  kind: "no-rules" | "no-matches";
  projectsExists: boolean;
  canCreateRule: boolean;
  actions: RulesViewProps["actions"];
  setView: (view: AppView) => void;
  onClearFilters?: () => void;
}) {
  if (kind === "no-rules") {
    return (
      <div className="rule-table-card">
        <div className="table-empty">
          <svg className="table-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 21V9" />
          </svg>
          <div className="table-empty-title">暂无规则</div>
          <div className="table-empty-desc">
            {!projectsExists
              ? "请先在设置页面创建一个站点，再新建规则。"
              : "点击「新建规则」添加第一条规则，或者从导入导出页面导入已有配置。"}
          </div>
          {!projectsExists ? (
            <button className="btn btn-primary" onClick={() => setView("settings")}>
              去创建站点
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => actions.openBatchRulePanel("api_forward")}
              disabled={!canCreateRule}
            >
              新建规则
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rule-table-card">
      <div className="table-empty">
        <svg className="table-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <div className="table-empty-title">没有匹配的规则</div>
        <div className="table-empty-desc">试着调整搜索关键词或筛选条件。</div>
        <button className="btn btn-default" onClick={onClearFilters}>
          清除筛选
        </button>
      </div>
    </div>
  );
}

function RuleTable({
  rows,
  busy,
  actions,
  dashboard,
}: {
  rows: RuleRow[];
  busy: boolean;
  actions: RulesViewProps["actions"];
  dashboard: DashboardState | null;
}) {
  return (
    <div className="rule-table-card">
      <table className="rule-table">
        <thead>
          <tr>
            <th style={{ width: 48 }}></th>
            <th className="col-seq" style={{ width: 40 }}>总序</th>
            <th style={{ width: "15%" }}>规则名称</th>
            <th style={{ width: 80 }}>匹配类型</th>
            <th style={{ width: "22%" }}>匹配规则</th>
            <th>代理资源</th>
            <th className="col-time" style={{ width: 110 }}>更新时间</th>
            <th className="col-actions" style={{ width: 120 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ rule }, index) => (
            <RuleTableRow
              key={rule.id}
              rule={rule}
              index={index}
              busy={busy}
              actions={actions}
            />
          ))}
        </tbody>
      </table>

      <div className="table-footer">
        <span>共 {rows.length} 条规则</span>
        {(dashboard?.warnings ?? []).length > 0 && (
          <span style={{ color: "var(--warning-text)" }}>
            {dashboard!.warnings.length} 条配置告警
          </span>
        )}
      </div>
    </div>
  );
}

function RuleTableRow({
  rule,
  index,
  busy,
  actions,
}: {
  rule: Rule;
  index: number;
  busy: boolean;
  actions: RulesViewProps["actions"];
}) {
  return (
    <tr className={rule.enabled ? "" : "is-disabled"}>
      <td>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={() => void actions.toggleRule(rule)}
            disabled={busy}
          />
          <span className="toggle-track" />
        </label>
      </td>
      <td className="col-seq">
        <span className="rule-seq-text">{index + 1}</span>
      </td>
      <td className="rule-name-cell">
        <span className="rule-name-text" title={rule.name}>
          {rule.name}
        </span>
      </td>
      <td>
        <span className={`match-badge ${rule.kind === "api_forward" ? "api" : "asset"}`}>
          {rule.kind === "api_forward" ? "API 转发" : "资源替换"}
        </span>
      </td>
      <td>
        <span className="rule-path-text" title={rule.match.pathGlob}>
          {rule.match.pathGlob}
        </span>
      </td>
      <td>
        <span className="rule-target-text" title={formatRuleTarget(rule)}>
          {formatRuleTarget(rule)}
        </span>
      </td>
      <td className="col-time">
        <span className="rule-time-text" title={formatTimestamp(rule.updatedAt)}>
          {formatTimestamp(rule.updatedAt, true)}
        </span>
      </td>
      <td className="col-actions">
        <div className="rule-actions-cell">
          <button className="btn-icon" title="编辑" onClick={() => actions.openRulePanel(rule.kind, rule)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button className="btn-icon" title="复制" onClick={() => actions.duplicateRule(rule)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          </button>
          <button
            className="btn-icon btn-icon-danger"
            title="删除"
            onClick={() => void actions.deleteRule(rule)}
            disabled={busy}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
          </button>
        </div>
      </td>
    </tr>
  );
}
