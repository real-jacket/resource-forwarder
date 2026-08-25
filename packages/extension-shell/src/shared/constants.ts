export const DEFAULT_SERVICE_URL = "http://127.0.0.1:5178";
export const STORAGE_KEYS = {
  serviceUrl: "resource-forwarder:service-url",
  serviceToken: "resource-forwarder:service-token",
  managedRuleIds: "resource-forwarder:managed-dnr-rule-ids",
  workspace: "resource-forwarder:workspace",
  workspaceDirty: "resource-forwarder:workspace-dirty",
  pendingDeletes: "resource-forwarder:pending-deletes",
  browserLogs: "resource-forwarder:browser-hit-logs",
} as const;
export const WINDOW_SOURCE = "resource-forwarder";
export const SERVICE_OFFLINE_SENTINEL = "__RF_SERVICE_OFFLINE__";
export const SERVICE_AUTH_REQUIRED_SENTINEL = "__RF_SERVICE_AUTH_REQUIRED__";
export const STREAMING_UNSUPPORTED_SENTINEL = "__RF_STREAMING_UNSUPPORTED__";
export const PAYLOAD_TOO_LARGE_SENTINEL = "__RF_PAYLOAD_TOO_LARGE__";

// Bodies above this size bypass the forward path (which has to base64-encode
// the entire payload twice and ship it through chrome.runtime.sendMessage).
// 2 MiB is well under chrome.runtime.sendMessage's practical ceiling and
// keeps a forwarded request's wire payload (after base64 expansion) under
// ~3 MiB, which all current Chrome versions handle comfortably.
export const FORWARD_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
