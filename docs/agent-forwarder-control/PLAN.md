# Agent Forwarder Control — Implementation Plan

This plan is binding to `docs/agent-forwarder-control/DESIGN.md`, especially the
`v3 — FINAL agreed spec` section. Implement in the order below; do not invent a
different consistency model. Existing line references are the source state
verified on 2026-08-26 and will move as edits land.

## 1. Prerequisites

1. From the repository root run `pnpm install` (this is a fresh worktree and
   `node_modules` is absent).
2. Read `CLAUDE.md` before editing. Use these checks during implementation:
   - all packages: `pnpm build`, `pnpm test`;
   - rule engine: `pnpm --filter @resource-forwarder/rule-core test`;
   - service: `pnpm --filter @resource-forwarder/forwarder-service test`;
   - extension: `pnpm --filter @resource-forwarder/extension-shell test`;
   - focused Vitest examples: `pnpm --filter @resource-forwarder/rule-core test -- src/index.test.ts`
     and `pnpm --filter @resource-forwarder/forwarder-service test -- src/index.test.ts`.
3. Preserve unrelated worktree changes. Before handoff run `git diff --check`.

## 2. Dependency-ordered implementation tasks

### Task 1 — Shared contracts and snapshot revision

**Files**

- Modify `packages/shared-types/src/index.ts` (current `WorkspaceSnapshot` at
  lines 174-180; service response at lines 291-293; mutation payloads at
  lines 244-258).
- Create `packages/shared-types/src/index.test.ts` for the new snapshot and
  request/response contract normalization tests.

**Changes**

- Add `revision: number` to `WorkspaceSnapshot`. Keep `version` as the format
  version (still initialized to `1` and never used for concurrency).
- Add canonical request/response types:
  - `RevisionGuard = { ifRevision?: number }` for JSON bodies;
  - `MutationResponse = { workspace: WorkspaceSnapshot; revision: number; warnings: string[] }`;
  - `WorkspaceMutationResponse`/`ServiceWorkspaceResponse` with the current
    revision exposed both as `workspace.revision` and response `revision`;
  - `SubtreePayload` containing one `project`, all of that project’s
    `ruleSets`, and all referenced `rules`, plus `ifRevision?: number`;
  - `SwitchProjectsPayload` containing `projectId`, optional `switchGroup`,
    `enabled` (or target project id/name resolved by the CLI), and
    `ifRevision?: number`;
  - `AppliedRevisionPayload { revision: number }` and
    `AppliedRevisionResponse { appliedRevision: number }`;
  - lower-level CLI request types for rule add/validate/match as needed.
- Document that `If-Match` is the HTTP equivalent of `ifRevision`; `force` is
  an explicit override and is not the default.
- Update every test fixture that constructs `WorkspaceSnapshot` to include
  `revision` (or rely on parser migration where appropriate).

**Tests**

- Add contract/parser coverage in `packages/rule-core/src/workspace.test.ts`
  (create the file if absent): legacy snapshot without `revision` hydrates to
  `revision: 0`; serialization preserves it; `version` remains `1`.

### Task 2 — Persisted monotonic revision and storage primitives

**Files**

- Modify `packages/rule-core/src/workspace.ts` (current default snapshot at
  lines 18-25 and normalization at lines 58-99).
- Modify `packages/rule-core/src/workspace-mutations.ts` (current mutations at
  lines 121-180).
- Modify `packages/forwarder-service/src/storage.ts` (current writes at
  lines 108-147 and serialized mutation at lines 231-257).
- Modify `packages/forwarder-service/src/storage.test.ts`.

**Changes**

- `createEmptyWorkspace()` returns `{ version: 1, revision: 0, ... }`.
- `assertWorkspace()` defaults missing/non-integer/negative revisions to `0`
  for migration; never derive concurrency from `version` or `updatedAt`.
