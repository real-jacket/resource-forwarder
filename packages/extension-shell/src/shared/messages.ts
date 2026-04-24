import type {
  ExportWorkspaceResponse,
  ForwardRequestPayload,
  ImportWorkspacePayload,
  LogsResponse,
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
}

export type RuntimeRequest =
  | { type: "get-dashboard-state"; tabId?: number }
  | { type: "sync-workspace" }
  | { type: "set-service-url"; serviceUrl: string }
  | { type: "upsert-project"; payload: UpsertProjectPayload }
  | { type: "delete-project"; projectId: string }
  | { type: "upsert-rule"; payload: UpsertRulePayload }
  | { type: "delete-rule"; ruleId: string }
  | { type: "get-logs"; limit?: number; projectId?: string }
  | { type: "import-workspace"; payload: ImportWorkspacePayload }
  | { type: "export-workspace"; projectIds: string[]; format: "json" | "yaml" }
  | { type: "get-site-context"; url: string; tabId?: number }
  | { type: "proxy-request"; payload: ForwardRequestPayload };

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
