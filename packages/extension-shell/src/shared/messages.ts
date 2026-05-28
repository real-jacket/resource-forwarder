import type {
  ExportWorkspaceResponse,
  ForwardRequestPayload,
  ImportWorkspacePayload,
  LogsResponse,
  RuleSet,
  RuntimeState,
  ServiceHealthResponse,
  SiteContextPayload,
  UpsertProjectPayload,
  UpsertRulePayload,
} from "@resource-forwarder/shared-types";

export interface DashboardState extends RuntimeState {
  warnings: string[];
  logs: LogsResponse["logs"];
  currentTab?: {
    id?: number;
    url: string;
    host: string;
  };
  // Chrome 实际注册的 DNR 规则计数。sidepanel 显示「未匹配」是基于当前页面 URL
  // 与 workspace 中 project 的匹配，但 DNR 一旦注册就独立运行；当两者出现差异
  // （workspace 改变但 DNR 还未同步、或 stale DNR 残留）时，这个字段让 UI 能
  // 提示用户「浏览器里其实还注册着 N 条规则」。
  dnrRuleCount?: {
    dynamic: number;
    session: number;
  };
}

export type RuntimeRequest =
  | { type: "get-dashboard-state"; tabId?: number }
  | { type: "sync-workspace" }
  | { type: "set-service-url"; serviceUrl: string }
  | { type: "set-service-token"; token: string }
  | { type: "upsert-project"; payload: UpsertProjectPayload }
  | { type: "delete-project"; projectId: string }
  | { type: "upsert-rule"; payload: UpsertRulePayload }
  | { type: "delete-rule"; ruleId: string }
  | { type: "upsert-rule-set"; payload: { ruleSet: RuleSet } }
  | { type: "delete-rule-set"; ruleSetId: string }
  | { type: "get-logs"; limit?: number; projectId?: string }
  | { type: "import-workspace"; payload: ImportWorkspacePayload }
  | { type: "export-workspace"; projectIds: string[]; format: "json" | "yaml" }
  | { type: "get-site-context"; url: string; tabId?: number }
  | { type: "proxy-request"; requestId: string; payload: ForwardRequestPayload }
  | { type: "proxy-abort"; requestId: string };

export interface RuntimeEnvelope {
  type: string;
  payload?: unknown;
}

export async function runtimeRequest<T>(request: RuntimeRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as { __error?: string } | T;
  if (response && typeof response === "object" && "__error" in response && typeof response.__error === "string") {
    throw new Error(response.__error);
  }
  return response as T;
}

export type GetLogsResponse = LogsResponse;
export type GetSiteContextResponse = SiteContextPayload;
export type GetDashboardStateResponse = DashboardState;
export type SetServiceUrlResponse = RuntimeState & { warnings: string[] };
export type SyncWorkspaceResponse = RuntimeState & { warnings: string[] };
export type UpsertMutationResponse = RuntimeState & { warnings: string[] };
export type ExportWorkspaceRuntimeResponse = ExportWorkspaceResponse;
export type HealthSnapshot = ServiceHealthResponse | null;
