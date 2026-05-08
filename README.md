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
pnpm dev
```

Then load `packages/extension-shell/dist` as an unpacked extension in Chrome or Edge.

### One-time auth setup

The local service authenticates every non-`/health` request with a bearer
token. On first launch the CLI generates one at
`<storage_root>/token` (default `./.resource-forwarder/token`, override with
`RF_STORAGE_ROOT`) and prints the path. Copy the contents and paste them into
the extension's **Settings → Service token** field once — the value is stored
in `chrome.storage.local` and re-applied on every subsequent service request.

If you need to lock CORS to your specific extension build, also export
`RF_EXTENSION_ID=<your-extension-id>` before starting the service. Without it
the server still requires the token but accepts any `chrome-extension://`
origin.

## Root scripts

```bash
pnpm dev            # 一键启动本地服务 + 扩展 watch 构建
pnpm dev:service    # 只启动本地转发服务
pnpm dev:extension  # 只启动扩展 watch 构建
pnpm start          # 运行已构建的本地服务
pnpm build          # 构建全部包
pnpm test           # 运行全部测试
```

## Using the service and extension

1. Run `pnpm dev`. It starts the local service and keeps `packages/extension-shell/dist` updated.
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
- WebSocket and transparent HTTPS MITM are intentionally out of scope for v1.
- Server-Sent Events (`text/event-stream`) and responses larger than ~4 MiB
  fall through to the native fetch automatically — buffering them through the
  extension messaging channel would corrupt streaming semantics. The hit log
  records these as `passed`, not `error`.
- Sensitive forward-profile headers (`Authorization`, `Cookie`, `X-API-Key`,
  …) are stored encrypted in `<storage_root>/secrets.json` (AES-256-GCM with
  a per-installation key in `secret.key`). Workspace exports still contain
  the cleartext values, so treat exported files as secrets.
- The extension avoids `chrome.debugger`, so some browser-level request rewriting scenarios remain out of reach until a future certificate proxy mode.

## Validation

```bash
pnpm build
pnpm test
```
