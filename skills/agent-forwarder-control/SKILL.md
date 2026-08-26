---
name: "agent-forwarder-control"
description: "Use when doing parallel local frontend development that needs production JS/CSS/API proxied to local dev servers through the Resource Forwarder browser extension. Create, switch, or tear down agent-managed proxy rule sets with the `rf` CLI — each parallel task/branch maps to one agent-managed project pointing at its own dev-server port. Requires the Resource Forwarder companion service running. Not for editing user-owned rules or starting dev-server processes."
---

# Agent Forwarder Control

Programmatically configure the Resource Forwarder browser extension's proxy rules from the
command line, so an agent can juggle many parallel requirements (e.g. several `zebra` branches),
each proxying production assets to its own local dev-server port.

Mental model: **one companion service, many agent-managed projects.** Each parallel requirement =
one `agent-managed` project whose asset rules redirect production URLs to `http://127.0.0.1:<devPort>`.
Enable the one you are testing; `switch` flips within a `switch-group`. This skill manages **rules
only** — it does not start dev servers or allocate ports.

## Prerequisites

1. The companion service must be running (from the resource-forwarder repo):
   ```bash
   pnpm dev:service        # or: pnpm start
   ```
2. `rf` must be on PATH (installed by `scripts/install-agent-control.sh`). Verify: `rf service status`.
3. The CLI reads the bearer token from `${RF_STORAGE_ROOT:-.resource-forwarder}/token` and targets
   `http://127.0.0.1:${PORT:-5178}`. Run `rf` with the SAME `RF_STORAGE_ROOT`/`PORT` the service uses.
4. Paste that token into the extension Settings page once, so the browser and CLI share one workspace.

## Core workflow (every mutation is CAS-guarded)

1. `rf workspace get --json` — read the current persisted `revision`.
2. Build/refresh the project (idempotent) with `rf project up ...`. It dry-runs locally, prints the
   generated DNR rule, validates against the service, then atomically replaces the whole subtree.
3. On `HTTP 409` (stale revision) the CLI re-reads and retries once. `--force` is an explicit
   last-writer-wins override — use only when you accept stale-write risk.
4. `rf wait-applied --timeout 30s` — block until the browser has applied the DNR (see ACK note).

## Commands

```bash
rf service status [--json]
rf workspace get [--json]
rf project list [--json]

# Create/refresh an agent-managed project. --asset takes a FULL production URL on the left
# (the CLI parses host+path from it) and the dev-server path on the right. '*' is a wildcard.
rf project up \
  --name zebra/feat-x \
  --site 'https://app.example.com/*' \
  --dev-port 8080 \
  --asset 'https://cdn.example.com/static/app.*.js => /static/app.js' \
  --switch-group zebra \
  --enable

rf project enable  zebra/feat-x
rf project disable zebra/feat-x
rf project switch  zebra/feat-x     # enable this, disable enabled siblings in the same switch-group
rf project down    zebra/feat-x     # delete the project subtree

rf wait-applied --timeout 30s

# Lower-level escape hatches (user-owned rules only):
rf rule list [--project <id>] [--json]
rf rule validate --file rule.json
rf rule match --url <url> --method GET [--page-url <url>] [--resource-type fetch] [--json]
```

> **Gotcha:** `--asset` LEFT side must be a full URL (`https://host/path`), not a bare path — the CLI
> runs `new URL()` on it. A bare path fails with `Invalid URL`.

## Ownership rules (why writes are safe)

- `agent-managed` is a reserved project tag; ownership is **immutable per project ID** in v1
  (transfer = `down` then `up` under a new name/ID; deleted IDs are tombstoned and cannot be reused).
- An agent-managed project owns its whole subtree (rule sets + rules). Options Page renders it
  read-only; generic CRUD and imports cannot touch it.
- `up` replaces the subtree atomically — assets omitted from a later `up` are removed.
- `switch` and subtree replacement are single atomic, revision-guarded service mutations.

## Failure codes

- `409` — stale/conflicting revision or ID ownership conflict → re-read and recompute (CLI retries once).
- `428` — missing revision guard → supply current revision or pass `--force`.
- `403` — attempted to edit reserved agent-managed data via a generic path.
- Failed validation writes nothing.

## Applied ACK vs real verification

`wait-applied` succeeds only after the extension persisted locally AND Chrome accepted both the
dynamic and session DNR updates. Timeout prints exactly `persisted but not browser-applied`. The ACK
does **not** prove the dev server is up, or that CSP/CORS/page code loaded the intended asset —
reload the page and check the actual network response.

## Out of scope (v1)

No dev-server lifecycle, no port allocation, no MCP/WebSocket. Concurrent agents sharing a storage
root coordinate via revision guards.
