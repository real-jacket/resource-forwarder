import React from "react";
import type { Project } from "@resource-forwarder/shared-types";
import { CustomSelect } from "../components/CustomSelect.js";
import type { ImportFeedback, ImportSource } from "../types.js";

/**
 * Props are grouped by responsibility (import, export, status) so the
 * 20+ underlying state slices stay readable at the call site.
 */
export interface ImportExportViewProps {
  /** All known projects, used by the export-scope checklist. */
  projects: Project[];
  /** Map projectId → rule count, derived in the parent. */
  ruleCountByProjectId: Map<string, number>;
  /** Whether any I/O is currently in flight. Disables action buttons. */
  busy: boolean;
  /** Bottom-of-page status line. */
  status: string;

  import: {
    text: string;
    setText: (value: string) => void;
    source: ImportSource;
    setSource: (source: ImportSource) => void;
    feedback: ImportFeedback | null;
    setFeedback: (value: ImportFeedback | null) => void;
    /** Setter for the resource-override preview modal state. */
    setResourceOverridePreview: (value: null) => void;
    /** Triggers the parsing modal for Resource Override JSON. */
    previewResourceOverride: () => void | Promise<void>;
    /** Workspace import; merge=true keeps existing rules. */
    workspace: (merge: boolean) => void | Promise<void>;
  };

  export: {
    scope: "all" | "selected";
    setScope: (scope: "all" | "selected") => void;
    selectedIds: Set<string>;
    setSelectedIds: (ids: Set<string>) => void;
    format: "json" | "yaml";
    setFormat: (value: "json" | "yaml") => void;
    text: string;
    /** Resolves with the export payload and appends to the textarea. */
    run: (projectIds: string[]) => void | Promise<void>;
    copy: () => void;
    download: () => void;
    /** Sets the bottom status banner (used for "select at least one" hint). */
    setStatus: (value: string) => void;
  };
}

