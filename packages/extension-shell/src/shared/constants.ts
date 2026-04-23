export const DEFAULT_SERVICE_URL = "http://127.0.0.1:5178";
export const STORAGE_KEYS = {
  serviceUrl: "resource-forwarder:service-url",
  managedRuleIds: "resource-forwarder:managed-dnr-rule-ids",
  workspace: "resource-forwarder:workspace",
  workspaceDirty: "resource-forwarder:workspace-dirty",
  pendingDeletes: "resource-forwarder:pending-deletes",
} as const;
export const WINDOW_SOURCE = "resource-forwarder";
