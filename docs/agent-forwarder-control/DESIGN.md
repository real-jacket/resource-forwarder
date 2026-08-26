# Design: Agent-facing rule control for Resource Forwarder
Status: v3 — FINAL agreed spec.
## v3 — FINAL agreed spec (review closed: APPROVE-WITH-CHANGES accepted in full)

Round-2 closing review reached consensus. The following 5 must-fixes are accepted as binding
invariants and supersede any looser wording above. Reviewer + orchestrator agree; this is the spec
the implementation plan must satisfy.

### FIX-1 — Real persisted revision + mandatory CAS
`workspace.version` is a schema/format version (initialized to 1, never incremented:
`rule-core/src/workspace.ts:18`, `workspace-mutations.ts:169`) — it CANNOT be used for concurrency.
- Add a separate **persisted monotonic `revision`** (integer), incremented on every mutation.
- `GET /workspace` and every mutation response return the current `revision`.
- Mutations take an `ifRevision` (If-Match) guard — **mandatory by default**, with an explicit
  `--force` override in the CLI. On 409, the CLI re-reads and recomputes.
- `writeChain` serializes handlers but cannot detect stale client decisions
  (`storage.ts:231`) — the revision guard is what provides that.

### FIX-2 — Ownership immutable per project ID (v1)
- `agent-managed` is a **reserved** marker set only at agent-driven creation; ownership is
  **immutable** for a project ID in v1. Transfer = delete + recreate under a new ID.
- Closes the user-owned→agent-managed race where a dirty extension pushes a stale tag after the
  service marks the project agent-managed (`background.ts:418`). No live transfer path in v1.

### FIX-3 — Block generic writes to agent-managed subtrees
- Options page: agent-managed subtrees are **read-only** in the UI (today saving writes `tags:[]`
  destructively: `options/main.tsx:620`, pushed via generic project PUT `background.ts:487`).
- Service: generic `PUT /projects/:id`, `PUT /rules/:id`, `PUT /rule-sets/:id` and `POST /import`
  **reject** any write that would alter an agent-managed subtree (protects against stale workers /
  older extension builds). Agent-managed subtrees are mutated only via the dedicated subtree/switch
  endpoints.

### FIX-4 — No generic `merge:false`; replace-import preserves agent subtrees
- The extension must **never** issue a generic service `merge:false` (today it forwards the replace
  payload unchanged: `background.ts:469`; replace erases omitted entities: `storage.ts:140`).
- "Replace import" must mean **replace the user-owned slice only**, preserving all service-owned
  (agent-managed) subtrees. Deletions use the new DELETE routes, not replace.

### FIX-5 — Subtree ID ownership + atomic switch
- Rule IDs are global and a valid binding requires membership in exactly one RuleSet
  (`matchers.ts:124`). `PUT /projects/:id/subtree` must **reject** ruleSet/rule IDs already owned by
  another project and reject cross-subtree references.
- `switch` modifies the target **and** its siblings, so it is **not** atomic via subtree-apply
  alone. Add one **service-side atomic switch/batch mutation** executed under a single storage
  transaction (same `writeChain`), guarded by `ifRevision`.

### ACK heartbeat — accepted for v1 (semantics fixed)
- Extension POSTs the new **`revision`** (not `workspace.version`) to a **dedicated authenticated
  endpoint** (e.g. `POST /applied`), **only after** local persistence AND successful DNR
  application. Note `commitWorkspace` currently swallows DNR failures and returns normally
  (`background.ts:353`) — the ACK post must be gated on real DNR success.
- `rf wait-applied [--timeout]` polls until `applied_revision >= written_revision`; on timeout it
  reports **"persisted but not browser-applied"**.
- Page-level verification (agent reloads page, confirms asset served from localhost) remains
  complementary — it proves CSP/CORS/dev-server actually loaded the intended asset.

### Consolidated invariants (must hold)
1. Ownership immutable per project ID in v1.
2. `agent-managed` not editable by ordinary UI/import operations.
3. Agent-managed subtrees read-only in options.
4. Generic service mutations cannot alter an agent-managed subtree.
5. Replace-import operates only on user-owned entities.
6. Subtree IDs cannot collide across projects.
7. Switch-group changes happen in one atomic, revision-guarded service mutation.
8. ACK posted only after real DNR application; CAS mandatory by default.
