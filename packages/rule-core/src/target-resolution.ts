import type { ForwardProfile, RuleBinding } from "@resource-forwarder/shared-types";

export function resolveBindingBaseUrl(binding: Pick<RuleBinding, "project" | "ruleSet">): string | undefined {
  const ruleSetBase = getRuleSetBaseUrl(binding.ruleSet)?.trim();
  if (ruleSetBase) {
    return ruleSetBase;
  }
  const projectBase = getProjectBaseUrl(binding.project)?.trim();
  return projectBase || undefined;
}

export function resolveRuleTargetValue(
  value: string | undefined,
  binding: Pick<RuleBinding, "project" | "ruleSet">,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isAbsoluteUrl(trimmed)) {
    return trimmed;
  }

  const baseUrl = resolveBindingBaseUrl(binding);
  if (!baseUrl || !isAbsoluteUrl(baseUrl)) {
    return undefined;
  }

  const normalizedBase =
    trimmed.startsWith("/") || baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(trimmed, normalizedBase).toString();
}

export function resolveForwardProfile(
  binding: Pick<RuleBinding, "project" | "ruleSet" | "rule">,
): ForwardProfile | undefined {
  const profile = binding.rule.target.forwardProfile;
  if (!profile) {
    return undefined;
  }

  const resolvedTargetBaseUrl = resolveRuleTargetValue(profile.targetBaseUrl, binding);
  if (!resolvedTargetBaseUrl) {
    return undefined;
  }

  return {
    ...profile,
    targetBaseUrl: resolvedTargetBaseUrl,
  };
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function getProjectBaseUrl(project: RuleBinding["project"]): string | undefined {
  return (project as (typeof project & { baseUrl?: string }) | undefined)?.baseUrl;
}

function getRuleSetBaseUrl(ruleSet: RuleBinding["ruleSet"]): string | undefined {
  return (ruleSet as (typeof ruleSet & { baseUrl?: string }) | undefined)?.baseUrl;
}
