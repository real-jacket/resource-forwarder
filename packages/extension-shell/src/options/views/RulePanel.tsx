import React, { useState } from "react";
import type { Project, RuleSet } from "@resource-forwarder/shared-types";
import type { RuleConflict } from "@resource-forwarder/rule-core";
import { joinCsv } from "../../shared/helpers.js";
import type { RuleDraft, RulePanelTab, RuleTemplatePreset } from "../types.js";
import { mergeRuleDraftByKind } from "../drafts.js";
import { CustomSelect } from "../components/CustomSelect.js";

export interface RulePanelProps {
  draft: RuleDraft;
  setDraft: (updater: (prev: RuleDraft) => RuleDraft) => void;

  /** Active tab — basic vs advanced. */
  tab: RulePanelTab;
  setTab: (tab: RulePanelTab) => void;

  /** Project / ruleset context shown in the header card and used to gate save. */
  selectedProject: Project | undefined;
  selectedRuleSet: RuleSet | undefined;
  projectRuleSets: RuleSet[];

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
  projectRuleSets,
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
  const activeRuleSet = projectRuleSets.find((ruleSet) => ruleSet.id === draft.ruleSetId) ?? selectedRuleSet;

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
            selectedRuleSet={activeRuleSet}
            projectRuleSets={projectRuleSets}
            activeTemplates={activeTemplates}
            applyTemplate={applyTemplate}
            conflicts={conflicts}
            warnings={warnings}
          />
        )}
        {tab === "advanced" && (
          <AdvancedTab
            draft={draft}
            setDraft={setDraft}
            selectedProject={selectedProject}
            selectedRuleSet={activeRuleSet}
          />
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
  projectRuleSets,
  activeTemplates,
  applyTemplate,
  conflicts,
  warnings,
}: {
  draft: RuleDraft;
  setDraft: RulePanelProps["setDraft"];
  selectedProject: Project | undefined;
  selectedRuleSet: RuleSet | undefined;
  projectRuleSets: RuleSet[];
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
        </div>
      )}

      {projectRuleSets.length > 0 && (
        <div className="form-group">
          <label className="form-label" htmlFor="rule-ruleset">所属分组</label>
          <CustomSelect
            id="rule-ruleset"
            className="cs-form"
            value={draft.ruleSetId || selectedRuleSet?.id || ""}
            options={projectRuleSets.map((rs) => ({
              value: rs.id,
              label: rs.name,
              description: rs.enabled ? undefined : "分组已停用",
              disabled: !rs.enabled,
            }))}
            onChange={(value) => setDraft((v) => ({ ...v, ruleSetId: value }))}
            ariaLabel="所属分组"
          />
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
        <label className="form-label" htmlFor="rule-name">
          规则名称 <span className="form-label-required">*</span>
        </label>
        <input
          id="rule-name"
          className="form-input"
          value={draft.name}
          onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))}
          placeholder="例如：把 /api 指到本地服务"
        />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="rule-path">
          匹配路径 <span className="form-label-required">*</span>
        </label>
        <input
          id="rule-path"
          className="form-input"
          value={draft.pathGlob}
          onChange={(e) => setDraft((v) => ({ ...v, pathGlob: e.target.value }))}
          placeholder="/api/**"
        />
      </div>

      {draft.kind === "api_forward" ? (
        <div className="form-group">
          <label className="form-label" htmlFor="rule-target-url">
            目标地址 {draft.responseMode === "forward" && <span className="form-label-required">*</span>}
          </label>
          <input
            id="rule-target-url"
            className="form-input"
            value={draft.targetBaseUrl}
            onChange={(e) => setDraft((v) => ({ ...v, targetBaseUrl: e.target.value }))}
            placeholder="http://127.0.0.1:3000"
          />
          {draft.responseMode !== "forward" && <span className="form-hint">当前为 Mock 响应模式，目标地址可以留空。</span>}
        </div>
      ) : (
        <div className="form-group">
          <label className="form-label" htmlFor="rule-redirect-url">
            替换到的 HTTPS 地址 <span className="form-label-required">*</span>
          </label>
          <input
            id="rule-redirect-url"
            className="form-input"
            value={draft.redirectUrl}
            onChange={(e) => setDraft((v) => ({ ...v, redirectUrl: e.target.value }))}
            placeholder="https://cdn.example.com/app.js"
          />
        </div>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="rule-note">备注</label>
        <textarea
          id="rule-note"
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
  selectedRuleSet,
}: {
  draft: RuleDraft;
  setDraft: RulePanelProps["setDraft"];
  selectedProject: Project | undefined;
  selectedRuleSet: RuleSet | undefined;
}) {
  const inheritedHosts = selectedRuleSet?.defaultRequestHosts?.length
    ? selectedRuleSet.defaultRequestHosts
    : selectedProject?.defaultRequestHosts?.length
      ? selectedProject.defaultRequestHosts
      : selectedProject?.siteHosts ?? [];
  const inheritedSource = selectedRuleSet?.defaultRequestHosts?.length
    ? "分组"
    : selectedProject?.defaultRequestHosts?.length
      ? "站点"
      : "站点页面";

  return (
    <div className="form-disclosure-stack">
      <MatchHierarchy
        project={selectedProject}
        ruleSet={selectedRuleSet}
        draft={draft}
      />
      <FormDisclosure
        title="匹配条件"
        description="限定 Host、资源类型、方法以及 Query / Header 条件"
        collapsible={draft.kind === "api_forward"}
      >
      <div className="form-subsection-heading">请求目标</div>
      <div className="form-group">
        <label className="form-label" htmlFor="rule-host-mode">请求 Host</label>
        <CustomSelect
          id="rule-host-mode"
          className="cs-form"
          value={draft.hostMode}
          options={[
            {
              value: "inherit",
              label: `继承${inheritedSource}`,
              description: joinCsv(inheritedHosts) || "匹配所有 Host",
            },
            { value: "custom", label: "自定义" },
          ]}
          onChange={(value) => setDraft((v) => ({ ...v, hostMode: value as RuleDraft["hostMode"] }))}
          ariaLabel="请求 Host 来源"
        />
        {draft.hostMode === "custom" && (
          <input
            id="rule-host"
            className="form-input"
            aria-label="自定义请求 Host"
            value={draft.host}
            onChange={(e) => setDraft((v) => ({ ...v, host: e.target.value }))}
            placeholder="as.smgv.cn, cdn.example.com"
            style={{ marginTop: 8 }}
          />
        )}
        <span className="form-hint">Host 匹配请求目标域名，与站点/分组的页面匹配 URL 相互独立。</span>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="rule-resource-type">资源类型</label>
          <input
            id="rule-resource-type"
            className="form-input"
            value={draft.resourceType}
            onChange={(e) => setDraft((v) => ({ ...v, resourceType: e.target.value }))}
            placeholder={draft.kind === "api_forward" ? "fetch, xmlhttprequest" : "script, stylesheet, image, font"}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="rule-method">HTTP 方法</label>
          <input
            id="rule-method"
            className="form-input"
            value={draft.method}
            onChange={(e) => setDraft((v) => ({ ...v, method: e.target.value }))}
            placeholder="GET, POST"
          />
        </div>
      </div>

      {draft.kind === "api_forward" && (
        <>
          <div className="form-subsection-heading">附加条件</div>
          <div className="form-group">
            <label className="form-label" htmlFor="rule-query-match">Query 参数匹配（JSON）</label>
            <textarea
              id="rule-query-match"
              className="form-textarea form-textarea-code"
              value={draft.queryMatchJson}
              onChange={(e) => setDraft((v) => ({ ...v, queryMatchJson: e.target.value }))}
              placeholder='{"tenant":"dev-*","debug":"1"}'
            />
            <span className="form-hint">同一路径需要按查询参数分流时使用；值支持 * 和 ?。</span>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="rule-header-match">请求 Header 匹配（JSON）</label>
            <textarea
              id="rule-header-match"
              className="form-textarea form-textarea-code"
              value={draft.headerMatchJson}
              onChange={(e) => setDraft((v) => ({ ...v, headerMatchJson: e.target.value }))}
              placeholder='{"content-type":"application/json*","x-tenant":"dev"}'
            />
            <span className="form-hint">Header 名大小写不敏感；Cookie 等浏览器受限 Header 可能无法用于页面侧匹配。</span>
          </div>
        </>
      )}
      </FormDisclosure>

      {draft.kind === "api_forward" && (
        <>
          <FormDisclosure
            title="请求改写"
            description="改写路径、Query 和发送给目标服务的 Header"
          >
          <div className="form-subsection-heading">路径</div>
          <div className="form-group">
            <label className="form-label" htmlFor="rule-strip-prefix">去掉路径前缀</label>
            <input
              id="rule-strip-prefix"
              className="form-input"
              value={draft.stripPrefix}
              onChange={(e) => setDraft((v) => ({ ...v, stripPrefix: e.target.value }))}
              placeholder="/api"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="rule-path-rewrite">路径改写（JSON）</label>
            <textarea
              id="rule-path-rewrite"
              className="form-textarea form-textarea-code"
              value={draft.pathRewriteJson}
              onChange={(e) => setDraft((v) => ({ ...v, pathRewriteJson: e.target.value }))}
              placeholder='[{"from":"/users","to":"/v1/users"}]'
            />
            <span className="form-hint">按配置顺序依次应用可命中的前缀改写。</span>
          </div>

          <div className="form-subsection-heading">Query</div>
          <div className="form-group">
            <label className="form-label" htmlFor="rule-query-remove">删除 Query 参数</label>
            <input
              id="rule-query-remove"
              className="form-input"
              value={draft.queryRemove}
              onChange={(e) => setDraft((v) => ({ ...v, queryRemove: e.target.value }))}
              placeholder="token, cacheBust"
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="rule-query-set">覆盖 Query（JSON）</label>
              <textarea
                id="rule-query-set"
                className="form-textarea form-textarea-code"
                value={draft.querySetJson}
                onChange={(e) => setDraft((v) => ({ ...v, querySetJson: e.target.value }))}
                placeholder='{"env":"local"}'
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="rule-query-append">追加 Query（JSON）</label>
              <textarea
                id="rule-query-append"
                className="form-textarea form-textarea-code"
                value={draft.queryAppendJson}
                onChange={(e) => setDraft((v) => ({ ...v, queryAppendJson: e.target.value }))}
                placeholder='{"tag":["local","debug"]}'
              />
            </div>
          </div>

          <div className="form-subsection-heading">请求 Header</div>
          <div className="form-group">
            <label className="form-label" htmlFor="rule-request-headers">注入 / 覆盖 Header（JSON）</label>
            <textarea
              id="rule-request-headers"
              className="form-textarea form-textarea-code"
              value={draft.headersJson}
              onChange={(e) => setDraft((v) => ({ ...v, headersJson: e.target.value }))}
              placeholder='{"x-forwarded-by":"resource-forwarder"}'
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="rule-header-strip">移除请求 Header</label>
              <input
                id="rule-header-strip"
                className="form-input"
                value={draft.headerStrip}
                onChange={(e) => setDraft((v) => ({ ...v, headerStrip: e.target.value }))}
                placeholder="x-trace-id, sec-fetch-site"
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="rule-header-passthrough">强制透传 Header</label>
              <input
                id="rule-header-passthrough"
                className="form-input"
                value={draft.headerPassthrough}
                onChange={(e) => setDraft((v) => ({ ...v, headerPassthrough: e.target.value }))}
                placeholder="authorization, cookie"
              />
            </div>
          </div>
          <span className="form-hint">强制透传 cookie 属于浏览器受限能力，自动模式会通过 Chrome cookies 权限读取后交给本地 Companion。</span>
          </FormDisclosure>

          <FormDisclosure
            title="响应行为"
            description="转发并修改真实响应，或直接返回内联 / 本地 JSON"
            defaultOpen={
              draft.responseMode !== "forward" ||
              Boolean(draft.responseJsonPatch.trim()) ||
              Boolean(draft.responseStatus.trim())
            }
            tone="primary"
          >
          <div className="form-group">
            <label className="form-label" htmlFor="rule-response-mode">响应来源</label>
            <CustomSelect
              id="rule-response-mode"
              className="cs-form"
              value={draft.responseMode}
              options={[
                { value: "forward", label: "请求上游并返回", description: "可对真实 JSON 响应做合并覆盖" },
                { value: "mock_json", label: "直接返回内联 JSON", description: "不请求上游，适合快速构造接口状态" },
                { value: "mock_file", label: "返回本地 JSON 文件", description: "由本地服务读取指定 .json 文件" },
              ]}
              onChange={(value) => setDraft((v) => ({ ...v, responseMode: value as RuleDraft["responseMode"] }))}
              ariaLabel="响应来源"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="rule-response-status">响应状态码</label>
              <input
                id="rule-response-status"
                className="form-input"
                inputMode="numeric"
                value={draft.responseStatus}
                onChange={(e) => setDraft((v) => ({ ...v, responseStatus: e.target.value }))}
                placeholder={draft.responseMode === "forward" ? "留空沿用上游" : "200"}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="rule-response-delay">延迟（毫秒）</label>
              <input
                id="rule-response-delay"
                className="form-input"
                type="number"
                min={0}
                max={30000}
                value={draft.responseDelayMs}
                onChange={(e) => setDraft((v) => ({ ...v, responseDelayMs: Number(e.target.value) }))}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="rule-response-status-text">状态描述（可选）</label>
            <input
              id="rule-response-status-text"
              className="form-input"
              value={draft.responseStatusText}
              onChange={(e) => setDraft((v) => ({ ...v, responseStatusText: e.target.value }))}
              placeholder="例如：Not Found"
            />
          </div>

          {draft.responseMode === "forward" && (
            <div className="form-group">
              <label className="form-label" htmlFor="rule-response-json-patch">JSON 合并覆盖（可选）</label>
              <textarea
                id="rule-response-json-patch"
                className="form-textarea form-textarea-code form-textarea-lg"
                value={draft.responseJsonPatch}
                onChange={(e) => setDraft((v) => ({ ...v, responseJsonPatch: e.target.value }))}
                placeholder={'{\n  "data": { "name": "本地调试用户" },\n  "debug": true\n}'}
              />
              <span className="form-hint">对象会递归合并到真实 JSON 响应；字段值设为 null 会删除该字段。</span>
            </div>
          )}

          {draft.responseMode === "mock_json" && (
            <div className="form-group">
              <label className="form-label" htmlFor="rule-response-mock-json">返回 JSON</label>
              <textarea
                id="rule-response-mock-json"
                className="form-textarea form-textarea-code form-textarea-xl"
                value={draft.responseMockJson}
                onChange={(e) => setDraft((v) => ({ ...v, responseMockJson: e.target.value }))}
                placeholder={'{\n  "code": 0,\n  "data": { "id": 42, "name": "Mock User" }\n}'}
              />
              <span className="form-hint">命中后直接返回该 JSON，不会请求目标地址。</span>
            </div>
          )}

          {draft.responseMode === "mock_file" && (
            <div className="form-group">
              <label className="form-label" htmlFor="rule-response-mock-file">本地 JSON 文件路径</label>
              <input
                id="rule-response-mock-file"
                className="form-input form-input-code"
                value={draft.responseMockFilePath}
                onChange={(e) => setDraft((v) => ({ ...v, responseMockFilePath: e.target.value }))}
                placeholder="/Users/me/project/mocks/user-detail.json"
              />
              <span className="form-hint">支持绝对路径，或相对于本地转发服务启动目录的路径；仅允许 .json 文件。</span>
            </div>
          )}

          <NestedDisclosure
            title="响应 Header 改写"
            initialOpen={Boolean(
              draft.responseHeaderStrip.trim() ||
              (draft.responseHeadersJson.trim() && draft.responseHeadersJson.trim() !== "{}")
            )}
          >
              <div className="form-group">
                <label className="form-label" htmlFor="rule-response-headers">注入 / 覆盖响应 Header（JSON）</label>
                <textarea
                  id="rule-response-headers"
                  className="form-textarea form-textarea-code"
                  value={draft.responseHeadersJson}
                  onChange={(e) => setDraft((v) => ({ ...v, responseHeadersJson: e.target.value }))}
                  placeholder='{"x-forwarded-by":"resource-forwarder","cache-control":"no-store"}'
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="rule-response-header-strip">移除响应 Header</label>
                <input
                  id="rule-response-header-strip"
                  className="form-input"
                  value={draft.responseHeaderStrip}
                  onChange={(e) => setDraft((v) => ({ ...v, responseHeaderStrip: e.target.value }))}
                  placeholder="content-security-policy, x-frame-options"
                />
              </div>
          </NestedDisclosure>
          </FormDisclosure>

          <FormDisclosure
            title="可靠性与安全"
            description="选择执行位置、设置超时，以及代理失败时是否允许回源"
          >
          <div className="form-group">
            <label className="form-label" htmlFor="rule-execution-mode">执行位置</label>
            <CustomSelect
              id="rule-execution-mode"
              className="cs-form"
              value={draft.executionMode}
              options={[
                { value: "auto", label: "自动选择（推荐）", description: "普通规则由浏览器执行，本地文件等能力自动使用 Companion" },
                { value: "browser", label: "仅浏览器", description: "不依赖本地服务；不支持任意文件路径和受限 Header" },
                { value: "local", label: "本地 Companion", description: "始终通过本地转发服务执行" },
              ]}
              onChange={(value) => setDraft((v) => ({ ...v, executionMode: value as RuleDraft["executionMode"] }))}
              ariaLabel="执行位置"
            />
            <span className="form-hint">
              自动模式优先使用扩展后台；本地 JSON 文件、强制 Cookie 透传等浏览器受限能力会自动切换到本地 Companion。
            </span>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="rule-timeout">超时（毫秒）</label>
              <input
                id="rule-timeout"
                className="form-input"
                type="number"
                min={100}
                max={300000}
                value={draft.timeoutMs}
                onChange={(e) => setDraft((v) => ({ ...v, timeoutMs: Number(e.target.value) }))}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="rule-fallback-mode">无法安全代理时</label>
              <CustomSelect
                id="rule-fallback-mode"
                className="cs-form"
                value={draft.fallbackMode}
                options={[
                  { value: "native", label: "回源原请求", description: "执行器不可用、SSE 或超限时继续原请求" },
                  { value: "error", label: "直接报错，不回源", description: "避免写请求误打测试或线上环境" },
                ]}
                onChange={(value) => setDraft((v) => ({ ...v, fallbackMode: value as RuleDraft["fallbackMode"] }))}
                ariaLabel="无法安全代理时"
              />
            </div>
          </div>
          <span className="form-hint">执行器不可用、SSE 或请求/响应超过扩展消息限制时，建议写接口选择“不回源”，避免误打测试或线上环境。</span>
          </FormDisclosure>
        </>
      )}

      <FormDisclosure
        title="规则行为"
        description="调整优先级、标签和默认启用状态"
        collapsible={draft.kind === "api_forward"}
      >
      <div className="form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="rule-priority">优先级</label>
          <input
            id="rule-priority"
            className="form-input"
            type="number"
            value={draft.priority}
            onChange={(e) => setDraft((v) => ({ ...v, priority: Number(e.target.value) }))}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="rule-tags">标签</label>
          <input
            id="rule-tags"
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
      </FormDisclosure>
    </div>
  );
}

