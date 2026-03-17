import type { MatchResourceType } from "@resource-forwarder/shared-types";

export function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinCsv(values: string[] | undefined): string {
  return (values ?? []).join(", ");
}

export function getHostFromUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

export function getPathFromUrl(value: string): string {
  try {
    return new URL(value).pathname || "/";
  } catch {
    return "/";
  }
}

export const DEFAULT_RESOURCE_TYPES: MatchResourceType[] = ["fetch", "xmlhttprequest"];
