import { join } from "node:path";

export const DEFAULT_SERVICE_PORT = 5178;
export const DEFAULT_STORAGE_DIRNAME = ".resource-forwarder";
export const DEFAULT_FORWARD_TIMEOUT_MS = 15000;

export function resolveStorageRoot(baseDir = process.cwd()): string {
  return join(baseDir, DEFAULT_STORAGE_DIRNAME);
}
