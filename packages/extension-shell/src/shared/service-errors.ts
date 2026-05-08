import { SERVICE_OFFLINE_SENTINEL, STREAMING_UNSUPPORTED_SENTINEL } from "./constants.js";

export function normalizeProxyRequestError(error: unknown): unknown {
  if (isAbortError(error)) {
    return error;
  }

  if (isNetworkFetchFailure(error)) {
    return new Error(SERVICE_OFFLINE_SENTINEL);
  }

  if (isStreamUnsupported(error)) {
    // Replace whatever the service returned (a localized 409 message) with a
    // sentinel page-bridge knows to fall back to a native fetch on. This stays
    // a string sentinel rather than a custom Error subclass so it survives the
    // chrome.runtime.sendMessage round-trip without losing its identity.
    return new Error(STREAMING_UNSUPPORTED_SENTINEL);
  }

  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isNetworkFetchFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message === "Failed to fetch";
}

/**
 * The service signals a streaming/oversize upstream by returning 409 with a
 * `stream-unsupported` code. background.ts converts that into an Error whose
 * message starts with "Upstream response is streaming". This helper recognises
 * either shape so the rule still works if we ever rename the sentinel.
 */
function isStreamUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === STREAMING_UNSUPPORTED_SENTINEL ||
    error.message.includes("stream-unsupported") ||
    error.message.startsWith("Upstream response is streaming")
  );
}
