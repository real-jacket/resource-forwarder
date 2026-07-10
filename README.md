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
the extension's **Settings → Service token** field once. The value is stored
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
5. Use the options page for full rule editing, import/export and request debugging.

## Rule model summary

- `Project`: scopes sites and default enable state
- `RuleSet`: groups rules for enable/disable and import/export
- `asset_redirect`: converts matched asset requests into HTTPS redirects via dynamic DNR rules. Rules are scoped to the owning project's `siteHosts` via `initiatorDomains`, so they only fire on pages within the project's site scope. Wildcard / global projects intentionally skip this restriction.
- `api_forward`: intercepts `fetch` and `XMLHttpRequest` in the page bridge, then proxies through the local service

### Matching hierarchy

Rules execute through one explicit ownership and matching chain:

1. The current page must match the owning `Project` site scope.
2. It must also match the owning `RuleSet` page scope, or the rule set inherits the project scope.
3. The request must match the rule's host, path, query, headers, method, resource type and tab scope.
4. If several rules pass every layer, priority decides the winner, followed by creation time and rule id for deterministic ties.

A rule must belong to exactly one rule set, and that rule set must belong to an existing project. Orphan rules, duplicate rule-set memberships and rule sets with missing projects remain visible for repair but do not participate in API forwarding or DNR registration. The UI's enabled/disabled counts use the effective project + rule set + rule chain rather than the rule toggle alone.

### API forwarding for frontend development

An `api_forward` rule can now cover the common frontend debugging loop without
requiring changes to application source code:

- Match by request host, path glob, query parameters, request headers, HTTP method and fetch/XHR type.
- Rewrite the upstream base URL, strip a path prefix, apply ordered path-prefix rewrites and preserve multi-value query parameters.
- Remove, replace or append query parameters before forwarding.
- Remove, pass through, inject or override request headers.
- Forward browser cookies (including HttpOnly cookies) for same-host targets, or explicitly to cross-host targets by adding `cookie` to the passthrough list.
- Keep the real upstream request and apply an RFC 7396-style JSON merge patch to its response (`null` removes a field).
- Skip the upstream entirely and return inline JSON, or load a local `.json` file as the response body.
- Override response status/status text and add up to 30 seconds of deterministic latency for loading, empty and error-state development.
- Remove, inject or override response headers before the page receives the synthetic response.
- Configure per-rule timeout and choose whether unsupported/offline proxy cases fall back to the original browser request or fail closed.
- Use **Request Debugging** to dry-run a URL against every rule, see the final rewritten URL and inspect which condition caused a miss.
- Review recent request records with source URL, target URL, rule, status, duration and error message.

For local API development, set **On proxy failure → Error, do not fall back**
to avoid accidentally sending a request to a shared test or production
endpoint when the local service is unavailable.

Local mock file paths may be absolute, or relative to the directory where the
forwarder service was started. Only `.json` files up to 4 MiB are accepted.
Mock modes do not contact the configured upstream. File paths are part of the
workspace configuration and may reveal local directory names when exported, so
review exported JSON/YAML before sharing it.

## Current boundaries

- Asset replacement only supports redirecting to browser reachable HTTPS targets.
- API forwarding supports `fetch` and `XMLHttpRequest` interception through the injected page bridge.
- WebSocket and transparent HTTPS MITM are intentionally out of scope for v1.
- Server-Sent Events (`text/event-stream`) and responses larger than ~4 MiB
  cannot be buffered through extension messaging without corrupting streaming
  semantics. Rules using the default native-fallback mode retry the original
  browser request and record `passed`; fail-closed rules surface an error.
- JSON response merge patches require the upstream body to be valid JSON. A
  parse failure is surfaced as a proxy error instead of returning a partially
  modified response.
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
