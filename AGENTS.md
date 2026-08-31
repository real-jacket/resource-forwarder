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

## Agent bootstrap: install the agent-control capability

When the user asks you to "install" / "set up" the **agent-control** capability (the ability to
configure this extension's proxy rules programmatically via the `rf` CLI + skill), run this from the
repo root — you do not need the skill pre-installed to do this:

```bash
pnpm install                 # only if node_modules is missing
pnpm agent-control:install   # builds rf, puts it on PATH, installs the skill into ~/.claude/skills and ~/.codex/skills
```

Pass-through flags: `--claude-only`, `--codex-only`, `--no-build`, `--uninstall`
(e.g. `pnpm agent-control:install --codex-only`).

After it runs, report to the user:

- `rf` is on PATH (a wrapper at `~/.local/bin/rf`; if that dir is not on PATH, tell the user to add it).
  The wrapper defaults `RF_STORAGE_ROOT` to this checkout's standard companion storage at
  `packages/forwarder-service/.resource-forwarder`, so it works from another repository; an explicit
  `RF_STORAGE_ROOT` still overrides it.
- The `agent-forwarder-control` skill is installed for Claude Code and Codex — they must **restart**
  Claude Code / Codex so a fresh session discovers it.
- To verify: `pnpm dev:service` (start the service), then from another directory run `rf --help` and
  `rf service status --json`; the latter prints `{ok:true}`.
  Open the token file path printed by the service and paste its contents into the extension Settings page once.

The `rf` wrapper points at the checkout you installed from; after merging this branch and removing a
worktree, re-run `pnpm agent-control:install` from the active checkout. Once installed, follow
`skills/agent-forwarder-control/SKILL.md` to create/switch/tear down agent-managed proxy projects;
do not hand-edit user-owned rules.

## Workspace architecture

This is a pnpm monorepo with 5 packages:

- `packages/shared-types`: canonical cross-package TypeScript contracts (workspace/project/rule schema, runtime payloads, logs, API request/response models).
- `packages/rule-core`: pure rule engine utilities:
  - workspace parse/serialize (`json`/`yaml`)
  - rule matching and conflict checks
  - declarativeNetRequest conversion for asset redirects
  - workspace trimming by current URL/tab scope
- `packages/forward-core`: browser/Node-compatible forwarding execution:
  - target URL, query, request and response header rewriting
  - upstream fetch, timeout, response buffering and binary encoding
  - JSON Merge Patch and inline JSON mocks
- `packages/forwarder-service`: Fastify local service that persists workspace state and proxies API traffic based on matched `api_forward` rules.
- `packages/extension-shell`: Manifest V3 extension (background worker + content script + injected page bridge + React options page + React sidepanel).

Dependency direction is intentionally one-way:

- `shared-types` -> consumed by all other packages
- `rule-core` -> depends on `shared-types`
- `forward-core` -> depends on `shared-types` and `rule-core`
- `forwarder-service` and `extension-shell` -> depend on `forward-core`, `shared-types`, and `rule-core`

## End-to-end request flow

### Asset redirect (`asset_redirect`)

1. Options page updates workspace via background runtime messages.
2. Background syncs workspace and converts enabled asset rules to DNR rules.
3. Truly global and fully host-wide page scopes use dynamic rules; page-, scheme-, path-, or tab-scoped rules use session rules with eligible `tabIds`.
4. Browser applies redirects directly at request layer (no service hop).

Dynamic host-wide rules carry `initiatorDomains` bound to the project's
`siteHosts`. Any Project or RuleSet page scope that cannot be represented by
host-only initiator domains is enforced with session-rule `tabIds` instead.
True global projects intentionally have no initiator restriction.

### API forward (`api_forward`)

1. The isolated content script requests site context for its current URL.
2. Background trims the workspace using the actual sender tab/frame and injects `page-bridge.js` into that frame with `chrome.scripting.executeScript({ world: "MAIN" })` only when an enabled API rule applies.
3. After the private MessagePort handshake delivers the first applicable config, Page Bridge patches `fetch` + `XMLHttpRequest` and emits proxy requests to the content script.
4. Content script forwards proxy requests to extension background.
5. Background re-validates the hinted rule against the full workspace and chooses an executor.
6. Ordinary forwarding, response patches, and inline JSON mocks execute in the extension service worker through `forward-core`.
7. Arbitrary local file paths, restricted headers, or rules explicitly set to `local` use the optional local service `/forward` adapter.
8. Background/content script/page bridge return the response back to page code.

## Persistence and state boundaries

- Local service storage root defaults to `./.resource-forwarder` under the service process cwd
  (normally `packages/forwarder-service/.resource-forwarder` via the root pnpm scripts; overridable
  with `RF_STORAGE_ROOT`).
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