- Add storage methods with concrete signatures:
  - `readWorkspace(): Promise<WorkspaceSnapshot>`;
  - `readAppliedRevision(): Promise<number>`;
  - `applyMutation(ifRevision: number | undefined, force: boolean, mutator): Promise<WorkspaceSnapshot>`;
  - `replaceProjectSubtree(projectId: string, subtree: ProjectSubtree, ifRevision: number | undefined, force: boolean): Promise<WorkspaceSnapshot>`;
  - `switchProjects(payload: SwitchProjectsPayload, ifRevision: number | undefined, force: boolean): Promise<WorkspaceSnapshot>`;
  - `deleteProject(projectId, guard): Promise<WorkspaceSnapshot>`;
  - `deleteRule(ruleId, guard): Promise<WorkspaceSnapshot>`;
  - `recordAppliedRevision(revision: number): Promise<AppliedRevisionResponse>`.
- Keep all reads and compare-and-write inside the existing `writeChain` (the
  current serialization boundary is `storage.ts:231-257`). On every actual
  workspace mutation, set `next.revision = current.revision + 1`; do not bump
  revision for reads, hit logs, or an ACK that does not advance the value.
- On a non-forced mutation, missing guard is a 428-style domain error and a
  mismatched guard is a 409 conflict carrying `currentRevision` and the current
  workspace. `force` bypasses only the compare, never validation or ownership
  checks.
- Persist `revision` in `.resource-forwarder/workspace.json` via the existing
  atomic tmp+rename path. Persist the latest ACK separately in
  `.resource-forwarder/applied-revision.json` (or an equivalent small JSON
  record) so it survives service restart; clamp ACKs to the greatest persisted
  revision and reject ACKs above the current revision.

**Tests** (`packages/forwarder-service/src/storage.test.ts`)

- `initializes revision at zero and migrates legacy workspace.json`;
- `increments revision exactly once for each serialized mutation`;
- `rejects missing ifRevision unless force is true`;
- `rejects stale ifRevision without writing and returns currentRevision`;
- `serializes concurrent CAS mutations without lost updates`;
- `persists and reloads applied revision`;
- `does not increment revision for read or ACK-only operations`.

### Task 3 — Rule-core subtree validation and atomic switch logic

**Files**

- Modify `packages/rule-core/src/workspace-mutations.ts`.
- Modify `packages/rule-core/src/index.ts` exports (currently re-exports
  mutation/matcher helpers, including `resolveRuleBinding`).
- Add `packages/rule-core/src/agent-control.ts` and
  `packages/rule-core/src/agent-control.test.ts`.

**Changes**

- Add pure helpers:
  - `isAgentManagedProject(project: Project): boolean` (exact tag
    `agent-managed`);
  - `getSwitchGroup(project: Project): string | undefined` (exact
    `switch-group:<name>` tag);
  - `validateProjectSubtree(workspace, subtree): void`;
  - `replaceProjectSubtree(workspace, subtree): WorkspaceSnapshot`;
  - `switchProjectGroup(workspace, targetProjectId, enabled): WorkspaceSnapshot`;
  - `projectSubtree(workspace, projectId): ProjectSubtree`;
  - `workspaceWithoutAgentManaged(workspace): WorkspaceSnapshot` and
    `mergeUserOwnedSlice(current, imported): WorkspaceSnapshot`.
- Validation must reject: project id mismatch; a ruleset whose `projectId`
  differs from the path project; a ruleSet id already bound to another project;
  a rule id already bound to another project; duplicate IDs; rules referenced
  by zero or more than one ruleset; cross-subtree references; and any rule not
  present in the supplied subtree. This enforces the existing exactly-one
  membership requirement in `matchers.ts:124-136`.
- `replaceProjectSubtree` removes the old project/rulesets/rules and installs
  the complete supplied subtree, preserving unrelated projects.
- `switchProjectGroup` changes the target project and only enabled siblings
  carrying the same `switch-group:<name>` tag; perform no host-wide disable.

