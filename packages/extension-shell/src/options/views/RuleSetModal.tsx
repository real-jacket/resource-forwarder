import React from "react";
import type { RuleSetDraft } from "../types.js";

export interface RuleSetModalProps {
  draft: RuleSetDraft;
  setDraft: (updater: (prev: RuleSetDraft) => RuleSetDraft) => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  busy: boolean;
}

export function RuleSetModal({ draft, setDraft, onClose, onSave, busy }: RuleSetModalProps) {
  const isEdit = !!draft.id;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-box-header">
          <span className="modal-box-title">{isEdit ? "编辑分组" : "新建分组"}</span>
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
              分组名称 <span className="form-label-required">*</span>
            </label>
            <input
              className="form-input"
              value={draft.name}
              onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))}
              placeholder="例如：tables / sheets / assets"
              autoFocus
            />
            <span className="form-hint">用于区分同一站点下的不同应用或子模块，分组内的规则会一起启停。</span>
          </div>

          <div className="form-group">
            <label className="form-label">分组匹配 URL</label>
            <input
              className="form-input"
              value={draft.siteMatchPatterns}
              onChange={(e) => setDraft((v) => ({ ...v, siteMatchPatterns: e.target.value }))}
              placeholder="https://shimo.im/tables/*, https://as.smgv.cn/table/*"
            />
            <span className="form-hint">
              留空时跟随所属站点；填写后只有当前页面 URL 命中这些模式时，分组才出现在侧边栏的「当前页面」视图。多个用逗号分隔。
            </span>
          </div>

          <div className="form-group">
            <label className="form-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft((v) => ({ ...v, enabled: e.target.checked }))}
                style={{ width: "auto", minHeight: "auto", margin: 0 }}
              />
              启用此分组
            </label>
          </div>

          <div className="form-group">
            <label className="form-label">备注</label>
            <textarea
              className="form-textarea"
              value={draft.note}
              onChange={(e) => setDraft((v) => ({ ...v, note: e.target.value }))}
              placeholder="可选：写清楚此分组覆盖的功能范围"
            />
          </div>
        </div>

        <div className="modal-box-footer">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void onSave()} disabled={busy}>
            {isEdit ? "保存修改" : "创建分组"}
          </button>
        </div>
      </div>
    </div>
  );
}
