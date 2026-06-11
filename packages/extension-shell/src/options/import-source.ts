import { detectFormat, parseResourceOverrideExport, parseWorkspace } from "@resource-forwarder/rule-core";
import type { ImportSource } from "./types.js";

export function detectImportSource(content: string): ImportSource | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  try {
    parseResourceOverrideExport(trimmed);
    return "resource-override";
  } catch {
    // Fall through to workspace detection.
  }

  try {
    parseWorkspace(trimmed, detectFormat(trimmed));
    return "workspace";
  } catch {
    return null;
  }
}
