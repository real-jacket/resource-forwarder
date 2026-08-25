import { getEnabledRuleBindings } from "@resource-forwarder/rule-core";
import type { WorkspaceSnapshot } from "@resource-forwarder/shared-types";

export function needsPageBridge(workspace: WorkspaceSnapshot): boolean {
  return getEnabledRuleBindings(workspace, "api_forward").length > 0;
}
