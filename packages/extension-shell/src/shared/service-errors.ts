import { SERVICE_OFFLINE_SENTINEL } from "./constants.js";

export function normalizeProxyRequestError(error: unknown): unknown {
  if (isAbortError(error)) {
    return error;
  }

  if (isNetworkFetchFailure(error)) {
    return new Error(SERVICE_OFFLINE_SENTINEL);
  }

  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isNetworkFetchFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message === "Failed to fetch";
}