**Tests** (`packages/rule-core/src/agent-control.test.ts`)

- accepts a valid subtree and removes stale rules on shrink;
- rejects cross-project project/ruleset/rule ID collisions;
- rejects duplicate or zero/multiple rule membership;
- preserves unrelated projects;
- switches only same-group siblings and leaves disjoint groups untouched;
- treats a project with no switch group as an independent toggle.

### Task 4 — Service endpoints, guards, and ACK

**Files**

- Modify `packages/forwarder-service/src/index.ts` (existing CRUD routes at
  lines 189-275, import at 410-419, and response construction throughout).
- Modify `packages/forwarder-service/src/storage.ts` as required by Task 2.
- Modify `packages/forwarder-service/src/index.test.ts`.
- Add `packages/forwarder-service/src/agent-control.test.ts` only if keeping
  route tests separate is clearer; otherwise extend `index.test.ts`.

**Routes and exact behavior**

1. `GET /workspace` → `ServiceWorkspaceResponse`; return one consistent
   snapshot, including `revision`.
2. `PUT /projects/:id/subtree` → `MutationResponse`; body is the complete
   subtree plus `ifRevision`; accept `If-Match` as an equivalent guard and
   `force` only through the explicit override. Validate all IDs before one
   storage transaction; replace the entire subtree atomically.
3. `POST /projects/switch` (atomic switch/batch endpoint) → `MutationResponse`;
   body names target project and optional explicit group, carries `ifRevision`;
   modify target plus same-group siblings under one `writeChain` transaction.
4. `DELETE /projects/:id` → cascade project, rulesets, and rules; guarded and
   returns `MutationResponse`.
5. `DELETE /rules/:id` → detach the rule from its ruleset and delete the rule;
   guarded and returns `MutationResponse`.
6. `POST /applied` → authenticated body `{ revision }`; only accept a revision
   `<= current workspace.revision`, store the maximum, and return
   `{ appliedRevision }`. It is not a workspace mutation.
7. `GET /applied` → authenticated `{ appliedRevision }`; this is the polling
   endpoint used by `rf wait-applied` and must never mutate workspace revision.
8. Existing generic `PUT /projects/:id`, `PUT /rules/:id`,
   `PUT /rule-sets/:id`, and `POST /import` must require the revision guard and
   reject any request that would alter an agent-managed subtree. For import,
   `merge:false` means replace only the user-owned slice; preserve every
   agent-managed subtree. Generic `merge:true` must also exclude agent-managed
   projects from incoming writes.
9. Return 409 for stale CAS, 428 for missing CAS, 403/409 for ownership
   violations, and include machine-readable `code`, `currentRevision`, and
   (for conflicts) current workspace where useful. Keep auth/host protections
   inherited from `buildServer` (`index.ts:119-137`).

**Tests** (`packages/forwarder-service/src/index.test.ts`)

- `GET /workspace returns one snapshot and revision`;
- `PUT /projects/:id/subtree atomically replaces and shrinks a subtree`;
- `PUT /projects/:id/subtree rejects path/body mismatch and cross-project IDs`;
- `all mutation routes require If-Match/ifRevision unless force`;
- `stale mutation returns 409 and leaves workspace unchanged`;
- `DELETE /projects/:id cascades`;
- `DELETE /rules/:id detaches and deletes`;
- `generic project/rule/rule-set PUT rejects agent-managed edits`;
- `POST /import preserves agent-managed subtrees for merge and replace`;
- `POST /projects/switch changes target and siblings atomically`;
- `switch rejects stale revision and never partially commits`;
- `POST /applied accepts only persisted revisions and returns max ACK`;
- auth is required for `/applied` and all mutation routes.

### Task 5 — Extension authoritative reconciliation and ACK gating

**Files**

- Modify `packages/extension-shell/src/shared/messages.ts` (runtime state and
  mutation response types).
