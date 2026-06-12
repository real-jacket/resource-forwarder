import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  collectRuleConflicts,
  collectUnsupportedRuleWarnings,
  detectFormat,
  deriveSiteHosts,
  matchesProjectSite,
  parseResourceOverrideExport,
  serializeWorkspace,
  sortRules,
} from "@resource-forwarder/rule-core";
import type {
  Project,
  Rule,
  RuleSet,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";
import { createId, joinCsv, splitCsv } from "../shared/helpers.js";
import {
  createProjectCopyBundle,
  createRuleCopy,
  createRuleSetCopyBundle,
} from "./project-copy.js";
import { detectImportSource } from "./import-source.js";
import type {
  DashboardState,
  ExportWorkspaceRuntimeResponse,
  GetDashboardStateResponse,
  SyncWorkspaceResponse,
  UpsertMutationResponse,
} from "../shared/messages.js";
import { runtimeRequest } from "../shared/messages.js";
import { STORAGE_KEYS } from "../shared/constants.js";
import {
  type AppView,
  type BatchRuleDraft,
  type CopyDraft,
  type ImportFeedback,
  type ImportSource,
  type PanelMode,
  type ProjectDraft,
  type RuleDraft,
  type RulePanelTab,
  type RuleSetDraft,
  type RuleStatusTab,
  type RuleTemplatePreset,
} from "./types.js";
import { useModalDismiss } from "./hooks/useModalDismiss.js";
import { useConfirm } from "./hooks/useConfirm.js";
import { AboutView } from "./views/AboutView.js";
import { SettingsView } from "./views/SettingsView.js";
import { ImportExportView } from "./views/ImportExportView.js";
import { ProjectModal } from "./views/ProjectModal.js";
import { RuleSetModal } from "./views/RuleSetModal.js";
import { ImportPreviewModal } from "./views/ImportPreviewModal.js";
import { RulesView } from "./views/RulesView.js";
import { RulePanel } from "./views/RulePanel.js";
import { BatchRulePanel } from "./views/BatchRulePanel.js";
import { CopyToModal } from "./views/CopyToModal.js";
import {
  createBatchRuleDraft,
  createRuleDraft,
  fromProject,
  getRuleTemplatePresets,
  mergeRuleDraftByKind,
  toRule,
} from "./drafts.js";
import { buildRuleSearchText, localizeWarning } from "./formatters.js";

const emptyProjectDraft = (): ProjectDraft => ({
  id: "",
  name: "",
  siteMatchPatterns: "",
  baseUrl: "",
  envLabel: "",
  note: "",
  enabled: true,
});

const emptyRuleSetDraft = (projectId = ""): RuleSetDraft => ({
  id: "",
  projectId,
  name: "",
  enabled: true,
  siteMatchPatterns: "",
  baseUrl: "",
  note: "",
});

function findDefaultCopyTargetProjectId(projects: Project[], sourceProjectId: string): string {
  return projects.find((project) => project.id !== sourceProjectId)?.id ?? projects[0]?.id ?? "";
}

function findFirstRuleSetId(ruleSets: RuleSet[], projectId: string): string {
  return ruleSets.find((ruleSet) => ruleSet.projectId === projectId)?.id ?? "";
}

function App() {
  const [view, setView] = useState<AppView>("rules");
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedRuleSetId, setSelectedRuleSetId] = useState("");
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [rulePanelTab, setRulePanelTab] = useState<RulePanelTab>("basic");
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>(emptyProjectDraft());
  const [showRuleSetModal, setShowRuleSetModal] = useState(false);
  const [ruleSetDraft, setRuleSetDraft] = useState<RuleSetDraft>(emptyRuleSetDraft());
  const [copyDraft, setCopyDraft] = useState<CopyDraft | null>(null);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(createRuleDraft());
  const [batchRuleDrafts, setBatchRuleDrafts] = useState<BatchRuleDraft[]>([]);
  const [serviceUrl, setServiceUrl] = useState("");
  // We never *display* the saved token (just whether one is present), so this
  // state holds only the value the user is currently editing in the input. It
  // resets to "" after a successful save so the input shows the masked
  // placeholder again.
  const [serviceTokenInput, setServiceTokenInput] = useState("");
  const [serviceTokenSaved, setServiceTokenSaved] = useState(false);
  const [importText, setImportText] = useState("");
  const [importSource, setImportSource] = useState<ImportSource>("resource-override");
  const [exportText, setExportText] = useState("");
  const [exportFormat, setExportFormat] = useState<"json" | "yaml">("yaml");
  const [exportScope, setExportScope] = useState<"all" | "selected">("all");
  const [exportSelectedIds, setExportSelectedIds] = useState<Set<string>>(new Set());
  const [ruleQuery, setRuleQuery] = useState("");
  const [ruleKindFilter, setRuleKindFilter] = useState<"all" | Rule["kind"]>("all");
  const [ruleStatusTab, setRuleStatusTab] = useState<RuleStatusTab>("all");
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null);
  const [resourceOverridePreview, setResourceOverridePreview] = useState<ReturnType<typeof parseResourceOverrideExport> | null>(null);
  const [importModalError, setImportModalError] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [siteStatusFilter, setSiteStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [siteQuery, setSiteQuery] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [status, setStatus] = useState("正在加载规则...");
  const [busy, setBusy] = useState(false);
  const deferredRuleQuery = useDeferredValue(ruleQuery.trim().toLowerCase());
  const deferredSiteQuery = useDeferredValue(siteQuery.trim().toLowerCase());

  useEffect(() => {
    void refresh();
    // Probe whether a token is already saved so the input shows the masked
    // "已保存" state on first paint rather than flashing an empty field. The
    // chrome types here resolve to the callback overload; using it avoids a
    // typing dance that does nothing for runtime behaviour.
    chrome.storage.local.get(STORAGE_KEYS.serviceToken, (stored) => {
      const value = (stored as Record<string, unknown>)[STORAGE_KEYS.serviceToken];
      setServiceTokenSaved(typeof value === "string" && value.length > 0);
    });
  }, []);

  // Async-friendly replacement for window.confirm. Renders an in-app dialog
  // so deletion flows match the rest of the app's chrome and respect ESC /
  // focus restoration. The `dialog` element gets mounted at the bottom of
  // the layout below.
  const { confirm, dialog: confirmDialog } = useConfirm();

  // ESC handlers + focus restoration for the two modal/panel surfaces.
  // Wired here at the top level so the rule-of-hooks is honoured even though
  // the modals themselves are rendered by helper functions further down.
  useModalDismiss(showProjectModal, () => setShowProjectModal(false));
  useModalDismiss(showRuleSetModal, () => setShowRuleSetModal(false));
  useModalDismiss(copyDraft !== null, () => setCopyDraft(null));
  useModalDismiss(resourceOverridePreview !== null, () => {
    if (busy) return;
    setResourceOverridePreview(null);
    setImportFeedback(null);
    setImportModalError(null);
  });
  useModalDismiss(panelMode !== null, () => setPanelMode(null));

  const projects = dashboard?.workspace.projects ?? [];
  const ruleSets = dashboard?.workspace.ruleSets ?? [];
  const rules = dashboard?.workspace.rules ?? [];
  const logs = dashboard?.logs ?? [];
  const currentHost = dashboard?.currentTab?.host ?? "";

  const currentUrl = dashboard?.currentTab?.url ?? "";
  const selectedProject = useMemo(
    () =>
      projects.find((p) => p.id === selectedProjectId) ??
      (currentUrl ? projects.find((p) => matchesProjectSite(p, currentUrl)) : undefined) ??
      projects[0],
    [projects, selectedProjectId, currentUrl],
  );

  const selectedProjectRuleSets = useMemo(
    () => ruleSets.filter((rs) => rs.projectId === selectedProject?.id),
    [ruleSets, selectedProject?.id],
  );

  const selectedRuleSet = useMemo(() => {
    if (!selectedProject) return undefined;
    return (
      selectedProjectRuleSets.find((rs) => rs.id === selectedRuleSetId) ?? selectedProjectRuleSets[0]
    );
  }, [selectedProjectRuleSets, selectedRuleSetId, selectedProject]);

  const copySourceProject = useMemo(
    () => (copyDraft ? projects.find((project) => project.id === copyDraft.sourceProjectId) : undefined),
    [copyDraft, projects],
  );
  const copySourceRuleSet = useMemo(
    () => (copyDraft ? ruleSets.find((ruleSet) => ruleSet.id === copyDraft.sourceRuleSetId) : undefined),
    [copyDraft, ruleSets],
  );
  const copySourceRule = useMemo(
    () =>
      copyDraft?.mode === "rule"
        ? rules.find((rule) => rule.id === copyDraft.sourceRuleId)
        : undefined,
    [copyDraft, rules],
  );
  const copyTargetRuleSets = useMemo(
    () => (copyDraft?.targetProjectId ? ruleSets.filter((ruleSet) => ruleSet.projectId === copyDraft.targetProjectId) : []),
    [copyDraft, ruleSets],
  );

  useEffect(() => {
    if (!copyDraft || copyDraft.mode !== "rule" || !copyDraft.targetProjectId) {
      return;
    }
    const targetRuleSetId = findFirstRuleSetId(ruleSets, copyDraft.targetProjectId);
    if (!targetRuleSetId) {
      if (copyDraft.targetRuleSetId) {
        setCopyDraft((current) =>
          current && current.mode === "rule" ? { ...current, targetRuleSetId: "" } : current,
        );
      }
      return;
    }
    if (copyDraft.targetRuleSetId !== targetRuleSetId && !ruleSets.some((ruleSet) => ruleSet.id === copyDraft.targetRuleSetId && ruleSet.projectId === copyDraft.targetProjectId)) {
      setCopyDraft((current) =>
        current && current.mode === "rule" ? { ...current, targetRuleSetId } : current,
      );
    }
  }, [copyDraft, ruleSets]);

  const selectedRuleIds = useMemo(
    () => new Set(selectedProjectRuleSets.flatMap((rs) => rs.ruleIds)),
    [selectedProjectRuleSets],
  );

  // O(rules + ruleSets + projects) indices used by every per-row lookup. Without
  // this, allRuleRows / ruleCount derivations were each O(rules × ruleSets × projects)
  // — at ~500 rules and ~50 projects that's already 12.5M operations per render
  // and the rule list scrolling would noticeably hitch.
  const projectById = useMemo(() => {
    const map = new Map<string, Project>();
    for (const project of projects) map.set(project.id, project);
    return map;
  }, [projects]);

  const ruleSetByRuleId = useMemo(() => {
    const map = new Map<string, RuleSet>();
    for (const ruleSet of ruleSets) {
      for (const ruleId of ruleSet.ruleIds) map.set(ruleId, ruleSet);
    }
    return map;
  }, [ruleSets]);

  const ruleCountByProjectId = useMemo(() => {
    const map = new Map<string, number>();
    for (const ruleSet of ruleSets) {
      map.set(ruleSet.projectId, (map.get(ruleSet.projectId) ?? 0) + ruleSet.ruleIds.length);
    }
    return map;
  }, [ruleSets]);

  // Flat list of all rules with their project info, derived via indices above.
  const allRuleRows = useMemo(() => {
    return sortRules(rules).map((rule) => {
      const ruleSet = ruleSetByRuleId.get(rule.id);
      const project = ruleSet ? projectById.get(ruleSet.projectId) ?? null : null;
      return { rule, project, ruleSet: ruleSet ?? null };
    });
  }, [rules, ruleSetByRuleId, projectById]);

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

  // The previous implementation called allRuleRows.find inside .filter, making
  // each count O(n²). Use the row's own `project` field — it is already
  // populated by allRuleRows and there's nothing else to look up.
  const { enabledCount, disabledCount } = useMemo(() => {
    let enabled = 0;
    let disabled = 0;
    for (const { rule, project } of allRuleRows) {
      if (selectedProjectId && project?.id !== selectedProjectId) continue;
      if (rule.enabled) enabled += 1;
      else disabled += 1;
    }
    return { enabledCount: enabled, disabledCount: disabled };
  }, [allRuleRows, selectedProjectId]);

  const filteredProjects = useMemo(() => {
    return projects.filter((project) => {
      if (siteStatusFilter === "enabled" && !project.enabled) return false;
      if (siteStatusFilter === "disabled" && project.enabled) return false;
      if (deferredSiteQuery) {
        const text = [
          project.name,
          ...project.siteHosts,
          ...(project.siteMatchPatterns ?? []),
          project.baseUrl ?? "",
          project.envLabel ?? "",
        ].join(" ").toLowerCase();
        return text.includes(deferredSiteQuery);
      }
      return true;
    });
  }, [projects, siteStatusFilter, deferredSiteQuery]);

  const duplicateProjectIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of projects) {
      const key = `${p.name}|${(p.siteMatchPatterns ?? p.siteHosts ?? []).join(",")}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const dupes = new Set<string>();
    for (const p of projects) {
      const key = `${p.name}|${(p.siteMatchPatterns ?? p.siteHosts ?? []).join(",")}`;
      if ((counts.get(key) ?? 0) > 1) dupes.add(p.id);
    }
    return dupes;
  }, [projects]);

  const siteEnabledCount = useMemo(() => projects.filter((p) => p.enabled).length, [projects]);
  const siteDisabledCount = useMemo(() => projects.filter((p) => !p.enabled).length, [projects]);

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
      const tabUrl = state.currentTab?.url ?? "";
      const matched = tabUrl ? state.workspace.projects.find((p) => matchesProjectSite(p, tabUrl)) : undefined;
      return matched?.id ?? state.workspace.projects[0]?.id ?? "";
    });
  }

  // When the selected project changes (either via user click or by hydrate),
  // reset selectedRuleSetId to that project's first group if the current
  // selection no longer belongs to the project. Keeping the id around when it
  // is still valid lets users navigate rules → settings → rules without losing
  // their group focus.
  useEffect(() => {
    if (!selectedProject) {
      setSelectedRuleSetId("");
      return;
    }
    const stillValid = selectedProjectRuleSets.some((rs) => rs.id === selectedRuleSetId);
    if (!stillValid) {
      setSelectedRuleSetId(selectedProjectRuleSets[0]?.id ?? "");
    }
  }, [selectedProject?.id, selectedProjectRuleSets, selectedRuleSetId]);

  function openProjectModal(project?: Project): void {
    setProjectDraft(project ? fromProject(project) : emptyProjectDraft());
    setShowProjectModal(true);
  }

  function openRuleSetModal(ruleSet?: RuleSet): void {
    if (!selectedProject && !ruleSet) {
      setStatus("请先选择一个站点，再创建分组。");
      return;
    }
    setRuleSetDraft(
      ruleSet
        ? {
            id: ruleSet.id,
            projectId: ruleSet.projectId,
            name: ruleSet.name,
            enabled: ruleSet.enabled,
            siteMatchPatterns: joinCsv(ruleSet.siteMatchPatterns ?? []),
            baseUrl: ruleSet.baseUrl ?? "",
            note: ruleSet.note ?? "",
          }
        : emptyRuleSetDraft(selectedProject?.id ?? ""),
    );
    setShowRuleSetModal(true);
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

  function duplicateRule(rule: Rule, project?: Project | null, ruleSet?: RuleSet | null): void {
    const sourceProject = project ?? selectedProject;
    const sourceRuleSet = ruleSet ?? selectedRuleSet;
    if (!sourceProject || !sourceRuleSet) {
      setStatus("请先选择一个站点，再复制规则。");
      return;
    }
    setSelectedProjectId(sourceProject.id);
    setSelectedRuleSetId(sourceRuleSet.id);
    const base = createRuleDraft({ project: sourceProject, ruleSet: sourceRuleSet, kind: rule.kind, rule });
    setRuleDraft({ ...base, id: "", name: `${rule.name} 副本` });
    setRulePanelTab("basic");
    setPanelMode("rule");
  }

  function openRuleCopyModal(rule: Rule, project?: Project | null, ruleSet?: RuleSet | null): void {
    const sourceProject = project ?? selectedProject;
    const sourceRuleSet = ruleSet ?? selectedRuleSet;
    if (!sourceProject || !sourceRuleSet) {
      setStatus("请先定位规则所属的站点和分组。");
      return;
    }
    const targetProjectId = findDefaultCopyTargetProjectId(projects, sourceProject.id);
    setCopyDraft({
      mode: "rule",
      sourceProjectId: sourceProject.id,
      sourceRuleSetId: sourceRuleSet.id,
      sourceRuleId: rule.id,
      targetProjectId,
      targetRuleSetId: findFirstRuleSetId(ruleSets, targetProjectId),
    });
  }

  function openRuleSetCopyModal(ruleSet: RuleSet): void {
    const sourceProject = projects.find((project) => project.id === ruleSet.projectId);
    if (!sourceProject) {
      setStatus("请先定位分组所属的站点。");
      return;
    }
    setCopyDraft({
      mode: "rule-set",
      sourceProjectId: sourceProject.id,
      sourceRuleSetId: ruleSet.id,
      targetProjectId: findDefaultCopyTargetProjectId(projects, sourceProject.id),
    });
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

  async function saveServiceToken(): Promise<void> {
    const token = serviceTokenInput.trim();
    if (!token) {
      setStatus("请粘贴 token 内容。");
      return;
    }
    setBusy(true);
    try {
      const state = await runtimeRequest<SyncWorkspaceResponse>({ type: "set-service-token", token });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setServiceTokenInput("");
      setServiceTokenSaved(true);
      setStatus("Token 已保存并完成同步。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存 token 失败。");
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
      const siteMatchPatterns = splitCsv(projectDraft.siteMatchPatterns);
      const payload = {
        project: {
          id: projectId,
          name: projectDraft.name.trim(),
          enabled: projectDraft.enabled,
          siteHosts: deriveSiteHosts(siteMatchPatterns),
          siteMatchPatterns,
          baseUrl: projectDraft.baseUrl.trim() || undefined,
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
                  name: `${projectDraft.name.trim()} 默认分组`,
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

  async function saveRuleSet(): Promise<void> {
    if (!ruleSetDraft.name.trim()) {
      setStatus("请输入分组名称。");
      return;
    }
    if (!ruleSetDraft.projectId) {
      setStatus("请先选择一个站点，再创建分组。");
      return;
    }
    setBusy(true);
    try {
      const now = new Date().toISOString();
      const existing = ruleSets.find((rs) => rs.id === ruleSetDraft.id);
      const siteMatchPatterns = splitCsv(ruleSetDraft.siteMatchPatterns);
      const ruleSet: RuleSet = {
        id: ruleSetDraft.id || createId("ruleset"),
        projectId: ruleSetDraft.projectId,
        name: ruleSetDraft.name.trim(),
        enabled: ruleSetDraft.enabled,
        ruleIds: existing?.ruleIds ?? [],
        siteMatchPatterns: siteMatchPatterns.length > 0 ? siteMatchPatterns : undefined,
        baseUrl: ruleSetDraft.baseUrl.trim() || undefined,
        note: ruleSetDraft.note.trim() || undefined,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-rule-set",
        payload: { ruleSet },
      });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setSelectedRuleSetId(ruleSet.id);
      setShowRuleSetModal(false);
      setRuleSetDraft(emptyRuleSetDraft());
      setStatus(`分组「${ruleSet.name}」已保存。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存分组失败。");
    } finally {
      setBusy(false);
    }
  }

  async function toggleRuleSet(ruleSet: RuleSet): Promise<void> {
    setBusy(true);
    try {
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-rule-set",
        payload: { ruleSet: { ...ruleSet, enabled: !ruleSet.enabled } },
      });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setStatus(`分组「${ruleSet.name}」已${ruleSet.enabled ? "停用" : "启用"}。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "切换分组状态失败。");
    } finally {
      setBusy(false);
    }
  }

  async function deleteRuleSet(ruleSet: RuleSet): Promise<void> {
    const ruleCount = ruleSet.ruleIds.length;
    const confirmed = await confirm({
      title: "删除分组",
      message: `确认删除分组「${ruleSet.name}」？\n将同时删除其下 ${ruleCount} 条规则，此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "delete-rule-set",
        ruleSetId: ruleSet.id,
      });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      if (selectedRuleSetId === ruleSet.id) setSelectedRuleSetId("");
      setStatus(`分组「${ruleSet.name}」已删除。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "删除分组失败。");
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
    const ruleCount = ruleCountByProjectId.get(project.id) ?? 0;
    const confirmed = await confirm({
      title: "删除分组",
      message: `确认删除分组「${project.name}」？\n将同时删除其下 ${ruleCount} 条规则，此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
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

  async function duplicateProject(project: Project): Promise<void> {
    if (!dashboard) {
      setStatus("请先加载站点后再复制。");
      return;
    }

    setBusy(true);
    let nextState: UpsertMutationResponse | null = null;
    try {
      const now = new Date().toISOString();
      const bundle = createProjectCopyBundle(dashboard.workspace, project.id, now, createId);
      nextState = await runtimeRequest<UpsertMutationResponse>({
        type: "upsert-project",
        payload: {
          project: bundle.project,
          ruleSets: bundle.ruleSets,
        },
      });

      for (const rule of bundle.rules) {
        const targetRuleSet = bundle.ruleSets.find((ruleSet) => ruleSet.ruleIds.includes(rule.id));
        if (!targetRuleSet) {
          continue;
        }
        nextState = await runtimeRequest<UpsertMutationResponse>({
          type: "upsert-rule",
          payload: { rule, ruleSetId: targetRuleSet.id },
        });
      }

      if (nextState) {
        hydrateDashboard({ ...nextState, logs: dashboard.logs, currentTab: dashboard.currentTab });
      }
      setSelectedProjectId(bundle.project.id);
      setSelectedProjectIds(new Set());
      setStatus(`站点「${project.name}」已复制为「${bundle.project.name}」。`);
    } catch (error) {
      if (nextState) {
        hydrateDashboard({ ...nextState, logs: dashboard.logs, currentTab: dashboard.currentTab });
      }
      setStatus(error instanceof Error ? error.message : "复制站点失败。");
    } finally {
      setBusy(false);
    }
  }

  async function confirmCopyToTarget(): Promise<void> {
    if (!dashboard || !copyDraft) {
      setStatus("请先选择要复制的内容。");
      return;
    }

    setBusy(true);
    let nextState: UpsertMutationResponse | null = null;
    try {
      const now = new Date().toISOString();
      if (copyDraft.mode === "rule") {
        const sourceRule = rules.find((rule) => rule.id === copyDraft.sourceRuleId);
        const targetProject = projects.find((project) => project.id === copyDraft.targetProjectId);
        const targetRuleSet = ruleSets.find((ruleSet) => ruleSet.id === copyDraft.targetRuleSetId);
        if (!sourceRule || !targetProject || !targetRuleSet) {
          throw new Error("请选择有效的目标站点和分组。");
        }
        const copiedRule = createRuleCopy(sourceRule, now, createId);
        nextState = await runtimeRequest<UpsertMutationResponse>({
          type: "upsert-rule",
          payload: { rule: copiedRule, ruleSetId: targetRuleSet.id },
        });
        hydrateDashboard({ ...nextState, logs: dashboard.logs, currentTab: dashboard.currentTab });
        setSelectedProjectId(targetProject.id);
        setSelectedRuleSetId(targetRuleSet.id);
        setStatus(`规则「${sourceRule.name}」已复制到「${targetProject.name} / ${targetRuleSet.name}」。`);
      } else {
        const targetProject = projects.find((project) => project.id === copyDraft.targetProjectId);
        if (!targetProject) {
          throw new Error("请选择有效的目标站点。");
        }
        const bundle = createRuleSetCopyBundle(
          dashboard.workspace,
          copyDraft.sourceRuleSetId,
          targetProject.id,
          now,
          createId,
        );
        nextState = await runtimeRequest<UpsertMutationResponse>({
          type: "upsert-rule-set",
          payload: { ruleSet: bundle.ruleSet },
        });
        for (const rule of bundle.rules) {
          nextState = await runtimeRequest<UpsertMutationResponse>({
            type: "upsert-rule",
            payload: { rule, ruleSetId: bundle.ruleSet.id },
          });
        }
        if (nextState) {
          hydrateDashboard({ ...nextState, logs: dashboard.logs, currentTab: dashboard.currentTab });
        }
        setSelectedProjectId(targetProject.id);
        setSelectedRuleSetId(bundle.ruleSet.id);
        setStatus(`分组「${bundle.ruleSet.name}」已复制到站点「${targetProject.name}」。`);
      }
      setCopyDraft(null);
    } catch (error) {
      if (nextState) {
        hydrateDashboard({ ...nextState, logs: dashboard.logs, currentTab: dashboard.currentTab });
      }
      setStatus(error instanceof Error ? error.message : "复制失败。");
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
    const visibleIds = filteredProjects.map((p) => p.id);
    setSelectedProjectIds((prev) =>
      prev.size === visibleIds.length ? new Set() : new Set(visibleIds),
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
      (sum, p) => sum + (ruleCountByProjectId.get(p.id) ?? 0),
      0,
    );
    const confirmed = await confirm({
      title: "批量删除分组",
      message: `确认删除 ${targets.length} 个分组？\n将同时删除 ${totalRules} 条规则，此操作不可撤销。`,
      confirmText: "全部删除",
      danger: true,
    });
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

  async function deleteRule(rule: Rule): Promise<void> {
    const confirmed = await confirm({
      title: "删除规则",
      message: `确认删除规则「${rule.name}」？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      const state = await runtimeRequest<UpsertMutationResponse>({ type: "delete-rule", ruleId: rule.id });
      hydrateDashboard({ ...state, logs: dashboard?.logs ?? [], currentTab: dashboard?.currentTab });
      setStatus(`规则「${rule.name}」已删除。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "删除规则失败。");
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

    const detectedSource = detectImportSource(importText);
    if (detectedSource === "resource-override") {
      setImportSource("resource-override");
      setStatus("已识别为 Resource Override 配置，请先点击“预览导入”。");
      return;
    }

    setBusy(true);
    try {
      const state = await runtimeRequest<UpsertMutationResponse>({
        type: "import-workspace",
        payload: {
          content: importText,
          format: detectFormat(importText),
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

    const detectedSource = detectImportSource(importText);
    if (detectedSource === "workspace") {
      setImportSource("workspace");
      setStatus("已识别为本工具导出的 Workspace 快照，请直接选择“合并导入”或“整体替换”。");
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

  async function exportWorkspace(projectIds: string[]): Promise<void> {
    setBusy(true);
    try {
      const response = await runtimeRequest<ExportWorkspaceRuntimeResponse>({
        type: "export-workspace",
        projectIds,
        format: exportFormat,
      });
      setExportText(response.content);
      const label = projectIds.length === 0
        ? "全部站点"
        : projectIds.length === 1
          ? `站点「${projects.find((p) => p.id === projectIds[0])?.name ?? ""}」`
          : `${projectIds.length} 个站点`;
      setStatus(`已导出${label}的规则（${response.format.toUpperCase()}）。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出失败。");
    } finally {
      setBusy(false);
    }
  }

  function copyExportToClipboard(): void {
    if (!exportText) return;
    void navigator.clipboard.writeText(exportText).then(
      () => setStatus("已复制到剪贴板。"),
      () => setStatus("复制失败，请手动选择并复制。"),
    );
  }

  function downloadExportFile(): void {
    if (!exportText) return;
    const ext = exportFormat === "json" ? "json" : "yaml";
    const blob = new Blob([exportText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `resource-proxy-export-${new Date().toISOString().slice(0, 10)}.${ext}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus(`已下载导出文件。`);
  }

  function applyImportText(value: string): void {
    setImportText(value);
    const detectedSource = detectImportSource(value);
    if (detectedSource) setImportSource(detectedSource);
  }

  async function loadImportFile(file: File): Promise<void> {
    const text = await file.text();
    applyImportText(text);

    const detectedSource = detectImportSource(text);
    if (detectedSource === "workspace") {
      setStatus(`已载入 ${file.name}，识别为本工具导出的 Workspace 快照。`);
      return;
    }
    if (detectedSource === "resource-override") {
      setStatus(`已载入 ${file.name}，识别为 Resource Override 配置。`);
      return;
    }
    setStatus(`已载入 ${file.name}，但暂未识别文件类型，请检查内容是否为导出的 JSON/YAML。`);
  }

  // ── RENDER ──────────────────────────────────────────────────────────────

  return (
    <div className={`options-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
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
          {/* Collapse button lives in the header next to the brand so users
              don't hunt for it at the bottom of a tall list. The same button
              becomes the "expand" affordance once collapsed (icon flips). */}
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-expanded={!sidebarCollapsed}
          >
            <svg className="sidebar-collapse-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="11 17 6 12 11 7" />
              <polyline points="18 17 13 12 18 7" />
            </svg>
          </button>
        </div>

        <div className="sidebar-nav">
          <button
            className={`sidebar-nav-item ${view === "rules" ? "active" : ""}`}
            onClick={() => setView("rules")}
            title="规则列表"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
            <span className="sidebar-nav-label">规则列表</span>
          </button>
          <button
            className={`sidebar-nav-item ${view === "import-export" ? "active" : ""}`}
            onClick={() => setView("import-export")}
            title="导入导出"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span className="sidebar-nav-label">导入导出</span>
          </button>
          <button
            className={`sidebar-nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => setView("settings")}
            title="设置"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41M12 2v2M12 20v2M2 12h2M20 12h2" />
            </svg>
            <span className="sidebar-nav-label">设置</span>
          </button>
          <button
            className={`sidebar-nav-item ${view === "about" ? "active" : ""}`}
            onClick={() => setView("about")}
            title="关于"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="sidebar-nav-label">关于</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <div className={`sidebar-status ${dashboard?.health ? "online" : "offline"}`}>
            <span className="sidebar-status-dot" />
            <span className="sidebar-nav-label">
              {dashboard?.health
                ? `服务已连接 :${servicePort}`
                : "离线模式（本地存储）"}
            </span>
          </div>
          {!dashboard?.health && rules.length > 0 && (
            <div className="sidebar-status-hint sidebar-nav-label">
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
          {view === "rules" && (
            <RulesView
              status={status}
              dashboard={dashboard}
              busy={busy}
              projects={projects}
              selectedProject={selectedProject}
              selectedProjectId={selectedProjectId}
              setSelectedProjectId={setSelectedProjectId}
              selectedRuleSet={selectedRuleSet}
              selectedRuleSetId={selectedRuleSetId}
              setSelectedRuleSetId={setSelectedRuleSetId}
              projectRuleSets={selectedProjectRuleSets}
              allRuleRows={allRuleRows}
              filteredRuleRows={filteredRuleRows}
              ruleStatusTab={ruleStatusTab}
              setRuleStatusTab={setRuleStatusTab}
              totalCount={totalCount}
              tabEnabledCount={tabEnabledCount}
              tabDisabledCount={tabDisabledCount}
              ruleKindFilter={ruleKindFilter}
              setRuleKindFilter={setRuleKindFilter}
              ruleQuery={ruleQuery}
              setRuleQuery={setRuleQuery}
              setView={setView}
              actions={{
                refresh,
                openProjectModal,
                openRuleSetModal,
                openRulePanel,
                openBatchRulePanel,
                duplicateRule,
                openRuleCopyModal,
                openRuleSetCopyModal,
                deleteRule,
                toggleRule,
                toggleProject,
                deleteProject,
                toggleRuleSet,
                deleteRuleSet,
              }}
            />
          )}
          {view === "import-export" && (
            <ImportExportView
              projects={projects}
              ruleCountByProjectId={ruleCountByProjectId}
              busy={busy}
              status={status}
              import={{
                text: importText,
                setText: applyImportText,
                source: importSource,
                setSource: setImportSource,
                feedback: importFeedback,
                setFeedback: setImportFeedback,
                setResourceOverridePreview,
                previewResourceOverride: previewResourceOverrideImport,
                workspace: importWorkspace,
                loadFile: loadImportFile,
              }}
              export={{
                scope: exportScope,
                setScope: setExportScope,
                selectedIds: exportSelectedIds,
                setSelectedIds: setExportSelectedIds,
                format: exportFormat,
                setFormat: setExportFormat,
                text: exportText,
                run: exportWorkspace,
                copy: copyExportToClipboard,
                download: downloadExportFile,
                setStatus,
              }}
            />
          )}
          {view === "settings" && (
            <SettingsView
              data={{
                dashboard,
                projects,
                selectedProject,
                currentUrl,
                logs,
                ruleCountByProjectId,
                duplicateProjectIds,
                busy,
              }}
              service={{
                url: serviceUrl,
                setUrl: setServiceUrl,
                save: saveServiceUrl,
                refresh,
                port: servicePort,
                tokenInput: serviceTokenInput,
                setTokenInput: setServiceTokenInput,
                tokenSaved: serviceTokenSaved,
                saveToken: saveServiceToken,
              }}
              filters={{
                status: siteStatusFilter,
                setStatus: setSiteStatusFilter,
                query: siteQuery,
                setQuery: setSiteQuery,
                deferredQuery: deferredSiteQuery,
                filtered: filteredProjects,
                enabledCount: siteEnabledCount,
                disabledCount: siteDisabledCount,
              }}
              selection={{
                ids: selectedProjectIds,
                setIds: setSelectedProjectIds,
                toggle: toggleProjectSelection,
                toggleAll: toggleAllProjectSelection,
                batchToggle: batchToggleProjects,
                batchDelete: batchDeleteProjects,
              }}
              actions={{
                openProjectModal,
                toggleProject,
                duplicateProject,
                deleteProject,
                setSelectedProjectId,
                setView,
              }}
            />
          )}
          {view === "about" && <AboutView />}
        </div>

        {/* Right panel */}
        {panelMode === "rule" && (
          <RulePanel
            draft={ruleDraft}
            setDraft={setRuleDraft}
            tab={rulePanelTab}
            setTab={setRulePanelTab}
            selectedProject={selectedProject}
            selectedRuleSet={selectedRuleSet}
            projectRuleSets={selectedProjectRuleSets}
            activeTemplates={activeRuleTemplates}
            applyTemplate={applyRuleTemplate}
            conflicts={ruleConflicts}
            warnings={ruleWarnings}
            busy={busy}
            onClose={() => setPanelMode(null)}
            onSave={saveRule}
            onSaveAndContinue={saveRuleAndContinue}
          />
        )}
        {panelMode === "rule-batch" && (
          <BatchRulePanel
            drafts={batchRuleDrafts}
            selectedProject={selectedProject}
            selectedRuleSet={selectedRuleSet}
            projectRuleSets={selectedProjectRuleSets}
            busy={busy}
            updateDraft={updateBatchRuleDraft}
            appendDraft={appendBatchRuleDraft}
            removeDraft={removeBatchRuleDraft}
            onClose={() => setPanelMode(null)}
            onSave={saveBatchRules}
          />
        )}
      </div>

      {/* Project modal */}
      {showProjectModal && (
        <ProjectModal
          draft={projectDraft}
          setDraft={setProjectDraft}
          onClose={() => setShowProjectModal(false)}
          onSave={saveProject}
          busy={busy}
        />
      )}

      {/* RuleSet modal */}
      {showRuleSetModal && (
        <RuleSetModal
          draft={ruleSetDraft}
          setDraft={setRuleSetDraft}
          onClose={() => setShowRuleSetModal(false)}
          onSave={saveRuleSet}
          busy={busy}
        />
      )}

      {copyDraft && (
        <CopyToModal
          draft={copyDraft}
          projects={projects}
          targetRuleSets={copyTargetRuleSets}
          sourceProject={copySourceProject}
          sourceRuleSet={copySourceRuleSet}
          sourceRule={copySourceRule}
          busy={busy}
          setDraft={(updater) => setCopyDraft((current) => (current ? updater(current) : current))}
          onClose={() => setCopyDraft(null)}
          onConfirm={confirmCopyToTarget}
        />
      )}

      {/* Resource Override import preview modal */}
      {resourceOverridePreview && (
        <ImportPreviewModal
          preview={resourceOverridePreview}
          busy={busy}
          error={importModalError}
          onClose={() => {
            if (busy) return;
            setResourceOverridePreview(null);
            setImportFeedback(null);
            setImportModalError(null);
          }}
          onImport={importResourceOverride}
        />
      )}

      {/* In-app confirm dialog (replaces window.confirm) */}
      {confirmDialog}
    </div>
  );


}

const rootElement = document.getElementById("app");
if (!rootElement) {
  throw new Error("Missing app root.");
}

createRoot(rootElement).render(<App />);
