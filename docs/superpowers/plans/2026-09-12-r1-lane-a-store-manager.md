# R1 Lane A — store + manager — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** DRAFT — header and decisions only. Tasks 1–11 are written in the
next session (see "Task map" below for the committed shape). Do not execute
until the task sections exist.

**Goal:** Land the SDK half of R1 — the execution record with a `kind`
discriminator, source generation provenance, the post-claim read-side
guard, the direct execution arm in the manager, client-namespaced request
keys, the per-call dispatch cell, and the D5 harness — as one PR on branch
`feat/r1-lane-a`, with every §9.1 Lane A row pinned and every Lane B/C row
entered ⏳ in `INVARIANTS.md`.

**Architecture:** All changes are additive and travel through the store's
PRAGMA-then-ALTER ladder. The manager gains a sibling entry point
`startDirect` that shares persist-before-run, `claimForResume`, the
decisions seam, TTL expiry, and the settle guards with `start`/`resume`.
Authority is recomputed per call from a `ScopeResolver` the daemon will
supply in Lane B; Lane A declares the types, a pure `buildEffectiveScope`,
and a default-profile resolver. No wire change; two one-way doors (the
governed-call 404 retry is removed for Code Mode too; every new row stores
the sentinel in `code`).

**Tech Stack:** TypeScript 5.7 (strict, `exactOptionalPropertyTypes`),
libSQL/SQLite, vitest 3, Biome 2 (double quotes, width 100). Zero new
dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-r1-direct-discovery-projections-design.md`
(rev 17). Sections the plan argues from: §4 (data model), §5.4 (manager),
§5.5 (invoker + dispatch cell), §7 (ambiguity), §9.1 rows for Lane A
(#1–#3, #9, #15, #16 manager half, #17, #18 manager half, #19, #21, #22,
#24, #25, #27, #28, #41, #42, #43 catalog half, #45, #47, #50), §9.2 (D5
harness), §9.3 (G1–G3), §10 (Lane A), §11 (constants).

## Global Constraints

Copied from the spec and CLAUDE.md; every task inherits them.

- Zero new dependencies (§10). No HTTP surface.
- Every invariant lands with its test in the same commit; the
  `INVARIANTS.md` row flips in that commit (CLAUDE.md, §9.1).
- The agent never installs packages. Run binaries as
  `./packages/sdk/node_modules/.bin/vitest` and `.../tsc`; never `npx`.
- Test names for invariants carry the `INVARIANT §x.y:` prefix.
- Manager and upstream suites bind loopback sockets and need the
  unsandboxed path (`listen EPERM` under the Bash-tool sandbox); the
  pre-commit hook run is authoritative.
- Constants (§11; values are recommendations, the bounds are pinned):
  `DIRECT_DRIVE_BUDGET_MS = 60_000`, `SETTLE_WRITE_BUDGET_MS = 5_000`,
  `DIRECT_SLOT_RETENTION_MS = 30_000`, `RESULT_BYTES_MAX = 262_144`
  (256 KiB, measured as `Buffer.byteLength(JSON.stringify(deliverable), "utf8")`).
  Daemon-side constants (`DIRECT_ADMISSION_MAX`, listing/advertise bounds)
  are Lane B.
- Sentinel program for every new row's `code` column (§4.1), verbatim:
  `throw new Error("conduit: row written by a newer build")`.
- Error names introduced (all host-side; guest-safe vocabulary unchanged):
  `ConduitCatalogChanged`, `ConduitScopeRevoked`, `ConduitOutcomeAmbiguous`
  (same string the crash sweep already uses).
- Error message format: `[Module] Operation failed: reason. Context: {…}`.
- Commits: Conventional Commits, no AI attribution. Branch from
  `origin/main`: `git switch -c feat/r1-lane-a origin/main`.
- Load-bearing PR: full gauntlet + `/explain-diff` explainer + quiz before
  any merge talk; the quiz covers the two one-way doors.

## Decisions the plan makes (tweakable — lead with what changes most)

Read these first; each is a degree of freedom the spec left to the plan.
Change one here and the affected tasks follow.

- **D-A1 `Execution` becomes a discriminated union with REQUIRED `kind`,
  `clientId`, `projection`.** Every test fixture that builds an `Execution`
  literal gains `kind: "code", clientId: null, projection: "code"`. Each
  test file gets a small `codeRow()` helper to absorb the churn. Alternative
  rejected: optional fields with defaults — they would let a caller omit
  attribution and defeat the §4.3 write-once audit rule.
- **D-A2 `startDirect` returns a handle, not a bare promise.**
  `DirectDriveHandle = { executionId, outcome, retention, finished }`:
  `outcome` resolves within the drive budget plus the settle-write budget
  (the client-visible promise; may resolve `{ status: "unknown", reason:
  "persist-timeout" }`); `retention` resolves `"released"` when the
  continuation finishes within `DIRECT_SLOT_RETENTION_MS` of settle, else
  `"abandoned"`; `finished` resolves only when the continuation and any
  tracked settle write have actually stopped. Lane B holds the admission
  slot on `retention` and counts an abandoned drive in quarantine until
  `finished`. This is the spec's two-promise model (§5.3) made explicit.
- **D-A3 `scope` is OPTIONAL on `start` and `resume` in Lane A.** Absent
  means the default profile: `code` on, `direct`/`discovery` off, allow
  ALL. Lane B makes the daemon pass a resolver on every call. Consequence:
  a direct row resumed without a resolver fails `ConduitScopeRevoked`
  (fail closed).
- **D-A4 Post-dispatch classification happens at the invoker's outermost
  catch by READING the per-call dispatch cell, and again by the manager's
  direct arm at settle.** The cell (not an error field) survives error
  replacement; the manager's timer consults the same cell.
- **D-A5 The 404 session-expiry retry stays for `initialize` and
  `tools/list`; `callTool` bypasses `withSessionExpiryRetry` entirely.**
  Existing ledger rows for the retry are reworded to "side-effect-free
  operations only" and their tests move to `listTools`.
- **D-A6 The scoped tool host lives in `execute.ts`
  (`createScopedCatalogToolHost`) and its filter-before-rank pin lives in
  `execute.test.ts`, not `catalog.test.ts` as row #43 names.** The
  `Catalog` interface gains no `list()`; the host asks the catalog for an
  unbounded ranked result, filters by `permits`, then slices to the limit.
- **D-A7 A Code Mode pause whose namespace has no `sources` row cannot be
  provenance-stamped and terminalizes `failed` with
  `ConduitCatalogChanged`** (the call did not run). Never a pause without
  both provenance fields.
- **D-A8 Budgets are injectable.** `ExecutionManagerDeps.direct?:
  Partial<DirectBudgets>` overrides the four constants for tests.
- **D-A9 `executions.create()` is a new store method** (plain INSERT plus
  the `request_keys` row for a named client, one batch); `put()` stays the
  settle upsert and never touches `request_keys`.
- **D-A10 The `profiles` table and `ProfileRepository` land in Lane A** (pure
  store code, §4.2) so Lane B touches no store file. No daemon consumer yet.
- **D-A11 The `status: "unknown"` outcome exists only on the
  `DirectDriveHandle.outcome` promise.** `resume()` keeps its `ResumeOutcome`
  type; on the direct resume path the manager awaits the handle's `outcome`
  and, if it is `unknown`, returns `failed` with error name
  `ConduitPersistTimeout` and `decisionApplied` as recorded — flagged here
  as a Lane B wire decision (the payload status vocabulary and the CLI verb
  rendering must grow the arm before a resume can honestly say "unknown").
  This is the one place Lane A knowingly under-delivers row #45's wording;
  the pin for the `startDirect` path is complete.

## File structure

New files:
- `packages/sdk/src/scope.ts` — `Projection`, `EffectiveScope`,
  `ScopeResolver`, `ALL_TOOLS`, `DEFAULT_PROFILE_GRANT`, `namespaceOf`,
  `buildEffectiveScope`, `defaultScopeResolver`.
- `packages/sdk/src/scope.test.ts` — rows #8, #9 unit.
- `packages/sdk/src/pipeline/dispatch.ts` — `DispatchCell`, `createDispatchCell`.
- `packages/sdk/src/execution/direct.ts` — `DirectBudgets`, `DIRECT_DEFAULTS`,
  `DirectDrive`, `DirectDriveHandle`, `DirectOutcome`, `createDirectDrive`.
- `packages/sdk/src/execution/projection-harness.test.ts` — D5 harness (§9.2).

Modified files:
- `packages/sdk/src/types.ts` — union `Execution`, `PendingApproval` +
  provenance, `LegacyPendingApproval`, `StoredPendingApproval`,
  `isPendingApproval` extension, `hasProvenance`, `TraceEvent` +
  `projection`/`clientId`, `Source.generation`, `NEWER_BUILD_SENTINEL`.
- `packages/sdk/src/store/store.ts` — `create`, `getByRequestKey(key,
  clientId)`, `settleDirect`, `invalidatePaused`, `sources.getGeneration`,
  `provisionSource` returns `{ generation }`, `ProfileRepository`.
- `packages/sdk/src/store/sqlite.ts` — DDL, ladder, triggers, hydration
  guards, request keys, profiles.
- `packages/sdk/src/pipeline/errors.ts` — `ConduitOutcomeAmbiguous` class.
- `packages/sdk/src/pipeline/mcp-client.ts` — `beforeSend` hook; `callTool`
  without the 404 retry.
- `packages/sdk/src/pipeline/upstream.ts` — `UpstreamRequest.dispatch`.
- `packages/sdk/src/pipeline/invoker.ts` — `projection`, `clientId`,
  `scope`, `dispatch` options; scope check; ambiguity classification;
  deadline gate before credentials.
- `packages/sdk/src/execute.ts` — `createScopedCatalogToolHost`.
- `packages/sdk/src/execution/manager.ts` — `start` options, `startDirect`,
  `resume` guard steps 2–4, direct resume arm, provenance capture.
- `packages/sdk/src/index.ts` — exports.
- `packages/mcp/src/runtime.ts` — thread `projection`/`clientId`/`scope`/
  `dispatch` into `createToolInvoker`; scoped host.
- `packages/mcp/src/daemon/connection.ts` — no behaviour change; compile
  against the new `start`/`resume` signatures (D-A3 keeps them compatible).
- `INVARIANTS.md` — Lane A rows ✅, Lane B/C rows ⏳, G1/G2 renames,
  §18-C4 retry rows reworded.
- Tests: `sqlite.test.ts`, `manager.test.ts`, `invoker.test.ts`,
  `upstream.test.ts`, `mcp-client.test.ts`, `execute.test.ts`,
  `types.test.ts` (new cases), `packages/mcp/src/server.test.ts` (G1 rename).

## Task map (to be expanded into full TDD steps)

| # | Task | Rows pinned | Files |
| --- | --- | --- | --- |
| 1 | Types + scope module | #8, #9 (unit), validator branches of #50 | types.ts, scope.ts, scope.test.ts, types.test.ts |
| 2 | Store: execution columns, sentinel/program hydration, kind + result_state guards, `create`, attempt-fenced `settleDirect`, `invalidatePaused`, trace columns | #19, #22 (store half), #41 (store half), request round-trip pin, kind-guard pin, crash-sweep-over-direct-row pin | store.ts, sqlite.ts, sqlite.test.ts |
| 3 | Store: `request_keys` table + per-client lookups | #25 (store half) | store.ts, sqlite.ts, sqlite.test.ts |
| 4 | Store: source generation column, ledger table, three triggers, `getGeneration`, `provisionSource` read-back; `profiles` table + repository | #47 | store.ts, sqlite.ts, sqlite.test.ts |
| 5 | Dispatch cell; MCP client `beforeSend` + 404 retry removed for `tools/call`; upstream wiring | #21 (client half), #24 (write-boundary half) | dispatch.ts, mcp-client.ts, upstream.ts, errors.ts, their tests |
| 6 | Invoker: scope check, attribution, per-call cell, ambiguity classification, deadline gate before credentials | #24 (invoker half), #27 (invoker half), scope-block pin | invoker.ts, invoker.test.ts |
| 7 | Scoped catalog tool host | #43 (catalog half) | execute.ts, execute.test.ts |
| 8 | Manager `start`: attribution, `create`, provenance capture on pause, scope threading, Code Mode ambiguity terminal signal | #15 (start half), #16 (running-program half), #21/#24 (Code Mode side), #25 (manager half), #18 (manager half) | manager.ts, manager.test.ts, runtime.ts |
| 9 | Manager `resume` guard steps 2–4 (both kinds) + legacy branch | #14, #15, #16 (resume half), #17, #42, #50 (one test per disposition row) | manager.ts, manager.test.ts |
| 10 | Manager direct arm: `DirectDrive`, `startDirect`, direct resume, result states + `RESULT_BYTES_MAX`, latch/fence/retention | #1, #2 (manager side), #3, #22, #28, #41 (manager half), #45 | direct.ts, manager.ts, manager.test.ts |
| 11 | D5 harness; ledger (Lane A ✅, Lane B/C ⏳, G1–G3, retry rows reworded); exports; runtime compile | #2, #10, #11, #27, #42 (harness) | projection-harness.test.ts, INVARIANTS.md, index.ts, server.test.ts, sqlite.test.ts |

Order is buildable as listed: each task compiles and passes on its own.
Tasks 2–4 may be executed by one worker in sequence; tasks 5–7 are
independent of each other once task 1 lands.

## Deviations log

Kept in the session scratchpad during execution; summarized under
"Deviations" in the PR description. Seed entries: D-A6 (row #43 test file),
D-A11 (row #45 resume-path wording).
