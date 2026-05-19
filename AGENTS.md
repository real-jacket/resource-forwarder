# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

- Install deps: `pnpm install`
- Build all packages: `pnpm build`
- Run all tests: `pnpm test`
- Start full dev workflow (service + extension watch build): `pnpm dev`
- Start only local forwarder service: `pnpm dev:service`
- Start only extension watch build: `pnpm dev:extension`
- Run built service: `pnpm start`

### Package-level commands

- Rule engine tests: `pnpm --filter @resource-forwarder/rule-core test`
- Service tests: `pnpm --filter @resource-forwarder/forwarder-service test`
- Extension tests (currently no test files): `pnpm --filter @resource-forwarder/extension-shell test`

### Single-test patterns (Vitest)

- Single file in rule-core: `pnpm --filter @resource-forwarder/rule-core test -- src/index.test.ts`
- Single test by name in rule-core: `pnpm --filter @resource-forwarder/rule-core test -- -t "matches the highest priority API rule"`
- Single file in forwarder-service: `pnpm --filter @resource-forwarder/forwarder-service test -- src/index.test.ts`

## Workspace architecture

This is a pnpm monorepo with 4 packages:

- `packages/shared-types`: canonical cross-package TypeScript contracts (workspace/project/rule schema, runtime payloads, logs, API request/response models).
- `packages/rule-core`: pure rule engine utilities:
  - workspace parse/serialize (`json`/`yaml`)
  - rule matching and conflict checks
  - declarativeNetRequest conversion for asset redirects
  - workspace trimming by current URL/tab scope
- `packages/forwarder-service`: Fastify local service that persists workspace state and proxies API traffic based on matched `api_forward` rules.
- `packages/extension-shell`: Manifest V3 extension (background worker + content script + injected page bridge + React options page + React sidepanel).

Dependency direction is intentionally one-way:

- `shared-types` -> consumed by all other packages
- `rule-core` -> depends on `shared-types`
- `forwarder-service` and `extension-shell` -> depend on both `shared-types` and `rule-core`

## End-to-end request flow

### Asset redirect (`asset_redirect`)

1. Options page updates workspace via background runtime messages.
2. Background syncs workspace from service and converts enabled asset rules to dynamic DNR rules (`chrome.declarativeNetRequest.updateDynamicRules`).
3. Browser applies redirect directly at request layer (no service hop).

Generated DNR rules carry `initiatorDomains` bound to the project's `siteHosts`
(unless the project is wildcard / `*`). This means a rule only fires when the
request is initiated by a page inside the owning project's site scope — so a
disabled or unmatched project cannot leak its rules onto unrelated pages. The
only exception is true global projects (`siteHosts` empty or contains `*`),
which intentionally have no initiator restriction.

### API forward (`api_forward`)

1. Content script injects `page-bridge.js` into page context.
2. Page bridge patches `fetch` + `XMLHttpRequest`, checks matching rules, and emits proxy requests to content script via `window.postMessage`.
3. Content script forwards proxy request to extension background.
4. Background calls local service `/forward`.
5. Service matches rule with `rule-core`, forwards upstream using rule profile (target base URL, prefix stripping, path rewrite, header injection), then returns response.
6. Background/content script/page bridge return the response back to page code.

## Persistence and state boundaries

- Local service storage root defaults to `./.resource-forwarder` (overridable via `RF_STORAGE_ROOT`).
- Workspace snapshot is stored as JSON at `.resource-forwarder/workspace.json`.
- Hit logs are appended as daily JSONL files under `.resource-forwarder/logs/`.
- Extension stores service URL and managed DNR rule IDs in `chrome.storage.local`.

## Important implementation notes

- Service base URL default is `http://127.0.0.1:5178` (extension constant + service default port).
- Background worker is the source of truth for runtime state (`serviceUrl`, `health`, `workspace`) inside the extension.
- Sidepanel is intentionally lightweight (status/toggle oriented), while options page is the full CRUD/import/export surface. It surfaces a `N 条 DNR 已注册` badge sourced from `chrome.declarativeNetRequest.getDynamicRules / getSessionRules` so users can see how many rules Chrome is actually enforcing — useful when the workspace view says "未匹配" but stale or cross-project DNR rules are still installed.
- `asset_redirect` rules must target `https://...` URLs; warnings are generated in `rule-core` for unsupported targets.
- Import/export supports JSON and YAML; `rule-core` auto-detects format for imports.

## Build and packaging details (extension)

- Extension builds are driven by `packages/extension-shell/scripts/build.mjs` using esbuild.
- Output goes to `packages/extension-shell/dist` and this folder is loaded as unpacked extension.
- Entrypoints: `background.ts`, `content-script.ts`, `page-bridge.ts`, `options/main.tsx`, `sidepanel/main.tsx`.
