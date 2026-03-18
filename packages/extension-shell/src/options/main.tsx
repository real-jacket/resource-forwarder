import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  collectRuleConflicts,
  collectUnsupportedRuleWarnings,
  sortRules,
} from "@resource-forwarder/rule-core";
import type {
  MatchResourceType,
  Project,
  Rule,
  RuleSet,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import { createId, joinCsv, splitCsv } from "../shared/helpers.js";
import type {
  DashboardState,
  ExportWorkspaceRuntimeResponse,
  GetDashboardStateResponse,
  SyncWorkspaceResponse,
  UpsertMutationResponse,
} from "../shared/messages.js";
import { runtimeRequest } from "../shared/messages.js";

type DrawerMode = "settings" | "project" | "rule" | "rule-batch" | null;
type SettingsTab = "site" | "logs" | "share";

interface ProjectDraft {
  id: string;
  name: string;
  siteHosts: string;
  envLabel: string;
  note: string;
  enabled: boolean;
}

interface RuleDraft {
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
}

interface BatchRuleDraft extends RuleDraft {
  localId: string;
}

const defaultApiTypes: MatchResourceType[] = ["fetch", "xmlhttprequest"];
const defaultAssetTypes: MatchResourceType[] = ["script", "stylesheet", "image", "font"];

const emptyProjectDraft = (): ProjectDraft => ({
  id: "",
  name: "",
  siteHosts: "",
  envLabel: "",
  note: "",
  enabled: true,
});

function App() {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("site");
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>(emptyProjectDraft());
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(createRuleDraft());
  const [batchRuleDrafts, setBatchRuleDrafts] = useState<BatchRuleDraft[]>([]);
  const [serviceUrl, setServiceUrl] = useState("");
  const [importText, setImportText] = useState("");
  const [exportText, setExportText] = useState("");
  const [exportFormat, setExportFormat] = useState<"json" | "yaml">("yaml");
  const [status, setStatus] = useState("正在加载规则...");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  const projects = dashboard?.workspace.projects ?? [];
  const ruleSets = dashboard?.workspace.ruleSets ?? [];
  const rules = dashboard?.workspace.rules ?? [];
  const logs = dashboard?.logs ?? [];
  const currentHost = dashboard?.currentTab?.host ?? "";

  const selectedProject = useMemo(
    () =>
      projects.find((project) => project.id === selectedProjectId) ??
      projects.find((project) => project.siteHosts.includes(currentHost)) ??
      projects[0],
    [projects, selectedProjectId, currentHost],
  );

  const selectedProjectRuleSets = useMemo(
    () => ruleSets.filter((ruleSet) => ruleSet.projectId === selectedProject?.id),
    [ruleSets, selectedProject?.id],
  );

  const selectedRuleSet = selectedProjectRuleSets[0];
  const selectedRuleIds = useMemo(
    () => new Set(selectedProjectRuleSets.flatMap((ruleSet) => ruleSet.ruleIds)),
    [selectedProjectRuleSets],
  );

  const selectedRules = useMemo(
    () =>
      sortRules(rules.filter((rule) => selectedRuleIds.has(rule.id))).sort((left, right) => {
        if (left.enabled !== right.enabled) {
          return left.enabled ? -1 : 1;
        }
        return 0;
      }),
    [rules, selectedRuleIds],
  );

  const filteredLogs = useMemo(
    () => logs.filter((log) => (selectedProject ? log.projectId === selectedProject.id : true)),
    [logs, selectedProject],
  );

  const siteViews = useMemo(
    () =>
      projects
        .map((project) => {
          const scopedRuleSets = ruleSets.filter((ruleSet) => ruleSet.projectId === project.id);
          const ruleCount = scopedRuleSets.reduce((sum, ruleSet) => sum + ruleSet.ruleIds.length, 0);
          const projectLogs = logs.filter((log) => log.projectId === project.id);
          return {
            project,
            ruleCount,
            hitCount: projectLogs.length,
            matchesCurrent: project.siteHosts.includes(currentHost),
          };
        })
        .sort((left, right) => {
          if (left.matchesCurrent !== right.matchesCurrent) {
            return left.matchesCurrent ? -1 : 1;
          }
          if (left.project.enabled !== right.project.enabled) {
            return left.project.enabled ? -1 : 1;
          }
          return left.project.name.localeCompare(right.project.name, "zh-CN");
        }),
    [projects, ruleSets, logs, currentHost],
  );

  const selectedApiRuleCount = useMemo(
    () => selectedRules.filter((rule) => rule.kind === "api_forward").length,
    [selectedRules],
  );

  const selectedAssetRuleCount = useMemo(
    () => selectedRules.filter((rule) => rule.kind === "asset_redirect").length,
    [selectedRules],
  );

  const draftRule = useMemo(() => {
    if (!dashboard || !selectedProject) {
      return null;
    }
    try {
      return toRule(ruleDraft, dashboard.workspace, selectedProject);
    } catch {
      return null;
    }
  }, [dashboard, selectedProject, ruleDraft]);

  const ruleConflicts = useMemo(() => {
    if (!dashboard || !draftRule) {
      return [];
    }
    return collectRuleConflicts(dashboard.workspace, draftRule);
  }, [dashboard, draftRule]);

  const ruleWarnings = useMemo(
    () => (draftRule ? collectUnsupportedRuleWarnings(draftRule).map(localizeWarning) : []),
    [draftRule],
  );

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      const state = await runtimeRequest<GetDashboardStateResponse>({ type: "get-dashboard-state" });
      hydrateDashboard(state);
      setStatus(state.health ? "规则已同步。" : "未连接到本地服务，请先在设置里检查服务地址。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "加载规则失败。");
    } finally {
      setBusy(false);
    }
  }

  function hydrateDashboard(state: DashboardState): void {
    setDashboard(state);
    setServiceUrl(state.serviceUrl);
    setSelectedProjectId((current) => {
      if (current && state.workspace.projects.some((project) => project.id === current)) {
        return current;
      }
      const matched = state.workspace.projects.find((project) =>
        project.siteHosts.includes(state.currentTab?.host ?? ""),
      );
      return matched?.id ?? state.workspace.projects[0]?.id ?? "";
    });
  }

  function openSettings(tab: SettingsTab = "site"): void {
    setSettingsTab(tab);
    setDrawerMode("settings");
  }

  function openProjectEditor(project?: Project): void {
    setProjectDraft(project ? fromProject(project) : emptyProjectDraft());
    setDrawerMode("project");
  }

  function openRuleEditor(kind: Rule["kind"], rule?: Rule): void {
    if (!selectedProject || !selectedRuleSet) {
      setStatus("请先创建一个站点，再添加规则。");
      return;
    }
    setRuleDraft(createRuleDraft({ project: selectedProject, ruleSet: selectedRuleSet, kind, rule }));
    setDrawerMode("rule");
  }

  function openBatchRuleEditor(kind: Rule["kind"] = "api_forward"): void {
    if (!selectedProject || !selectedRuleSet) {
      setStatus("请先创建一个站点，再添加规则。");
      return;
    }
    setBatchRuleDrafts([createBatchRuleDraft({ project: selectedProject, ruleSet: selectedRuleSet, kind })]);
    setDrawerMode("rule-batch");
  }

  function openBatchRuleEditorForProject(projectId: string, kind: Rule["kind"] = "api_forward"): void {
    const project = projects.find((item) => item.id === projectId);
    const ruleSet = ruleSets.find((item) => item.projectId === projectId);
    if (!project || !ruleSet) {
      setStatus("这个站点还没有可用规则组，请先检查站点配置。");
      return;
    }
    setSelectedProjectId(projectId);
    setBatchRuleDrafts([createBatchRuleDraft({ project, ruleSet, kind })]);
    setDrawerMode("rule-batch");
  }

  function appendBatchRuleDraft(): void {
    if (!selectedProject || !selectedRuleSet) {
      setStatus("请先创建一个站点，再添加规则。");
      return;
    }
    setBatchRuleDrafts((current) => {
      const previous = current[current.length - 1];
      return [
        ...current,
        createBatchRuleDraft({
          project: selectedProject,
          ruleSet: selectedRuleSet,
          kind: previous?.kind ?? "api_forward",
          source: previous,
        }),
      ];
    });
  }

  function updateBatchRuleDraft(localId: string, patch: Partial<BatchRuleDraft>): void {
    setBatchRuleDrafts((current) =>
      current.map((draft) => (draft.localId === localId ? { ...draft, ...patch } : draft)),
    );
  }

  function removeBatchRuleDraft(localId: string): void {
    setBatchRuleDrafts((current) => current.filter((draft) => draft.localId !== localId));
  }

  async function saveServiceUrl(): Promise<void> {
    setBusy(true);
    try {
      const state = await runtimeRequest<SyncWorkspaceResponse>({ type: "set-service-url", serviceUrl });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setStatus(`本地服务地址已更新为 ${serviceUrl}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存服务地址失败。");
    } finally {
      setBusy(false);
    }
  }

  async function saveProject(): Promise<void> {
    if (!projectDraft.name.trim()) {
      setStatus("请输入站点名称。");
      return;
    }

    setBusy(true);
    try {
      const now = new Date().toISOString();
      const projectId = projectDraft.id || createId("project");
      const existingRuleSets =
        dashboard?.workspace.ruleSets.filter((ruleSet) => ruleSet.projectId === projectId) ?? [];
      const payload = {
        project: {
          id: projectId,
          name: projectDraft.name.trim(),
          enabled: projectDraft.enabled,
          siteHosts: splitCsv(projectDraft.siteHosts),
          envLabel: projectDraft.envLabel.trim() || undefined,
          note: projectDraft.note.trim() || undefined,
          tags: [],
          createdAt:
            dashboard?.workspace.projects.find((project) => project.id === projectId)?.createdAt ?? now,
          updatedAt: now,
        },
        ruleSets:
          existingRuleSets.length > 0
            ? existingRuleSets
            : [
                {
                  id: createId("ruleset"),
                  projectId,
                  name: `${projectDraft.name.trim()} 默认规则组`,
                  enabled: true,
                  ruleIds: [],
                  createdAt: now,
                  updatedAt: now,
                },
              ],
      };

      const state = await runtimeRequest<UpsertMutationResponse>({ type: "upsert-project", payload });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setSelectedProjectId(projectId);
      setDrawerMode("settings");
      setSettingsTab("site");
      setProjectDraft(emptyProjectDraft());
      setStatus(`站点「${payload.project.name}」已保存。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存站点失败。");
    } finally {
      setBusy(false);
    }
  }

  async function saveRule(): Promise<void> {
    if (!dashboard || !selectedProject) {
      setStatus("请先选择站点。");
      return;
    }

    setBusy(true);
    try {
      const rule = toRule(ruleDraft, dashboard.workspace, selectedProject);
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-rule",
        payload: {
          rule,
          ruleSetId: ruleDraft.ruleSetId,
        },
      });
      hydrateDashboard({ ...state, logs: dashboard.logs, currentTab: dashboard.currentTab });
      setDrawerMode(null);
      setRuleDraft(createRuleDraft({ project: selectedProject, ruleSet: selectedRuleSet, kind: rule.kind }));
      setStatus(`规则「${rule.name}」已保存。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存规则失败。");
    } finally {
      setBusy(false);
    }
  }

  async function saveBatchRules(): Promise<void> {
    if (!dashboard || !selectedProject || !selectedRuleSet) {
      setStatus("请先选择站点。");
      return;
    }

    if (batchRuleDrafts.length === 0) {
      setStatus("请先添加至少一条规则。");
      return;
    }

    setBusy(true);
    let nextState: UpsertMutationResponse | null = null;
    let workspace = dashboard.workspace;
    let savedCount = 0;

    try {
      for (let index = 0; index < batchRuleDrafts.length; index += 1) {
        const draft = batchRuleDrafts[index];
        const rule = toRule(draft, workspace, selectedProject);
        try {
          const state = await runtimeRequest<UpsertMutationResponse>({
            type: "upsert-rule",
            payload: {
              rule,
              ruleSetId: draft.ruleSetId,
            },
          });
          nextState = state;
          workspace = state.workspace;
          savedCount += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : "未知错误";
          throw new Error(`第 ${index + 1} 条规则保存失败：${message}`);
        }
      }

      if (nextState) {
        hydrateDashboard({ ...nextState, logs: dashboard.logs, currentTab: dashboard.currentTab });
      }
      setBatchRuleDrafts([]);
      setDrawerMode(null);
      setStatus(`已连续保存 ${savedCount} 条规则。`);
    } catch (error) {
      if (nextState) {
        hydrateDashboard({ ...nextState, logs: dashboard.logs, currentTab: dashboard.currentTab });
      }
      setStatus(error instanceof Error ? error.message : "保存规则失败。");
    } finally {
      setBusy(false);
    }
  }

  async function toggleProject(project: Project): Promise<void> {
    setBusy(true);
    try {
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-project",
        payload: {
          project: { ...project, enabled: !project.enabled },
          ruleSets: ruleSets.filter((ruleSet) => ruleSet.projectId === project.id),
        },
      });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setStatus(`站点「${project.name}」已${project.enabled ? "停用" : "启用"}。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "切换站点状态失败。");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(rule: Rule): Promise<void> {
    setBusy(true);
    try {
      const owningRuleSet = ruleSets.find((ruleSet) => ruleSet.ruleIds.includes(rule.id));
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-rule",
        payload: {
          rule: { ...rule, enabled: !rule.enabled },
          ruleSetId: owningRuleSet?.id,
        },
      });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setStatus(`规则「${rule.name}」已${rule.enabled ? "停用" : "启用"}。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "切换规则状态失败。");
    } finally {
      setBusy(false);
    }
  }

  async function importWorkspace(merge: boolean): Promise<void> {
    if (!importText.trim()) {
      setStatus("请先粘贴要导入的 JSON 或 YAML。");
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
      setStatus(merge ? "规则已合并导入。" : "规则工作区已整体替换。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导入失败。");
    } finally {
      setBusy(false);
    }
  }

  async function exportWorkspace(projectId: string): Promise<void> {
    setBusy(true);
    try {
      const response = await runtimeRequest<ExportWorkspaceRuntimeResponse>({
        type: "export-workspace",
        projectId,
        format: exportFormat,
      });
      setExportText(response.content);
      setDrawerMode("settings");
      setSettingsTab("share");
      setStatus(`已导出站点规则（${response.format.toUpperCase()}）。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="minimal-app-shell">
      <section className="hero minimal-hero">
        <div className="stack compact-gap">
          <span className="kicker">资源转发器</span>
          <h1>先看规则，其他操作都收进设置。</h1>
          <p className="muted">
            默认页面只保留你最常用的规则列表；站点管理、服务地址、日志、导入导出都放进设置弹窗。
          </p>
        </div>

        <div className="hero-controls">
          <label className="stack compact-gap control-block">
            <span className="label">当前站点</span>
            <select
              value={selectedProject?.id ?? ""}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              disabled={projects.length === 0}
            >
              {projects.length === 0 ? <option value="">请先创建站点</option> : null}
              {siteViews.map((item) => (
                <option key={item.project.id} value={item.project.id}>
                  {item.project.name}
                  {item.matchesCurrent ? " · 当前页面" : ""}
                </option>
              ))}
            </select>
          </label>

          <div className="row wrap-gap hero-actions">
            <button onClick={() => openBatchRuleEditor("api_forward")} disabled={busy || !selectedRuleSet}>
              新建规则
            </button>
            <button className="secondary" onClick={() => openSettings("site")}>
              设置
            </button>
            <button className="ghost" onClick={() => void refresh()} disabled={busy}>
              刷新
            </button>
          </div>
        </div>

        <div className="row wrap-gap status-row">
          <span className={`badge ${dashboard?.health ? "success" : "danger"}`}>
            {dashboard?.health ? "本地服务已连接" : "本地服务未连接"}
          </span>
          <span className="badge neutral">当前标签页 {dashboard?.currentTab?.host || "未检测到"}</span>
          {selectedProject ? (
            <span className={`badge ${selectedProject.enabled ? "success" : "warning"}`}>
              {selectedProject.enabled ? "站点启用中" : "站点已停用"}
            </span>
          ) : null}
        </div>
      </section>

      <section className="card rule-focus-card">
        {selectedProject ? (
          <>
            <div className="row between align-start">
              <div className="stack compact-gap">
                <h2>{selectedProject.name}</h2>
                <p className="muted small">
                  {joinCsv(selectedProject.siteHosts)}
                  {selectedProject.envLabel ? ` · ${selectedProject.envLabel}` : ""}
                </p>
              </div>
              <div className="row wrap-gap compact-actions">
                <span className="badge neutral">API {selectedApiRuleCount}</span>
                <span className="badge neutral">资源 {selectedAssetRuleCount}</span>
                <span className="badge neutral">命中 {filteredLogs.length}</span>
                <button className="secondary" onClick={() => openBatchRuleEditor("api_forward")} disabled={!selectedRuleSet || busy}>
                  在当前站点新增 API
                </button>
                <button className="ghost" onClick={() => openBatchRuleEditor("asset_redirect")} disabled={!selectedRuleSet || busy}>
                  新增资源规则
                </button>
              </div>
            </div>

            <div className="rule-list minimal-rule-list">
              {selectedRules.map((rule) => (
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
                    <p className="small muted">
                      {joinCsv(rule.match.host) || "继承站点 Host"} · {rule.match.pathGlob}
                    </p>
                    <p className="target-line">{formatRuleTarget(rule)}</p>
                  </div>
                  <div className="rule-row-actions">
                    <button className="ghost" onClick={() => openRuleEditor(rule.kind, rule)}>
                      编辑
                    </button>
                  </div>
                </article>
              ))}

              {selectedRules.length === 0 ? (
                <div className="empty-state large-empty-state">
                  <p>当前站点还没有规则。</p>
                  <p className="small muted">从最基础开始，先新建一条规则，只填“匹配路径”和“目标地址”。</p>
                  <div className="row wrap-gap">
                    <button onClick={() => openBatchRuleEditor("api_forward")} disabled={!selectedRuleSet || busy}>
                      新建 API 规则
                    </button>
                    <button
                      className="secondary"
                      onClick={() => openBatchRuleEditor("asset_redirect")}
                      disabled={!selectedRuleSet || busy}
                    >
                      新建资源规则
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <div className="empty-state large-empty-state">
            <p>还没有站点配置。</p>
            <p className="small muted">先建一个站点，把 Host 归拢起来，主页面就只会显示这个站点的规则。</p>
            <div className="row wrap-gap">
              <button onClick={() => openProjectEditor()}>新建站点</button>
              <button className="secondary" onClick={() => openSettings("site")}>
                打开设置
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="status-footer card compact-card">
        <div className="row between align-start">
          <div className="stack compact-gap">
            <span className="label">当前状态</span>
            <p>{status}</p>
          </div>
          <button className="ghost" onClick={() => openSettings("logs")}>
            查看日志
          </button>
        </div>
      </section>

      {drawerMode ? (
        <div className="modal-backdrop" onClick={() => setDrawerMode(null)}>
          <aside
            className={`modal-panel ${drawerMode === "rule" || drawerMode === "rule-batch" ? "wide-panel" : ""}`}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-header">
              <div className="stack compact-gap">
                <span className="kicker">{drawerTitle(drawerMode)}</span>
                <h3>
                  {drawerHeadline(
                    drawerMode,
                    projectDraft.id,
                    ruleDraft.id,
                    selectedProject?.name,
                    batchRuleDrafts.length,
                  )}
                </h3>
              </div>
              <button className="ghost" onClick={() => setDrawerMode(null)}>
                关闭
              </button>
            </div>

            {drawerMode === "settings" ? (
              <div className="modal-body stack">
                {selectedProject ? (
                  <section className="modal-context">
                    <div className="modal-context-main">
                      <span className="label">当前站点</span>
                      <strong>{selectedProject.name}</strong>
                      <p className="small muted">{joinCsv(selectedProject.siteHosts) || "未填写 Host"}</p>
                    </div>
                    <div className="row wrap-gap">
                      {selectedProject.envLabel ? <span className="badge neutral">{selectedProject.envLabel}</span> : null}
                      <span className={`badge ${selectedProject.siteHosts.includes(currentHost) ? "success" : "warning"}`}>
                        {selectedProject.siteHosts.includes(currentHost) ? "当前页面已命中" : "当前页面未命中"}
                      </span>
                    </div>
                  </section>
                ) : null}
                <div className="settings-tabs">
                  <button
                    className={settingsTab === "site" ? "active-segment" : "ghost"}
                    onClick={() => setSettingsTab("site")}
                  >
                    设置
                  </button>
                  <button
                    className={settingsTab === "logs" ? "active-segment" : "ghost"}
                    onClick={() => setSettingsTab("logs")}
                  >
                    日志
                  </button>
                  <button
                    className={settingsTab === "share" ? "active-segment" : "ghost"}
                    onClick={() => setSettingsTab("share")}
                  >
                    导入导出
                  </button>
                </div>

                {settingsTab === "site" ? (
                  <div className="stack">
                    <section className="mini-section stack compact-gap">
                      <span className="label">本地服务地址</span>
                      <input
                        value={serviceUrl}
                        onChange={(event) => setServiceUrl(event.target.value)}
                        placeholder="http://127.0.0.1:5178"
                      />
                      <div className="row wrap-gap">
                        <button onClick={() => void saveServiceUrl()} disabled={busy}>
                          保存地址
                        </button>
                        <button className="secondary" onClick={() => void refresh()} disabled={busy}>
                          立即同步
                        </button>
                      </div>
                    </section>

                    <section className="mini-section stack compact-gap">
                      <div className="row between align-start">
                        <div className="stack compact-gap">
                          <span className="label">站点</span>
                          <p className="small muted">只在这里做站点管理，主页面始终保持规则列表优先。</p>
                        </div>
                        <button className="secondary" onClick={() => openProjectEditor()}>
                          新建站点
                        </button>
                      </div>

                      <div className="site-mini-list">
                        {siteViews.map((item) => (
                          <article
                            key={item.project.id}
                            className={`site-mini-item ${selectedProject?.id === item.project.id ? "active" : ""}`}
                          >
                            <button className="site-mini-main" onClick={() => setSelectedProjectId(item.project.id)}>
                              <div className="stack compact-gap">
                                <span className="site-title">{item.project.name}</span>
                                <span className="site-hosts">{joinCsv(item.project.siteHosts) || "未填写 Host"}</span>
                              </div>
                              <div className="row wrap-gap site-mini-meta">
                                <span>{item.ruleCount} 条规则</span>
                                <span>{item.hitCount} 次命中</span>
                              </div>
                            </button>
                            <div className="site-mini-actions">
                              <button className="ghost" onClick={() => setSelectedProjectId(item.project.id)}>
                                查看规则
                              </button>
                              <button
                                className="secondary"
                                onClick={() => openBatchRuleEditorForProject(item.project.id, "api_forward")}
                                disabled={busy}
                              >
                                在此站点新增
                              </button>
                            </div>
                          </article>
                        ))}
                        {siteViews.length === 0 ? <div className="empty-state">还没有站点。</div> : null}
                      </div>

                      {selectedProject ? (
                        <div className="row wrap-gap">
                          <button className="secondary" onClick={() => openProjectEditor(selectedProject)}>
                            编辑当前站点
                          </button>
                          <button className="ghost" onClick={() => void toggleProject(selectedProject)} disabled={busy}>
                            {selectedProject.enabled ? "停用当前站点" : "启用当前站点"}
                          </button>
                        </div>
                      ) : null}
                    </section>
                  </div>
                ) : null}

                {settingsTab === "logs" ? (
                  <section className="mini-section stack compact-gap">
                    <span className="label">最近命中</span>
                    <div className="log-list">
                      {filteredLogs.map((log) => (
                        <article className="item" key={log.id}>
                          <div className="stack compact-gap">
                            <div className="row between align-start">
                              <h4>
                                {log.method} {shorten(log.requestUrl)}
                              </h4>
                              <span className="micro-code">{formatTimestamp(log.occurredAt)}</span>
                            </div>
                            <p className="small muted">
                              {log.outcome === "matched" ? "已命中" : log.outcome === "error" ? "执行失败" : "未处理"}
                              {` · ${log.statusCode ?? "-"} · ${log.durationMs} ms`}
                            </p>
                          </div>
                        </article>
                      ))}
                      {filteredLogs.length === 0 ? <div className="empty-state">当前站点还没有命中记录。</div> : null}
                    </div>
                  </section>
                ) : null}

                {settingsTab === "share" ? (
                  <div className="stack">
                    <section className="mini-section stack compact-gap">
                      <div className="row between align-start">
                        <div className="stack compact-gap">
                          <span className="label">导入规则</span>
                          <p className="small muted">支持 JSON / YAML，适合团队共享或迁移。</p>
                        </div>
                        <div className="row wrap-gap">
                          <button className="ghost" onClick={() => void importWorkspace(true)} disabled={busy}>
                            合并导入
                          </button>
                          <button onClick={() => void importWorkspace(false)} disabled={busy}>
                            整体替换
                          </button>
                        </div>
                      </div>
                      <textarea
                        value={importText}
                        onChange={(event) => setImportText(event.target.value)}
                        placeholder="粘贴 JSON 或 YAML 规则配置"
                      />
                    </section>

                    <section className="mini-section stack compact-gap">
                      <div className="row between align-start">
                        <div className="stack compact-gap">
                          <span className="label">导出当前站点</span>
                          <p className="small muted">只导出当前站点与它的规则。</p>
                        </div>
                        <div className="row wrap-gap">
                          <select
                            value={exportFormat}
                            onChange={(event) => setExportFormat(event.target.value as "json" | "yaml")}
                          >
                            <option value="yaml">YAML</option>
                            <option value="json">JSON</option>
                          </select>
                          <button
                            onClick={() => selectedProject && void exportWorkspace(selectedProject.id)}
                            disabled={busy || !selectedProject}
                          >
                            导出
                          </button>
                        </div>
                      </div>
                      <textarea
                        value={exportText}
                        onChange={(event) => setExportText(event.target.value)}
                        placeholder="点击导出后会在这里展示配置文本"
                      />

                      <div className="warning-list compact-gap">
                        {(dashboard?.warnings ?? []).map((warning) => (
                          <div className="warning-item" key={warning}>
                            {localizeWarning(warning)}
                          </div>
                        ))}
                        {(dashboard?.warnings ?? []).length === 0 ? (
                          <p className="small muted">当前没有全局能力告警。</p>
                        ) : null}
                      </div>
                    </section>
                  </div>
                ) : null}
              </div>
            ) : null}

            {drawerMode === "project" ? (
              <div className="modal-body stack">
                <section className="modal-context">
                  <div className="modal-context-main">
                    <span className="label">{projectDraft.id ? "正在编辑站点" : "即将创建站点"}</span>
                    <strong>{projectDraft.name || selectedProject?.name || "未命名站点"}</strong>
                    <p className="small muted">
                      {projectDraft.siteHosts || joinCsv(selectedProject?.siteHosts) || "保存后这里会用来匹配页面 Host"}
                    </p>
                  </div>
                  <div className="row wrap-gap">
                    <span className={`badge ${(projectDraft.enabled || (!projectDraft.id && selectedProject?.enabled)) ? "success" : "warning"}`}>
                      {(projectDraft.enabled || (!projectDraft.id && selectedProject?.enabled)) ? "默认启用" : "默认停用"}
                    </span>
                  </div>
                </section>
                <label className="stack compact-gap">
                  <span className="label">站点名称</span>
                  <input
                    value={projectDraft.name}
                    onChange={(event) =>
                      setProjectDraft((value) => ({ ...value, name: event.target.value }))
                    }
                    placeholder="例如：App 主站"
                  />
                </label>
                <label className="stack compact-gap">
                  <span className="label">Host 列表</span>
                  <input
                    value={projectDraft.siteHosts}
                    onChange={(event) =>
                      setProjectDraft((value) => ({ ...value, siteHosts: event.target.value }))
                    }
                    placeholder="app.example.com, admin.example.com"
                  />
                </label>
                <div className="grid two compact-grid">
                  <label className="stack compact-gap">
                    <span className="label">环境标签</span>
                    <input
                      value={projectDraft.envLabel}
                      onChange={(event) =>
                        setProjectDraft((value) => ({ ...value, envLabel: event.target.value }))
                      }
                      placeholder="staging / local"
                    />
                  </label>
                  <label className="stack compact-gap checkbox-line">
                    <span className="label">默认状态</span>
                    <span className="toggle-line">
                      <input
                        type="checkbox"
                        checked={projectDraft.enabled}
                        onChange={(event) =>
                          setProjectDraft((value) => ({ ...value, enabled: event.target.checked }))
                        }
                      />
                      启用站点
                    </span>
                  </label>
                </div>
                <label className="stack compact-gap">
                  <span className="label">备注</span>
                  <textarea
                    value={projectDraft.note}
                    onChange={(event) =>
                      setProjectDraft((value) => ({ ...value, note: event.target.value }))
                    }
                    placeholder="写清楚这个站点主要用来覆盖哪个环境。"
                  />
                </label>
                <div className="row between wrap-gap">
                  <button className="ghost" onClick={() => openSettings("site")}>
                    返回设置
                  </button>
                  <button onClick={() => void saveProject()} disabled={busy}>
                    保存站点
                  </button>
                </div>
              </div>
            ) : null}

            {drawerMode === "rule" ? (
              <div className="modal-body stack">
                {selectedProject ? (
                  <section className="modal-context strong-context">
                    <div className="modal-context-main">
                      <span className="label">所属站点</span>
                      <strong>{selectedProject.name}</strong>
                      <p className="small muted">{joinCsv(selectedProject.siteHosts) || "未填写 Host"}</p>
                    </div>
                    <div className="modal-context-meta">
                      <span className={`badge ${selectedProject.siteHosts.includes(currentHost) ? "success" : "warning"}`}>
                        {selectedProject.siteHosts.includes(currentHost) ? "当前页面命中此站点" : "当前页面未命中此站点"}
                      </span>
                      {selectedRuleSet ? <span className="badge neutral">规则组 {selectedRuleSet.name}</span> : null}
                    </div>
                  </section>
                ) : null}
                <div className="segmented-row compact-segmented-row">
                  <button
                    className={ruleDraft.kind === "api_forward" ? "active-segment" : "ghost"}
                    onClick={() =>
                      setRuleDraft((value) => ({
                        ...value,
                        kind: "api_forward",
                        resourceType: joinCsv(defaultApiTypes),
                        method: "GET, POST",
                      }))
                    }
                  >
                    API 转发
                  </button>
                  <button
                    className={ruleDraft.kind === "asset_redirect" ? "active-segment" : "ghost"}
                    onClick={() =>
                      setRuleDraft((value) => ({
                        ...value,
                        kind: "asset_redirect",
                        resourceType: joinCsv(defaultAssetTypes),
                        method: "",
                      }))
                    }
                  >
                    资源替换
                  </button>
                </div>

                <label className="stack compact-gap">
                  <span className="label">规则名称</span>
                  <input
                    value={ruleDraft.name}
                    onChange={(event) =>
                      setRuleDraft((value) => ({ ...value, name: event.target.value }))
                    }
                    placeholder="例如：把 /api 指到本地服务"
                  />
                </label>
                <label className="stack compact-gap">
                  <span className="label">匹配路径</span>
                  <input
                    value={ruleDraft.pathGlob}
                    onChange={(event) =>
                      setRuleDraft((value) => ({ ...value, pathGlob: event.target.value }))
                    }
                    placeholder="/api/**"
                  />
                </label>
                {ruleDraft.kind === "api_forward" ? (
                  <label className="stack compact-gap">
                    <span className="label">目标地址</span>
                    <input
                      value={ruleDraft.targetBaseUrl}
                      onChange={(event) =>
                        setRuleDraft((value) => ({ ...value, targetBaseUrl: event.target.value }))
                      }
                      placeholder="http://127.0.0.1:3000"
                    />
                  </label>
                ) : (
                  <label className="stack compact-gap">
                    <span className="label">替换到的 HTTPS 地址</span>
                    <input
                      value={ruleDraft.redirectUrl}
                      onChange={(event) =>
                        setRuleDraft((value) => ({ ...value, redirectUrl: event.target.value }))
                      }
                      placeholder="https://cdn.example.com/app.js"
                    />
                  </label>
                )}

                <details className="advanced-panel">
                  <summary>高级选项</summary>
                  <div className="stack advanced-body">
                    <label className="stack compact-gap">
                      <span className="label">Host 覆盖（留空则沿用站点 Host）</span>
                      <input
                        value={ruleDraft.host}
                        onChange={(event) =>
                          setRuleDraft((value) => ({ ...value, host: event.target.value }))
                        }
                        placeholder={selectedProject ? joinCsv(selectedProject.siteHosts) : "app.example.com"}
                      />
                    </label>
                    <div className="grid two compact-grid">
                      <label className="stack compact-gap">
                        <span className="label">资源类型</span>
                        <input
                          value={ruleDraft.resourceType}
                          onChange={(event) =>
                            setRuleDraft((value) => ({ ...value, resourceType: event.target.value }))
                          }
                          placeholder={
                            ruleDraft.kind === "api_forward"
                              ? "fetch, xmlhttprequest"
                              : "script, stylesheet"
                          }
                        />
                      </label>
                      <label className="stack compact-gap">
                        <span className="label">HTTP 方法</span>
                        <input
                          value={ruleDraft.method}
                          onChange={(event) =>
                            setRuleDraft((value) => ({ ...value, method: event.target.value }))
                          }
                          placeholder="GET, POST"
                        />
                      </label>
                    </div>
                    {ruleDraft.kind === "api_forward" ? (
                      <>
                        <label className="stack compact-gap">
                          <span className="label">去掉路径前缀</span>
                          <input
                            value={ruleDraft.stripPrefix}
                            onChange={(event) =>
                              setRuleDraft((value) => ({ ...value, stripPrefix: event.target.value }))
                            }
                            placeholder="/api"
                          />
                        </label>
                        <label className="stack compact-gap">
                          <span className="label">注入 Header（JSON）</span>
                          <textarea
                            value={ruleDraft.headersJson}
                            onChange={(event) =>
                              setRuleDraft((value) => ({ ...value, headersJson: event.target.value }))
                            }
                            placeholder='{"x-forwarded-by":"resource-forwarder"}'
                          />
                        </label>
                      </>
                    ) : null}
                    <div className="grid two compact-grid">
                      <label className="stack compact-gap">
                        <span className="label">优先级</span>
                        <input
                          type="number"
                          value={ruleDraft.priority}
                          onChange={(event) =>
                            setRuleDraft((value) => ({ ...value, priority: Number(event.target.value) }))
                          }
                        />
                      </label>
                      <label className="stack compact-gap checkbox-line">
                        <span className="label">默认状态</span>
                        <span className="toggle-line">
                          <input
                            type="checkbox"
                            checked={ruleDraft.enabled}
                            onChange={(event) =>
                              setRuleDraft((value) => ({ ...value, enabled: event.target.checked }))
                            }
                          />
                          启用规则
                        </span>
                      </label>
                    </div>
                    <label className="stack compact-gap">
                      <span className="label">标签</span>
                      <input
                        value={ruleDraft.tags}
                        onChange={(event) =>
                          setRuleDraft((value) => ({ ...value, tags: event.target.value }))
                        }
                        placeholder="team-a, local"
                      />
                    </label>
                    <label className="stack compact-gap">
                      <span className="label">备注</span>
                      <textarea
                        value={ruleDraft.note}
                        onChange={(event) =>
                          setRuleDraft((value) => ({ ...value, note: event.target.value }))
                        }
                        placeholder="补充这条规则的适用场景。"
                      />
                    </label>
                  </div>
                </details>

                {ruleConflicts.length > 0 ? (
                  <div className="warning-list compact-gap">
                    {ruleConflicts.map((conflict) => (
                      <div className="warning-item" key={conflict.ruleId}>
                        {conflict.reason}
                      </div>
                    ))}
                  </div>
                ) : null}
                {ruleWarnings.length > 0 ? (
                  <div className="warning-list compact-gap">
                    {ruleWarnings.map((warning) => (
                      <div className="warning-item" key={warning}>
                        {warning}
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="row between wrap-gap">
                  <button className="ghost" onClick={() => setDrawerMode(null)}>
                    取消
                  </button>
                  <button
                    onClick={() => void saveRule()}
                    disabled={busy || !selectedProject || !ruleDraft.ruleSetId}
                  >
                    保存规则
                  </button>
                </div>
              </div>
            ) : null}

            {drawerMode === "rule-batch" ? (
              <div className="modal-body stack">
                {selectedProject ? (
                  <section className="modal-context strong-context">
                    <div className="modal-context-main">
                      <span className="label">所属站点</span>
                      <strong>{selectedProject.name}</strong>
                      <p className="small muted">{joinCsv(selectedProject.siteHosts) || "未填写 Host"}</p>
                    </div>
                    <div className="modal-context-meta">
                      <span className={`badge ${selectedProject.siteHosts.includes(currentHost) ? "success" : "warning"}`}>
                        {selectedProject.siteHosts.includes(currentHost) ? "当前页面命中此站点" : "当前页面未命中此站点"}
                      </span>
                      {selectedRuleSet ? <span className="badge neutral">规则组 {selectedRuleSet.name}</span> : null}
                    </div>
                  </section>
                ) : null}

                <section className="mini-section stack compact-gap">
                  <div className="row between align-start wrap-gap">
                    <div className="stack compact-gap">
                      <span className="label">连续新增</span>
                      <p className="small muted">
                        先在一个窗口里把基础规则连续录入。Host、优先级、Header 等高级项，保存后再点“编辑”补充。
                      </p>
                    </div>
                    <span className="badge neutral">共 {batchRuleDrafts.length} 条待保存</span>
                  </div>

                  <div className="batch-rule-list">
                    {batchRuleDrafts.map((draft, index) => (
                      <article className="batch-rule-card" key={draft.localId}>
                        <div className="batch-rule-header">
                          <div className="stack compact-gap">
                            <strong>规则 {index + 1}</strong>
                            <span className="small muted">
                              默认匹配 Host：{joinCsv(selectedProject?.siteHosts) || "未填写 Host"}
                            </span>
                          </div>
                          <button
                            className="ghost"
                            onClick={() => removeBatchRuleDraft(draft.localId)}
                            disabled={busy || batchRuleDrafts.length === 1}
                          >
                            删除
                          </button>
                        </div>

                        <div className="segmented-row compact-segmented-row">
                          <button
                            className={draft.kind === "api_forward" ? "active-segment" : "ghost"}
                            onClick={() =>
                              updateBatchRuleDraft(draft.localId, {
                                kind: "api_forward",
                                resourceType: joinCsv(defaultApiTypes),
                                method: "GET, POST",
                                pathGlob:
                                  draft.pathGlob === "/assets/**" || !draft.pathGlob ? "/api/**" : draft.pathGlob,
                              })
                            }
                          >
                            API 转发
                          </button>
                          <button
                            className={draft.kind === "asset_redirect" ? "active-segment" : "ghost"}
                            onClick={() =>
                              updateBatchRuleDraft(draft.localId, {
                                kind: "asset_redirect",
                                resourceType: joinCsv(defaultAssetTypes),
                                method: "",
                                pathGlob:
                                  draft.pathGlob === "/api/**" || !draft.pathGlob ? "/assets/**" : draft.pathGlob,
                              })
                            }
                          >
                            资源替换
                          </button>
                        </div>

                        <div className="batch-rule-fields">
                          <label className="stack compact-gap">
                            <span className="label">规则名称</span>
                            <input
                              value={draft.name}
                              onChange={(event) =>
                                updateBatchRuleDraft(draft.localId, { name: event.target.value })
                              }
                              placeholder="例如：把 /api 指到本地服务"
                            />
                          </label>
                          <label className="stack compact-gap">
                            <span className="label">匹配路径</span>
                            <input
                              value={draft.pathGlob}
                              onChange={(event) =>
                                updateBatchRuleDraft(draft.localId, { pathGlob: event.target.value })
                              }
                              placeholder={draft.kind === "api_forward" ? "/api/**" : "/assets/**"}
                            />
                          </label>
                          {draft.kind === "api_forward" ? (
                            <label className="stack compact-gap">
                              <span className="label">目标地址</span>
                              <input
                                value={draft.targetBaseUrl}
                                onChange={(event) =>
                                  updateBatchRuleDraft(draft.localId, { targetBaseUrl: event.target.value })
                                }
                                placeholder="http://127.0.0.1:3000"
                              />
                            </label>
                          ) : (
                            <label className="stack compact-gap">
                              <span className="label">替换到的 HTTPS 地址</span>
                              <input
                                value={draft.redirectUrl}
                                onChange={(event) =>
                                  updateBatchRuleDraft(draft.localId, { redirectUrl: event.target.value })
                                }
                                placeholder="https://cdn.example.com/app.js"
                              />
                            </label>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>

                <div className="row between wrap-gap">
                  <div className="row wrap-gap">
                    <button className="ghost" onClick={() => setDrawerMode(null)}>
                      取消
                    </button>
                    <button className="secondary" onClick={() => appendBatchRuleDraft()} disabled={busy}>
                      再加一条
                    </button>
                  </div>
                  <button onClick={() => void saveBatchRules()} disabled={busy || !selectedProject || !selectedRuleSet}>
                    全部保存
                  </button>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function drawerTitle(mode: DrawerMode): string {
  if (mode === "settings") {
    return "设置";
  }
  if (mode === "project") {
    return "站点";
  }
  if (mode === "rule") {
    return "规则";
  }
  if (mode === "rule-batch") {
    return "规则";
  }
  return "";
}

function drawerHeadline(
  mode: DrawerMode,
  projectId: string,
  ruleId: string,
  selectedProjectName?: string,
  batchSize = 0,
): string {
  if (mode === "settings") {
    return selectedProjectName ? `设置 · ${selectedProjectName}` : "把不常用的操作都收在这里。";
  }
  if (mode === "project") {
    return projectId ? "编辑站点" : "新建站点";
  }
  if (mode === "rule") {
    return selectedProjectName
      ? `${ruleId ? "编辑规则" : "新建规则"} · ${selectedProjectName}`
      : ruleId
        ? "编辑规则"
        : "新建规则";
  }
  if (mode === "rule-batch") {
    return selectedProjectName
      ? `连续新增 ${batchSize || 1} 条规则 · ${selectedProjectName}`
      : `连续新增 ${batchSize || 1} 条规则`;
  }
  return "";
}

function createRuleDraft(options?: {
  project?: Project;
  ruleSet?: RuleSet;
  kind?: Rule["kind"];
  rule?: Rule;
}): RuleDraft {
  const kind = options?.rule?.kind ?? options?.kind ?? "api_forward";
  return {
    id: options?.rule?.id ?? "",
    ruleSetId: options?.ruleSet?.id ?? "",
    name: options?.rule?.name ?? "",
    kind,
    enabled: options?.rule?.enabled ?? true,
    priority: options?.rule?.priority ?? 100,
    host: joinCsv(options?.rule?.match.host ?? options?.project?.siteHosts),
    pathGlob: options?.rule?.match.pathGlob ?? (kind === "api_forward" ? "/api/**" : "/assets/**"),
    resourceType: joinCsv(
      options?.rule?.match.resourceType ?? (kind === "api_forward" ? defaultApiTypes : defaultAssetTypes),
    ),
    method: joinCsv(options?.rule?.match.method ?? (kind === "api_forward" ? ["GET", "POST"] : undefined)),
    redirectUrl: options?.rule?.target.redirectUrl ?? "",
    targetBaseUrl: options?.rule?.target.forwardProfile?.targetBaseUrl ?? "",
    stripPrefix: options?.rule?.target.forwardProfile?.stripPrefix ?? "",
    headersJson: JSON.stringify(options?.rule?.target.forwardProfile?.headers ?? {}, null, 2),
    tags: joinCsv(options?.rule?.tags),
    note: options?.rule?.note ?? "",
  };
}

function createBatchRuleDraft(options?: {
  project?: Project;
  ruleSet?: RuleSet;
  kind?: Rule["kind"];
  source?: RuleDraft | BatchRuleDraft;
}): BatchRuleDraft {
  const base = createRuleDraft({
    project: options?.project,
    ruleSet: options?.ruleSet,
    kind: options?.source?.kind ?? options?.kind,
  });
  const source = options?.source;

  return {
    localId: createId("draft"),
    ...base,
    kind: source?.kind ?? base.kind,
    enabled: source?.enabled ?? base.enabled,
    priority: source?.priority ?? base.priority,
    host: source?.host ?? base.host,
    resourceType: source?.resourceType ?? base.resourceType,
    method: source?.method ?? base.method,
    redirectUrl: source?.kind === "asset_redirect" ? source.redirectUrl : base.redirectUrl,
    targetBaseUrl: source?.kind === "api_forward" ? source.targetBaseUrl : base.targetBaseUrl,
    stripPrefix: source?.kind === "api_forward" ? source.stripPrefix : base.stripPrefix,
    headersJson: source?.kind === "api_forward" ? source.headersJson : base.headersJson,
    tags: source?.tags ?? base.tags,
  };
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

function toRule(draft: RuleDraft, workspace: WorkspaceSnapshot, project: Project): Rule {
  if (!draft.ruleSetId) {
    throw new Error("当前站点还没有规则组，请先保存站点后再添加规则。");
  }

  const existing = workspace.rules.find((rule) => rule.id === draft.id);
  const now = new Date().toISOString();
  const host = splitCsv(draft.host);
  const resourceType = splitCsv(draft.resourceType) as MatchResourceType[];
  const method = splitCsv(draft.method);
  const headers =
    draft.kind === "api_forward" && draft.headersJson.trim()
      ? (JSON.parse(draft.headersJson) as Record<string, string>)
      : {};

  return {
    id: draft.id || createId("rule"),
    name: draft.name.trim() || (draft.kind === "api_forward" ? "新的 API 转发" : "新的资源替换"),
    enabled: draft.enabled,
    kind: draft.kind,
    priority: Number.isFinite(draft.priority) ? draft.priority : 100,
    match: {
      host: host.length > 0 ? host : project.siteHosts,
      pathGlob: draft.pathGlob || "**",
      resourceType:
        resourceType.length > 0
          ? resourceType
          : draft.kind === "api_forward"
            ? defaultApiTypes
            : defaultAssetTypes,
      method: draft.kind === "api_forward" ? (method.length > 0 ? method : ["GET", "POST"]) : undefined,
      tabScope: { mode: "all" as const },
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

function formatKind(kind: Rule["kind"]): string {
  return kind === "api_forward" ? "API 转发" : "资源替换";
}

function formatRuleTarget(rule: Rule): string {
  if (rule.kind === "asset_redirect") {
    return rule.target.redirectUrl || "未填写 HTTPS 地址";
  }
  return rule.target.forwardProfile?.targetBaseUrl || "未填写目标地址";
}

function formatTimestamp(value?: string): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无";
}

function shorten(value: string): string {
  return value.length > 90 ? `${value.slice(0, 87)}...` : value;
}

function localizeWarning(value: string): string {
  if (value.includes("must point to an HTTPS target")) {
    return "资源替换规则目前只支持跳到浏览器可直接访问的 HTTPS 地址。";
  }
  if (value.includes("missing a forward profile")) {
    return "API 转发规则缺少目标转发配置。";
  }
  return value;
}

const rootElement = document.getElementById("app");
if (!rootElement) {
  throw new Error("Missing app root.");
}

createRoot(rootElement).render(<App />);
