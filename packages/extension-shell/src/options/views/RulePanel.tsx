import React from "react";
import type { Project, RuleSet } from "@resource-forwarder/shared-types";
import type { RuleConflict } from "@resource-forwarder/rule-core";
import { joinCsv } from "../../shared/helpers.js";
import type { RuleDraft, RulePanelTab, RuleTemplatePreset } from "../types.js";
import { mergeRuleDraftByKind } from "../drafts.js";

export interface RulePanelProps {
  draft: RuleDraft;
  setDraft: (updater: (prev: RuleDraft) => RuleDraft) => void;

  /** Active tab — basic vs advanced. */
  tab: RulePanelTab;
  setTab: (tab: RulePanelTab) => void;

  /** Project / ruleset context shown in the header card and used to gate save. */
  selectedProject: Project | undefined;
  selectedRuleSet: RuleSet | undefined;

  /** Quick templates filtered to the active rule kind. */
  activeTemplates: RuleTemplatePreset[];
  applyTemplate: (preset: RuleTemplatePreset) => void;

  /** Conflict + warning lists derived in the parent. */
  conflicts: RuleConflict[];
  warnings: string[];

  busy: boolean;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  /** Save current rule then reset the form to start a new one. */
  onSaveAndContinue: () => void | Promise<void>;
}

/**
 * Side panel for creating or editing a single rule. The component is fully
 * controlled — `draft` + `setDraft` come from the parent so the same state
 * survives tab switches and modal close/open cycles.
 */
export function RulePanel({
  draft,
  setDraft,
  tab,
  setTab,
  selectedProject,
  selectedRuleSet,
  activeTemplates,
  applyTemplate,
  conflicts,
  warnings,
  busy,
  onClose,
  onSave,
  onSaveAndContinue,
}: RulePanelProps) {
  const isNew = !draft.id;
  const canSave = !busy && !!selectedProject && !!draft.ruleSetId;

  return (
    <aside className="rule-panel">
      <div className="rule-panel-header">
        <span className="rule-panel-title">{isNew ? "新建规则" : "编辑规则"}</span>
        <button className="btn-icon" onClick={onClose} aria-label="关闭规则面板" title="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="rule-panel-tabs">
        <button
          className={`rule-panel-tab ${tab === "basic" ? "active" : ""}`}
          onClick={() => setTab("basic")}
        >
          基础设置
        </button>
        <button
          className={`rule-panel-tab ${tab === "advanced" ? "active" : ""}`}
          onClick={() => setTab("advanced")}
        >
          高级设置
        </button>
      </div>

      <div className="rule-panel-body">
        {tab === "basic" && (
          <BasicTab
            draft={draft}
            setDraft={setDraft}
            selectedProject={selectedProject}
            selectedRuleSet={selectedRuleSet}
            activeTemplates={activeTemplates}
            applyTemplate={applyTemplate}
            conflicts={conflicts}
            warnings={warnings}
          />
        )}
        {tab === "advanced" && (
          <AdvancedTab draft={draft} setDraft={setDraft} selectedProject={selectedProject} />
        )}
      </div>

      <div className="rule-panel-footer">
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button
          className="btn btn-default"
          onClick={() => void onSaveAndContinue()}
          disabled={!canSave}
        >
          保存并继续新建
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void onSave()}
          disabled={!canSave}
        >
          保存
        </button>
      </div>
    </aside>
  );
}

// ── Tab subcomponents ────────────────────────────────────────────────

