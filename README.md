# Resource Forwarder

A Chrome and Edge focused resource forwarding toolkit with a local forwarder service and a Manifest V3 extension shell.

## Workspace layout

- `packages/shared-types`: shared contracts across the service and extension
- `packages/rule-core`: rule matching, import/export and DNR conversion
- `packages/forwarder-service`: Fastify based local forwarder service
- `packages/extension-shell`: MV3 extension shell with options page and side panel
- `examples/sample-workspace.yaml`: importable starter workspace

## Quick start

```bash
pnpm install
pnpm build
pnpm --filter @resource-forwarder/forwarder-service dev
```

Then load `packages/extension-shell/dist` as an unpacked extension in Chrome or Edge.

## Using the service and extension

1. Start the local service. It listens on `http://127.0.0.1:5178` by default and stores data under `./.resource-forwarder`.
2. Open the extension options page and confirm the service URL.
3. Import `examples/sample-workspace.yaml` or create a project and rule set manually.
4. Use the side panel on the active tab to toggle matching projects and create quick rules.
5. Use the options page for full rule editing, import/export and log review.

## Rule model summary

- `Project`: scopes sites and default enable state
- `RuleSet`: groups rules for enable/disable and import/export
- `asset_redirect`: converts matched asset requests into HTTPS redirects via dynamic DNR rules
- `api_forward`: intercepts `fetch` and `XMLHttpRequest` in the page bridge, then proxies through the local service

## Current boundaries

- Asset replacement only supports redirecting to browser reachable HTTPS targets.
- API forwarding supports `fetch` and `XMLHttpRequest` interception through the injected page bridge.
- WebSocket, SSE streaming rewrite and transparent HTTPS MITM are intentionally out of scope for v1.
- The extension avoids `chrome.debugger`, so some browser-level request rewriting scenarios remain out of reach until a future certificate proxy mode.

## Validation

```bash
pnpm build
pnpm test
```