export function ImportExportView(props: ImportExportViewProps) {
  return (
    <>
      <div className="page-header">
        <div className="page-title">导入导出</div>
        <div className="page-subtitle">支持 JSON / YAML 格式，也可导入 Resource Override 的配置</div>
      </div>

      <div className="io-page">
        <ImportCard {...props.import} busy={props.busy} />
        <ExportCard
          {...props.export}
          projects={props.projects}
          ruleCountByProjectId={props.ruleCountByProjectId}
          busy={props.busy}
        />
        <div style={{ fontSize: 13, color: "var(--muted)", padding: "4px 0" }}>{props.status}</div>
      </div>
    </>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────

function ImportCard({
  text,
  setText,
  source,
  setSource,
  feedback,
  setFeedback,
  setResourceOverridePreview,
  previewResourceOverride,
  workspace,
  busy,
}: ImportExportViewProps["import"] & { busy: boolean }) {
  // Selecting a different source or editing the textarea invalidates any
  // in-flight preview; we collapse it eagerly so the UI doesn't show stale
  // results next to fresh input.
  function clearPendingPreview() {
    setResourceOverridePreview(null);
    setFeedback(null);
  }

  return (
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
            className={`io-source-tab ${source === "resource-override" ? "active" : ""}`}
            onClick={() => {
              setSource("resource-override");
              clearPendingPreview();
            }}
          >
            Resource Override
          </button>
          <button
            className={`io-source-tab ${source === "workspace" ? "active" : ""}`}
            onClick={() => {
              setSource("workspace");
              clearPendingPreview();
            }}
          >
            Workspace 快照
          </button>
        </div>

        <textarea
          className="io-import-textarea"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            clearPendingPreview();
          }}
          placeholder={
            source === "resource-override"
              ? '粘贴 Resource Override 导出的 {"v":1,"data":[...]} JSON'
              : "粘贴 JSON 或 YAML 规则配置"
          }
        />

        {feedback && (
          <div className="io-feedback">
            <div className="io-feedback-title">{feedback.title}</div>
            {feedback.details.slice(0, 4).map((d) => (
              <div className="io-feedback-item" key={d}>{d}</div>
            ))}
          </div>
        )}

        <div className="io-actions">
          {source === "resource-override" ? (
            <button
              className="btn btn-primary"
              onClick={() => void previewResourceOverride()}
              disabled={busy}
            >
              预览导入
            </button>
          ) : (
            <>
              <button
                className="btn btn-default"
                onClick={() => void workspace(true)}
                disabled={busy}
              >
                合并导入
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void workspace(false)}
                disabled={busy}
              >
                整体替换
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ExportCard({
  scope,
  setScope,
  selectedIds,
  setSelectedIds,
  format,
  setFormat,
  text,
  run,
  copy,
  download,
  setStatus,
  projects,
  ruleCountByProjectId,
  busy,
}: ImportExportViewProps["export"] & {
  projects: Project[];
  ruleCountByProjectId: Map<string, number>;
  busy: boolean;
}) {
  return (
    <div className="io-card">
      <div className="io-card-header">
        <div className="io-card-title">导出规则</div>
        <div className="io-card-desc">导出全部或选中站点的规则配置，用于备份或分享</div>
      </div>
      <div className="io-card-body">
        <div className="io-source-tabs">
          <button
            className={`io-source-tab ${scope === "all" ? "active" : ""}`}
            onClick={() => setScope("all")}
          >
            全部站点
          </button>
          <button
            className={`io-source-tab ${scope === "selected" ? "active" : ""}`}
            onClick={() => setScope("selected")}
          >
            选择站点
          </button>
        </div>

        {scope === "selected" && (
          <div className="export-site-checklist">
            {projects.length === 0 ? (
              <div className="export-site-empty">暂无可导出的站点，请先创建。</div>
            ) : (
              <>
                <label className="export-site-check-item export-site-check-all">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === projects.length && projects.length > 0}
                    onChange={() =>
                      setSelectedIds(
                        selectedIds.size === projects.length ? new Set() : new Set(projects.map((p) => p.id)),
                      )
                    }
                  />
                  <span>全选（{projects.length} 个站点）</span>
                </label>
                {projects.map((p) => {
                  const ruleCount = ruleCountByProjectId.get(p.id) ?? 0;
                  return (
                    <label className="export-site-check-item" key={p.id}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(p.id)}
                        onChange={() => {
                          // Build a fresh Set so the parent sees a new ref.
                          const next = new Set(selectedIds);
                          if (next.has(p.id)) next.delete(p.id);
                          else next.add(p.id);
                          setSelectedIds(next);
                        }}
                      />
                      <span className="export-site-check-name">{p.name}</span>
                      <span className="export-site-check-meta">{ruleCount} 条规则</span>
                    </label>
                  );
                })}
              </>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">格式</label>
            <CustomSelect
              className="cs-form"
              value={format}
              options={[
                { value: "yaml", label: "YAML" },
                { value: "json", label: "JSON" },
              ]}
              onChange={(v) => setFormat(v as "json" | "yaml")}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={() => {
              const ids = scope === "all" ? [] : [...selectedIds];
              if (scope === "selected" && ids.length === 0) {
                setStatus("请至少选择一个站点再导出。");
                return;
              }
              void run(ids);
            }}
            disabled={busy || projects.length === 0}
            style={{ marginBottom: 0, alignSelf: "flex-end" }}
          >
            {scope === "all" ? "导出全部" : `导出选中（${selectedIds.size}）`}
          </button>
        </div>

        {text && (
          <>
            <textarea
              className="io-import-textarea"
              style={{ minHeight: 160 }}
              value={text}
              readOnly
            />
            <div className="io-actions">
              <button className="btn btn-default" onClick={copy}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
                复制到剪贴板
              </button>
              <button className="btn btn-default" onClick={download}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                下载文件
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
