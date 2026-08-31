---
name: "agent-forwarder-control"
description: "Use when doing parallel local frontend development that needs production JS/CSS/API proxied to local dev servers through the Resource Forwarder browser extension. Create, switch, or tear down agent-managed proxy rule sets with the `rf` CLI — each parallel task/branch maps to one agent-managed project pointing at its own dev-server port. Requires the Resource Forwarder companion service running. Not for editing user-owned rules or starting dev-server processes."
---

# Agent Forwarder Control

Programmatically configure the Resource Forwarder browser extension from the command line, so an
agent can juggle parallel requirements (for example several `zebra` branches), each with its own
asset redirects, API forwarding, request/response rewrites, or mocks.

Mental model: **one companion service, many agent-managed projects.** Each parallel requirement =
one `agent-managed` project pointing at its own dev-server port.
Enable the one you are testing; `switch` flips within a `switch-group`. This skill manages **rules
only** — it does not start dev servers or allocate ports.

## Prerequisites

1. The companion service must be running (from the resource-forwarder repo):
   ```bash
   pnpm dev:service        # or: pnpm start
   ```
2. `rf` must be on PATH (installed by `scripts/install-agent-control.sh`). `rf --help` works without
   a token; `rf service status` checks the public health endpoint.
3. The installed wrapper defaults `RF_STORAGE_ROOT` to the checkout's standard companion storage at
   `packages/forwarder-service/.resource-forwarder` and targets `http://127.0.0.1:${PORT:-5178}`.
   An explicit `RF_STORAGE_ROOT` still overrides it; use the SAME storage root and port as the service.
4. Paste that token into the extension Settings page once, so the browser and CLI share one workspace.

## Core workflow (every mutation is CAS-guarded)

1. `rf schema get --json` — inspect the live Rule/Project/RuleSet contract when authoring a full rule.
2. `rf workspace get --json` — read the current persisted `revision`.
3. Build/refresh the project with `rf project up ...`. Use `--asset` for the common static-resource
   shortcut and repeatable `--rule <json|yaml>` for the full `asset_redirect` or `api_forward`
   contract. The CLI validates every rule, then atomically replaces the whole agent subtree.
4. On `HTTP 409` (stale revision) the CLI re-reads and retries once. `--force` is an explicit
   last-writer-wins override — use only when you accept stale-write risk.
5. Capture the mutation response `revision`, then run
   `rf wait-applied --revision <revision> --timeout 75s`. Supplying the exact revision prevents a
   concurrent agent's later write from making this agent wait for unrelated work.
6. Dry-run the persisted result with `rf rule match ... --json`; inspect hit logs after real traffic
   with `rf logs --project <project-id> --json`.

## Commands

```bash
rf service status [--json]
rf schema get [--json]
rf workspace get [--json]
rf project list [--json]

# Create/refresh an agent-managed project. --asset takes a FULL production URL on the left
# (the CLI parses host+path from it) and the dev-server path on the right. '*' is a wildcard.
rf project up \
  --name zebra/feat-x \
  --site 'https://app.example.com/*' \
  --dev-port 8080 \
  --asset 'https://cdn.example.com/static/app.*.js => /static/app.js' \
  --rule ./api-forward.yaml \
  --switch-group zebra \
  --enable --json

rf project enable  zebra/feat-x
rf project disable zebra/feat-x
rf project switch  zebra/feat-x     # enable this, disable enabled siblings in the same switch-group
rf project down    zebra/feat-x     # delete the project subtree

rf wait-applied --revision <revision-from-mutation> --timeout 75s

# Lower-level escape hatches (user-owned rules only):
rf rule list [--project <id>] [--json]
rf rule validate --file rule.json
rf rule match --url <url> --method GET [--page-url <url>] [--resource-type fetch] \
  [--header 'Name: value'] [--tab-id <id>] [--json]
rf logs [--limit 100] [--project <id>] [--json]
```

> **Gotcha:** `--asset` LEFT side must be a full URL (`https://host/path`), not a bare path — the CLI
> runs `new URL()` on it. A bare path fails with `Invalid URL`.

`--rule` accepts one Rule object or `{ "rule": { ... } }` in JSON/YAML. The CLI namespaces the
file's logical `id` under the agent project, fills default `enabled=true`, `priority=100`, tags and
timestamps, and supports every existing forward profile field. A minimal API rule can be:

```yaml
id: users-api
name: local users API
kind: api_forward
match:
  host: [app.example.com]
  pathGlob: /api/users/**
  method: [GET, POST]
  resourceType: [fetch, xmlhttprequest]
  tabScope: { mode: all }
target:
  forwardProfile:
    executionMode: auto
    targetBaseUrl: /
    fallbackMode: error
    responsePolicy:
      mode: forward
      jsonMergePatch: { source: local }
```

Because the project base URL is `http://127.0.0.1:<devPort>`, a relative `targetBaseUrl` resolves to
that server. Use the same Rule shape for inline JSON mocks, local-file mocks, query/header policies,
response header changes, latency, and status overrides; `rf schema get --json` is authoritative.

## Ownership rules (why writes are safe)

- `agent-managed` is a reserved project tag; ownership is **immutable per project ID** in v1.
  Deleted IDs remain tombstoned; a later `up` with the same name receives the next safe generation.
- An agent-managed project owns its whole subtree (rule sets + rules). Options Page renders it
  read-only; generic CRUD and imports cannot touch it.
- `up` replaces the subtree atomically — assets omitted from a later `up` are removed.
- `switch` and subtree replacement are single atomic, revision-guarded service mutations; switching
  never toggles user-owned projects, even if they carry the same switch-group tag.

## Failure codes

- `409` — stale/conflicting revision or ID ownership conflict → re-read and recompute (CLI retries once).
- `428` — missing revision guard → supply current revision or pass `--force`.
- `403` — attempted to edit reserved agent-managed data via a generic path.
- Failed validation writes nothing.
- With `--json`, stdout is exactly one machine-readable result; dry-run/validation diagnostics and
  structured errors go to stderr.

## Applied ACK vs real verification

`wait-applied` succeeds only after the extension persisted locally, refreshed live page configs,
and Chrome accepted both dynamic and session DNR updates. The extension polls external changes at
Chrome's 30-second alarm floor, which is why 75 seconds is the safe default. Timeout prints exactly
`persisted but not browser-applied`. The ACK does **not** prove the dev server is up, or that
CSP/CORS/page code loaded the intended response — reload the page and check the actual Network entry.

## Out of scope (v1)

No dev-server lifecycle, no port allocation, no MCP/WebSocket. Concurrent agents sharing a storage
root coordinate via revision guards.
