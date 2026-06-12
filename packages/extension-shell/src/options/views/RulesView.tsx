import React from "react";
import type { Project, Rule, RuleSet } from "@resource-forwarder/shared-types";
import type { DashboardState } from "../../shared/messages.js";
import type { AppView, RuleStatusTab } from "../types.js";
import { CustomSelect } from "../components/CustomSelect.js";
import { formatProjectScopeSummary, formatRuleSetScopeSummary, formatRuleTarget, formatTimestamp } from "../formatters.js";

export interface RuleRow {
  rule: Rule;
  project: Project | null;
  ruleSet: RuleSet | null;
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
  /** Active rule set within the selected project; the create-rule button targets this one. */
  selectedRuleSet: RuleSet | undefined;
  selectedRuleSetId: string;
  setSelectedRuleSetId: (id: string) => void;
  /** All rule sets belonging to the currently selected project. */
  projectRuleSets: RuleSet[];

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
    openRuleSetModal: (ruleSet?: RuleSet) => void;
    openRulePanel: (kind: Rule["kind"], rule?: Rule) => void;
    openBatchRulePanel: (kind?: Rule["kind"]) => void;
    duplicateRule: (rule: Rule, project?: Project | null, ruleSet?: RuleSet | null) => void;
    openRuleCopyModal: (rule: Rule, project?: Project | null, ruleSet?: RuleSet | null) => void;
    openRuleSetCopyModal: (ruleSet: RuleSet) => void;
    deleteRule: (rule: Rule) => void | Promise<void>;
    toggleRule: (rule: Rule) => void | Promise<void>;
    toggleProject: (project: Project) => void | Promise<void>;
    deleteProject: (project: Project) => void | Promise<void>;
    toggleRuleSet: (ruleSet: RuleSet) => void | Promise<void>;
    deleteRuleSet: (ruleSet: RuleSet) => void | Promise<void>;
  };
}

/**
 * Top-level "Rules" view: project / kind / status filters, the rule table
 * grouped by ruleSet with row-level actions, and the bottom status bar.
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
          <GroupedRuleTable
            rows={props.filteredRuleRows}
            busy={props.busy}
            actions={props.actions}
            dashboard={props.dashboard}
            selectedProjectId={props.selectedProjectId}
            projectRuleSets={props.projectRuleSets}
          />
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
  const { selectedProject, projects, busy, actions, projectRuleSets } = props;
  return (
    <div className="page-toolbar">
      <div className="toolbar-filters">
        <CustomSelect
          className="cs-wide"
          value={props.selectedProjectId}
          options={[
            { value: "", label: "全部站点" },
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
              title="编辑站点"
              onClick={() => actions.openProjectModal(selectedProject)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                <path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z" />
              </svg>
            </button>
            <button
              className={`btn btn-ghost btn-sm ${!selectedProject.enabled ? "is-off" : ""}`}
              title={selectedProject.enabled ? "停用站点" : "启用站点"}
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
              title="删除站点"
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

        {selectedProject && (
          <>
            <div className="toolbar-divider" />
            <CustomSelect
              value={props.selectedRuleSetId || (props.selectedRuleSet?.id ?? "")}
              options={[
                ...projectRuleSets.map((rs) => ({
                  value: rs.id,
                  label: `${rs.name}${rs.enabled ? "" : "（已停用）"}`,
                })),
              ]}
              onChange={props.setSelectedRuleSetId}
            />
            <button
              className="btn btn-ghost btn-sm"
              title="新建分组"
              onClick={() => actions.openRuleSetModal()}
              disabled={busy}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </>
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
  const summary = formatProjectScopeSummary(project);
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
        <span className={project.siteMatchPatterns?.length ? "site-scope-pattern" : "site-scope-empty"}>
          {summary}
        </span>
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

interface GroupedRuleTableProps {
  rows: RuleRow[];
  busy: boolean;
  actions: RulesViewProps["actions"];
  dashboard: DashboardState | null;
  selectedProjectId: string;
  projectRuleSets: RuleSet[];
}

/**
 * Renders the rule table grouped by ruleSet. A "group header" row precedes
 * each group's rules with the group's name, enable toggle, and management
 * actions. When no project filter is active, also shows orphan rules (no
 * ruleSet) at the bottom in a sentinel group.
 */
