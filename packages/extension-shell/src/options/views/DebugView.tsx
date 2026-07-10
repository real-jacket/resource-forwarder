import { useEffect, useMemo, useState } from "react";
import type {
  HitRecord,
  MatchRequestPayload,
  MatchResponse,
  MatchTraceEntry,
  Rule,
} from "@resource-forwarder/shared-types";
import type {
  DiagnoseMatchResponse,
  GetLogsResponse,
} from "../../shared/messages.js";
import { runtimeRequest } from "../../shared/messages.js";
import { CustomSelect } from "../components/CustomSelect.js";

export function DebugView({
  logs,
  rules,
  currentUrl,
}: {
  logs: HitRecord[];
  rules: Rule[];
  currentUrl: string;
}) {
  const [requestUrl, setRequestUrl] = useState("");
  const [method, setMethod] = useState("GET");
  const [resourceType, setResourceType] = useState<"fetch" | "xmlhttprequest">("fetch");
  const [headersJson, setHeadersJson] = useState("{}");
  const [result, setResult] = useState<MatchResponse | null>(null);
  const [status, setStatus] = useState("输入一个页面实际发出的请求，查看命中规则和最终目标地址。");
  const [busy, setBusy] = useState(false);
  const [visibleLogs, setVisibleLogs] = useState(logs);

  useEffect(() => setVisibleLogs(logs), [logs]);

  const ruleNameById = useMemo(
    () => new Map(rules.map((rule) => [rule.id, rule.name])),
    [rules],
  );

  async function diagnose(): Promise<void> {
    if (!requestUrl.trim()) {
      setStatus("请先输入完整请求 URL。");
      return;
    }
    let headers: Record<string, string>;
    try {
      const parsed = JSON.parse(headersJson || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      headers = parsed as Record<string, string>;
      if (Object.values(headers).some((value) => typeof value !== "string")) throw new Error();
    } catch {
      setStatus("请求 Header 必须是字符串键值 JSON 对象。");
      return;
    }

    setBusy(true);
    try {
      const payload: MatchRequestPayload = {
        url: requestUrl.trim(),
        pageUrl: currentUrl || undefined,
        method,
        resourceType,
        headers,
      };
      const next = await runtimeRequest<DiagnoseMatchResponse>({ type: "diagnose-match", payload });
      setResult(next);
      setStatus(next.matched ? "已找到命中规则。" : "没有规则满足全部条件，可查看下方逐项诊断。");
    } catch (error) {
      setResult(null);
      setStatus(error instanceof Error ? error.message : "请求诊断失败。");
    } finally {
      setBusy(false);
    }
  }

  async function refreshLogs(): Promise<void> {
    setBusy(true);
    try {
      const response = await runtimeRequest<GetLogsResponse>({ type: "get-logs", limit: 100 });
      setVisibleLogs(response.logs);
      setStatus(`已刷新最近 ${response.logs.length} 条请求记录。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "刷新请求记录失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="debug-view">
      <div className="page-header">
        <div>
          <h1>请求调试</h1>
          <p>验证规则为何命中或未命中，并查看浏览器请求实际转发到了哪里。</p>
        </div>
        <button className="btn btn-default" onClick={() => void refreshLogs()} disabled={busy}>
          刷新记录
        </button>
      </div>

      <section className="debug-card">
        <div className="debug-card-header">
          <div>
            <h2>规则诊断</h2>
            <p>只做匹配和地址预览，不会真正请求上游。</p>
          </div>
        </div>
        <div className="debug-form-grid">
          <div className="form-group debug-url-field">
            <label className="form-label" htmlFor="debug-request-url">请求 URL</label>
            <input
              id="debug-request-url"
              className="form-input"
              value={requestUrl}
              onChange={(event) => setRequestUrl(event.target.value)}
              placeholder="https://api.example.com/api/users?tenant=dev"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="debug-method">方法</label>
            <CustomSelect
              id="debug-method"
              className="cs-form"
              value={method}
              options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((value) => ({ value, label: value }))}
              onChange={setMethod}
              ariaLabel="请求方法"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="debug-resource-type">调用方式</label>
            <CustomSelect
              id="debug-resource-type"
              className="cs-form"
              value={resourceType}
              options={[
                { value: "fetch", label: "fetch", description: "页面 Fetch API 请求" },
                { value: "xmlhttprequest", label: "XMLHttpRequest", description: "传统 XHR 请求" },
              ]}
              onChange={(value) => setResourceType(value as typeof resourceType)}
              ariaLabel="调用方式"
            />
          </div>
          <div className="form-group debug-headers-field">
            <label className="form-label" htmlFor="debug-request-headers">请求 Header（JSON，可选）</label>
            <textarea
              id="debug-request-headers"
              className="form-textarea form-textarea-code"
              value={headersJson}
              onChange={(event) => setHeadersJson(event.target.value)}
              placeholder='{"content-type":"application/json"}'
            />
          </div>
        </div>
        <div className="debug-actions">
          <span className="debug-status">{status}</span>
          <button className="btn btn-primary" onClick={() => void diagnose()} disabled={busy}>开始诊断</button>
        </div>

        {result && <MatchResult result={result} />}
      </section>

      <section className="debug-card">
        <div className="debug-card-header">
          <div>
            <h2>最近请求</h2>
            <p>按最新请求排序，包含目标地址、耗时、状态和错误原因。</p>
          </div>
          <span className="debug-count">{visibleLogs.length} 条</span>
        </div>
        <div className="debug-table-wrap">
          <table className="debug-table">
            <thead>
              <tr>
                <th>结果</th>
                <th>请求 → 目标</th>
                <th>规则</th>
                <th>状态</th>
                <th>耗时</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {visibleLogs.length === 0 ? (
                <tr><td colSpan={6} className="debug-empty">暂无请求记录。发起一次命中规则的 fetch 或 XHR 后再刷新。</td></tr>
              ) : visibleLogs.map((log) => (
                <tr key={log.id}>
                  <td><OutcomeBadge outcome={log.outcome} /></td>
                  <td className="debug-url-cell">
                    <strong>{log.method} {log.requestUrl}</strong>
                    <span>→ {log.target}</span>
                    {log.errorMessage && <em>{log.errorMessage}</em>}
                  </td>
                  <td>{ruleNameById.get(log.ruleId) ?? log.ruleId}</td>
                  <td>{log.statusCode ?? "-"}</td>
                  <td>{log.durationMs} ms</td>
                  <td>{formatTime(log.occurredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function MatchResult({ result }: { result: MatchResponse }) {
  return (
    <div className={`match-result ${result.matched ? "is-match" : "is-miss"}`}>
      <div className="match-result-summary">
        <div>
          <strong>{result.matched ? `命中：${result.binding?.ruleName ?? result.binding?.ruleId}` : "未命中任何规则"}</strong>
          {result.rewrittenUrl && <span>{result.rewrittenUrl}</span>}
        </div>
        <span className="match-result-badge">{result.matched ? "MATCH" : "MISS"}</span>
      </div>
      <div className="match-trace-list">
        {result.trace.map((entry) => <TraceRow key={entry.ruleId} entry={entry} />)}
      </div>
    </div>
  );
}

function TraceRow({ entry }: { entry: MatchTraceEntry }) {
  const groups = [
    {
      label: "归属与页面范围",
      checks: [
        ["层级归属", entry.conditions.hierarchy],
        ["启用链", entry.enabled],
        ["站点范围", entry.conditions.projectScope],
        ["分组范围", entry.conditions.ruleSetScope],
      ] as const,
    },
    {
      label: "请求条件",
      checks: [
        ["Host", entry.conditions.host],
        ["路径", entry.conditions.path],
        ["Query", entry.conditions.query],
        ["Header", entry.conditions.headers],
        ["方法", entry.conditions.method],
        ["类型", entry.conditions.resourceType],
        ["标签页", entry.conditions.tabScope],
      ] as const,
    },
  ];
  return (
    <div className={`match-trace-row ${entry.wouldMatch ? "is-match" : ""}`}>
      <strong>{entry.ruleName}</strong>
      <div className="match-trace-check-groups">
        {groups.map((group) => (
          <div className="match-trace-check-group" key={group.label}>
            <span className="match-trace-group-label">{group.label}</span>
            <div className="match-trace-checks">
              {group.checks.map(([label, ok]) => (
                <span key={label} className={ok ? "ok" : "fail"}>{label} {ok ? "✓" : "×"}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: HitRecord["outcome"] }) {
  const labels = { matched: "已转发", passed: "已回源", error: "失败" } as const;
  return <span className={`debug-outcome ${outcome}`}>{labels[outcome]}</span>;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
