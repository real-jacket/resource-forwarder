import React, { useMemo } from "react";
import type { parseResourceOverrideExport } from "@resource-forwarder/rule-core";

/** Result returned by `parseResourceOverrideExport`. */
export type ImportPreview = ReturnType<typeof parseResourceOverrideExport>;

export interface ImportPreviewModalProps {
  preview: ImportPreview;
  /** Whether an import is currently in flight; disables actions + the close button. */
  busy: boolean;
  /** Error banner shown above the footer (e.g. service offline). */
  error: string | null;
  onClose: () => void;
  /** `merge=true` keeps existing rules; `false` replaces the workspace. */
  onImport: (merge: boolean) => void | Promise<void>;
}

/**
 * Read-only preview of a parsed Resource Override export, surfacing what
 * would be imported and what was skipped before the user commits.
 *
 * The component is fully controlled — open/close, error display, and import
 * actions are all routed through props so the parent owns the full state
 * machine (busy flag, refresh-after-import, etc.).
 */
export function ImportPreviewModal({ preview, busy, error, onClose, onImport }: ImportPreviewModalProps) {
  const { workspace, report } = preview;
  const canImport = report.importedRuleCount > 0;

  // Indexes for fast O(1) lookups while rendering — avoids quadratic
  // walk on every iteration of the project list.
  const ruleSetByProjectId = useMemo(
    () => new Map(workspace.ruleSets.map((rs) => [rs.projectId, rs])),
    [workspace.ruleSets],
  );
  const rulesById = useMemo(
    () => new Map(workspace.rules.map((r) => [r.id, r])),
    [workspace.rules],
  );

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    // Only close on direct overlay clicks (not bubbled clicks from inside
    // the dialog), and never while busy — the user might lose their place.
    if (e.target === e.currentTarget && !busy) onClose();
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-box import-preview-modal" onClick={(e) => e.stopPropagation()}>
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
                <span className="import-preview-badge warning">{report.skippedRuleCount} 条跳过</span>
              )}
            </div>
          </div>
          <button className="btn btn-icon" onClick={onClose} title="关闭" aria-label="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-box-body import-preview-body">
          {workspace.projects.map((project) => {
            const ruleSet = ruleSetByProjectId.get(project.id);
            const projectRules = (ruleSet?.ruleIds ?? [])
              .map((id) => rulesById.get(id))
              .filter((r): r is NonNullable<typeof r> => r !== undefined);

            return (
              <div className="import-preview-site" key={project.id}>
                <div className="import-preview-site-header">
                  <div className="import-preview-site-name">{project.name}</div>
                  <div className="import-preview-site-meta">
                    <span className="import-preview-site-host">
                      {(project.siteMatchPatterns ?? project.siteHosts).join(", ") || "-"}
                    </span>
                    <span className={`import-preview-badge ${project.enabled ? "success" : "muted"}`} style={{ fontSize: 11 }}>
                      {project.enabled ? "启用" : "停用"}
                    </span>
                    <span className="import-preview-badge muted" style={{ fontSize: 11 }}>
                      {projectRules.length} 条规则
                    </span>
                  </div>
                </div>

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
                          // Drop the wildcard host so the cross-origin badge
                          // only fires when the rule explicitly targets a
                          // domain other than the parent project's hosts.
                          const ruleHosts = rule.match.host.filter((h) => h !== "*");
                          const isSameOrigin =
                            ruleHosts.length > 0 &&
                            ruleHosts.every(
                              (h) =>
                                project.siteHosts.includes(h) ||
                                (project.siteMatchPatterns ?? []).some((p) => p.includes(h)),
                            );
                          return (
                            <tr key={rule.id}>
                              <td className="import-preview-path">
                                {!isSameOrigin && ruleHosts.length > 0 && (
                                  <span className="import-preview-cross-origin">{ruleHosts.join(", ")}</span>
                                )}
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
            <div className="import-preview-empty">没有可导入的规则，请检查上方跳过提示后重新预览。</div>
          )}
        </div>

        {error && (
          <div className="import-modal-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" style={{ flexShrink: 0 }} aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}

        <div className="modal-box-footer">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn btn-default"
            onClick={() => void onImport(true)}
            disabled={busy || !canImport}
          >
            {busy ? "导入中…" : "合并导入"}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void onImport(false)}
            disabled={busy || !canImport}
          >
            {busy ? "导入中…" : "整体替换"}
          </button>
        </div>
      </div>
    </div>
  );
}