function GroupedRuleTable({
  rows,
  busy,
  actions,
  dashboard,
  selectedProjectId,
  projectRuleSets,
}: GroupedRuleTableProps) {
  // Preserve sort order from the parent — we just bucket rows by ruleSet id.
  // The parent already filters by project, so when a project is selected, the
  // only groups that show up belong to that project.
  const grouped = new Map<string, { ruleSet: RuleSet | null; rows: RuleRow[] }>();
  for (const row of rows) {
    const key = row.ruleSet?.id ?? "__orphan__";
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.rows.push(row);
    } else {
      grouped.set(key, { ruleSet: row.ruleSet, rows: [row] });
    }
  }

  // When a project is selected, also include any of its empty groups so the
  // user can see "tables (0 条规则)" instead of an invisible group they just
  // created. Empty groups only appear when the project filter is active to
  // avoid cluttering the "all sites" view.
  if (selectedProjectId) {
    for (const ruleSet of projectRuleSets) {
      if (!grouped.has(ruleSet.id)) {
        grouped.set(ruleSet.id, { ruleSet, rows: [] });
      }
    }
  }

  const groups = Array.from(grouped.values()).sort((a, b) => {
    if (!a.ruleSet && b.ruleSet) return 1;
    if (a.ruleSet && !b.ruleSet) return -1;
    if (!a.ruleSet || !b.ruleSet) return 0;
    return a.ruleSet.name.localeCompare(b.ruleSet.name);
  });

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
            <th className="col-actions" style={{ width: 160 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group, gi) => (
            <React.Fragment key={group.ruleSet?.id ?? `orphan-${gi}`}>
              <GroupHeaderRow
                ruleSet={group.ruleSet}
                ruleCount={group.rows.length}
                busy={busy}
                actions={actions}
              />
              {group.rows.map(({ rule, project, ruleSet }, index) => (
                <RuleTableRow
                  key={rule.id}
                  rule={rule}
                  project={project}
                  ruleSet={ruleSet}
                  index={index}
                  busy={busy}
                  actions={actions}
                />
              ))}
            </React.Fragment>
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

function GroupHeaderRow({
  ruleSet,
  ruleCount,
  busy,
  actions,
}: {
  ruleSet: RuleSet | null;
  ruleCount: number;
  busy: boolean;
  actions: RulesViewProps["actions"];
}) {
  if (!ruleSet) {
    return (
      <tr className="rule-group-row">
        <td colSpan={8}>
          <div className="rule-group-header is-orphan">
            <span className="rule-group-name">未归类规则</span>
            <span className="rule-group-meta">{ruleCount} 条</span>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className={`rule-group-row${ruleSet.enabled ? "" : " is-disabled"}`}>
      <td colSpan={8}>
        <div className="rule-group-header">
          <label className="toggle-switch toggle-switch-sm" title={ruleSet.enabled ? "停用此分组" : "启用此分组"}>
            <input
              type="checkbox"
              checked={ruleSet.enabled}
              onChange={() => void actions.toggleRuleSet(ruleSet)}
              disabled={busy}
            />
            <span className="toggle-track" />
          </label>
          <span className="rule-group-name">{ruleSet.name}</span>
          <span className="rule-group-meta">{ruleCount} 条规则</span>
          {formatRuleSetScopeSummary(ruleSet) && (
            <span
              className="rule-group-patterns"
              title={formatRuleSetScopeSummary(ruleSet)}
            >
              {formatRuleSetScopeSummary(ruleSet)}
            </span>
          )}
          {!ruleSet.enabled && <span className="rule-group-badge">已停用</span>}
          <div className="rule-group-actions">
            <button
              className="btn-icon"
              title="编辑分组"
              onClick={() => actions.openRuleSetModal(ruleSet)}
              disabled={busy}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              className="btn-icon"
              title="复制到站点"
              onClick={() => actions.openRuleSetCopyModal(ruleSet)}
              disabled={busy}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M14 4h6v6" />
                <path d="M10 14 20 4" />
                <path d="M20 14v6h-6" />
                <path d="M4 10 14 20" />
              </svg>
            </button>
            <button
              className="btn-icon btn-icon-danger"
              title="删除分组"
              onClick={() => void actions.deleteRuleSet(ruleSet)}
              disabled={busy}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

function RuleTableRow({
  rule,
  project,
  ruleSet,
  index,
  busy,
  actions,
}: {
  rule: Rule;
  project: Project | null;
  ruleSet: RuleSet | null;
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
          <button className="btn-icon" title="复制为草稿" onClick={() => actions.duplicateRule(rule, project, ruleSet)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          </button>
          <button className="btn-icon" title="复制到..." onClick={() => actions.openRuleCopyModal(rule, project, ruleSet)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M14 4h6v6" />
              <path d="M10 14 20 4" />
              <path d="M20 14v6h-6" />
              <path d="M4 10 14 20" />
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
