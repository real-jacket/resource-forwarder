import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  collectRuleConflicts,
  collectUnsupportedRuleWarnings,
  parseResourceOverrideExport,
  serializeWorkspace,
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

type AppView = "rules" | "import-export" | "settings" | "about";
type PanelMode = "rule" | "rule-batch" | null;
type RulePanelTab = "basic" | "advanced";
type RuleStatusTab = "all" | "enabled" | "disabled";
type ImportSource = "workspace" | "resource-override";

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

interface RuleTemplatePreset {
  id: string;
  kind: Rule["kind"];
  label: string;
  description: string;
  patch: Partial<RuleDraft>;
}

interface ImportFeedback {
  title: string;
  details: string[];
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
  const [view, setView] = useState<AppView>("rules");
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [rulePanelTab, setRulePanelTab] = useState<RulePanelTab>("basic");
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>(emptyProjectDraft());
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(createRuleDraft());
  const [batchRuleDrafts, setBatchRuleDrafts] = useState<BatchRuleDraft[]>([]);
  const [serviceUrl, setServiceUrl] = useState("");
  const [importText, setImportText] = useState("");
  const [importSource, setImportSource] = useState<ImportSource>("resource-override");
  const [exportText, setExportText] = useState("");
  const [exportFormat, setExportFormat] = useState<"json" | "yaml">("yaml");
  const [ruleQuery, setRuleQuery] = useState("");
  const [ruleKindFilter, setRuleKindFilter] = useState<"all" | Rule["kind"]>("all");
  const [ruleStatusTab, setRuleStatusTab] = useState<RuleStatusTab>("all");
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null);
  const [resourceOverridePreview, setResourceOverridePreview] = useState<ReturnType<typeof parseResourceOverrideExport> | null>(null);
  const [importModalError, setImportModalError] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("正在加载规则...");
  const [busy, setBusy] = useState(false);
  const deferredRuleQuery = useDeferredValue(ruleQuery.trim().toLowerCase());

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
      projects.find((p) => p.id === selectedProjectId) ??
      projects.find((p) => p.siteHosts.includes(currentHost)) ??
      projects[0],
    [projects, selectedProjectId, currentHost],
  );

  const selectedProjectRuleSets = useMemo(
    () => ruleSets.filter((rs) => rs.projectId === selectedProject?.id),
    [ruleSets, selectedProject?.id],
  );

  const selectedRuleSet = selectedProjectRuleSets[0];

  const selectedRuleIds = useMemo(
    () => new Set(selectedProjectRuleSets.flatMap((rs) => rs.ruleIds)),
    [selectedProjectRuleSets],
  );

  // Flat list of all rules with their project info
  const allRuleRows = useMemo(() => {
    return sortRules(rules).map((rule) => {
      const rs = ruleSets.find((r) => r.ruleIds.includes(rule.id));
      const project = rs ? projects.find((p) => p.id === rs.projectId) : null;
      return { rule, project };
    });
  }, [rules, ruleSets, projects]);

  const filteredRuleRows = useMemo(() => {
    return allRuleRows.filter(({ rule, project }) => {
      // Project filter
      if (selectedProjectId && project?.id !== selectedProjectId) return false;
      // Status tab
      if (ruleStatusTab === "enabled" && !rule.enabled) return false;
      if (ruleStatusTab === "disabled" && rule.enabled) return false;
      // Kind filter
      if (ruleKindFilter !== "all" && rule.kind !== ruleKindFilter) return false;
      // Search
      if (deferredRuleQuery) {
        return buildRuleSearchText(rule).includes(deferredRuleQuery);
      }
      return true;
    });
  }, [allRuleRows, selectedProjectId, ruleStatusTab, ruleKindFilter, deferredRuleQuery]);

  const selectedRules = useMemo(
    () => sortRules(rules.filter((r) => selectedRuleIds.has(r.id))),
    [rules, selectedRuleIds],
  );

  const enabledCount = useMemo(() => allRuleRows.filter(({ rule }) => rule.enabled && (!selectedProjectId || (allRuleRows.find(r => r.rule.id === rule.id)?.project?.id === selectedProjectId))).length, [allRuleRows, selectedProjectId]);
  const disabledCount = useMemo(() => allRuleRows.filter(({ rule }) => !rule.enabled && (!selectedProjectId || (allRuleRows.find(r => r.rule.id === rule.id)?.project?.id === selectedProjectId))).length, [allRuleRows, selectedProjectId]);

  const projectRuleRows = useMemo(
    () => selectedProjectId ? allRuleRows.filter(({ project }) => project?.id === selectedProjectId) : allRuleRows,
    [allRuleRows, selectedProjectId],
  );

  const totalCount = projectRuleRows.length;
  const tabEnabledCount = projectRuleRows.filter(({ rule }) => rule.enabled).length;
  const tabDisabledCount = projectRuleRows.filter(({ rule }) => !rule.enabled).length;

  const draftRule = useMemo(() => {
    if (!dashboard || !selectedProject) return null;
    try {
      return toRule(ruleDraft, dashboard.workspace, selectedProject);
    } catch {
      return null;
    }
  }, [dashboard, selectedProject, ruleDraft]);

  const ruleConflicts = useMemo(() => {
    if (!dashboard || !draftRule) return [];
    return collectRuleConflicts(dashboard.workspace, draftRule);
  }, [dashboard, draftRule]);

  const ruleWarnings = useMemo(
    () => (draftRule ? collectUnsupportedRuleWarnings(draftRule).map(localizeWarning) : []),
    [draftRule],
  );

  const activeRuleTemplates = useMemo(
    () => getRuleTemplatePresets(ruleDraft.kind),
    [ruleDraft.kind],
  );

  const servicePort = useMemo(() => {
    try {
      return new URL(serviceUrl).port || "5178";
    } catch {
      return "5178";
    }
  }, [serviceUrl]);

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
      if (current && state.workspace.projects.some((p) => p.id === current)) return current;
      const matched = state.workspace.projects.find((p) =>
        p.siteHosts.includes(state.currentTab?.host ?? ""),
      );
      return matched?.id ?? state.workspace.projects[0]?.id ?? "";
    });
  }

  function openProjectModal(project?: Project): void {
    setProjectDraft(project ? fromProject(project) : emptyProjectDraft());
    setShowProjectModal(true);
  }

  function openRulePanel(kind: Rule["kind"], rule?: Rule): void {
    if (!selectedProject || !selectedRuleSet) {
      setStatus("请先创建一个站点，再添加规则。");
      return;
    }
    setRuleDraft(createRuleDraft({ project: selectedProject, ruleSet: selectedRuleSet, kind, rule }));
    setRulePanelTab("basic");
    setPanelMode("rule");
  }

  function duplicateRule(rule: Rule): void {
    if (!selectedProject || !selectedRuleSet) {
      setStatus("请先选择一个站点，再复制规则。");
      return;
    }
    const base = createRuleDraft({ project: selectedProject, ruleSet: selectedRuleSet, kind: rule.kind, rule });
    setRuleDraft({ ...base, id: "", name: `${rule.name} 副本` });
    setRulePanelTab("basic");
    setPanelMode("rule");
  }

  function openBatchRulePanel(kind: Rule["kind"] = "api_forward"): void {
    if (!selectedProject || !selectedRuleSet) {
      setStatus("请先创建一个站点，再添加规则。");
      return;
    }
    setBatchRuleDrafts([createBatchRuleDraft({ project: selectedProject, ruleSet: selectedRuleSet, kind })]);
    setPanelMode("rule-batch");
  }

  function appendBatchRuleDraft(): void {
    if (!selectedProject || !selectedRuleSet) return;
    setBatchRuleDrafts((current) => {
      const prev = current[current.length - 1];
      return [
        ...current,
        createBatchRuleDraft({
          project: selectedProject,
          ruleSet: selectedRuleSet,
          kind: prev?.kind ?? "api_forward",
          source: prev,
        }),
      ];
    });
  }

  function updateBatchRuleDraft(localId: string, patch: Partial<BatchRuleDraft>): void {
    setBatchRuleDrafts((current) =>
      current.map((d) => (d.localId === localId ? { ...d, ...patch } : d)),
    );
  }

  function removeBatchRuleDraft(localId: string): void {
    setBatchRuleDrafts((current) => current.filter((d) => d.localId !== localId));
  }

  function applyRuleTemplate(template: RuleTemplatePreset): void {
    setRuleDraft((current) => mergeRuleDraftByKind(current, template.kind, template.patch));
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
        dashboard?.workspace.ruleSets.filter((rs) => rs.projectId === projectId) ?? [];
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
            dashboard?.workspace.projects.find((p) => p.id === projectId)?.createdAt ?? now,
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
      setShowProjectModal(false);
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
        payload: { rule, ruleSetId: ruleDraft.ruleSetId },
      });
      hydrateDashboard({ ...state, logs: dashboard.logs, currentTab: dashboard.currentTab });
      setPanelMode(null);
      setRuleDraft(createRuleDraft({ project: selectedProject, ruleSet: selectedRuleSet, kind: rule.kind }));
      setStatus(`规则「${rule.name}」已保存。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存规则失败。");
    } finally {
      setBusy(false);
    }
  }

  async function saveRuleAndContinue(): Promise<void> {
    if (!dashboard || !selectedProject) return;
    setBusy(true);
    try {
      const rule = toRule(ruleDraft, dashboard.workspace, selectedProject);
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-rule",
        payload: { rule, ruleSetId: ruleDraft.ruleSetId },
      });
      hydrateDashboard({ ...state, logs: dashboard.logs, currentTab: dashboard.currentTab });
      setRuleDraft(createRuleDraft({ project: selectedProject, ruleSet: selectedRuleSet, kind: rule.kind }));
      setRulePanelTab("basic");
      setStatus(`规则「${rule.name}」已保存，继续新建。`);
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
      for (let i = 0; i < batchRuleDrafts.length; i++) {
        const draft = batchRuleDrafts[i];
        const rule = toRule(draft, workspace, selectedProject);
        const state = await runtimeRequest<UpsertMutationResponse>({
          type: "upsert-rule",
          payload: { rule, ruleSetId: draft.ruleSetId },
        });
        nextState = state;
        workspace = state.workspace;
        savedCount++;
      }
      if (nextState) {
        hydrateDashboard({ ...nextState, logs: dashboard.logs, currentTab: dashboard.currentTab });
      }
      setBatchRuleDrafts([]);
      setPanelMode(null);
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
          ruleSets: ruleSets.filter((rs) => rs.projectId === project.id),
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

  async function deleteProject(project: Project): Promise<void> {
    const ruleCount = ruleSets
      .filter((rs) => rs.projectId === project.id)
      .reduce((sum, rs) => sum + rs.ruleIds.length, 0);
    const confirmed = window.confirm(
      `确认删除分组「${project.name}」？\n将同时删除其下 ${ruleCount} 条规则，此操作不可撤销。`,
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "delete-project",
        projectId: project.id,
      });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      if (selectedProjectId === project.id) setSelectedProjectId("");
      setStatus(`分组「${project.name}」已删除。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "删除分组失败。");
    } finally {
      setBusy(false);
    }
  }

  function toggleProjectSelection(id: string): void {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllProjectSelection(): void {
    setSelectedProjectIds((prev) =>
      prev.size === projects.length ? new Set() : new Set(projects.map((p) => p.id)),
    );
  }

  async function batchToggleProjects(enable: boolean): Promise<void> {
    const targets = projects.filter((p) => selectedProjectIds.has(p.id) && p.enabled !== enable);
    if (targets.length === 0) {
      setStatus(`选中的分组已${enable ? "全部启用" : "全部停用"}。`);
      return;
    }
    setBusy(true);
    try {
      let lastState: UpsertMutationResponse | null = null;
      for (const project of targets) {
        lastState = await runtimeRequest<UpsertMutationResponse>({
          type: "upsert-project",
          payload: {
            project: { ...project, enabled: enable },
            ruleSets: ruleSets.filter((rs) => rs.projectId === project.id),
          },
        });
      }
      if (lastState) hydrateDashboard({ ...lastState, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setSelectedProjectIds(new Set());
      setStatus(`已${enable ? "启用" : "停用"} ${targets.length} 个分组。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "批量操作失败。");
    } finally {
      setBusy(false);
    }
  }

  async function batchDeleteProjects(): Promise<void> {
    const targets = projects.filter((p) => selectedProjectIds.has(p.id));
    if (targets.length === 0) return;
    const totalRules = targets.reduce(
      (sum, p) => sum + ruleSets.filter((rs) => rs.projectId === p.id).reduce((s, rs) => s + rs.ruleIds.length, 0),
      0,
    );
    const confirmed = window.confirm(
      `确认删除 ${targets.length} 个分组？\n将同时删除 ${totalRules} 条规则，此操作不可撤销。`,
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      let lastState: UpsertMutationResponse | null = null;
      for (const project of targets) {
        lastState = await runtimeRequest<UpsertMutationResponse>({
          type: "delete-project",
          projectId: project.id,
        });
      }
      if (lastState) hydrateDashboard({ ...lastState, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      if (selectedProjectIds.has(selectedProjectId)) setSelectedProjectId("");
      setSelectedProjectIds(new Set());
      setStatus(`已删除 ${targets.length} 个分组。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "批量删除失败。");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRule(rule: Rule): Promise<void> {
    setBusy(true);
    try {
      const owningRuleSet = ruleSets.find((rs) => rs.ruleIds.includes(rule.id));
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-rule",
        payload: { rule: { ...rule, enabled: !rule.enabled }, ruleSetId: owningRuleSet?.id },
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
      setImportFeedback(null);
      setStatus(merge ? "规则已合并导入。" : "规则工作区已整体替换。");
    } catch (error) {
      // Even on error, data may have been committed locally — refresh UI
      try {
        const freshState = await runtimeRequest<GetDashboardStateResponse>({ type: "get-dashboard-state" });
        hydrateDashboard(freshState);
        if (freshState.workspace.rules.length > 0) {
          setImportFeedback(null);
          setStatus(merge ? "导入完成（服务离线，数据已保存到本地）。" : "替换完成（服务离线，数据已保存到本地）。");
          setBusy(false);
          return;
        }
      } catch { /* dashboard refresh also failed */ }
      const msg = error instanceof Error ? error.message : String(error);
      setStatus(msg || "导入失败。");
    } finally {
      setBusy(false);
    }
  }

  async function importResourceOverride(merge: boolean): Promise<void> {
    if (!resourceOverridePreview) {
      setStatus("请先预览 Resource Override 导入结果，再确认导入。");
      return;
    }
    setBusy(true);
    setImportModalError(null);
    try {
      const { workspace, report } = resourceOverridePreview;
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "import-workspace",
        payload: {
          content: serializeWorkspace(workspace, "json"),
          format: "json",
          merge,
        },
      });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setStatus(
        merge
          ? `已合并导入 ${report.importedRuleCount} 条规则，共 ${report.importedProjectCount} 个站点。`
          : `已替换工作区，导入 ${report.importedRuleCount} 条规则，共 ${report.importedProjectCount} 个站点。`,
      );
      setResourceOverridePreview(null);
      setImportFeedback(null);
      setView("rules");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Even if push to service failed, data may have been committed locally — refresh UI
      try {
        const freshState = await runtimeRequest<GetDashboardStateResponse>({ type: "get-dashboard-state" });
        hydrateDashboard(freshState);
        if (freshState.workspace.rules.length > 0) {
          setResourceOverridePreview(null);
          setImportFeedback(null);
          setView("rules");
          setStatus("导入完成（服务离线，数据已保存到本地）。");
          return;
        }
      } catch { /* dashboard refresh also failed — show original error */ }
      setImportModalError(msg || "导入失败。");
    } finally {
      setBusy(false);
    }
  }

  async function previewResourceOverrideImport(): Promise<void> {
    if (!importText.trim()) {
      setStatus("请先粘贴 Resource Override 导出的 JSON。");
      return;
    }

    setBusy(true);
    try {
      const preview = parseResourceOverrideExport(importText);
      setResourceOverridePreview(preview);
      setImportFeedback(null);

      if (preview.report.importedRuleCount === 0) {
        setStatus("预览完成：当前没有可导入的规则，请先检查下方跳过原因。");
        return;
      }

      setStatus(
        `预览完成：${preview.report.importedProjectCount} 个站点，${preview.report.importedRuleCount} 条可导入规则，${preview.report.skippedRuleCount} 条跳过。`,
      );
    } catch (error) {
      setResourceOverridePreview(null);
      setImportFeedback(null);
      setStatus(error instanceof Error ? error.message : "预览 Resource Override 规则失败。");
    } finally {
      setBusy(false);
    }
  }

  function renderResourceOverridePreviewModal() {
    if (!resourceOverridePreview) {
      return null;
    }

    const { workspace, report } = resourceOverridePreview;
    const ruleSetByProjectId = new Map(workspace.ruleSets.map((rs) => [rs.projectId, rs]));
    const rulesById = new Map(workspace.rules.map((r) => [r.id, r]));
    const canImport = report.importedRuleCount > 0;

    function closePreview() {
      if (busy) return;
      setResourceOverridePreview(null);
      setImportFeedback(null);
      setImportModalError(null);
    }

    return (
        <div
        className="modal-overlay"
        onClick={(e) => { if (e.target === e.currentTarget && !busy) closePreview(); }}
      >
        <div className="modal-box import-preview-modal" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="modal-box-header">
            <div>
              <div className="modal-box-title">导入预览</div>
              <div className="import-preview-stats">
                <span className={`import-preview-badge ${canImport ? "success" : "muted"}`}>
                  {report.importedProjectCount} 个站点
                </span>
                <span className={`import-preview-badge ${canImport ? "success" : "muted"}`}>
                  {report.importedRuleCount} 条可导入规则
                </span>
                {report.skippedRuleCount > 0 && (
                  <span className="import-preview-badge warning">
                    {report.skippedRuleCount} 条跳过
                  </span>
                )}
              </div>
            </div>
            <button className="btn btn-icon" onClick={closePreview} title="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Body：按站点分组展示规则 */}
          <div className="modal-box-body import-preview-body">
            {workspace.projects.map((project) => {
              const ruleSet = ruleSetByProjectId.get(project.id);
              const projectRules = (ruleSet?.ruleIds ?? [])
                .map((id) => rulesById.get(id))
                .filter((r): r is NonNullable<typeof r> => r !== undefined);

              return (
                <div className="import-preview-site" key={project.id}>
                  {/* Site header */}
                  <div className="import-preview-site-header">
                    <div className="import-preview-site-name">{project.name}</div>
                    <div className="import-preview-site-meta">
                      <span className="import-preview-site-host">
                        {project.siteHosts.join(", ") || "-"}
                      </span>
                      <span className={`import-preview-badge ${project.enabled ? "success" : "muted"}`} style={{ fontSize: 11 }}>
                        {project.enabled ? "启用" : "停用"}
                      </span>
                      <span className="import-preview-badge muted" style={{ fontSize: 11 }}>
                        {projectRules.length} 条规则
                      </span>
                    </div>
                  </div>

                  {/* Rules table */}
                  {projectRules.length > 0 && (
                    <div className="import-preview-rules">
                      <table className="import-preview-table">
                        <thead>
                          <tr>
                            <th>匹配地址</th>
                            <th>类型</th>
                            <th>目标地址</th>
                          </tr>
                        </thead>
                        <tbody>
                          {projectRules.map((rule) => {
                            const ruleHosts = rule.match.host.filter((h) => h !== "*");
                            const isSameOrigin = ruleHosts.length > 0 && ruleHosts.every((h) => project.siteHosts.includes(h));
                            return (
                            <tr key={rule.id}>
                              <td className="import-preview-path">
                                {!isSameOrigin && ruleHosts.length > 0 && <span className="import-preview-cross-origin">{ruleHosts.join(", ")}</span>}
                                {rule.match.pathGlob}
                              </td>
                              <td>
                                <span className={`match-badge ${rule.kind === "api_forward" ? "api" : "asset"}`}>
                                  {rule.kind === "api_forward" ? "转发" : "替换"}
                                </span>
                              </td>
                              <td className="import-preview-target">
                                {rule.kind === "api_forward"
                                  ? rule.target.forwardProfile?.targetBaseUrl ?? "-"
                                  : rule.target.redirectUrl ?? "-"}
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}

            {report.warnings.length > 0 && (
              <details className="import-preview-warnings">
                <summary className="import-preview-warnings-summary">
                  跳过与提示（{report.warnings.length} 条）
                </summary>
                <div className="import-preview-warnings-list">
                  {report.warnings.map((w, i) => (
                    <div className="import-preview-warning-item" key={i}>{w}</div>
                  ))}
                </div>
              </details>
            )}

            {!canImport && (
              <div className="import-preview-empty">
                没有可导入的规则，请检查上方跳过提示后重新预览。
              </div>
            )}
          </div>

          {/* Error / loading banner above footer */}
          {importModalError && (
            <div className="import-modal-error">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ flexShrink: 0 }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {importModalError}
            </div>
          )}

          {/* Footer */}
          <div className="modal-box-footer">
            <button className="btn btn-ghost" onClick={closePreview} disabled={busy}>
              取消
            </button>
            <button
              className="btn btn-default"
              onClick={() => void importResourceOverride(true)}
              disabled={busy || !canImport}
            >
              {busy ? "导入中…" : "合并导入"}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void importResourceOverride(false)}
              disabled={busy || !canImport}
            >
              {busy ? "导入中…" : "整体替换"}
            </button>
          </div>
        </div>
      </div>
    );
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
      setStatus(`已导出站点规则（${response.format.toUpperCase()}）。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出失败。");
    } finally {
      setBusy(false);
    }
  }

  // ── RENDER ──────────────────────────────────────────────────────────────

  return (
    <div className="options-layout">
      {/* Sidebar */}
      <nav className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div className="sidebar-logo-text">
            <div className="sidebar-logo-name">Resource Proxy</div>
            <div className="sidebar-logo-sub">本地资源代理插件</div>
          </div>
        </div>

        <div className="sidebar-nav">
          <button
            className={`sidebar-nav-item ${view === "rules" ? "active" : ""}`}
            onClick={() => setView("rules")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
            规则列表
          </button>
          <button
            className={`sidebar-nav-item ${view === "import-export" ? "active" : ""}`}
            onClick={() => setView("import-export")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            导入导出
          </button>
          <button
            className={`sidebar-nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => setView("settings")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41M12 2v2M12 20v2M2 12h2M20 12h2" />
            </svg>
            设置
          </button>
          <button
            className={`sidebar-nav-item ${view === "about" ? "active" : ""}`}
            onClick={() => setView("about")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            关于
          </button>
        </div>

        <div className="sidebar-footer">
          <div className={`sidebar-status ${dashboard?.health ? "online" : "offline"}`}>
            <span className="sidebar-status-dot" />
            {dashboard?.health
              ? `服务已连接 :${servicePort}`
              : "离线模式（本地存储）"}
          </div>
          {!dashboard?.health && rules.length > 0 && (
            <div className="sidebar-status-hint">
              {dashboard?.warnings?.some((w) => w.includes("离线模式"))
                ? `${rules.length} 条规则已缓存，服务恢复后自动同步`
                : "启动本地服务后数据将自动同步"}
            </div>
          )}
        </div>
      </nav>

      {/* Main content area */}
      <div className="options-content">
        <div className="options-page">
          {view === "rules" && renderRulesView()}
          {view === "import-export" && renderImportExportView()}
          {view === "settings" && renderSettingsView()}
          {view === "about" && renderAboutView()}
        </div>

        {/* Right panel */}
        {panelMode === "rule" && renderRulePanel()}
        {panelMode === "rule-batch" && renderBatchRulePanel()}
      </div>

      {/* Project modal */}
      {showProjectModal && renderProjectModal()}

      {/* Resource Override import preview modal */}
      {resourceOverridePreview && renderResourceOverridePreviewModal()}
    </div>
  );

  // ── RULES VIEW ────────────────────────────────────────────────────────

  function renderRulesView() {
    const hasRules = allRuleRows.length > 0;

    return (
      <>
        {/* Page header */}
        <div className="page-header">
          <div className="page-title">规则列表</div>
          <div className="page-subtitle">管理和查看所有本地代理规则</div>
        </div>

        {/* Status tabs */}
        <div className="status-tabs">
          <button
            className={`status-tab ${ruleStatusTab === "all" ? "active" : ""}`}
            onClick={() => setRuleStatusTab("all")}
          >
            全部
            <span className="status-tab-count">{totalCount}</span>
          </button>
          <button
            className={`status-tab ${ruleStatusTab === "enabled" ? "active" : ""}`}
            onClick={() => setRuleStatusTab("enabled")}
          >
            启用中
            <span className="status-tab-count">{tabEnabledCount}</span>
          </button>
          <button
            className={`status-tab ${ruleStatusTab === "disabled" ? "active" : ""}`}
            onClick={() => setRuleStatusTab("disabled")}
          >
            已禁用
            <span className="status-tab-count">{tabDisabledCount}</span>
          </button>
        </div>

        {/* Toolbar */}
        <div className="page-toolbar">
          <div className="toolbar-filters">
            <select
              className="toolbar-select"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              <option value="">全部分组</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.enabled ? "" : "（已停用）"}
                </option>
              ))}
            </select>
            {selectedProject && (
              <div className="toolbar-group-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  title="编辑分组"
                  onClick={() => openProjectModal(selectedProject)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                    <path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z" />
                  </svg>
                </button>
                <button
                  className={`btn btn-ghost btn-sm ${!selectedProject.enabled ? "is-off" : ""}`}
                  title={selectedProject.enabled ? "停用分组" : "启用分组"}
                  onClick={() => void toggleProject(selectedProject)}
                  disabled={busy}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    {!selectedProject.enabled && <line x1="9" y1="9" x2="15" y2="15" />}
                  </svg>
                </button>
                <button
                  className="btn btn-ghost btn-sm btn-danger"
                  title="删除分组"
                  onClick={() => void deleteProject(selectedProject)}
                  disabled={busy}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                </button>
              </div>
            )}

            <select
              className="toolbar-select"
              value={ruleKindFilter}
              onChange={(e) => setRuleKindFilter(e.target.value as "all" | Rule["kind"])}
            >
              <option value="all">全部类型</option>
              <option value="api_forward">API 转发</option>
              <option value="asset_redirect">资源替换</option>
            </select>

            <div className="toolbar-divider" />

            <div className="toolbar-search-wrap">
              <svg className="toolbar-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                className="toolbar-search-input"
                value={ruleQuery}
                onChange={(e) => setRuleQuery(e.target.value)}
                placeholder="搜索规则名称、路径、目标地址"
              />
            </div>
          </div>

          <div className="toolbar-actions">
            <button className="btn btn-default" onClick={() => void refresh()} disabled={busy}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
              </svg>
              刷新
            </button>
            <button
              className="btn btn-primary"
              onClick={() => openBatchRulePanel("api_forward")}
              disabled={!selectedProject || !selectedRuleSet}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              新建规则
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="rule-table-container">
          {!hasRules ? (
            <div className="rule-table-card">
              <div className="table-empty">
                <svg className="table-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M9 21V9" />
                </svg>
                <div className="table-empty-title">暂无规则</div>
                <div className="table-empty-desc">
                  {projects.length === 0
                    ? "请先在设置页面创建一个站点，再新建规则。"
                    : "点击「新建规则」添加第一条规则，或者从导入导出页面导入已有配置。"}
                </div>
                {projects.length === 0 ? (
                  <button className="btn btn-primary" onClick={() => setView("settings")}>
                    去创建站点
                  </button>
                ) : (
                  <button
                    className="btn btn-primary"
                    onClick={() => openBatchRulePanel("api_forward")}
                    disabled={!selectedProject || !selectedRuleSet}
                  >
                    新建规则
                  </button>
                )}
              </div>
            </div>
          ) : filteredRuleRows.length === 0 ? (
            <div className="rule-table-card">
              <div className="table-empty">
                <svg className="table-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <div className="table-empty-title">没有匹配的规则</div>
                <div className="table-empty-desc">试着调整搜索关键词或筛选条件。</div>
                <button
                  className="btn btn-default"
                  onClick={() => {
                    setRuleQuery("");
                    setRuleKindFilter("all");
                    setRuleStatusTab("all");
                  }}
                >
                  清除筛选
                </button>
              </div>
            </div>
          ) : (
            <div className="rule-table-card">
              <table className="rule-table">
                <thead>
                  <tr>
                    <th style={{ width: 48 }}></th>
                    <th style={{ width: 40 }}>总序</th>
                    <th>规则名称</th>
                    <th style={{ width: 96 }}>匹配类型</th>
                    <th>匹配规则</th>
                    <th>代理资源</th>
                    <th style={{ width: 100 }}>分组</th>
                    <th style={{ width: 140 }}>更新时间</th>
                    <th style={{ width: 88 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRuleRows.map(({ rule, project }, index) => (
                    <tr key={rule.id} className={rule.enabled ? "" : "is-disabled"}>
                      <td>
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={() => void toggleRule(rule)}
                            disabled={busy}
                          />
                          <span className="toggle-track" />
                        </label>
                      </td>
                      <td>
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
                        <span
                          className="rule-target-text"
                          title={formatRuleTarget(rule)}
                        >
                          {formatRuleTarget(rule)}
                        </span>
                      </td>
                      <td>
                        {project ? (
                          <span
                            className="rule-group-tag clickable"
                            title={`筛选「${project.name}」分组`}
                            onClick={() => setSelectedProjectId(project.id)}
                          >
                            {project.name}
                          </span>
                        ) : (
                          <span className="rule-seq-text">—</span>
                        )}
                      </td>
                      <td>
                        <span className="rule-time-text">{formatTimestamp(rule.updatedAt)}</span>
                      </td>
                      <td>
                        <div className="rule-actions-cell">
                          <button
                            className="btn-icon"
                            title="编辑"
                            onClick={() => openRulePanel(rule.kind, rule)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button
                            className="btn-icon"
                            title="复制"
                            onClick={() => duplicateRule(rule)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <rect x="9" y="9" width="13" height="13" rx="2" />
                              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="table-footer">
                <span>共 {filteredRuleRows.length} 条规则</span>
                {(dashboard?.warnings ?? []).length > 0 && (
                  <span style={{ color: "var(--warning-text)" }}>
                    {dashboard!.warnings.length} 条配置告警
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Status bar */}
        <div className="options-statusbar">
          <span className={`statusbar-dot ${dashboard?.health ? "online" : ""}`} />
          {status}
        </div>
      </>
    );
  }

  // ── RULE PANEL (single rule) ──────────────────────────────────────────

  function renderRulePanel() {
    const isNew = !ruleDraft.id;

    return (
      <aside className="rule-panel">
        <div className="rule-panel-header">
          <span className="rule-panel-title">{isNew ? "新建规则" : "编辑规则"}</span>
          <button className="btn-icon" onClick={() => setPanelMode(null)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="rule-panel-tabs">
          <button
            className={`rule-panel-tab ${rulePanelTab === "basic" ? "active" : ""}`}
            onClick={() => setRulePanelTab("basic")}
          >
            基础设置
          </button>
          <button
            className={`rule-panel-tab ${rulePanelTab === "advanced" ? "active" : ""}`}
            onClick={() => setRulePanelTab("advanced")}
          >
            高级设置
          </button>
        </div>

        <div className="rule-panel-body">
          {rulePanelTab === "basic" && (
            <>
              {/* Context */}
              {selectedProject && (
                <div style={{ padding: "10px 12px", background: "var(--surface-soft)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", fontSize: 12, color: "var(--muted)" }}>
                  所属站点：<strong style={{ color: "var(--ink)" }}>{selectedProject.name}</strong>
                  {selectedRuleSet ? `　规则组：${selectedRuleSet.name}` : ""}
                </div>
              )}

              {/* Kind switcher */}
              <div className="form-group">
                <span className="form-label">规则类型</span>
                <div className="kind-segmented">
                  <button
                    className={`kind-seg-btn ${ruleDraft.kind === "api_forward" ? "active" : ""}`}
                    onClick={() => setRuleDraft((v) => mergeRuleDraftByKind(v, "api_forward"))}
                  >
                    API 转发
                  </button>
                  <button
                    className={`kind-seg-btn ${ruleDraft.kind === "asset_redirect" ? "active" : ""}`}
                    onClick={() => setRuleDraft((v) => mergeRuleDraftByKind(v, "asset_redirect"))}
                  >
                    资源替换
                  </button>
                </div>
              </div>

              {/* Quick templates */}
              <div className="form-group">
                <span className="form-label">快速模板</span>
                <div className="template-grid">
                  {activeRuleTemplates.map((tpl) => (
                    <button
                      key={tpl.id}
                      className="template-card"
                      onClick={() => applyRuleTemplate(tpl)}
                    >
                      <strong>{tpl.label}</strong>
                      <span>{tpl.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Rule name */}
              <div className="form-group">
                <label className="form-label">
                  规则名称 <span className="form-label-required">*</span>
                </label>
                <input
                  className="form-input"
                  value={ruleDraft.name}
                  onChange={(e) => setRuleDraft((v) => ({ ...v, name: e.target.value }))}
                  placeholder="例如：把 /api 指到本地服务"
                />
              </div>

              {/* Match path */}
              <div className="form-group">
                <label className="form-label">
                  匹配路径 <span className="form-label-required">*</span>
                </label>
                <input
                  className="form-input"
                  value={ruleDraft.pathGlob}
                  onChange={(e) => setRuleDraft((v) => ({ ...v, pathGlob: e.target.value }))}
                  placeholder="/api/**"
                />
              </div>

              {/* Target */}
              {ruleDraft.kind === "api_forward" ? (
                <div className="form-group">
                  <label className="form-label">
                    目标地址 <span className="form-label-required">*</span>
                  </label>
                  <input
                    className="form-input"
                    value={ruleDraft.targetBaseUrl}
                    onChange={(e) => setRuleDraft((v) => ({ ...v, targetBaseUrl: e.target.value }))}
                    placeholder="http://127.0.0.1:3000"
                  />
                </div>
              ) : (
                <div className="form-group">
                  <label className="form-label">
                    替换到的 HTTPS 地址 <span className="form-label-required">*</span>
                  </label>
                  <input
                    className="form-input"
                    value={ruleDraft.redirectUrl}
                    onChange={(e) => setRuleDraft((v) => ({ ...v, redirectUrl: e.target.value }))}
                    placeholder="https://cdn.example.com/app.js"
                  />
                </div>
              )}

              {/* Note */}
              <div className="form-group">
                <label className="form-label">备注</label>
                <textarea
                  className="form-textarea"
                  value={ruleDraft.note}
                  onChange={(e) => setRuleDraft((v) => ({ ...v, note: e.target.value }))}
                  placeholder="补充这条规则的适用场景。"
                />
              </div>

              {/* Conflicts & Warnings */}
              {ruleConflicts.length > 0 && (
                <div className="form-warnings">
                  {ruleConflicts.map((c) => (
                    <div className="form-conflict-item" key={c.ruleId}>{c.reason}</div>
                  ))}
                </div>
              )}
              {ruleWarnings.length > 0 && (
                <div className="form-warnings">
                  {ruleWarnings.map((w) => (
                    <div className="form-warning-item" key={w}>{w}</div>
                  ))}
                </div>
              )}
            </>
          )}

          {rulePanelTab === "advanced" && (
            <>
              <div className="form-group">
                <label className="form-label">Host 覆盖（留空则沿用站点 Host）</label>
                <input
                  className="form-input"
                  value={ruleDraft.host}
                  onChange={(e) => setRuleDraft((v) => ({ ...v, host: e.target.value }))}
                  placeholder={selectedProject ? joinCsv(selectedProject.siteHosts) : "app.example.com"}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">资源类型</label>
                  <input
                    className="form-input"
                    value={ruleDraft.resourceType}
                    onChange={(e) => setRuleDraft((v) => ({ ...v, resourceType: e.target.value }))}
                    placeholder={ruleDraft.kind === "api_forward" ? "fetch, xmlhttprequest" : "script, stylesheet"}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">HTTP 方法</label>
                  <input
                    className="form-input"
                    value={ruleDraft.method}
                    onChange={(e) => setRuleDraft((v) => ({ ...v, method: e.target.value }))}
                    placeholder="GET, POST"
                  />
                </div>
              </div>

              {ruleDraft.kind === "api_forward" && (
                <>
                  <div className="form-group">
                    <label className="form-label">去掉路径前缀</label>
                    <input
                      className="form-input"
                      value={ruleDraft.stripPrefix}
                      onChange={(e) => setRuleDraft((v) => ({ ...v, stripPrefix: e.target.value }))}
                      placeholder="/api"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">注入 Header（JSON）</label>
                    <textarea
                      className="form-textarea"
                      value={ruleDraft.headersJson}
                      onChange={(e) => setRuleDraft((v) => ({ ...v, headersJson: e.target.value }))}
                      placeholder='{"x-forwarded-by":"resource-forwarder"}'
                    />
                  </div>
                </>
              )}

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">优先级</label>
                  <input
                    className="form-input"
                    type="number"
                    value={ruleDraft.priority}
                    onChange={(e) => setRuleDraft((v) => ({ ...v, priority: Number(e.target.value) }))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">标签</label>
                  <input
                    className="form-input"
                    value={ruleDraft.tags}
                    onChange={(e) => setRuleDraft((v) => ({ ...v, tags: e.target.value }))}
                    placeholder="team-a, local"
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={ruleDraft.enabled}
                    onChange={(e) => setRuleDraft((v) => ({ ...v, enabled: e.target.checked }))}
                    style={{ width: "auto", minHeight: "auto", margin: 0 }}
                  />
                  默认启用规则
                </label>
              </div>
            </>
          )}
        </div>

        <div className="rule-panel-footer">
          <button className="btn btn-ghost" onClick={() => setPanelMode(null)}>取消</button>
          <button
            className="btn btn-default"
            onClick={() => void saveRuleAndContinue()}
            disabled={busy || !selectedProject || !ruleDraft.ruleSetId}
          >
            保存并继续新建
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void saveRule()}
            disabled={busy || !selectedProject || !ruleDraft.ruleSetId}
          >
            保存
          </button>
        </div>
      </aside>
    );
  }

  // ── BATCH RULE PANEL ──────────────────────────────────────────────────

  function renderBatchRulePanel() {
    return (
      <aside className="rule-panel">
        <div className="rule-panel-header">
          <span className="rule-panel-title">连续新增规则</span>
          <button className="btn-icon" onClick={() => setPanelMode(null)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="rule-panel-body">
          {selectedProject && (
            <div style={{ padding: "10px 12px", background: "var(--surface-soft)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", fontSize: 12, color: "var(--muted)" }}>
              所属站点：<strong style={{ color: "var(--ink)" }}>{selectedProject.name}</strong>
            </div>
          )}

          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            在这里快速录入多条规则的基础字段，保存后可逐一补充高级选项。
          </div>

          <div className="batch-rule-list">
            {batchRuleDrafts.map((draft, index) => (
              <div className="batch-rule-card" key={draft.localId}>
                <div className="batch-rule-card-header">
                  <span className="batch-rule-card-label">规则 {index + 1}</span>
                  <button
                    className="btn-icon btn-icon-danger"
                    onClick={() => removeBatchRuleDraft(draft.localId)}
                    disabled={busy || batchRuleDrafts.length === 1}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14H6L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4h6v2" />
                    </svg>
                  </button>
                </div>

                <div className="kind-segmented">
                  <button
                    className={`kind-seg-btn ${draft.kind === "api_forward" ? "active" : ""}`}
                    onClick={() =>
                      updateBatchRuleDraft(
                        draft.localId,
                        mergeRuleDraftByKind(draft, "api_forward", {
                          pathGlob: draft.pathGlob === "/assets/**" || !draft.pathGlob ? "/api/**" : draft.pathGlob,
                        }),
                      )
                    }
                  >
                    API 转发
                  </button>
                  <button
                    className={`kind-seg-btn ${draft.kind === "asset_redirect" ? "active" : ""}`}
                    onClick={() =>
                      updateBatchRuleDraft(
                        draft.localId,
                        mergeRuleDraftByKind(draft, "asset_redirect", {
                          pathGlob: draft.pathGlob === "/api/**" || !draft.pathGlob ? "/assets/**" : draft.pathGlob,
                        }),
                      )
                    }
                  >
                    资源替换
                  </button>
                </div>

                <div className="form-group">
                  <label className="form-label">规则名称</label>
                  <input
                    className="form-input"
                    value={draft.name}
                    onChange={(e) => updateBatchRuleDraft(draft.localId, { name: e.target.value })}
                    placeholder="例如：把 /api 指到本地服务"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">匹配路径</label>
                  <input
                    className="form-input"
                    value={draft.pathGlob}
                    onChange={(e) => updateBatchRuleDraft(draft.localId, { pathGlob: e.target.value })}
                    placeholder={draft.kind === "api_forward" ? "/api/**" : "/assets/**"}
                  />
                </div>
                {draft.kind === "api_forward" ? (
                  <div className="form-group">
                    <label className="form-label">目标地址</label>
                    <input
                      className="form-input"
                      value={draft.targetBaseUrl}
                      onChange={(e) => updateBatchRuleDraft(draft.localId, { targetBaseUrl: e.target.value })}
                      placeholder="http://127.0.0.1:3000"
                    />
                  </div>
                ) : (
                  <div className="form-group">
                    <label className="form-label">替换到的 HTTPS 地址</label>
                    <input
                      className="form-input"
                      value={draft.redirectUrl}
                      onChange={(e) => updateBatchRuleDraft(draft.localId, { redirectUrl: e.target.value })}
                      placeholder="https://cdn.example.com/app.js"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <button className="btn btn-default" style={{ width: "100%" }} onClick={appendBatchRuleDraft} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            再加一条
          </button>
        </div>

        <div className="rule-panel-footer">
          <button className="btn btn-ghost" onClick={() => setPanelMode(null)}>取消</button>
          <button
            className="btn btn-primary"
            onClick={() => void saveBatchRules()}
            disabled={busy || !selectedProject || !selectedRuleSet}
          >
            全部保存（{batchRuleDrafts.length} 条）
          </button>
        </div>
      </aside>
    );
  }

  // ── IMPORT/EXPORT VIEW ────────────────────────────────────────────────

  function renderImportExportView() {
    return (
      <>
        <div className="page-header">
          <div className="page-title">导入导出</div>
          <div className="page-subtitle">支持 JSON / YAML 格式，也可导入 Resource Override 的配置</div>
        </div>

        <div className="io-page">
          {/* Import */}
          <div className="io-card">
            <div className="io-card-header">
              <div className="io-card-title">导入规则</div>
              <div className="io-card-desc">
                支持从 Resource Override 导入，或粘贴本工具的 JSON / YAML 快照
              </div>
            </div>
            <div className="io-card-body">
              <div className="io-source-tabs">
                <button
                  className={`io-source-tab ${importSource === "resource-override" ? "active" : ""}`}
                  onClick={() => {
                    setImportSource("resource-override");
                    setResourceOverridePreview(null);
                    setImportFeedback(null);
                  }}
                >
                  Resource Override
                </button>
                <button
                  className={`io-source-tab ${importSource === "workspace" ? "active" : ""}`}
                  onClick={() => {
                    setImportSource("workspace");
                    setResourceOverridePreview(null);
                    setImportFeedback(null);
                  }}
                >
                  Workspace 快照
                </button>
              </div>

              <textarea
                className="io-import-textarea"
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  setResourceOverridePreview(null);
                  setImportFeedback(null);
                }}
                placeholder={
                  importSource === "resource-override"
                    ? '粘贴 Resource Override 导出的 {"v":1,"data":[...]} JSON'
                    : "粘贴 JSON 或 YAML 规则配置"
                }
              />

              {importFeedback && (
                <div className="io-feedback">
                  <div className="io-feedback-title">{importFeedback.title}</div>
                  {importFeedback.details.slice(0, 4).map((d) => (
                    <div className="io-feedback-item" key={d}>{d}</div>
                  ))}
                </div>
              )}

              <div className="io-actions">
                {importSource === "resource-override" ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => void previewResourceOverrideImport()}
                    disabled={busy}
                  >
                    预览导入
                  </button>
                ) : (
                  <>
                    <button
                      className="btn btn-default"
                      onClick={() => void importWorkspace(true)}
                      disabled={busy}
                    >
                      合并导入
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={() => void importWorkspace(false)}
                      disabled={busy}
                    >
                      整体替换
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Export */}
          <div className="io-card">
            <div className="io-card-header">
              <div className="io-card-title">导出规则</div>
              <div className="io-card-desc">导出当前选中站点的规则配置，用于备份或分享</div>
            </div>
            <div className="io-card-body">
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">站点</label>
                  <select
                    className="form-select"
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                  >
                    {projects.length === 0 && <option value="">请先创建站点</option>}
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">格式</label>
                  <select
                    className="form-select"
                    value={exportFormat}
                    onChange={(e) => setExportFormat(e.target.value as "json" | "yaml")}
                  >
                    <option value="yaml">YAML</option>
                    <option value="json">JSON</option>
                  </select>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => selectedProject && void exportWorkspace(selectedProject.id)}
                  disabled={busy || !selectedProject}
                  style={{ marginBottom: 0, alignSelf: "flex-end" }}
                >
                  导出
                </button>
              </div>

              {exportText && (
                <textarea
                  className="io-import-textarea"
                  style={{ minHeight: 160 }}
                  value={exportText}
                  onChange={(e) => setExportText(e.target.value)}
                  readOnly
                />
              )}
            </div>
          </div>

          {/* Status */}
          <div style={{ fontSize: 13, color: "var(--muted)", padding: "4px 0" }}>
            {status}
          </div>
        </div>
      </>
    );
  }

  // ── SETTINGS VIEW ─────────────────────────────────────────────────────

  function renderSettingsView() {
    const filteredLogs = logs.filter((log) =>
      selectedProject ? log.projectId === selectedProject.id : true,
    );

    return (
      <>
        <div className="page-header">
          <div className="page-title">设置</div>
          <div className="page-subtitle">配置本地服务地址和管理站点</div>
        </div>

        <div className="settings-page">
          {/* Service URL */}
          <div className="settings-card">
            <div className="settings-card-header">
              <div className="settings-card-title">通用设置</div>
              <div className="settings-card-desc">配置本地转发服务地址</div>
            </div>
            <div className="settings-card-body">
              <div className="settings-field-row">
                <div className="form-group">
                  <label className="form-label">本地服务地址</label>
                  <input
                    className="form-input"
                    value={serviceUrl}
                    onChange={(e) => setServiceUrl(e.target.value)}
                    placeholder="http://127.0.0.1:5178"
                  />
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => void saveServiceUrl()}
                  disabled={busy}
                >
                  保存
                </button>
                <button
                  className="btn btn-default"
                  onClick={() => void refresh()}
                  disabled={busy}
                >
                  立即同步
                </button>
              </div>

              <div className={`service-status-bar ${dashboard?.health ? "online" : "offline"}`}>
                <span className="service-status-dot" />
                <span className="service-status-text">
                  {dashboard?.health ? `服务在线 · 端口 ${servicePort}` : "服务离线 · 数据仅保存在本地"}
                </span>
              </div>
            </div>
          </div>

          {/* Sites */}
          <div className="settings-card">
            <div className="settings-card-header site-mgr-header">
              <div className="site-mgr-title-area">
                <div className="settings-card-title">站点管理</div>
                <div className="settings-card-desc">
                  共 {projects.length} 个站点 · {projects.filter((p) => p.enabled).length} 个启用
                </div>
              </div>
              <div className="site-mgr-header-actions">
                {selectedProjectIds.size > 0 && (
                  <>
                    <span className="site-mgr-selection-count">已选 {selectedProjectIds.size}</span>
                    <button className="btn btn-default btn-sm" disabled={busy} onClick={() => void batchToggleProjects(true)}>启用</button>
                    <button className="btn btn-default btn-sm" disabled={busy} onClick={() => void batchToggleProjects(false)}>停用</button>
                    <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void batchDeleteProjects()}>删除</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setSelectedProjectIds(new Set())}>取消</button>
                    <div className="site-mgr-divider" />
                  </>
                )}
                <button className="btn btn-primary btn-sm" onClick={() => openProjectModal()}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 12, height: 12 }}>
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  新建
                </button>
              </div>
            </div>

            <div className="site-list">
              {projects.length > 0 && (
                <div className="site-list-head">
                  <label className="site-list-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedProjectIds.size === projects.length && projects.length > 0}
                      onChange={toggleAllProjectSelection}
                    />
                  </label>
                  <span className="site-list-head-label">全选</span>
                </div>
              )}
              {projects.length === 0 && (
                <div className="site-list-empty">
                  还没有站点，点击「新建」开始添加。
                </div>
              )}
              {projects.map((project) => {
                const ruleCount = ruleSets
                  .filter((rs) => rs.projectId === project.id)
                  .reduce((sum, rs) => sum + rs.ruleIds.length, 0);
                const isActive = project.siteHosts.includes(currentHost);
                const isChecked = selectedProjectIds.has(project.id);
                return (
                  <div className={`site-list-item${isChecked ? " is-selected" : ""}${!project.enabled ? " is-disabled" : ""}`} key={project.id}>
                    <label className="site-list-checkbox">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleProjectSelection(project.id)}
                      />
                    </label>
                    <div className="site-list-info">
                      <div className="site-list-name-row">
                        <span className="site-list-name">{project.name}</span>
                        {!project.enabled && (
                          <span className="site-list-badge disabled">已停用</span>
                        )}
                        {isActive && (
                          <span className="site-list-badge active">当前页面</span>
                        )}
                      </div>
                      <div className="site-list-meta">
                        <span className="site-list-hosts">{joinCsv(project.siteHosts) || "未填写 Host"}</span>
                        <span className="site-list-dot">·</span>
                        <span>{ruleCount} 条规则</span>
                      </div>
                    </div>
                    <div className="site-list-actions">
                      <button
                        className="btn-icon"
                        title="查看规则"
                        onClick={() => { setSelectedProjectId(project.id); setView("rules"); }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>
                      </button>
                      <button
                        className="btn-icon"
                        title="编辑"
                        onClick={() => openProjectModal(project)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
                      </button>
                      <button
                        className={`btn-icon${project.enabled ? "" : " is-off"}`}
                        title={project.enabled ? "停用" : "启用"}
                        onClick={() => void toggleProject(project)}
                        disabled={busy}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" /><line x1="12" y1="2" x2="12" y2="12" /></svg>
                      </button>
                      <button
                        className="btn-icon btn-icon-danger"
                        title="删除"
                        onClick={() => void deleteProject(project)}
                        disabled={busy}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Hit logs */}
          {filteredLogs.length > 0 && (
            <div className="settings-card">
              <div className="settings-card-header">
                <div className="settings-card-title">命中日志</div>
                <div className="settings-card-desc">最近 {filteredLogs.length} 条命中记录</div>
              </div>
              <div className="settings-card-body" style={{ gap: 8 }}>
                {filteredLogs.slice(0, 8).map((log) => (
                  <div
                    key={log.id}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "8px 12px", background: "var(--surface-soft)", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", fontSize: 12 }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {log.method} {log.requestUrl}
                      </div>
                      <div style={{ color: "var(--muted)", marginTop: 2 }}>
                        {log.outcome === "matched" ? "已命中" : log.outcome === "error" ? "执行失败" : "未处理"}
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
          )}

          {/* Warnings */}
          {(dashboard?.warnings ?? []).length > 0 && (
            <div className="settings-card">
              <div className="settings-card-header">
                <div className="settings-card-title">配置告警</div>
              </div>
              <div className="settings-card-body" style={{ gap: 8 }}>
                {(dashboard?.warnings ?? []).map((w) => (
                  <div className="form-warning-item" key={w}>{localizeWarning(w)}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  // ── ABOUT VIEW ────────────────────────────────────────────────────────

  function renderAboutView() {
    return (
      <>
        <div className="page-header">
          <div className="page-title">关于</div>
          <div className="page-subtitle">查看插件信息、文档与反馈渠道</div>
        </div>

        <div className="about-page">
          <div className="about-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>

          <div>
            <div className="about-app-name">Resource Proxy</div>
            <div className="about-app-desc">本地资源代理插件，更友好地管理你的本地规则，高效调试、预览与协作。</div>
          </div>

          <div className="about-links">
            <a
              className="about-link-item"
              href="https://github.com/your/resource-proxy"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>GitHub 源码</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
            <a
              className="about-link-item"
              href="https://docs.resource-proxy.dev"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>使用文档</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
            <a
              className="about-link-item"
              href="https://github.com/your/resource-proxy/issues"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>提交反馈</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          </div>
        </div>
      </>
    );
  }

  // ── PROJECT MODAL ─────────────────────────────────────────────────────

  function renderProjectModal() {
    const isEdit = !!projectDraft.id;
    return (
      <div className="modal-overlay" onClick={() => setShowProjectModal(false)}>
        <div className="modal-box" onClick={(e) => e.stopPropagation()}>
          <div className="modal-box-header">
            <span className="modal-box-title">{isEdit ? "编辑站点" : "新建站点"}</span>
            <button className="btn-icon" onClick={() => setShowProjectModal(false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="modal-box-body">
            <div className="form-group">
              <label className="form-label">
                站点名称 <span className="form-label-required">*</span>
              </label>
              <input
                className="form-input"
                value={projectDraft.name}
                onChange={(e) => setProjectDraft((v) => ({ ...v, name: e.target.value }))}
                placeholder="例如：App 主站"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Host 列表</label>
              <input
                className="form-input"
                value={projectDraft.siteHosts}
                onChange={(e) => setProjectDraft((v) => ({ ...v, siteHosts: e.target.value }))}
                placeholder="app.example.com, admin.example.com"
              />
              <span className="form-hint">多个 Host 用逗号分隔</span>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">环境标签</label>
                <input
                  className="form-input"
                  value={projectDraft.envLabel}
                  onChange={(e) => setProjectDraft((v) => ({ ...v, envLabel: e.target.value }))}
                  placeholder="staging / local"
                />
              </div>
              <div className="form-group">
                <label className="form-label" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 24 }}>
                  <input
                    type="checkbox"
                    checked={projectDraft.enabled}
                    onChange={(e) => setProjectDraft((v) => ({ ...v, enabled: e.target.checked }))}
                    style={{ width: "auto", minHeight: "auto", margin: 0 }}
                  />
                  默认启用
                </label>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">备注</label>
              <textarea
                className="form-textarea"
                value={projectDraft.note}
                onChange={(e) => setProjectDraft((v) => ({ ...v, note: e.target.value }))}
                placeholder="写清楚这个站点主要用来覆盖哪个环境。"
              />
            </div>
          </div>

          <div className="modal-box-footer">
            <button className="btn btn-ghost" onClick={() => setShowProjectModal(false)}>取消</button>
            <button
              className="btn btn-primary"
              onClick={() => void saveProject()}
              disabled={busy}
            >
              {isEdit ? "保存修改" : "创建站点"}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

// ── PURE HELPERS ────────────────────────────────────────────────────────

function mergeRuleDraftByKind<T extends RuleDraft | BatchRuleDraft>(
  draft: T,
  kind: Rule["kind"],
  patch: Partial<T> = {},
): T {
  const base = {
    ...draft,
    kind,
    resourceType:
      patch.resourceType ?? (kind === draft.kind ? draft.resourceType : defaultResourceTypeText(kind)),
    method: patch.method ?? (kind === draft.kind ? draft.method : defaultMethodText(kind)),
    redirectUrl: kind === "asset_redirect" ? (patch.redirectUrl ?? draft.redirectUrl) : "",
    targetBaseUrl: kind === "api_forward" ? (patch.targetBaseUrl ?? draft.targetBaseUrl) : "",
    stripPrefix: kind === "api_forward" ? (patch.stripPrefix ?? draft.stripPrefix) : "",
    headersJson: kind === "api_forward" ? (patch.headersJson ?? draft.headersJson ?? "{}") : "",
  };
  return { ...base, ...patch } as T;
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
  const existing = workspace.rules.find((r) => r.id === draft.id);
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

function buildRuleSearchText(rule: Rule): string {
  return [
    rule.name,
    rule.kind,
    joinCsv(rule.match.host),
    rule.match.pathGlob,
    joinCsv(rule.match.resourceType),
    joinCsv(rule.match.method),
    formatRuleTarget(rule),
    rule.note ?? "",
    joinCsv(rule.tags),
  ]
    .join(" ")
    .toLowerCase();
}

function formatRuleTarget(rule: Rule): string {
  if (rule.kind === "asset_redirect") {
    return rule.target.redirectUrl || "未填写 HTTPS 地址";
  }
  return rule.target.forwardProfile?.targetBaseUrl || "未填写目标地址";
}

function formatTimestamp(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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

function defaultResourceTypeText(kind: Rule["kind"]): string {
  return joinCsv(kind === "api_forward" ? defaultApiTypes : defaultAssetTypes);
}

function defaultMethodText(kind: Rule["kind"]): string {
  return kind === "api_forward" ? "GET, POST" : "";
}

function getRuleTemplatePresets(kind: Rule["kind"]): RuleTemplatePreset[] {
  return ruleTemplatePresets.filter((t) => t.kind === kind);
}

const ruleTemplatePresets: RuleTemplatePreset[] = [
  {
    id: "api-local",
    kind: "api_forward",
    label: "本地 API 联调",
    description: "把 /api 请求转给本地服务",
    patch: {
      kind: "api_forward",
      name: "本地 API 转发",
      pathGlob: "/api/**",
      targetBaseUrl: "http://127.0.0.1:3000",
      stripPrefix: "",
      headersJson: "{}",
      resourceType: defaultResourceTypeText("api_forward"),
      method: defaultMethodText("api_forward"),
    },
  },
  {
    id: "api-bff",
    kind: "api_forward",
    label: "BFF / 网关转发",
    description: "替换目标网关地址，适合切 staging",
    patch: {
      kind: "api_forward",
      name: "网关 API 转发",
      pathGlob: "/gateway/**",
      targetBaseUrl: "https://staging.example.com",
      stripPrefix: "",
      headersJson: "{}",
      resourceType: defaultResourceTypeText("api_forward"),
      method: defaultMethodText("api_forward"),
    },
  },
  {
    id: "asset-bundle",
    kind: "asset_redirect",
    label: "静态资源替换",
    description: "替换脚本、样式或图片到 CDN",
    patch: {
      kind: "asset_redirect",
      name: "静态资源替换",
      pathGlob: "/assets/**",
      redirectUrl: "https://cdn.example.com/assets/app.js",
      resourceType: defaultResourceTypeText("asset_redirect"),
      method: defaultMethodText("asset_redirect"),
    },
  },
  {
    id: "asset-single-file",
    kind: "asset_redirect",
    label: "单文件覆盖",
    description: "替换一条精确文件路径",
    patch: {
      kind: "asset_redirect",
      name: "单文件资源替换",
      pathGlob: "/static/app.js",
      redirectUrl: "https://cdn.example.com/static/app.js",
      resourceType: "script",
      method: defaultMethodText("asset_redirect"),
    },
  },
];

const rootElement = document.getElementById("app");
if (!rootElement) {
  throw new Error("Missing app root.");
}

createRoot(rootElement).render(<App />);
