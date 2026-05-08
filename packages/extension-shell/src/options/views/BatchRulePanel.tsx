import React from "react";
import type { Project, RuleSet } from "@resource-forwarder/shared-types";
import type { BatchRuleDraft } from "../types.js";
import { mergeRuleDraftByKind } from "../drafts.js";

export interface BatchRulePanelProps {
  drafts: BatchRuleDraft[];
  selectedProject: Project | undefined;
  selectedRuleSet: RuleSet | undefined;
  busy: boolean;

  /** Patch a single draft's fields, identified by `localId`. */
  updateDraft: (localId: string, patch: Partial<BatchRuleDraft>) => void;
  /** Append a fresh empty draft to the list. */
  appendDraft: () => void;
  /** Remove a draft by `localId`. Disabled when only one draft remains. */
  removeDraft: (localId: string) => void;

  onClose: () => void;
  onSave: () => void | Promise<void>;
}

/**
 * Side panel that lets a user enter several rules at once before persisting
 * them in a single batch. Each row is essentially a stripped-down rule form.
 */
export function BatchRulePanel({
  drafts,
  selectedProject,
  selectedRuleSet,
  busy,
  updateDraft,
  appendDraft,
  removeDraft,
  onClose,
  onSave,
}: BatchRulePanelProps) {
  const canSave = !busy && !!selectedProject && !!selectedRuleSet;

  return (
    <aside className="rule-panel">
      <div className="rule-panel-header">
        <span className="rule-panel-title">连续新增规则</span>
        <button className="btn-icon" onClick={onClose} aria-label="关闭批量规则面板" title="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="rule-panel-body">
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
          </div>
        )}

        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          在这里快速录入多条规则的基础字段，保存后可逐一补充高级选项。
        </div>

        <div className="batch-rule-list">
          {drafts.map((draft, index) => (
            <BatchRuleCard
              key={draft.localId}
              draft={draft}
              index={index}
              busy={busy}
              canRemove={drafts.length > 1}
              update={(patch) => updateDraft(draft.localId, patch)}
              remove={() => removeDraft(draft.localId)}
            />
          ))}
        </div>

        <button className="btn btn-default" style={{ width: "100%" }} onClick={appendDraft} disabled={busy}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }} aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          再加一条
        </button>
      </div>

      <div className="rule-panel-footer">
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn btn-primary" onClick={() => void onSave()} disabled={!canSave}>
          全部保存（{drafts.length} 条）
        </button>
      </div>
    </aside>
  );
}

function BatchRuleCard({
  draft,
  index,
  busy,
  canRemove,
  update,
  remove,
}: {
  draft: BatchRuleDraft;
  index: number;
  busy: boolean;
  canRemove: boolean;
  update: (patch: Partial<BatchRuleDraft>) => void;
  remove: () => void;
}) {
  // Switching kinds re-derives a sensible default path so the placeholder
  // text matches the active mode without clobbering user-edited values.
  function switchKind(kind: BatchRuleDraft["kind"]) {
    const fallbackPath = kind === "api_forward" ? "/api/**" : "/assets/**";
    const otherDefault = kind === "api_forward" ? "/assets/**" : "/api/**";
    const nextPath =
      draft.pathGlob === otherDefault || !draft.pathGlob ? fallbackPath : draft.pathGlob;
    update(mergeRuleDraftByKind(draft, kind, { pathGlob: nextPath }));
  }

  return (
    <div className="batch-rule-card">
      <div className="batch-rule-card-header">
        <span className="batch-rule-card-label">规则 {index + 1}</span>
        <button className="btn-icon btn-icon-danger" onClick={remove} disabled={busy || !canRemove}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
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
          onClick={() => switchKind("api_forward")}
        >
          API 转发
        </button>
        <button
          className={`kind-seg-btn ${draft.kind === "asset_redirect" ? "active" : ""}`}
          onClick={() => switchKind("asset_redirect")}
        >
          资源替换
        </button>
      </div>

      <div className="form-group">
        <label className="form-label">规则名称</label>
        <input
          className="form-input"
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="例如：把 /api 指到本地服务"
        />
      </div>
      <div className="form-group">
        <label className="form-label">匹配路径</label>
        <input
          className="form-input"
          value={draft.pathGlob}
          onChange={(e) => update({ pathGlob: e.target.value })}
          placeholder={draft.kind === "api_forward" ? "/api/**" : "/assets/**"}
        />
      </div>
      {draft.kind === "api_forward" ? (
        <div className="form-group">
          <label className="form-label">目标地址</label>
          <input
            className="form-input"
            value={draft.targetBaseUrl}
            onChange={(e) => update({ targetBaseUrl: e.target.value })}
            placeholder="http://127.0.0.1:3000"
          />
        </div>
      ) : (
        <div className="form-group">
          <label className="form-label">替换到的 HTTPS 地址</label>
          <input
            className="form-input"
            value={draft.redirectUrl}
            onChange={(e) => update({ redirectUrl: e.target.value })}
            placeholder="https://cdn.example.com/app.js"
          />
        </div>
      )}
    </div>
  );
}