- Modify `packages/extension-shell/src/shared/constants.ts` (persist the last
  service revision/applied state if needed).
- Modify `packages/extension-shell/src/background.ts` (sync at lines 397-464;
  commit at 353-384; generic pushes/deletes at 469-620; service helpers at
  1043-1070; DNR application at 1082-1192).
- Modify `packages/extension-shell/src/background.test.ts`.
- Modify `packages/extension-shell/src/options/main.tsx` (project save at
  lines 608-653 and all edit/delete/toggle handlers).
- Modify `packages/extension-shell/src/options/views/RulesView.tsx`,
  `ProjectModal.tsx`, `RulePanel.tsx`, `BatchRulePanel.tsx`,
  `RuleSetModal.tsx`, and `ImportExportView.tsx` only where needed to disable
  agent-managed edits and expose read-only state.
- Add `packages/extension-shell/src/agent-reconciliation.ts` and
  `agent-reconciliation.test.ts` for pure ownership/slice state transitions if
  extracting the logic keeps `background.ts` small.

**Changes**

- Pull one authoritative `GET /workspace`; stop the split `/projects` +
  `/rules` read at `background.ts:449-458`. Store the service revision locally.
- On every pull, replace local copies of agent-managed project subtrees with the
  service copy; if the service omits an agent-managed project, remove the local
  subtree. Never push those subtrees back, whether clean, dirty, pending-delete,
  or racing with a push.
- For user-owned data, retain local-first behavior. Replace-import constructs a
  candidate from only the user-owned local slice plus imported user-owned data;
  it never sends generic `merge:false` (remove the path at `background.ts:425`
  and `469-483`). Deletions call `DELETE /projects/:id` or `DELETE /rules/:id`
  with the current revision instead of full-workspace replace.
- All service mutations send `If-Match`/`ifRevision` from the last pulled
  service revision. On 409, re-pull `/workspace`, recompute the user-owned
  operation, and retry once; do not silently overwrite agent-managed data.
- The options page must detect `agent-managed` projects and render them
  read-only: no save/toggle/delete/copy/import mutation may include them. In
  particular remove the destructive `tags: []` assignment at `main.tsx:630`
  for existing projects; preserve tags when displaying a read-only project.
- `commitWorkspace` must return/propagate DNR failure instead of merely adding
  a warning. Post `/applied` with `workspace.revision` only after both
  `writeLocalWorkspace` succeeds and `applyDynamicRules` resolves successfully.
  Do not post on offline/local-only snapshots or failed persistence/DNR.
  Preserve the existing retry behavior for navigation refresh, but make the ACK
  path explicit and testable. The comment at `background.ts:353-384` must be
  updated to document the gate.
- Keep page-level verification complementary; ACK means browser DNR application,
  not proof that a dev server/CSP/CORS loaded the intended asset.

**Tests** (`packages/extension-shell/src/background.test.ts` and new pure test)

- external agent upsert wins over clean local state;
- external agent upsert wins over dirty local state;
- external agent delete sticks through pending-delete state;
- racing user push cannot resurrect an agent-deleted project/rule;
- replace import preserves agent-managed projects and never sends `merge:false`;
- delete handlers call dedicated DELETE routes;
- options refuses save/toggle/delete for agent-managed projects and preserves tags;
- ACK is posted after local persistence and successful dynamic+session DNR;
- ACK is not posted when either DNR bucket rejects (regression for swallowed
  failure at `background.ts:1155-1185`);
- ACK posts the persisted `revision`, never `workspace.version`.

### Task 6 — `rf` CLI in forwarder-service

**Files**

- Create `packages/forwarder-service/src/rf.ts` as the executable CLI entry.
- Modify `packages/forwarder-service/package.json`: add
  `"bin": { "rf": "dist/rf.js" }` and keep the existing service `dev/start`
  entrypoints.
- Modify `packages/forwarder-service/tsconfig.json` only if needed for the new
  entry (current `rootDir: src`, `include: src/**/*.ts` already includes it).
