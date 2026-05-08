import React from "react";
import type { ProjectDraft } from "../types.js";

export interface ProjectModalProps {
  draft: ProjectDraft;
  /** Functional setter so the consumer can keep delta-style updates terse. */
  setDraft: (updater: (prev: ProjectDraft) => ProjectDraft) => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  /** Disables the primary button while a save is in flight. */
  busy: boolean;
}

/**
 * Create / edit modal for a Project (site). Renders the form synchronously —
 * actual persistence and validation live in the parent's `onSave`. ESC + focus
 * restoration are handled by the parent's `useModalDismiss` wiring; this
 * component only implements the modal markup and field bindings.
 */
export function ProjectModal({ draft, setDraft, onClose, onSave, busy }: ProjectModalProps) {
  const isEdit = !!draft.id;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-box-header">
          <span className="modal-box-title">{isEdit ? "编辑站点" : "新建站点"}</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭" title="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
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
              value={draft.name}
              onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))}
              placeholder="例如：App 主站"
            />
          </div>

          <div className="form-group">
            <label className="form-label">站点匹配</label>
            <input
              className="form-input"
              value={draft.siteMatchPatterns}
              onChange={(e) => setDraft((v) => ({ ...v, siteMatchPatterns: e.target.value }))}
              placeholder="https://shimo.im/tables/*, https://shimodev.com/*"
            />
            <span className="form-hint">规则仅在当前页面匹配此模式时生效，多个用逗号分隔。支持 * 通配符</span>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">环境标签</label>
              <input
                className="form-input"
                value={draft.envLabel}
                onChange={(e) => setDraft((v) => ({ ...v, envLabel: e.target.value }))}
                placeholder="staging / local"
              />
            </div>
            <div className="form-group">
              {/* Inline checkbox: marginTop offsets the missing label height
                  so the row aligns with the env-label field above. */}
              <label className="form-label" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 24 }}>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft((v) => ({ ...v, enabled: e.target.checked }))}
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
              value={draft.note}
              onChange={(e) => setDraft((v) => ({ ...v, note: e.target.value }))}
              placeholder="写清楚这个站点主要用来覆盖哪个环境。"
            />
          </div>
        </div>

        <div className="modal-box-footer">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void onSave()} disabled={busy}>
            {isEdit ? "保存修改" : "创建站点"}
          </button>
        </div>
      </div>
    </div>
  );
}
