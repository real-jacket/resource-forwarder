# Rules Toolbar Redesign

## Goal

Improve the top area of the rules list so users can immediately understand:

- which site / group they are currently operating on
- which actions are high-frequency and safe to expose directly
- where filtering and searching live

The redesign should reduce icon-only ambiguity without changing the underlying rule-management behavior.

## Current Problems

1. Site actions are rendered as unlabeled icon buttons next to the site selector, so users must infer meaning from similar-looking glyphs.
2. Context selection, structural actions, filters, and search all share one horizontal band, which makes the page hierarchy unclear.
3. The site scope banner has useful information but currently competes visually with the primary working controls.
4. `新建站点` and `新建规则` are separated from the site/group context, weakening the sense of “what object am I acting on now”.

## Scope

This redesign changes presentation only:

- modify `packages/extension-shell/src/options/views/RulesView.tsx`
- update related styles in `packages/extension-shell/public/styles.css`

It should not change:

- existing runtime actions or message contracts
- rule/group/site data flow in `main.tsx`
- row-level actions inside the table

## Interaction Design

### 1. Context Bar

The current toolbar is split into a dedicated context row that focuses on structural context and high-frequency actions.

Left to right:

- site selector
- `编辑站点`
- `停用站点` / `启用站点`
- `更多` menu containing `删除站点`
- group selector
- `新建分组`
- right-aligned actions: `新建站点`, `新建规则`

Rules:

- `编辑站点` and `启停站点` remain directly visible because they are common maintenance actions.
- `删除站点` moves into a lower-emphasis menu because it is destructive and lower frequency.
- `新建规则` remains the only primary CTA in this area.
- `新建分组` must use text, not a bare plus icon.

### 2. Filter Bar

Filtering and search are moved into a second row below the context bar.

Left to right:

- status tabs: `全部 / 启用中 / 已禁用`
- type selector
- wide search input
- `刷新`

Rules:

- search should be the visually dominant control in this row
- filter controls should read left-to-right as “status -> type -> search”
- refresh is a secondary utility action at the far right

### 3. Context Hint

The existing site scope banner is reduced in visual weight and treated as supporting context below the context bar.

Rules:

- keep the `站点匹配` information
- reduce the emphasis from alert-like banner to lightweight hint/badge row
- only strengthen visual emphasis when the site is disabled or otherwise needs attention

## Visual Direction

- replace icon-only top-level actions with text buttons or menu items
- keep icons as supporting cues, not primary carriers of meaning
- use stronger spacing/grouping to separate:
  - object context
  - structural actions
  - filtering/search
- preserve the existing product look and component language; avoid introducing a completely new visual system

## Implementation Boundary

Recommended component structure inside `RulesView.tsx`:

- `ContextBar`
- `FilterBar`
- `ContextHint`

Responsibilities:

- `ContextBar`: site/group selection and structural actions
- `FilterBar`: status tabs, type filter, search, refresh
- `ContextHint`: site match summary and disabled-state emphasis

## Validation

Success looks like:

1. A first-time viewer can identify site actions without guessing icon meaning.
2. The page reads in a clear order: current context first, filters second, table third.
3. High-frequency actions stay one click away, while destructive actions are deemphasized.
4. No behavior regressions occur in site/group selection, refresh, or rule creation flows.