- Create `packages/forwarder-service/src/rf.test.ts`.

**CLI contract**

- Read bearer token from `<RF_STORAGE_ROOT>/token`; base URL is
  `http://127.0.0.1:${PORT:-5178}`. Use native `fetch`, no new dependency.
- `rf service status` → `/health`, print human output or `--json`.
- `rf workspace get [--json]` → `/workspace`.
- `rf project list [--json]` → `/workspace`, list project ownership, enabled
  state, switch group, and revision.
- `rf project up --name <project-name> --site <host|pattern> --dev-port <port>
  [--asset '<urlGlob> => <devPath>' ...] [--switch-group <name>] [--enable]`
  resolves a stable project id, builds one agent-managed project/ruleset/rules,
  is idempotent, performs local `rule-core` dry-run against the candidate,
  calls `POST /rules/validate` for warnings/conflicts, then reads current
  revision and atomically calls `PUT /projects/:id/subtree`. A shrunk candidate
  omits stale rules and therefore deletes them.
- `rf project enable <name>` / `disable <name>`: read workspace, reject
  user-owned projects, create a guarded subtree mutation with only `enabled`
  changed.
- `rf project switch <name>`: resolve by name, read revision, call atomic
  `POST /projects/switch`; retry after a 409 by re-reading and recomputing.
- `rf project down <name>`: resolve id and call guarded `DELETE /projects/:id`.
- `rf wait-applied [--timeout <ms|duration>]`: poll `/workspace` plus an
  applied-revision read endpoint (or the response exposed by the service) until
  `applied_revision >= written_revision`; on timeout print exactly
  `persisted but not browser-applied` and exit non-zero.
- Lower-level escapes:
  - `rf rule add --project <id> --ruleset <id> --file <json|yaml>` (build or
    validate one rule, local dry-run, guarded generic write only for user-owned
    subtree);
  - `rf rule list [--project <id>] [--json]`;
  - `rf rule validate --file <path>` → local structural checks plus
    `POST /rules/validate`;
  - `rf rule match --url <url> --method <method> [--page-url <url>]
    [--resource-type <type>] [--json]` → local `rule-core` match against the
    current workspace; do not call service `/match` for the draft path.
- Every mutating command is CAS-first. On 409 re-read `/workspace`, rebuild the
  candidate, and retry once. `--force` is the only way to bypass a missing or
  stale revision guard and must be sent explicitly.

**Tests** (`packages/forwarder-service/src/rf.test.ts`)

- parses every subcommand and required/optional argument;
- reads token and honors `PORT`/`RF_STORAGE_ROOT`;
- `project up` is idempotent;
- `project up` subtree shrink removes stale rules;
- `project switch` affects only same switch group;
- local dry-run catches a matching rule and emits `toDynamicRule` output;
- validation surfaces warnings/conflicts before commit;
- 409 causes one re-read/recompute retry;
- `--force` is the only bypass;
- `wait-applied` succeeds, times out with the required message, and uses
  revision rather than format version.

### Task 7 — Skill documentation and README

**Files**

- Create `docs/agent-forwarder-control/SKILL.md`.
- Modify `README.md` (add the agent-control section near the commands/API
  documentation, preserving existing user-facing behavior).
- Modify `README.zh-CN.md` with the same workflow in Chinese if the project
  maintains bilingual docs (it currently does).

**`SKILL.md` outline**

1. Purpose and scope: one service, multiple agent-managed projects, no MCP and
   no dev-server lifecycle management in v1.
2. Prerequisites and service/token discovery.
3. Read → local dry-run → validate → CAS mutation → wait for applied ACK.
4. Full `rf` command reference with examples for `up`, `switch`, `down`,
   `wait-applied`, and rule escape hatches.
5. Ownership rules: `agent-managed` immutable per project id; transfer is
   delete/recreate; options/import/generic CRUD cannot edit the subtree.
