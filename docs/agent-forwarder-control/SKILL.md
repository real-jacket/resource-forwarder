# Agent Forwarder Control Skill

## Purpose and scope

This skill controls one Resource Forwarder Companion workspace containing multiple agent-managed projects. Each project may represent one requirement and one development-server port. The v1 workflow does not manage dev-server processes, allocate ports, add MCP, or use WebSockets.

The `rf` binary is provided by `@resource-forwarder/forwarder-service`. It drives the authenticated HTTP API and runs rule-core dry-runs locally before writes.

## Prerequisites

1. Start the Companion service:

   ```bash
   pnpm dev:service
   ```

2. Read the bearer token from the storage root:

   ```bash
   cat "${RF_STORAGE_ROOT:-.resource-forwarder}/token"
   ```

3. Configure the extension with the token. The default service endpoint is `http://127.0.0.1:5178`; override it with `PORT` and `RF_STORAGE_ROOT` when required.

The CLI reads the same token file and targets `http://127.0.0.1:${PORT:-5178}`.

## Required workflow

Use this order for every agent mutation:

1. Read `rf workspace get --json`.
2. Build or update the candidate locally.
3. Run the local dry-run and `rf rule validate` / service validation.
4. Send the mutation with the current `revision` as `If-Match` and `ifRevision`.
5. On HTTP 409, re-read the workspace, rebuild the candidate, and retry once.
6. Run `rf wait-applied` after the browser should have reconciled the persisted revision.

Every mutation is CAS-guarded by default. `--force` is an explicit last-writer-wins override; use it only when the operator has intentionally accepted stale-write risk.

## Command reference

### Service and workspace

```bash
rf service status [--json]
rf workspace get [--json]
rf project list [--json]
```

`workspace get` exposes the persisted monotonic `revision`. `version` is only the workspace format version and is not a concurrency token.

### Agent projects

```bash
rf project up \
  --name zebra/feat-x \
  --site app.example.com \
  --dev-port 8080 \
  --asset 'https://cdn.example.com/assets/app.js => /assets/app.js' \
  --switch-group zebra \
  --enable

rf project enable zebra/feat-x
rf project disable zebra/feat-x
rf project switch zebra/feat-x
rf project down zebra/feat-x
```

`project up` resolves a stable project ID from the name, creates an `agent-managed` project subtree, validates every rule, prints the generated DNR representation, and atomically replaces the complete subtree. Omitting an old asset from a subsequent `up` removes that stale rule. `switch` enables the target and disables only enabled siblings with the same `switch-group:<name>` tag.

The CLI rejects user-owned projects for agent operations. Transfer is delete plus recreate with a new stable ID; ownership is immutable per project ID.

### Applied ACK

```bash
rf wait-applied --timeout 30s
```

The command reads the current persisted workspace revision and polls `/applied` until `appliedRevision >= revision`. Timeout output is exactly:

```text
persisted but not browser-applied
```

The ACK means local extension persistence and successful Chrome dynamic/session DNR application. It does not prove that the dev server is running, that CSP/CORS permits the request, or that page code loaded the intended asset. Reload the page and verify the actual network response separately.

### Lower-level rule escape hatches

```bash
rf rule add --project <id> --ruleset <id> --file rule.json
rf rule list [--project <id>] [--json]
rf rule validate --file rule.json
rf rule match --url <url> --method GET [--page-url <url>] [--resource-type fetch] [--json]
```

`rule match` evaluates the current workspace locally. It does not call service `/match` for a draft.

## Ownership and import rules

- `agent-managed` is an exact reserved project tag.
- A project ID cannot change ownership in v1.
- An agent-managed project owns its entire subtree: all of its rule sets and rules.
- Options Page controls render agent-managed subtrees read-only.
- Generic project/rule/rule-set CRUD and imports cannot alter agent-managed data.
- Replace import replaces only the user-owned slice; it never sends generic `merge:false`.
- Agent subtree IDs cannot collide with IDs owned by another project.
- Subtree replacement is complete and atomic; switch-group changes are one atomic mutation.

## Revision and failure handling

`WorkspaceSnapshot.revision` starts at zero and increments once per committed workspace mutation. Reads, hit logs, and applied ACKs do not increment it. `If-Match` is the HTTP equivalent of JSON `ifRevision`.

- HTTP 428: the guard is missing; add the current revision or use explicit `--force`.
- HTTP 409: the guard is stale or the mutation conflicts with ownership/IDs. Re-read and recompute once.
- HTTP 403: the operation attempted to edit reserved agent-managed ownership through a generic path.
- Failed subtree validation writes nothing.

## Browser verification

`rf wait-applied` is a DNR application heartbeat only. After it succeeds, reload the target page and inspect the browser network panel. Confirm the request used the expected local asset/API, and independently check dev-server health, CSP, CORS, and page runtime behavior.

## v1 boundaries

No dev-server lifecycle, free-port allocation, MCP wrapper, WebSocket control, or broad redesign of user-owned local-first behavior is included. Concurrent agents sharing a storage root must coordinate through revision guards; `--force` intentionally bypasses that protection.