function BasicTab({
  draft,
  setDraft,
  selectedProject,
  selectedRuleSet,
  activeTemplates,
  applyTemplate,
  conflicts,
  warnings,
}: {
  draft: RuleDraft;
  setDraft: RulePanelProps["setDraft"];
  selectedProject: Project | undefined;
  selectedRuleSet: RuleSet | undefined;
  activeTemplates: RuleTemplatePreset[];
  applyTemplate: (preset: RuleTemplatePreset) => void;
  conflicts: RuleConflict[];
  warnings: string[];
}) {
  return (
    <>
      {selectedProject && (
        <div
          style={{
            padding: "10px 12px",
            background: "var(--surface-soft)",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          所属站点：<strong style={{ color: "var(--ink)" }}>{selectedProject.name}</strong>
          {selectedRuleSet ? `　规则组：${selectedRuleSet.name}` : ""}
        </div>
      )}

      <div className="form-group">
        <span className="form-label">规则类型</span>
        <div className="kind-segmented">
          <button
            className={`kind-seg-btn ${draft.kind === "api_forward" ? "active" : ""}`}
            onClick={() => setDraft((v) => mergeRuleDraftByKind(v, "api_forward"))}
          >
            API 转发
          </button>
          <button
            className={`kind-seg-btn ${draft.kind === "asset_redirect" ? "active" : ""}`}
            onClick={() => setDraft((v) => mergeRuleDraftByKind(v, "asset_redirect"))}
          >
            资源替换
          </button>
        </div>
      </div>

      <div className="form-group">
        <span className="form-label">快速模板</span>
        <div className="template-grid">
          {activeTemplates.map((tpl) => (
            <button key={tpl.id} className="template-card" onClick={() => applyTemplate(tpl)}>
              <strong>{tpl.label}</strong>
              <span>{tpl.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">
          规则名称 <span className="form-label-required">*</span>
        </label>
        <input
          className="form-input"
          value={draft.name}
          onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))}
          placeholder="例如：把 /api 指到本地服务"
        />
      </div>

      <div className="form-group">
        <label className="form-label">
          匹配路径 <span className="form-label-required">*</span>
        </label>
        <input
          className="form-input"
          value={draft.pathGlob}
          onChange={(e) => setDraft((v) => ({ ...v, pathGlob: e.target.value }))}
          placeholder="/api/**"
        />
      </div>

      {draft.kind === "api_forward" ? (
        <div className="form-group">
          <label className="form-label">
            目标地址 <span className="form-label-required">*</span>
          </label>
          <input
            className="form-input"
            value={draft.targetBaseUrl}
            onChange={(e) => setDraft((v) => ({ ...v, targetBaseUrl: e.target.value }))}
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
            value={draft.redirectUrl}
            onChange={(e) => setDraft((v) => ({ ...v, redirectUrl: e.target.value }))}
            placeholder="https://cdn.example.com/app.js"
          />
        </div>
      )}

      <div className="form-group">
        <label className="form-label">备注</label>
        <textarea
          className="form-textarea"
          value={draft.note}
          onChange={(e) => setDraft((v) => ({ ...v, note: e.target.value }))}
          placeholder="补充这条规则的适用场景。"
        />
      </div>

      {conflicts.length > 0 && (
        <div className="form-warnings">
          {conflicts.map((c) => (
            <div className="form-conflict-item" key={c.ruleId}>{c.reason}</div>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="form-warnings">
          {warnings.map((w) => (
            <div className="form-warning-item" key={w}>{w}</div>
          ))}
        </div>
      )}
    </>
  );
}

function AdvancedTab({
  draft,
  setDraft,
  selectedProject,
}: {
  draft: RuleDraft;
  setDraft: RulePanelProps["setDraft"];
  selectedProject: Project | undefined;
}) {
  return (
    <>
      <div className="form-group">
        <label className="form-label">Host 覆盖（留空则沿用站点 Host）</label>
        <input
          className="form-input"
          value={draft.host}
          onChange={(e) => setDraft((v) => ({ ...v, host: e.target.value }))}
          placeholder={selectedProject ? joinCsv(selectedProject.siteHosts) : "as.smgv.cn, cdn.example.com"}
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">资源类型</label>
          <input
            className="form-input"
            value={draft.resourceType}
            onChange={(e) => setDraft((v) => ({ ...v, resourceType: e.target.value }))}
            placeholder={draft.kind === "api_forward" ? "fetch, xmlhttprequest" : "script, stylesheet"}
          />
        </div>
        <div className="form-group">
          <label className="form-label">HTTP 方法</label>
          <input
            className="form-input"
            value={draft.method}
            onChange={(e) => setDraft((v) => ({ ...v, method: e.target.value }))}
            placeholder="GET, POST"
          />
        </div>
      </div>

      {draft.kind === "api_forward" && (
        <>
          <div className="form-group">
            <label className="form-label">去掉路径前缀</label>
            <input
              className="form-input"
              value={draft.stripPrefix}
              onChange={(e) => setDraft((v) => ({ ...v, stripPrefix: e.target.value }))}
              placeholder="/api"
            />
          </div>
          <div className="form-group">
            <label className="form-label">注入 Header（JSON）</label>
            <textarea
              className="form-textarea"
              value={draft.headersJson}
              onChange={(e) => setDraft((v) => ({ ...v, headersJson: e.target.value }))}
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
            value={draft.priority}
            onChange={(e) => setDraft((v) => ({ ...v, priority: Number(e.target.value) }))}
          />
        </div>
        <div className="form-group">
          <label className="form-label">标签</label>
          <input
            className="form-input"
            value={draft.tags}
            onChange={(e) => setDraft((v) => ({ ...v, tags: e.target.value }))}
            placeholder="team-a, local"
          />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft((v) => ({ ...v, enabled: e.target.checked }))}
            style={{ width: "auto", minHeight: "auto", margin: 0 }}
          />
          默认启用规则
        </label>
      </div>
    </>
  );
}
