import { createRequestContext, executeForward, STREAMING_UNSUPPORTED } from "@resource-forwarder/forward-core";
import {
  matchesProjectSite,
  matchesRule,
  matchesRuleSetSite,
  pickMatchingRule,
  resolveEffectiveRequestHosts,
  resolveForwardProfile,
  resolveRuleBinding,
} from "@resource-forwarder/rule-core";
import type {
  ForwardProfile,
  ForwardRequestPayload,
  ForwardResponsePayload,
  RuleBinding,
  WorkspaceSnapshot,
} from "@resource-forwarder/shared-types";

export const BROWSER_CAPABILITY_UNSUPPORTED = "BROWSER_CAPABILITY_UNSUPPORTED";

export type ForwardExecutionLocation = "browser" | "local";

export interface ForwardExecutionDecision {
  location: ForwardExecutionLocation;
  reason: "explicit-browser" | "explicit-local" | "browser-default" | "local-capability";
}

const BROWSER_FORBIDDEN_HEADERS = new Set([
  "cookie",
  "cookie2",
  "host",
  "content-length",
  "origin",
  "referer",
]);

/**
 * Re-resolve and re-match the page hint inside the privileged worker. Page
 * code is untrusted and must never be able to turn host_permissions into an
 * arbitrary cross-origin fetch primitive.
 */
export function resolveForwardBinding(
  workspace: WorkspaceSnapshot,
  payload: ForwardRequestPayload,
): RuleBinding {
  const context = createRequestContext(payload);
  const hinted = payload.matchedRuleId
    ? resolveRuleBinding(workspace, payload.matchedRuleId)
    : undefined;
  const binding = payload.matchedRuleId
    ? hinted && isUsableForwardBinding(hinted, context)
      ? hinted
      : undefined
    : pickMatchingRule(workspace, context, "api_forward");

  if (!binding) {
    throw new Error(
      payload.matchedRuleId
        ? `Forward rule ${payload.matchedRuleId} is missing, disabled, or no longer matches this request.`
        : "No enabled API forward rule matched this request.",
    );
  }
  return binding;
}

export function chooseForwardExecution(binding: RuleBinding): ForwardExecutionDecision {
  const profile = resolveForwardProfile(binding);
  if (!profile) {
    throw new Error(`Rule ${binding.rule.id} does not have a forward profile.`);
  }

  const configured = profile.executionMode ?? "auto";
  const localOnlyReason = getLocalOnlyReason(profile);
  if (configured === "local") {
    return { location: "local", reason: "explicit-local" };
  }
  if (configured === "browser") {
    if (localOnlyReason) {
      throw new Error(`${BROWSER_CAPABILITY_UNSUPPORTED}: ${localOnlyReason}`);
    }
    return { location: "browser", reason: "explicit-browser" };
  }
  return localOnlyReason
    ? { location: "local", reason: "local-capability" }
    : { location: "browser", reason: "browser-default" };
}

export async function executeInBrowser(
  binding: RuleBinding,
  payload: ForwardRequestPayload,
  signal?: AbortSignal,
): Promise<{ response: ForwardResponsePayload; targetUrl: string }> {
  return executeForward(binding, payload, {
    signal,
    // The extension origin is not the page origin. Include credentials so the
    // browser may attach cookies belonging to the actual target host; moving a
    // source host's Cookie header across origins remains a local-only feature.
    fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
  });
}

export { STREAMING_UNSUPPORTED };

function getLocalOnlyReason(profile: ForwardProfile): string | undefined {
  if (profile.responsePolicy?.mode === "mock_file") {
    return "任意本地 JSON 文件路径需要本地 Companion。";
  }

  const configuredHeaders = Object.keys(profile.headers ?? {});
  const passthroughHeaders = profile.headerPolicy?.passthrough ?? [];
  const restricted = [...configuredHeaders, ...passthroughHeaders]
    .map((name) => name.toLowerCase())
    .find((name) => BROWSER_FORBIDDEN_HEADERS.has(name));
  if (restricted) {
    return `Header ${restricted} 不能由浏览器扩展 fetch 可靠设置。`;
  }
  return undefined;
}

function isUsableForwardBinding(binding: RuleBinding, context: ReturnType<typeof createRequestContext>): boolean {
  return (
    binding.rule.kind === "api_forward" &&
    binding.rule.enabled &&
    (binding.ruleSet ? binding.ruleSet.enabled : true) &&
    (binding.project ? binding.project.enabled : true) &&
    (!context.pageUrl || !binding.project || matchesProjectSite(binding.project, context.pageUrl)) &&
    (!context.pageUrl ||
      !binding.ruleSet ||
      matchesRuleSetSite(
        binding.ruleSet,
        binding.project ?? { siteHosts: [], siteMatchPatterns: [] },
        context.pageUrl,
      )) &&
    matchesRule(binding.rule, context, resolveEffectiveRequestHosts(binding))
  );
}
