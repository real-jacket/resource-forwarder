# Rules Toolbar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the rules list header into a clearer context bar, filter bar, and lightweight scope hint while keeping all existing rule-management behaviors intact.

**Architecture:** Keep all behavior in `main.tsx` unchanged and refactor only the `RulesView` presentation layer plus CSS. Replace icon-only site actions with labeled controls, move destructive site deletion behind a lightweight menu, and split context selection from filtering/search.

**Tech Stack:** React 18, TypeScript, existing options-page CSS, Vitest, esbuild build script

---

### Task 1: Add a Focused Toolbar Model Test

**Files:**
- Create: `packages/extension-shell/src/options/rules-toolbar.test.ts`
- Test: `packages/extension-shell/src/options/rules-toolbar.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  buildSiteActionMenuItems,
  getToolbarLayoutFlags,
} from "./rules-toolbar.js";

describe("buildSiteActionMenuItems", () => {
  it("keeps delete inside the overflow menu and toggles the enable label", () => {
    expect(buildSiteActionMenuItems(true).map((item) => item.label)).toEqual(["删除站点"]);
    expect(getToolbarLayoutFlags({ hasSelectedProject: true, hasSelectedRuleSet: true })).toEqual({
      showSiteActions: true,
      showGroupActions: true,
      canCreateRule: true,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH=/Users/shimo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PWD/node_modules/.bin:$PATH && cd packages/extension-shell && vitest run src/options/rules-toolbar.test.ts`

Expected: FAIL because `rules-toolbar.js` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface ToolbarLayoutFlags {
  showSiteActions: boolean;
  showGroupActions: boolean;
  canCreateRule: boolean;
}

export interface SiteActionMenuItem {
  key: "delete";
  label: string;
  danger?: boolean;
}

export function buildSiteActionMenuItems(_enabled: boolean): SiteActionMenuItem[] {
  return [{ key: "delete", label: "删除站点", danger: true }];
}

export function getToolbarLayoutFlags(input: {
  hasSelectedProject: boolean;
  hasSelectedRuleSet: boolean;
}): ToolbarLayoutFlags {
  return {
    showSiteActions: input.hasSelectedProject,
    showGroupActions: input.hasSelectedProject,
    canCreateRule: input.hasSelectedProject && input.hasSelectedRuleSet,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH=/Users/shimo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PWD/node_modules/.bin:$PATH && cd packages/extension-shell && vitest run src/options/rules-toolbar.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/extension-shell/src/options/rules-toolbar.ts packages/extension-shell/src/options/rules-toolbar.test.ts
git commit -m "test(options): cover rules toolbar layout helpers"
```

### Task 2: Refactor RulesView into Context Bar + Filter Bar

**Files:**
- Modify: `packages/extension-shell/src/options/views/RulesView.tsx`
- Modify: `packages/extension-shell/src/options/rules-toolbar.ts`
- Test: `packages/extension-shell/src/options/rules-toolbar.test.ts`

- [ ] **Step 1: Extend the helper test with layout expectations**

```ts
it("shows rule creation only when both project and group are present", () => {
  expect(getToolbarLayoutFlags({ hasSelectedProject: true, hasSelectedRuleSet: false }).canCreateRule).toBe(false);
});
```

- [ ] **Step 2: Run test to verify the new expectation passes or fails for the right reason**

Run: `export PATH=/Users/shimo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PWD/node_modules/.bin:$PATH && cd packages/extension-shell && vitest run src/options/rules-toolbar.test.ts`

Expected: PASS or a small assertion failure tied only to the helper behavior.

- [ ] **Step 3: Implement the RulesView structure change**

```tsx
<>
  <div className="page-header">...</div>
  <ContextBar {...props} />
  <ContextHint project={props.selectedProject} />
  <FilterBar {...props} />
  <div className="rule-table-container">...</div>
  <div className="options-statusbar">...</div>
</>
```

Also move the current site/group actions into labeled buttons and replace direct delete exposure with a small overflow trigger rendered only when a site is selected.

- [ ] **Step 4: Run focused typecheck**

Run: `export PATH=/Users/shimo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PWD/node_modules/.bin:$PATH && cd packages/extension-shell && tsc -p tsconfig.json --noEmit`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/extension-shell/src/options/views/RulesView.tsx packages/extension-shell/src/options/rules-toolbar.ts packages/extension-shell/src/options/rules-toolbar.test.ts
git commit -m "feat(options): restructure rules toolbar layout"
```

### Task 3: Update CSS for the New Toolbar Hierarchy

**Files:**
- Modify: `packages/extension-shell/public/styles.css`

- [ ] **Step 1: Write the CSS changes**

```css
.rules-context-bar { ... }
.rules-filter-bar { ... }
.site-action-menu { ... }
.context-hint-inline { ... }
.toolbar-primary-actions { ... }
```

Make the context bar more prominent than the filter bar, widen the search control, and reduce the visual weight of the old site scope banner.

- [ ] **Step 2: Run build to verify styling changes bundle cleanly**

Run: `export PATH=/Users/shimo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PWD/node_modules/.bin:$PATH && cd packages/extension-shell && node scripts/build.mjs`

Expected: PASS

- [ ] **Step 3: Run full extension-shell verification**

Run: `export PATH=/Users/shimo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PWD/node_modules/.bin:$PATH && cd packages/extension-shell && vitest run --passWithNoTests && tsc -p tsconfig.json --noEmit && node scripts/build.mjs`

Expected: PASS with 0 failed tests and successful build output.

- [ ] **Step 4: Commit**

```bash
git add packages/extension-shell/public/styles.css
git commit -m "style(options): polish rules toolbar interactions"
```
