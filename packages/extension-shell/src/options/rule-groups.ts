import type { RuleSet } from "@resource-forwarder/shared-types";

export interface RuleGroup<Row extends { ruleSet: RuleSet | null }> {
  ruleSet: RuleSet | null;
  rows: Row[];
}

export function buildRuleGroups<Row extends { ruleSet: RuleSet | null }>(
  rows: Row[],
  selectedProjectId: string,
  projectRuleSets: RuleSet[],
): RuleGroup<Row>[] {
  const grouped = new Map<string, RuleGroup<Row>>();
  for (const row of rows) {
    const key = row.ruleSet?.id ?? "__orphan__";
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.rows.push(row);
    } else {
      grouped.set(key, { ruleSet: row.ruleSet, rows: [row] });
    }
  }

  if (selectedProjectId) {
    for (const ruleSet of projectRuleSets) {
      if (!grouped.has(ruleSet.id)) {
        grouped.set(ruleSet.id, { ruleSet, rows: [] });
      }
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    if (!a.ruleSet && b.ruleSet) return 1;
    if (a.ruleSet && !b.ruleSet) return -1;
    if (!a.ruleSet || !b.ruleSet) return 0;
    return a.ruleSet.name.localeCompare(b.ruleSet.name);
  });
}

export function toggleCollapsedRuleSetIds(current: Set<string>, ruleSetId: string): Set<string> {
  const next = new Set(current);
  if (next.has(ruleSetId)) {
    next.delete(ruleSetId);
  } else {
    next.add(ruleSetId);
  }
  return next;
}
