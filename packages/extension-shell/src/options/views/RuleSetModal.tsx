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
            <span className="form-hint">同一站点下的规则分组，可统一启停。</span>
          </div>

          <div className="form-group">
            <label className="form-label">分组页面范围</label>
            <input
              className="form-input"
              value={draft.siteMatchPatterns}
              onChange={(e) => setDraft((v) => ({ ...v, siteMatchPatterns: e.target.value }))}
              placeholder="https://shimo.im/tables/*, https://as.smgv.cn/table/*"
            />
            <span className="form-hint">
              留空继承站点；填写后进一步缩小页面范围。
            </span>
          </div>

          <div className="form-group">
            <label className="form-label">分组目标基址（完整 URL）</label>
            <input
              className="form-input"
              value={draft.baseUrl}
              onChange={(e) => setDraft((v) => ({ ...v, baseUrl: e.target.value }))}
              placeholder="例如 https://dev.example.com/tables/"
            />
            <span className="form-hint">用于解析规则中的相对目标；留空使用站点基址。</span>
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