6. Revision/CAS rules, 409 recovery, and `--force` warning.
7. ACK semantics and complementary page-level verification.
8. Failure handling, timeout wording, and residual v1 boundaries.

**README update**

- Document `rf`, its token/base URL, the command examples, persisted
  `revision`, mandatory CAS, atomic subtree/switch semantics, and
  `wait-applied` meaning. State explicitly that page reload/dev-server checks
  remain necessary for CSP/CORS/runtime confirmation.

## 3. FIX and invariant coverage map

| Requirement | Enforcing tasks |
|---|---|
| FIX-1 persisted monotonic revision + mandatory CAS + `--force` | Tasks 1, 2, 4, 5, 6 |
| FIX-2 immutable ownership per project id | Tasks 3, 4, 5, 6 |
| FIX-3 block generic writes to agent-managed subtrees | Tasks 4, 5, 7 |
| FIX-4 no generic `merge:false`; user-owned-only replace import | Tasks 3, 4, 5, 7 |
| FIX-5 subtree ID ownership + atomic switch/batch | Tasks 3, 4, 6 |
| Invariant 1 ownership immutable | Tasks 3-6 |
| Invariant 2 marker not editable by UI/import | Tasks 4-5 |
| Invariant 3 agent-managed options read-only | Task 5 |
| Invariant 4 generic service mutations cannot alter agent subtree | Task 4 |
| Invariant 5 replace-import only user-owned entities | Tasks 3-5 |
| Invariant 6 no cross-project subtree ID collision | Tasks 3-4 |
| Invariant 7 switch-group atomic + revision guarded | Tasks 3-4, 6 |
| Invariant 8 ACK after real DNR + default CAS | Tasks 2, 4-6 |

## 4. Verification checklist and acceptance criteria

Run, in order:

1. `pnpm install`.
2. Focused rule-core, service, extension, and CLI tests listed above.
3. `pnpm build`.
4. `pnpm test`.
5. `git diff --check`.
6. Start the service with a temporary `RF_STORAGE_ROOT`; exercise `rf project
   up`, inspect `workspace.json` revision increments, run `rf project switch`,
   `rf project down`, and verify no unrelated project changes.
7. With the extension loaded, verify an external upsert/delete survives clean,
   dirty, pending-delete, and racing-push states; inspect Chrome dynamic/session
   rules; verify `/applied` advances only after both DNR buckets succeed.
8. Verify stale CAS returns 409, missing CAS returns 428, and `--force` is
   explicit and auditable.

Done means: all tests pass; every mutation is revision-guarded by default;
workspace persistence is atomic and monotonic; subtree replacement shrinks
correctly; switch is one transaction; agent-managed ownership cannot be changed
by UI/import/generic CRUD; extension never pushes or erases agent-managed data;
ACK is persisted only after successful local persistence and real DNR success;
and the documented CLI workflow is runnable from a fresh worktree.

## 5. Residual risks and decisions

- Decision: store `revision` in `workspace.json` alongside `version`, initialized
  to `0` for new/migrated snapshots; `version` remains a format number.
- Decision: use `POST /projects/switch` for the atomic switch/batch operation and
  `POST /applied` for the authenticated ACK; keep the existing `/health` route
  unchanged.
- Decision: use `src/rf.ts` as the package `rf` bin entry to avoid a second
  package or a new runtime dependency.
- Residual risk: a service restart between a successful DNR apply and `/applied`
  can delay the ACK; persisted applied state and polling make this recoverable.
- Residual risk: ACK proves DNR application only, not dev-server availability,
  CSP, CORS, or page execution; retain page-level verification.
- Residual risk: concurrent agents sharing one token/storage still need CAS
  retries; `--force` intentionally permits last-writer-wins and should be rare.
- Explicitly out of scope: dev-server process/port allocation, MCP, WebSocket,
  and broad redesign of user-owned local-first behavior.
