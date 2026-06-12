import React from "react";
import type { Project, Rule, RuleSet } from "@resource-forwarder/shared-types";
import type { CopyDraft } from "../types.js";

export interface CopyToModalProps {
  draft: CopyDraft;
  projects: Project[];
  targetRuleSets: RuleSet[];
  sourceProject: Project | undefined;
  sourceRuleSet: RuleSet | undefined;
  sourceRule?: Rule;
  busy: boolean;
  setDraft: (updater: (prev: CopyDraft) => CopyDraft) => void;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}

export function CopyToModal({
  draft,
  projects,
  targetRuleSets,
  sourceProject,
  sourceRuleSet,
  sourceRule,
  busy,
  setDraft,
  onClose,
  onConfirm,
}: CopyToModalProps) {
  const isRuleMode = draft.mode === "rule";
  const canConfirm = draft.targetProjectId && (!isRuleMode || draft.targetRuleSetId);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(event) => event.stopPropagation()}>
        <div className="modal-box-header">
          <span className="modal-box-title">{isRuleMode ? "复制规则到..." : "复制分组到站点"}</span>
          <button className="btn-icon" onClick={onClose} aria-label="关闭" title="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-box-body">
          <div className="form-group">
            <label className="form-label">复制来源</label>
            <div
              style={{
                padding: "10px 12px",
                background: "var(--surface-soft)",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border)",
                color: "var(--muted)",
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              <div>站点：{sourceProject?.name ?? "未知站点"}</div>
              <div>分组：{sourceRuleSet?.name ?? "未知分组"}</div>
              {isRuleMode ? <div>规则：{sourceRule?.name ?? "未知规则"}</div> : <div>内容：整组 {sourceRuleSet?.ruleIds.length ?? 0} 条规则</div>}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">
              目标站点 <span className="form-label-required">*</span>
            </label>
            <select
              className="form-input"
              value={draft.targetProjectId}
              onChange={(event) =>
                setDraft((prev) =>
                  prev.mode === "rule"
                    ? {
                        ...prev,
                        targetProjectId: event.target.value,
                        targetRuleSetId: "",
                      }
                    : {
                        ...prev,
                        targetProjectId: event.target.value,
                      },
                )
              }
            >
              <option value="">请选择站点</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                  {project.enabled ? "" : "（已停用）"}
                </option>
              ))}
            </select>
          </div>

          {isRuleMode && (
            <div className="form-group">
              <label className="form-label">
                目标分组 <span className="form-label-required">*</span>
              </label>
              <select
                className="form-input"
                value={draft.targetRuleSetId}
                onChange={(event) =>
                  setDraft((prev) =>
                    prev.mode === "rule"
                      ? {
                          ...prev,
                          targetRuleSetId: event.target.value,
                        }
                      : prev,
                  )
                }
                disabled={!draft.targetProjectId || targetRuleSets.length === 0}
              >
                <option value="">
                  {draft.targetProjectId
                    ? targetRuleSets.length > 0
                      ? "请选择分组"
                      : "目标站点下暂无分组"
                    : "请先选择站点"}
                </option>
                {targetRuleSets.map((ruleSet) => (
                  <option key={ruleSet.id} value={ruleSet.id}>
                    {ruleSet.name}
                    {ruleSet.enabled ? "" : "（已停用）"}
                  </option>
                ))}
              </select>
              <span className="form-hint">复制后会直接落到所选分组下，并保留原规则内容。</span>
            </div>
          )}

          {!isRuleMode && (
            <div className="form-group">
              <label className="form-label">复制结果</label>
              <span className="form-hint">
                会在目标站点下自动新建一个分组，并把当前分组内的规则完整复制过去；若同名已存在，会自动追加“副本”后缀。
              </span>
            </div>
          )}
        </div>

        <div className="modal-box-footer">
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void onConfirm()} disabled={!canConfirm || busy}>
            {isRuleMode ? "复制规则" : "复制分组"}
          </button>
        </div>
      </div>
    </div>
  );
}