function FormDisclosure({
  title,
  description,
  defaultOpen = false,
  collapsible = true,
  tone = "default",
  children,
}: {
  title: string;
  description: string;
  defaultOpen?: boolean;
  collapsible?: boolean;
  tone?: "default" | "primary";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const className = `form-disclosure ${tone === "primary" ? "is-primary" : ""}`;
  if (!collapsible) {
    return (
      <section className={className}>
        <div className="form-disclosure-static-header">
          <span className="form-disclosure-copy">
            <strong>{title}</strong>
            <span>{description}</span>
          </span>
        </div>
        <div className="form-disclosure-body">{children}</div>
      </section>
    );
  }
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="form-disclosure-copy">
          <strong>{title}</strong>
          <span>{description}</span>
        </span>
      </summary>
      <div className="form-disclosure-body">{children}</div>
    </details>
  );
}

function MatchHierarchy({
  project,
  ruleSet,
  draft,
}: {
  project: Project | undefined;
  ruleSet: RuleSet | undefined;
  draft: RuleDraft;
}) {
  const projectScope = project
    ? (project.siteMatchPatterns?.length ? project.siteMatchPatterns : project.siteHosts).join(", ") || "全部页面"
    : "尚未选择站点";
  const ruleSetScope = ruleSet?.siteMatchPatterns?.length
    ? ruleSet.siteMatchPatterns.join(", ")
    : "继承站点页面范围";
  const inheritedHosts = ruleSet?.defaultRequestHosts?.length
    ? ruleSet.defaultRequestHosts
    : project?.defaultRequestHosts?.length
      ? project.defaultRequestHosts
      : project?.siteHosts ?? [];
  const hostScope = draft.hostMode === "inherit"
    ? `继承：${joinCsv(inheritedHosts) || "所有 Host"}`
    : draft.host.trim() || "未填写自定义 Host";
  const requestScope = `${hostScope}  ${draft.pathGlob || "**"}`;

  return (
    <section className="match-hierarchy-card" aria-label="匹配链路">
      <div className="match-hierarchy-header">
        <div>
          <strong>匹配链路</strong>
          <span>页面范围和请求条件必须同时通过</span>
        </div>
        <span className="match-hierarchy-logic">AND</span>
      </div>
      <div className="match-hierarchy-layers">
        <div className={`match-hierarchy-layer${project?.enabled === false ? " is-disabled" : ""}`}>
          <span>站点页面</span>
          <strong>{projectScope}</strong>
          {project?.enabled === false && <em>站点已停用</em>}
        </div>
        <div className={`match-hierarchy-layer${ruleSet?.enabled === false ? " is-disabled" : ""}`}>
          <span>分组页面</span>
          <strong>{ruleSet ? ruleSetScope : "尚未选择分组"}</strong>
          {ruleSet?.enabled === false && <em>分组已停用</em>}
        </div>
        <div className={`match-hierarchy-layer${draft.enabled ? "" : " is-disabled"}`}>
          <span>规则请求</span>
          <strong>{requestScope}</strong>
          {!draft.enabled && <em>规则已停用</em>}
        </div>
      </div>
      <p>优先级只在多条规则都通过上述链路时决定最终命中项。</p>
    </section>
  );
}

function NestedDisclosure({
  title,
  initialOpen,
  children,
}: {
  title: string;
  initialOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(initialOpen));
  return (
    <details
      className="form-nested-disclosure"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      <div className="form-nested-disclosure-body">{children}</div>
    </details>
  );
}
