# R1 Lane A — store + manager — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** COMPLETE — header, decisions, and Tasks 1–11 with TDD steps.
Ready for execution once the founder picks subagent-driven or inline.

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

---

### Task 1: Types + scope module

**Files:**
- Modify: `packages/sdk/src/types.ts`
- Create: `packages/sdk/src/scope.ts`
- Create: `packages/sdk/src/scope.test.ts`
- Create: `packages/sdk/src/types.test.ts`
- Modify: `packages/sdk/src/index.ts` (exports)

**Interfaces:**
- Consumes: nothing new.
- Produces (every later task imports these by name):
  - `Projection = "code" | "direct" | "discovery"`, `PROJECTIONS`
  - `ExecutionKind = "code" | "direct"`, `ResultState = "delivered" | "retained" | "discarded"`
  - `NEWER_BUILD_SENTINEL: string`
  - `Execution` (union), `DirectCall`, `ExecutionBase`
  - `PendingApproval` (with `namespace`, `sourceGeneration`), `LegacyPendingApproval`, `StoredPendingApproval`
  - `isPendingApproval(value): value is StoredPendingApproval`, `hasProvenance(p): p is PendingApproval`
  - `TraceEvent.projection: Projection`, `TraceEvent.clientId: string | null`
  - `Source.generation?: number` (populated on read, ignored on write)
  - `scope.ts`: `ALL_TOOLS`, `ScopeGrant`, `EffectiveScope`, `ScopeResolver`, `DEFAULT_PROFILE_GRANT`, `namespaceOf`, `buildEffectiveScope`, `defaultScopeResolver`

Note: this task changes types that every existing `Execution` literal and
`TraceEvent` literal must satisfy. Typecheck WILL fail after step 3 until
Tasks 2 and 6 update the store and invoker. That is expected; the task's
own tests compile because they only touch the new modules. Do not "fix"
the store here.

- [ ] **Step 1: Write the failing scope tests**

```ts
// packages/sdk/src/scope.test.ts
import { describe, expect, it } from "vitest";
import {
  ALL_TOOLS,
  buildEffectiveScope,
  DEFAULT_PROFILE_GRANT,
  namespaceOf,
} from "./scope.js";
import type { Tool } from "./types.js";

function tool(name: string): Tool {
  return {
    name,
    namespace: name.slice(0, name.indexOf(".")),
    inputSchema: { type: "object" },
    outputSchema: {},
    riskClass: "safe",
    sourceSemantics: { kind: "mcp" },
  };
}

const catalog = [tool("github.issues.list"), tool("github.repos.delete"), tool("slack.post")];

describe("namespaceOf (§8.3 grammar)", () => {
  it("returns the text before the first dot", () => {
    expect(namespaceOf("github.issues.list")).toBe("github");
    expect(namespaceOf("a-.b")).toBe("a-");
  });
  it("returns undefined for a name with no dot (not a qualified name)", () => {
    expect(namespaceOf("execute")).toBeUndefined();
  });
});

describe("buildEffectiveScope (§5.2)", () => {
  it("INVARIANT §5.2: the default profile permits every catalog tool on code and nothing on direct/discovery", () => {
    const scope = buildEffectiveScope(DEFAULT_PROFILE_GRANT, catalog);
    expect(scope.permits("code", "github.issues.list")).toBe(true);
    expect(scope.permits("direct", "github.issues.list")).toBe(false);
    expect(scope.permits("discovery", "github.issues.list")).toBe(false);
    expect(scope.listing.map((t) => t.name)).toEqual(catalog.map((t) => t.name));
  });

  it("INVARIANT §5.2 (#9): a profile only narrows — listing is catalog ∩ allow, never wider than allow", () => {
    const scope = buildEffectiveScope(
      { projections: { code: true, direct: true, discovery: true }, allow: ["slack", "github.issues.list", "ghost.tool"] },
      catalog,
    );
    expect(scope.listing.map((t) => t.name).sort()).toEqual(["github.issues.list", "slack.post"]);
    expect(scope.permits("direct", "ghost.tool")).toBe(false); // granted but not in catalog
    expect(scope.permits("direct", "github.repos.delete")).toBe(false); // in catalog, not granted
  });

  it("INVARIANT §5.2 (#8): a namespace entry grows with its namespace; a tool-level entry does not", () => {
    const grant = { projections: { code: true, direct: true, discovery: false }, allow: ["slack", "github.issues.list"] };
    const grown = [...catalog, tool("slack.delete_channel"), tool("github.issues.create")];
    const scope = buildEffectiveScope(grant, grown);
    expect(scope.permits("direct", "slack.delete_channel")).toBe(true);
    expect(scope.permits("direct", "github.issues.create")).toBe(false);
  });

  it("INVARIANT §5.2 (#16): a projection flag turned off revokes exactly as removing the grant does", () => {
    const scope = buildEffectiveScope(
      { projections: { code: false, direct: true, discovery: false }, allow: ALL_TOOLS },
      catalog,
    );
    expect(scope.permits("code", "github.issues.list")).toBe(false);
    expect(scope.permits("direct", "github.issues.list")).toBe(true);
  });

  it("a snapshot is immutable: later catalog changes do not change permits", () => {
    const live = [...catalog];
    const scope = buildEffectiveScope(DEFAULT_PROFILE_GRANT, live);
    live.push(tool("late.tool"));
    expect(scope.permits("code", "late.tool")).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing validator tests**

```ts
// packages/sdk/src/types.test.ts
import { describe, expect, it } from "vitest";
import { hasProvenance, isPendingApproval, type StoredPendingApproval } from "./types.js";

const base = { callId: "c1", toolName: "github.issues.list", input: {}, reason: "r", expiresAt: 9e12 };

describe("isPendingApproval (§4.1, one validator; row #50 branches)", () => {
  it("accepts the R1 shape: both provenance fields present and typed", () => {
    const v: unknown = { ...base, namespace: "github", sourceGeneration: 7 };
    expect(isPendingApproval(v)).toBe(true);
    if (isPendingApproval(v)) expect(hasProvenance(v)).toBe(true);
  });
  it("accepts the legacy shape: both provenance fields absent", () => {
    expect(isPendingApproval(base)).toBe(true);
    if (isPendingApproval(base)) expect(hasProvenance(base)).toBe(false);
  });
  it.each([
    ["namespace present, sourceGeneration absent", { ...base, namespace: "github" }],
    ["sourceGeneration present, namespace absent", { ...base, sourceGeneration: 7 }],
    ["namespace not text", { ...base, namespace: 3, sourceGeneration: 7 }],
    ["sourceGeneration not finite", { ...base, namespace: "github", sourceGeneration: Number.NaN }],
    ["sourceGeneration a string", { ...base, namespace: "github", sourceGeneration: "7" }],
  ])("rejects a half-present or mistyped provenance pair: %s", (_label, v) => {
    expect(isPendingApproval(v)).toBe(false);
  });
  it("still rejects the shipped corrupt shapes", () => {
    expect(isPendingApproval({ ...base, callId: " " })).toBe(false);
    expect(isPendingApproval({ ...base, expiresAt: "soon" })).toBe(false);
    expect(isPendingApproval(null)).toBe(false);
  });
  it("compile-time: the legacy arm has no namespace to read", () => {
    const stored: StoredPendingApproval = base;
    // @ts-expect-error — namespace exists only on the provenance arm
    const _ns: string = stored.namespace;
    expect(hasProvenance(stored) ? stored.namespace : "legacy").toBe("legacy");
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk src/scope.test.ts src/types.test.ts`
Expected: FAIL — `./scope.js` cannot be resolved; `hasProvenance` is not exported.

- [ ] **Step 4: Edit `types.ts`**

Replace the `Execution`, `PendingApproval`, `isPendingApproval`, and
`TraceEvent` blocks, and add the new declarations. Keep every existing doc
comment that still applies.

```ts
// add after SourceType
export type Projection = "code" | "direct" | "discovery";
export const PROJECTIONS: readonly Projection[] = ["code", "direct", "discovery"];
export type ExecutionKind = "code" | "direct";
export type ResultState = "delivered" | "retained" | "discarded";

/**
 * §4.1: every row written by this build stores this program in `code`
 * (the real program moves to `program`). An OLDER build ignores the new
 * columns, reads `code`, and fails the row closed instead of resuming a
 * direct row as an empty program or a narrowed code row under the
 * unscoped invoker. Verbatim; the string is part of the downgrade contract.
 */
export const NEWER_BUILD_SENTINEL = 'throw new Error("conduit: row written by a newer build")';
```

```ts
// Source gains generation (read-side; §4.1a)
export interface Source {
  id: string;
  type: SourceType;
  namespace: string;
  location: string;
  baseUrl?: string;
  /** §4.1a provenance, allocated by SQLite triggers. Populated on every
   * read; ignored on write (the database owns it). */
  generation?: number;
}
```

```ts
export interface ExecutionBase {
  /** `exec_...` */
  id: string;
  status: ExecutionStatus;
  /**
   * The UNION, never bare `PendingApproval`: the hydrator casts parsed JSON
   * without validating; readers narrow through `isPendingApproval`, then
   * `hasProvenance` for the legacy arm (§4.1, rev 13).
   */
  pausedOn?: StoredPendingApproval;
  startedAt: number;
  endedAt?: number;
  /** Caller-generated correlation key (mcp design M1). Default profile: the
   * legacy column. Named client: the `request_keys` row (§4.1). */
  requestKey?: string;
  /** null = default profile (§4.1). Written for BOTH kinds at start. */
  clientId: string | null;
  /** Which profile FLAG this execution runs under; re-checked on every call. */
  projection: Projection;
  result?: unknown;
  error?: ExecutionError;
}

/** A direct row's stored canonical call. Provenance does NOT live here. */
export interface DirectCall {
  toolName: string;
  namespace: string;
  /** `JSON.stringify(input)` as the invoker computes it — the decisions-seam identity. */
  request: string;
}

export type Execution =
  | (ExecutionBase & {
      kind: "code";
      code: string;
      /** Recorded non-determinism, replayed verbatim on resume (spec §5.5). */
      seeds: { now: number; random: number };
    })
  | (ExecutionBase & {
      kind: "direct";
      call: DirectCall;
      /** Set iff status is `completed` (§4.1 status table, rev 16). */
      resultState?: ResultState;
    });

/** A call waiting on a human (spec §10.2), as written by R1: provenance included (§4.1). */
export interface PendingApproval {
  callId: string;
  toolName: string;
  namespace: string;
  sourceGeneration: number;
  input: unknown;
  reason: string;
  expiresAt: number;
}

/** A pause written before R1: NO provenance. Resume fails it closed (§5.4 step 3). */
export type LegacyPendingApproval = Omit<PendingApproval, "namespace" | "sourceGeneration">;

export type StoredPendingApproval = PendingApproval | LegacyPendingApproval;

export function hasProvenance(pause: StoredPendingApproval): pause is PendingApproval {
  return "sourceGeneration" in pause;
}
```

`isPendingApproval` becomes:

```ts
export function isPendingApproval(value: unknown): value is StoredPendingApproval {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const baseOk =
    typeof v.callId === "string" &&
    !NOT_NAMEABLE_CALL_ID.test(v.callId) &&
    typeof v.toolName === "string" &&
    "input" in v &&
    typeof v.reason === "string" &&
    typeof v.expiresAt === "number" &&
    Number.isFinite(v.expiresAt);
  if (!baseOk) return false;
  const hasNamespace = "namespace" in v;
  const hasGeneration = "sourceGeneration" in v;
  if (!hasNamespace && !hasGeneration) return true; // legacy arm
  return (
    hasNamespace &&
    hasGeneration &&
    typeof v.namespace === "string" &&
    typeof v.sourceGeneration === "number" &&
    Number.isFinite(v.sourceGeneration)
  );
}
```

`TraceEvent` gains, after `connectionPrefix`:

```ts
  /** §4.3 (D4): attribution lands at append time; audit rows are write-once. */
  projection: Projection;
  clientId: string | null;
```

- [ ] **Step 5: Create `scope.ts`**

```ts
import type { ConduitStore } from "./store/store.js";
import type { Projection, Tool } from "./types.js";

/** The default profile's allowlist: the full current catalog (§4.2). Not a legal namespace. */
export const ALL_TOOLS = "*" as const;

export interface ScopeGrant {
  projections: { code: boolean; direct: boolean; discovery: boolean };
  /** Namespaces or qualified tool names (A2), or `ALL_TOOLS`. */
  allow: readonly string[] | typeof ALL_TOOLS;
}

/** An IMMUTABLE snapshot: one grant + one tool-name set, read together (§5.2). */
export interface EffectiveScope {
  projections: ScopeGrant["projections"];
  /** True iff the projection flag is on AND the tool is in catalog ∩ allow. */
  permits: (projection: Projection, qualifiedName: string) => boolean;
  /** catalog ∩ allow at snapshot time. */
  listing: Tool[];
}

/**
 * Async because profile and tool reads are store reads. Rejects → the call
 * fails as infra (fail closed). A missing profile row for a named client
 * → every flag false and an empty listing (fail closed, never the default).
 * The daemon implements it in Lane B; Lane A declares it and ships the
 * default-profile resolver.
 */
export type ScopeResolver = (clientId: string | null) => Promise<EffectiveScope>;

export const DEFAULT_PROFILE_GRANT: ScopeGrant = {
  projections: { code: true, direct: false, discovery: false },
  allow: ALL_TOOLS,
};

/** §8.3 grammar: `namespace.local`; the namespace alphabet has no dot. */
export function namespaceOf(qualifiedName: string): string | undefined {
  const dot = qualifiedName.indexOf(".");
  return dot <= 0 ? undefined : qualifiedName.slice(0, dot);
}

export function buildEffectiveScope(grant: ScopeGrant, tools: readonly Tool[]): EffectiveScope {
  const inCatalog = new Set(tools.map((t) => t.name));
  const allow = grant.allow === ALL_TOOLS ? ALL_TOOLS : new Set(grant.allow);
  const granted = (name: string): boolean =>
    allow === ALL_TOOLS ||
    allow.has(name) ||
    (() => {
      const ns = namespaceOf(name);
      return ns !== undefined && allow.has(ns);
    })();
  const projections = { ...grant.projections };
  return {
    projections,
    permits: (projection, name) => projections[projection] && inCatalog.has(name) && granted(name),
    listing: tools.filter((t) => granted(t.name)),
  };
}

/** The default profile, read fresh from the store on every call (D-A3). */
export function defaultScopeResolver(store: Pick<ConduitStore, "tools">): ScopeResolver {
  return async () => buildEffectiveScope(DEFAULT_PROFILE_GRANT, await store.tools.list());
}
```

- [ ] **Step 6: Export from `index.ts`**

Add to the `./types.js` export list: `Projection`, `ExecutionKind`,
`ResultState`, `ExecutionBase`, `DirectCall`, `LegacyPendingApproval`,
`StoredPendingApproval` (types) and `hasProvenance`, `NEWER_BUILD_SENTINEL`,
`PROJECTIONS` (values). Add:

```ts
export type { EffectiveScope, ScopeGrant, ScopeResolver } from "./scope.js";
export { ALL_TOOLS, buildEffectiveScope, DEFAULT_PROFILE_GRANT, defaultScopeResolver, namespaceOf } from "./scope.js";
```

- [ ] **Step 7: Run the two test files**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk src/scope.test.ts src/types.test.ts`
Expected: PASS (all cases). Full typecheck is expected to FAIL on store and
invoker literals until Tasks 2 and 6; do not commit yet if the pre-commit
hook runs typecheck — instead commit Task 1 together with Task 2 (see Task
2 step 9), OR commit with `git commit` after Task 2's store changes land.

- [ ] **Step 8: Commit (deferred)**

Commit lands at the end of Task 2 as one commit:
`feat(sdk): execution kind, provenance, and scope types` — because the
pre-commit hook typechecks the whole package.

---

### Task 2: Store — execution columns, sentinel/program, guards, `create`, fenced settle, sweep, trace columns

**Files:**
- Modify: `packages/sdk/src/store/store.ts`
- Modify: `packages/sdk/src/store/sqlite.ts` (SCHEMA, ladder, `executions`, `trace`, `hydrateExecutionRow`, `rowToTraceEvent`)
- Modify: `packages/sdk/src/store/sqlite.test.ts`
- Modify: every test file that builds an `Execution` or `TraceEvent` literal (mechanical, step 8)

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `ExecutionRepository.create(execution: Execution, opts?: { attempt?: string }): Promise<void>` — plain INSERT; throws on duplicate id or duplicate request key.
  - `ExecutionRepository.put(execution: Execution): Promise<void>` — settle upsert, unchanged contract, never touches `request_keys`, never touches `resume_attempt`.
  - `ExecutionRepository.settleDirect(id: string, attempt: string, settle: DirectSettle): Promise<boolean>` — fenced `WHERE status='running' AND resume_attempt=?`; true iff one row changed.
  - `type DirectSettle = { status: "completed"; resultState: "delivered" | "discarded" } | { status: "completed"; resultState: "retained"; result: unknown } | { status: "failed"; error: ExecutionError } | { status: "paused"; pausedOn: PendingApproval }`
  - `ExecutionRepository.invalidatePaused(namespace: string): Promise<number>`
  - `ExecutionRepository.getByRequestKey(key: string, clientId: string | null)` — signature widened here; the named-client lookup body lands in Task 3 (this task: `clientId !== null` → return `undefined`).

- [ ] **Step 1: Write the failing store tests** (append inside `describe("executions")` in `sqlite.test.ts`; add a `codeRow` helper at file top)

```ts
function codeRow(overrides: Partial<Extract<Execution, { kind: "code" }>> & { id: string }): Execution {
  return {
    kind: "code",
    code: "return 1",
    status: "running",
    seeds: { now: 0, random: 0 },
    startedAt: 0,
    clientId: null,
    projection: "code",
    ...overrides,
  };
}
function directRow(overrides: Partial<Extract<Execution, { kind: "direct" }>> & { id: string }): Execution {
  return {
    kind: "direct",
    call: { toolName: "github.issues.list", namespace: "github", request: "{}" },
    status: "running",
    startedAt: 0,
    clientId: null,
    projection: "direct",
    ...overrides,
  };
}
```

```ts
it("INVARIANT §4.1 (#19): every new row stores the sentinel in `code` and the program in `program`; hydration reads `program`", async () => {
  await store.executions.create(codeRow({ id: "e_new", code: "return 42" }));
  const raw = await client.execute({ sql: "SELECT code, program, kind, seeds FROM executions WHERE id = ?", args: ["e_new"] });
  expect(raw.rows[0]?.code).toBe(NEWER_BUILD_SENTINEL);
  expect(raw.rows[0]?.program).toBe("return 42");
  const back = await store.executions.get("e_new");
  expect(back?.kind === "code" && back.code).toBe("return 42");
});

it("INVARIANT §4.1 (#19): an OLDER hydrator (reads `code` only) sees the sentinel for both kinds", async () => {
  await store.executions.create(codeRow({ id: "e_c" }));
  await store.executions.create(directRow({ id: "e_d" }));
  const legacyView = await client.execute("SELECT id, code FROM executions ORDER BY id");
  expect(legacyView.rows.map((r) => r.code)).toEqual([NEWER_BUILD_SENTINEL, NEWER_BUILD_SENTINEL]);
  const direct = await client.execute({ sql: "SELECT program, seeds FROM executions WHERE id = ?", args: ["e_d"] });
  expect(direct.rows[0]?.program).toBeNull();
  expect(direct.rows[0]?.seeds).toBe("{}");
});

it("a legacy row (program NULL, kind defaulted) hydrates its program from `code` as today", async () => {
  await client.execute({
    sql: "INSERT INTO executions (id, code, status, seeds, started_at) VALUES (?, ?, 'completed', '{\"now\":1,\"random\":0.5}', 1)",
    args: ["e_old", "return 'old'"],
  });
  const row = await store.executions.get("e_old");
  expect(row?.kind).toBe("code");
  expect(row?.kind === "code" && row.code).toBe("return 'old'");
  expect(row?.clientId).toBeNull();
  expect(row?.projection).toBe("code");
});

it("INVARIANT §4.1: the read-side kind guard refuses a row whose kind and direct_call disagree", async () => {
  await client.execute("INSERT INTO executions (id, code, status, seeds, started_at, kind, projection) VALUES ('bad1', 'x', 'running', '{}', 0, 'direct', 'direct')");
  await expect(store.executions.get("bad1")).rejects.toThrow(/kind = 'direct' requires direct_call/);
  await client.execute("INSERT INTO executions (id, code, status, seeds, started_at, kind, projection, direct_call) VALUES ('bad2', 'x', 'running', '{}', 0, 'code', 'code', '{}')");
  await expect(store.executions.get("bad2")).rejects.toThrow(/kind = 'code' forbids direct_call/);
});

it("INVARIANT §4.1 (#41): a completed direct row needs a consistent result_state/result pair", async () => {
  const insert = (id: string, resultState: string | null, result: string | null) =>
    client.execute({
      sql: `INSERT INTO executions (id, code, status, seeds, started_at, kind, projection, direct_call, result_state, result)
            VALUES (?, 'x', 'completed', '{}', 0, 'direct', 'direct', '{"toolName":"a.b","namespace":"a","request":"{}"}', ?, ?)`,
      args: [id, resultState, result],
    });
  await insert("d_null", null, null);
  await expect(store.executions.get("d_null")).rejects.toThrow(/result_state/);
  await insert("d_deliv_with_result", "delivered", '{"x":1}');
  await expect(store.executions.get("d_deliv_with_result")).rejects.toThrow(/result_state/);
  await insert("d_retained_no_result", "retained", null);
  await expect(store.executions.get("d_retained_no_result")).rejects.toThrow(/result_state/);
  await insert("d_ok", "discarded", null);
  const ok = await store.executions.get("d_ok");
  expect(ok?.kind === "direct" && ok.resultState).toBe("discarded");
  expect(ok?.result).toBeUndefined();
});

it("INVARIANT §4.1: the request round-trip property holds through the store", async () => {
  const input = { b: 1, a: [true, null, "x"], nested: { z: 0, y: "ÿ" } };
  const request = JSON.stringify(input);
  await store.executions.create(directRow({ id: "d_rt", call: { toolName: "github.issues.list", namespace: "github", request } }));
  const back = await store.executions.get("d_rt");
  const stored = back?.kind === "direct" ? back.call.request : "";
  expect(stored).toBe(request);
  expect(JSON.stringify(JSON.parse(stored))).toBe(request);
});

it("INVARIANT §5.3 (#22, store half): settleDirect is fenced on status AND attempt", async () => {
  await store.executions.create(directRow({ id: "d_f" }), { attempt: "att-1" });
  expect(await store.executions.settleDirect("d_f", "att-WRONG", { status: "failed", error: { name: "X", message: "m" } })).toBe(false);
  expect((await store.executions.get("d_f"))?.status).toBe("running");
  expect(await store.executions.settleDirect("d_f", "att-1", { status: "failed", error: { name: "ConduitOutcomeAmbiguous", message: "m" } })).toBe(true);
  // a late completion with the RIGHT attempt still loses: the row is no longer running
  expect(await store.executions.settleDirect("d_f", "att-1", { status: "completed", resultState: "delivered" })).toBe(false);
  const row = await store.executions.get("d_f");
  expect(row?.status).toBe("failed");
  expect(row?.error?.name).toBe("ConduitOutcomeAmbiguous");
});

it("settleDirect paused writes pausedOn and keeps status transitions fenced", async () => {
  await store.executions.create(directRow({ id: "d_p" }), { attempt: "a" });
  const pausedOn = { callId: "c", toolName: "github.issues.list", namespace: "github", sourceGeneration: 3, input: {}, reason: "r", expiresAt: 9e12 };
  expect(await store.executions.settleDirect("d_p", "a", { status: "paused", pausedOn })).toBe(true);
  expect((await store.executions.get("d_p"))?.pausedOn).toEqual(pausedOn);
});

it("INVARIANT §4.1 (D3 sweep): invalidatePaused flips paused rows of BOTH kinds by namespace EQUALITY, returns the count", async () => {
  const pause = (ns: string) => ({ callId: "c", toolName: `${ns}.t`, namespace: ns, sourceGeneration: 1, input: {}, reason: "r", expiresAt: 9e12 });
  await store.executions.create(codeRow({ id: "p_code", status: "paused", pausedOn: pause("github") }));
  await store.executions.create(directRow({ id: "p_direct", status: "paused", pausedOn: pause("github") }));
  await store.executions.create(codeRow({ id: "p_other", status: "paused", pausedOn: pause("github_x") })); // `_` is a legal namespace char, not a wildcard
  await store.executions.create(codeRow({ id: "p_running", status: "running" }));
  expect(await store.executions.invalidatePaused("github")).toBe(2);
  for (const id of ["p_code", "p_direct"]) {
    const row = await store.executions.get(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toEqual({ name: "ConduitCatalogChanged", message: "catalog changed — re-approve" });
    expect(row?.pausedOn).toBeUndefined();
    expect(row?.endedAt).toBeTypeOf("number");
  }
  expect((await store.executions.get("p_other"))?.status).toBe("paused");
  expect((await store.executions.get("p_running"))?.status).toBe("running");
});

it("§7 crash sweep: a running DIRECT row is listed by id and terminalized without hydration", async () => {
  await store.executions.create(directRow({ id: "d_run" }));
  expect(await store.executions.listRunningIds()).toContain("d_run");
  await store.executions.failClaimedResume("d_run", "daemon died", "ConduitOutcomeAmbiguous");
  expect((await store.executions.get("d_run"))?.error?.name).toBe("ConduitOutcomeAmbiguous");
});

it("§4.3 (#27 store half): trace rows carry projection and client_id; legacy rows default to code / null", async () => {
  await store.trace.append({ callId: "t1", executionId: "e", toolName: "a.b", connectionPrefix: "p", input: {}, policyVerdict: "allow", at: 1, projection: "discovery", clientId: "acme" });
  await client.execute("INSERT INTO trace_events (call_id, execution_id, tool_name, connection_prefix, input, policy_verdict, at) VALUES ('t0','e','a.b','p','{}','allow',0)");
  const [legacy, r1] = await store.trace.listByExecution("e");
  expect([legacy?.projection, legacy?.clientId]).toEqual(["code", null]);
  expect([r1?.projection, r1?.clientId]).toEqual(["discovery", "acme"]);
});

it("fresh DDL CHECKs refuse an unknown kind, projection, result_state, and trace projection", async () => {
  await expect(client.execute("INSERT INTO executions (id, code, status, seeds, started_at, kind) VALUES ('k', 'x', 'running', '{}', 0, 'bogus')")).rejects.toThrow(/CHECK/);
  await expect(client.execute("INSERT INTO executions (id, code, status, seeds, started_at, projection) VALUES ('p', 'x', 'running', '{}', 0, 'bogus')")).rejects.toThrow(/CHECK/);
  await expect(client.execute("INSERT INTO executions (id, code, status, seeds, started_at, result_state) VALUES ('r', 'x', 'running', '{}', 0, 'bogus')")).rejects.toThrow(/CHECK/);
  await expect(client.execute("INSERT INTO trace_events (call_id, execution_id, tool_name, connection_prefix, input, policy_verdict, at, projection) VALUES ('c','e','a','p','{}','allow',0,'bogus')")).rejects.toThrow(/CHECK/);
});
```

Import `NEWER_BUILD_SENTINEL` and `Execution` from `../types.js` at the top.

- [ ] **Step 2: Run to verify failure**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk src/store/sqlite.test.ts`
Expected: FAIL — `create`/`settleDirect`/`invalidatePaused` are not functions; columns missing.

- [ ] **Step 3: Extend `store.ts`**

```ts
export type DirectSettle =
  | { status: "completed"; resultState: "delivered" | "discarded" }
  | { status: "completed"; resultState: "retained"; result: unknown }
  | { status: "failed"; error: ExecutionError }
  | { status: "paused"; pausedOn: PendingApproval };

export interface ExecutionRepository {
  /**
   * Persist a NEW execution (start/startDirect). A plain INSERT — a
   * duplicate id or, for a named client, a duplicate `(client_id, key)` in
   * `request_keys` throws (the manager maps the UNIQUE failure to
   * `conflict`). `attempt` seeds `resume_attempt` so a direct drive's settle
   * writes can be fenced from the first write (§5.3).
   */
  create(execution: Execution, opts?: { attempt?: string }): Promise<void>;
  /** Settle upsert. Never writes `request_keys`; never changes `resume_attempt`. */
  put(execution: Execution): Promise<void>;
  get(id: string): Promise<Execution | undefined>;
  /** Default profile (`null`): the legacy column. Named client: `request_keys` (§4.1). */
  getByRequestKey(key: string, clientId: string | null): Promise<Execution | undefined>;
  claimForResume(id: string, resumeAttemptId: string, callId: string): Promise<boolean>;
  claimCallId(id: string): Promise<string | undefined>;
  failClaimedResume(id: string, reason: string, errorName?: string): Promise<void>;
  /**
   * The ONE settle write for a direct row (§5.3 exactly-once): fenced
   * `WHERE status = 'running' AND resume_attempt = ?`. Returns true iff this
   * write changed the row. A late continuation after the timer, or a
   * duplicate settle, returns false and changes nothing.
   */
  settleDirect(id: string, attempt: string, settle: DirectSettle): Promise<boolean>;
  /**
   * D3 housekeeping sweep (§4.1): every `paused` row of EITHER kind whose
   * `pausedOn.namespace` EQUALS `namespace` becomes `failed` with
   * `ConduitCatalogChanged`. Returns the count. Not the authority — the
   * generation check on resume is.
   */
  invalidatePaused(namespace: string): Promise<number>;
  listPaused(): Promise<Execution[]>;
  listRunningIds(): Promise<string[]>;
}
```

Import `DirectSettle`-needed types (`ExecutionError`, `PendingApproval`).

- [ ] **Step 4: `sqlite.ts` — DDL and ladder**

In `SCHEMA`, the `executions` CREATE gains, after `request_key TEXT`:

```sql
    kind TEXT NOT NULL DEFAULT 'code' CHECK (kind IN ('code', 'direct')),
    projection TEXT NOT NULL DEFAULT 'code' CHECK (projection IN ('code', 'direct', 'discovery')),
    direct_call TEXT,
    client_id TEXT,
    program TEXT,
    result_state TEXT CHECK (result_state IN ('delivered', 'retained', 'discarded'))
```

`trace_events` CREATE gains, after `at INTEGER NOT NULL`:

```sql
    projection TEXT NOT NULL DEFAULT 'code' CHECK (projection IN ('code', 'direct', 'discovery')),
    client_id TEXT
```

Ladder, after the `request_key` retrofit block (reuse the
`executionColumns` PRAGMA result):

```ts
  // R1 §4.1: kind / projection / direct_call / client_id / program /
  // result_state. Same PRAGMA-then-ALTER retrofit; CHECKs protect fresh
  // schemas only — hydrateExecutionRow guards legacy rows read-side.
  const r1ExecutionColumns: readonly [string, string][] = [
    ["kind", "kind TEXT NOT NULL DEFAULT 'code'"],
    ["projection", "projection TEXT NOT NULL DEFAULT 'code'"],
    ["direct_call", "direct_call TEXT"],
    ["client_id", "client_id TEXT"],
    ["program", "program TEXT"],
    ["result_state", "result_state TEXT"],
  ];
  for (const [name, ddl] of r1ExecutionColumns) {
    if (!executionColumns.rows.some((row) => row.name === name)) {
      await tolerateSchemaRace(() => client.execute(`ALTER TABLE executions ADD COLUMN ${ddl}`));
    }
  }
```

After the pre-§11 trace migration block:

```ts
  // R1 §4.3: attribution columns on trace_events.
  const traceColumnsAfter = await client.execute("PRAGMA table_info(trace_events)");
  for (const [name, ddl] of [
    ["projection", "projection TEXT NOT NULL DEFAULT 'code'"],
    ["client_id", "client_id TEXT"],
  ] as const) {
    if (!traceColumnsAfter.rows.some((row) => row.name === name)) {
      await tolerateSchemaRace(() => client.execute(`ALTER TABLE trace_events ADD COLUMN ${ddl}`));
    }
  }
```

- [ ] **Step 5: `sqlite.ts` — `create`, `put`, `settleDirect`, `invalidatePaused`, `getByRequestKey`**

Shared column builder (module scope):

```ts
/** The R1 row shape for INSERT/UPSERT: sentinel in `code`, program in `program` (§4.1). */
function executionColumns(execution: Execution): {
  code: string; seeds: string; program: string | null; directCall: string | null;
  kind: Execution["kind"]; projection: string; clientId: string | null; resultState: string | null;
} {
  return execution.kind === "code"
    ? {
        code: NEWER_BUILD_SENTINEL, seeds: JSON.stringify(execution.seeds), program: execution.code,
        directCall: null, kind: "code", projection: execution.projection,
        clientId: execution.clientId, resultState: null,
      }
    : {
        code: NEWER_BUILD_SENTINEL, seeds: "{}", program: null,
        directCall: JSON.stringify(execution.call), kind: "direct", projection: execution.projection,
        clientId: execution.clientId, resultState: execution.resultState ?? null,
      };
}
```

`create`:

```ts
async create(execution, opts) {
  const c = executionColumns(execution);
  const named = execution.clientId !== null && execution.requestKey !== undefined;
  const insert = {
    sql: `INSERT INTO executions
            (id, code, status, seeds, paused_on, started_at, ended_at, result, error, request_key,
             kind, projection, direct_call, client_id, program, result_state, resume_attempt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      execution.id, c.code, execution.status, c.seeds,
      execution.pausedOn === undefined ? null : JSON.stringify(execution.pausedOn),
      execution.startedAt, execution.endedAt ?? null,
      execution.result === undefined ? null : JSON.stringify(execution.result),
      execution.error === undefined ? null : JSON.stringify(execution.error),
      named ? null : (execution.requestKey ?? null),
      c.kind, c.projection, c.directCall, c.clientId, c.program, c.resultState,
      opts?.attempt ?? null,
    ],
  };
  if (!named) {
    await client.execute(insert);
    return;
  }
  // Task 3 adds the request_keys statement to this batch.
  await client.batch([insert], "write");
},
```

`put`: same column list minus `resume_attempt` and `request_key` handling as today, with the `ON CONFLICT(id) DO UPDATE SET` clause extended by `kind = excluded.kind, projection = excluded.projection, direct_call = excluded.direct_call, client_id = excluded.client_id, program = excluded.program, result_state = excluded.result_state`. `request_key` keeps today's behaviour (`execution.requestKey ?? null`) ONLY when `execution.clientId === null`; a named row writes `NULL` (its key lives in `request_keys`).

`settleDirect`:

```ts
async settleDirect(id, attempt, settle) {
  const endedAt = settle.status === "paused" ? null : Date.now();
  const rs = await client.execute({
    sql: `UPDATE executions SET status = ?, ended_at = ?, paused_on = ?, result = ?, error = ?, result_state = ?
          WHERE id = ? AND status = 'running' AND resume_attempt = ? AND kind = 'direct'`,
    args: [
      settle.status,
      endedAt,
      settle.status === "paused" ? JSON.stringify(settle.pausedOn) : null,
      settle.status === "completed" && settle.resultState === "retained" ? JSON.stringify(settle.result ?? null) : null,
      settle.status === "failed" ? JSON.stringify(settle.error) : null,
      settle.status === "completed" ? settle.resultState : null,
      id,
      attempt,
    ],
  });
  return rs.rowsAffected === 1;
},
```

`invalidatePaused`:

```ts
async invalidatePaused(namespace) {
  const rs = await client.execute({
    sql: `UPDATE executions SET status = 'failed', ended_at = ?, paused_on = NULL, error = ?
          WHERE status = 'paused'
            AND json_valid(paused_on)
            AND json_type(paused_on, '$.namespace') = 'text'
            AND json_extract(paused_on, '$.namespace') = ?`,
    args: [Date.now(), JSON.stringify({ name: "ConduitCatalogChanged", message: "catalog changed — re-approve" }), namespace],
  });
  return rs.rowsAffected;
},
```

`getByRequestKey(key, clientId)`: `clientId === null` → today's query; otherwise `return undefined` (Task 3 fills it).

- [ ] **Step 6: `sqlite.ts` — hydration guards**

Replace the body of `hydrateExecutionRow` after the status check:

```ts
  const kind = text(row, "kind");
  if (kind !== "code" && kind !== "direct") throw executionReadError(`unrecognized kind ${JSON.stringify(kind)}`);
  const projection = text(row, "projection");
  if (!isOneOf(projection, PROJECTIONS)) throw executionReadError(`unrecognized projection ${JSON.stringify(projection)}`);
  const directCall = maybeText(row, "direct_call");
  if (kind === "direct" && directCall === undefined) throw executionReadError("kind = 'direct' requires direct_call");
  if (kind === "code" && directCall !== undefined) throw executionReadError("kind = 'code' forbids direct_call");
  const resultStateRaw = maybeText(row, "result_state");
  const resultRaw = maybeText(row, "result");
  if (kind === "code" && resultStateRaw !== undefined) throw executionReadError("result_state is set on a code row");
  if (kind === "direct" && status === "completed") {
    if (resultStateRaw === undefined || !isOneOf(resultStateRaw, RESULT_STATES)) throw executionReadError(`completed direct row has result_state ${JSON.stringify(resultStateRaw)}`);
    if (resultStateRaw === "retained" && resultRaw === undefined) throw executionReadError("result_state 'retained' with no result");
    if (resultStateRaw !== "retained" && resultRaw !== undefined) throw executionReadError(`result_state '${resultStateRaw}' with a stored result`);
  }
  if (kind === "direct" && status !== "completed" && resultStateRaw !== undefined) throw executionReadError("result_state on a non-completed direct row");

  const base: ExecutionBase = {
    id: text(row, "id"), status, startedAt: integer(row, "started_at"),
    clientId: maybeText(row, "client_id") ?? null, projection,
  };
  // optional fields exactly as today: pausedOn (cast to StoredPendingApproval), endedAt, result, error
  // requestKey: legacy column first, then the named join column Task 3 adds
  const requestKey = maybeText(row, "request_key") ?? maybeText(row, "named_request_key");
  if (requestKey !== undefined) base.requestKey = requestKey;

  if (kind === "code") {
    const program = maybeText(row, "program");
    return { ...base, kind, code: program ?? text(row, "code"),
      seeds: parseJson(text(row, "seeds"), (cause) => executionReadError("seeds is not valid JSON", cause)) as Extract<Execution, { kind: "code" }>["seeds"] };
  }
  const call = parseJson(directCall as string, (cause) => executionReadError("direct_call is not valid JSON", cause));
  if (typeof call !== "object" || call === null || typeof (call as DirectCall).toolName !== "string" ||
      typeof (call as DirectCall).namespace !== "string" || typeof (call as DirectCall).request !== "string") {
    throw executionReadError("direct_call is malformed");
  }
  const direct: Extract<Execution, { kind: "direct" }> = { ...base, kind, call: call as DirectCall };
  if (resultStateRaw !== undefined) direct.resultState = resultStateRaw as ResultState;
  return direct;
```

Add `const RESULT_STATES: readonly ResultState[] = ["delivered", "retained", "discarded"];` beside the other vocabularies. `rowToTraceEvent` adds `projection` (guarded by `PROJECTIONS`, default `"code"` when the column is absent on a legacy table) and `clientId: maybeText(row, "client_id") ?? null`. `trace.append` writes both columns. `listPaused`'s fallback recovery row becomes `{ id, kind: "code", code: "", status: "paused", seeds: {...}, startedAt, clientId: null, projection: "code", ...pausedOn }`.

- [ ] **Step 7: Run the store tests**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk src/store/sqlite.test.ts`
Expected: the new tests PASS; existing tests FAIL only where fixtures lack the new fields (next step).

- [ ] **Step 8: Mechanical fixture update**

Enumerate: `grep -rn "status: \"paused\"\|status: \"running\"\|status: \"completed\"\|status: \"failed\"\|status: \"expired\"" packages/sdk/src packages/mcp/src packages/cli/src --include=*.test.ts -l`. In each file, add `kind: "code", clientId: null, projection: "code"` to every `Execution` literal (or route it through a `codeRow` helper as above), and `projection: "code", clientId: null` to every `TraceEvent` literal. Update `executions.getByRequestKey(key)` calls to `getByRequestKey(key, null)`.

- [ ] **Step 9: Typecheck and full SDK suite**

Run: `./packages/sdk/node_modules/.bin/tsc --noEmit -p packages/sdk/tsconfig.json && ./packages/sdk/node_modules/.bin/vitest run --root packages/sdk`
Expected: typecheck reports errors ONLY in `manager.ts` (`start` builds an `Execution` without `kind`) and `invoker.ts`/`runtime.ts` (`TraceEvent` without attribution). Fix `manager.ts` minimally now — add `kind: "code", clientId: null, projection: "code"` to the `start` literal and switch `put` to `create` — and add `projection: "code", clientId: null` to `appendTrace`'s event in `invoker.ts` as a placeholder that Task 6 replaces. Re-run: PASS, 0 type errors across `packages/sdk`, `packages/mcp`, `packages/cli` (`pnpm typecheck` from the root, run unsandboxed).

- [ ] **Step 10: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): R1 execution record — kind, provenance types, sentinel, fenced direct settle"
```

---

### Task 3: Store — client-namespaced request keys (§4.1, row #25 store half)

**Files:**
- Modify: `packages/sdk/src/store/sqlite.ts` (SCHEMA, `create`, `get`, `getByRequestKey`, `listPaused`)
- Modify: `packages/sdk/src/store/sqlite.test.ts`

**Interfaces:**
- Consumes: Task 2's `create` and the `named_request_key` hydration hook.
- Produces: `request_keys` table; `getByRequestKey(key, clientId)` complete; the UNIQUE failure text the manager matches: `UNIQUE constraint failed: request_keys.client_id, request_keys.key`.

- [ ] **Step 1: Write the failing tests** (inside `describe("executions")`)

```ts
it("INVARIANT §4.1 (#25): a named client's key lives in request_keys; the legacy column stays NULL; lookup is per client", async () => {
  await store.executions.create(codeRow({ id: "n1", clientId: "acme", requestKey: "k" }));
  const raw = await client.execute({ sql: "SELECT request_key FROM executions WHERE id = ?", args: ["n1"] });
  expect(raw.rows[0]?.request_key).toBeNull();
  const rk = await client.execute({ sql: "SELECT execution_id FROM request_keys WHERE client_id = ? AND key = ?", args: ["acme", "k"] });
  expect(rk.rows[0]?.execution_id).toBe("n1");
  expect((await store.executions.getByRequestKey("k", "acme"))?.id).toBe("n1");
  expect(await store.executions.getByRequestKey("k", null)).toBeUndefined();
  expect(await store.executions.getByRequestKey("k", "other")).toBeUndefined();
  expect((await store.executions.get("n1"))?.requestKey).toBe("k"); // hydrated through the join
});

it("INVARIANT §4.1 (#25): a named key never collides with a default-profile key, including a legacy key containing U+0000", async () => {
  await client.execute({
    sql: "INSERT INTO executions (id, code, status, seeds, started_at, request_key) VALUES ('legacy', 'x', 'completed', '{}', 0, ?)",
    args: ["acme k"],
  });
  await store.executions.create(codeRow({ id: "d1", requestKey: "k" }));          // default profile, raw column
  await store.executions.create(codeRow({ id: "n2", clientId: "acme", requestKey: "k" })); // named, table
  expect((await store.executions.getByRequestKey("k", null))?.id).toBe("d1");
  expect((await store.executions.getByRequestKey("k", "acme"))?.id).toBe("n2");
  expect((await store.executions.getByRequestKey("acme k", null))?.id).toBe("legacy");
  expect(await store.executions.getByRequestKey("acme k", "acme")).toBeUndefined(); // unreachable from a named client
});

it("INVARIANT §4.1 (#25): a duplicate named key fails the create atomically — no execution row, no key row", async () => {
  await store.executions.create(codeRow({ id: "n3", clientId: "acme", requestKey: "dup" }));
  await expect(store.executions.create(codeRow({ id: "n4", clientId: "acme", requestKey: "dup" }))).rejects.toThrow(
    "UNIQUE constraint failed: request_keys.client_id, request_keys.key",
  );
  expect(await store.executions.get("n4")).toBeUndefined();
  await store.executions.create(codeRow({ id: "n5", clientId: "beta", requestKey: "dup" })); // another client: fine
});

it("listPaused hydrates a named row's key through the join", async () => {
  await store.executions.create(codeRow({ id: "np", clientId: "acme", requestKey: "pk", status: "paused",
    pausedOn: { callId: "c", toolName: "a.b", input: {}, reason: "r", expiresAt: 9e12 } }));
  expect((await store.executions.listPaused()).find((e) => e.id === "np")?.requestKey).toBe("pk");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk src/store/sqlite.test.ts -t "#25"`
Expected: FAIL — `no such table: request_keys`.

- [ ] **Step 3: Implement**

SCHEMA gains:

```sql
CREATE TABLE IF NOT EXISTS request_keys (
  client_id TEXT NOT NULL,
  key TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  PRIMARY KEY (client_id, key)
)
```

`create`: when `named`, the batch is `[insert, { sql: "INSERT INTO request_keys (client_id, key, execution_id) VALUES (?, ?, ?)", args: [execution.clientId, execution.requestKey, execution.id] }]`. libSQL rolls the batch back on the PK failure and surfaces the SQLite message verbatim.

Introduce one SELECT prefix used by `get`, `getByRequestKey`, `listPaused`:

```ts
const EXECUTION_SELECT = `SELECT e.*, rk.key AS named_request_key
  FROM executions e LEFT JOIN request_keys rk ON rk.execution_id = e.id`;
```

- `get`: `${EXECUTION_SELECT} WHERE e.id = ?`
- `getByRequestKey(key, null)`: `${EXECUTION_SELECT} WHERE e.request_key = ?`
- `getByRequestKey(key, clientId)`: `${EXECUTION_SELECT} WHERE rk.client_id = ? AND rk.key = ?`
- `listPaused`: `${EXECUTION_SELECT.replace("SELECT e.*", "SELECT e.*, CASE WHEN json_valid(e.paused_on) THEN json_extract(e.paused_on, '$.callId') END AS claim_call_id")} WHERE e.status = 'paused' ORDER BY e.started_at ASC, e.id ASC` — write it out in full rather than via `replace`.

- [ ] **Step 4: Run store tests, then the whole SDK suite**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/store
git commit -m "feat(sdk): client-namespaced request keys via request_keys table"
```

---

### Task 4: Store — source generation (§4.1a, row #47) and profiles (§4.2)

**Files:**
- Modify: `packages/sdk/src/store/store.ts` (`SourceRepository.getGeneration`, `provisionSource` return, `ProfileRepository`, `ConduitStore.profiles`)
- Modify: `packages/sdk/src/store/sqlite.ts`
- Modify: `packages/sdk/src/store/sqlite.test.ts`
- Modify: `packages/sdk/src/types.ts` (`Profile`)

**Interfaces:**
- Produces:
  - `SourceRepository.getGeneration(namespace: string): Promise<number | undefined>` — `undefined` when no source row.
  - `ConduitStore.provisionSource(...)`: `Promise<{ generation: number }>`.
  - `Source.generation` populated by `rowToSource`.
  - `interface Profile { clientId: string; projections: {code;direct;discovery}; allow: string[]; updatedAt: number }`
  - `ProfileRepository { get(clientId); list(); put(profile); remove(clientId) }`; `put` throws on a `clientId` outside `/^[a-z0-9][a-z0-9_-]{0,63}$/`.
  - `CLIENT_ID_GRAMMAR` regex exported from `types.ts`.

- [ ] **Step 1: Write the failing generation tests** (new `describe("source generation (§4.1a)")`)

```ts
const gen = (ns: string) => store.sources.getGeneration(ns);
const ledgerCount = async () => Number((await client.execute("SELECT COUNT(*) AS n FROM source_generations")).rows[0]?.n);

async function provision(namespace: string, toolNames: string[], location = "https://x.example/mcp") {
  return store.provisionSource({
    source: { id: `src_${namespace}`, type: "mcp", namespace, location },
    integration: { id: `int_${namespace}`, sourceId: `src_${namespace}`, namespace },
    connection: { id: `conn_${namespace}`, integrationId: `int_${namespace}`, prefix: `${namespace}.acme.prod` },
    tools: toolNames.map((n) => tool({ name: `${namespace}.${n}`, namespace })),
  });
}

it("INVARIANT §4.1a (#47): a provision with N tools writes exactly N+1 ledger rows and the namespace's generation is the last", async () => {
  const before = await ledgerCount();
  const { generation } = await provision("gh", ["a", "b", "c"]);
  expect((await ledgerCount()) - before).toBe(4);
  const max = Number((await client.execute("SELECT MAX(gen) AS m FROM source_generations")).rows[0]?.m);
  expect(generation).toBe(max);
  expect(await gen("gh")).toBe(generation);
  expect((await store.sources.getByNamespace("gh"))?.generation).toBe(generation);
});

it("INVARIANT §4.1a (#47): every write path bumps — standalone INSERT (sources.upsert), zero-tool revalidate, retarget", async () => {
  await store.sources.upsert({ id: "s1", type: "mcp", namespace: "solo", location: "https://a" });
  const g0 = await gen("solo");
  expect(g0).toBeGreaterThan(0); // INSERT trigger: never the column default
  await provision("solo", []);            // zero tools: the source-row trigger bumps alone
  const g1 = await gen("solo");
  expect(g1).toBeGreaterThan(g0 as number);
  await provision("solo", [], "https://b"); // retarget under the same id: DO UPDATE path bumps
  expect(await gen("solo")).toBeGreaterThan(g1 as number);
});

it("INVARIANT §4.1a (#47): the SHIPPED pre-R1 SQL bumps too — the database enforces it, not the writer", async () => {
  await provision("old", ["t"]);
  const g0 = await gen("old");
  // the exact statements sqlite.ts shipped before R1 (upsert leaves unknown columns untouched)
  await client.execute({ sql: "UPDATE sources SET location = ? WHERE id = ?", args: ["https://moved", "src_old"] });
  const g1 = await gen("old");
  expect(g1).toBeGreaterThan(g0 as number);
  await client.batch([
    { sql: "DELETE FROM tools WHERE namespace = ?", args: ["old"] },
    { sql: "INSERT INTO tools (name, namespace, description, input_schema, output_schema, risk_class, source_semantics) VALUES ('old.t2','old',NULL,'{}','{}','safe','{\"kind\":\"mcp\"}')", args: [] },
  ], "write");
  expect(await gen("old")).toBeGreaterThan(g1 as number);
});

it("INVARIANT §4.1a (#17): remove then re-add never reuses a generation — including deleting the current maximum and every source", async () => {
  await provision("x", ["t"]);
  await provision("y", ["t"]);
  const gx = await gen("x");
  const gy = await gen("y"); // current maximum
  await store.sources.remove("src_y");
  await store.sources.remove("src_x");
  expect(await gen("x")).toBeUndefined();
  await provision("y", ["t"]);
  await provision("x", ["t"]);
  expect(await gen("y")).toBeGreaterThan(gy as number);
  expect(await gen("x")).toBeGreaterThan(gy as number);
  expect(await gen("x")).not.toBe(gx);
});

it("INVARIANT §4.1a (#47): the triggers survive a pre-R1 build opening the database", async () => {
  // A pre-R1 ladder is CREATE TABLE IF NOT EXISTS over the pre-R1 schema: it knows no triggers and drops none.
  const preR1 = [
    `CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, type TEXT NOT NULL, namespace TEXT NOT NULL UNIQUE, location TEXT NOT NULL, base_url TEXT)`,
    `CREATE TABLE IF NOT EXISTS tools (name TEXT PRIMARY KEY, namespace TEXT NOT NULL, description TEXT, input_schema TEXT NOT NULL, output_schema TEXT NOT NULL, risk_class TEXT NOT NULL, source_semantics TEXT NOT NULL)`,
  ];
  await provision("surv", ["t"]);
  const g0 = await gen("surv");
  await client.batch(preR1, "write");
  await client.execute({ sql: "UPDATE sources SET location = 'https://again' WHERE id = ?", args: ["src_surv"] });
  expect(await gen("surv")).toBeGreaterThan(g0 as number);
  const triggers = await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
  expect(triggers.rows.map((r) => r.name)).toEqual(["sources_gen_on_insert", "sources_gen_on_tools", "sources_gen_on_update"]);
});

it("the update trigger does not recurse: one allocation per statement with recursive_triggers on or off", async () => {
  for (const mode of ["OFF", "ON"]) {
    await client.execute(`PRAGMA recursive_triggers = ${mode}`);
    const before = await ledgerCount();
    await client.execute({ sql: "UPDATE sources SET location = ? WHERE id = ?", args: [`https://${mode}`, "src_gh"] }).catch(() => provision("gh", ["a"]));
    const after = await ledgerCount();
    expect(after - before).toBeLessThanOrEqual(1 + 1); // provision fallback writes N+1 = 2 on first run; a bare UPDATE writes exactly 1
  }
});
```

(Tighten the last test: provision `gh` once in a `beforeEach`, then assert exactly `1` per bare UPDATE.)

- [ ] **Step 2: Write the failing profile tests** (new `describe("profiles (§4.2)")`)

```ts
it("round-trips a profile and lists deterministically by clientId", async () => {
  const p = { clientId: "acme", projections: { code: true, direct: true, discovery: false }, allow: ["github", "slack.post"], updatedAt: 5 };
  await store.profiles.put(p);
  await store.profiles.put({ ...p, clientId: "abc", allow: [] });
  expect(await store.profiles.get("acme")).toEqual(p);
  expect((await store.profiles.list()).map((x) => x.clientId)).toEqual(["abc", "acme"]);
  await store.profiles.remove("acme");
  expect(await store.profiles.get("acme")).toBeUndefined();
});

it("put is a whole-row replace", async () => {
  await store.profiles.put({ clientId: "acme", projections: { code: true, direct: false, discovery: false }, allow: ["a"], updatedAt: 1 });
  await store.profiles.put({ clientId: "acme", projections: { code: false, direct: true, discovery: true }, allow: [], updatedAt: 2 });
  expect(await store.profiles.get("acme")).toMatchObject({ allow: [], updatedAt: 2, projections: { code: false, direct: true, discovery: true } });
});

it.each(["", "Acme", "-lead", "a".repeat(65), "has space", "dot.name"])("refuses clientId %j (grammar)", async (bad) => {
  await expect(store.profiles.put({ clientId: bad, projections: { code: true, direct: false, discovery: false }, allow: [], updatedAt: 0 })).rejects.toThrow(/clientId/);
});

it("a corrupt stored projections/allow blob fails the read loudly", async () => {
  await client.execute("INSERT INTO profiles (client_id, projections, allow, updated_at) VALUES ('bad', '{\"code\":1}', '[]', 0)");
  await expect(store.profiles.get("bad")).rejects.toThrow(/projections/);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk src/store/sqlite.test.ts -t "§4.1a|profiles"`
Expected: FAIL — `getGeneration`/`profiles` undefined; no `source_generations` table.

- [ ] **Step 4: Types**

`types.ts`:

```ts
export const CLIENT_ID_GRAMMAR = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export interface Profile {
  clientId: string;
  projections: { code: boolean; direct: boolean; discovery: boolean };
  allow: string[];
  updatedAt: number;
}
```

`store.ts`: `SourceRepository.getGeneration`, `ConduitStore.profiles: ProfileRepository`, `provisionSource(...): Promise<{ generation: number }>`, and:

```ts
export interface ProfileRepository {
  get(clientId: string): Promise<Profile | undefined>;
  list(): Promise<Profile[]>;
  /** Whole-row replace. Throws on a clientId outside CLIENT_ID_GRAMMAR. */
  put(profile: Profile): Promise<void>;
  remove(clientId: string): Promise<void>;
}
```

- [ ] **Step 5: `sqlite.ts` DDL, ladder, triggers**

SCHEMA: `sources` gains `generation INTEGER NOT NULL DEFAULT 0`; add:

```sql
CREATE TABLE IF NOT EXISTS source_generations (
  gen INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  at INTEGER NOT NULL
)
```
```sql
CREATE TABLE IF NOT EXISTS profiles (
  client_id TEXT PRIMARY KEY,
  projections TEXT NOT NULL,
  allow TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)
```

Ladder, after the other retrofits and BEFORE the canary:

```ts
  // R1 §4.1a: sources.generation, then the three triggers. The triggers
  // reference the column, so they are created only after the ALTER on a
  // legacy database. CREATE TRIGGER IF NOT EXISTS is idempotent and lives
  // in the database file: a pre-R1 build's ladder knows no triggers and
  // drops none (row #47, trigger survival).
  const sourceColumns = await client.execute("PRAGMA table_info(sources)");
  if (!sourceColumns.rows.some((row) => row.name === "generation")) {
    await tolerateSchemaRace(() =>
      client.execute("ALTER TABLE sources ADD COLUMN generation INTEGER NOT NULL DEFAULT 0"),
    );
  }
  await client.batch(GENERATION_TRIGGERS, "write");
```

with, at module scope, the three trigger statements copied VERBATIM from spec §4.1a (`sources_gen_on_update` with `WHEN NEW.generation = OLD.generation`, `sources_gen_on_insert`, `sources_gen_on_tools`).

- [ ] **Step 6: `sqlite.ts` repository code**

- `rowToSource`: `generation: integer(row, "generation")` (present after the ladder on every db).
- `sources.getGeneration`: `SELECT generation FROM sources WHERE namespace = ?` → `maybeInteger`.
- `provisionSource`: after `client.batch(statements, "write")`, `const rs = await client.execute({ sql: "SELECT generation FROM sources WHERE id = ?", args: [source.id] }); return { generation: integer(rs.rows[0] as Row, "generation") };` — no explicit ledger insert (§4.1a rev 11).
- `profiles` repository: `put` validates `CLIENT_ID_GRAMMAR.test(profile.clientId)` and that `allow` is `string[]` and each projection flag is boolean, then `INSERT ... ON CONFLICT(client_id) DO UPDATE SET projections=excluded.projections, allow=excluded.allow, updated_at=excluded.updated_at`; `rowToProfile` parses both JSON blobs with `parseJson` and rebuilds field-by-field, throwing `[SqliteStore] Failed to read profile: projections is malformed. Context: { clientId }` on any non-boolean flag or non-string allow entry.

- [ ] **Step 7: Run the whole SDK suite and root typecheck**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk` then `pnpm typecheck` (unsandboxed).
Expected: PASS; `packages/mcp` compiles (its `provisionSource` call ignores the new return value).

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): source generation ledger with writer-independent triggers; profiles table"
```

---

### Task 5: Dispatch cell; MCP client `beforeSend`; no 404 retry on `tools/call`; upstream wiring (§5.5, §7; rows #21 client half, #24 write boundary)

**Files:**
- Create: `packages/sdk/src/pipeline/dispatch.ts`
- Modify: `packages/sdk/src/pipeline/errors.ts`
- Modify: `packages/sdk/src/pipeline/mcp-client.ts` (`McpClient.callTool`, `openPost`, `postClassified`, `requestAndAwait`, `callToolOnce`)
- Modify: `packages/sdk/src/pipeline/upstream.ts` (`UpstreamRequest.dispatch`)
- Modify: `packages/sdk/src/pipeline/mcp-client.test.ts`, `packages/sdk/src/pipeline/upstream.test.ts`
- Modify: `packages/sdk/src/index.ts`

**Interfaces:**
- Produces:
  - `type DispatchState = "none" | "initializing" | "dispatched"`
  - `interface DispatchCell { readonly state: DispatchState; advance(to: DispatchState): void }` — monotonic; `advance` to a lower state is a no-op.
  - `createDispatchCell(): DispatchCell`
  - `OUTCOME_AMBIGUOUS_ERROR_NAME = "ConduitOutcomeAmbiguous"`; `class ConduitOutcomeAmbiguous extends Error { cause?: unknown }` (host-side, NOT a `ConduitCallError`).
  - `McpClient.callTool(session, name, args, hooks?: { beforeSend?: () => void })` — `beforeSend` runs synchronously immediately before `req.end(payload)` of the `tools/call` POST, and never for initialize/initialized/ping posts.
  - `UpstreamRequest.dispatch?: DispatchCell` — the caller advances it to `initializing` before session acquire and `dispatched` via `beforeSend`.

- [ ] **Step 1: Write the failing `dispatch` unit test** (top of a new `describe` in `upstream.test.ts` or a new `dispatch.test.ts`; use `dispatch.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { createDispatchCell } from "./dispatch.js";

describe("DispatchCell (§5.5)", () => {
  it("is monotonic: none → initializing → dispatched, never lowered", () => {
    const cell = createDispatchCell();
    expect(cell.state).toBe("none");
    cell.advance("initializing");
    expect(cell.state).toBe("initializing");
    cell.advance("dispatched");
    cell.advance("initializing");
    cell.advance("none");
    expect(cell.state).toBe("dispatched");
  });
});
```

- [ ] **Step 2: Rewrite the three `callTool`-based 404-retry tests to `listTools`, and add the no-retry pins** (`mcp-client.test.ts`)

In the `describe("INVARIANT §18-C4: scoped 404-session-expiry retry")` block:
- Test at ~line 910: change the server branch from `parsed.method === "tools/call"` to `parsed.method === "tools/list"` (respond `{ tools: [] }` on the retry), and the call to `client.listTools(session, 1024)`; expectations unchanged (`initializeCount` 2, headers `["sess-1","sess-2"]`). Rename to "INVARIANT §18-C4: the 404 retry fires ONLY for side-effect-free operations (tools/list), only when the request carried a session id, at most once".
- Test at ~961 ("second consecutive 404") and ~999 ("sessionless 404"): same substitution to `listTools`.

Add:

```ts
it("INVARIANT §7 (#21): a governed tools/call is dispatched at most once — a 404 after dispatch is NOT retried and the session is NOT re-initialized", async () => {
  let initializeCount = 0;
  const sideEffects: string[] = [];
  const url = await serve((req, res) => {
    readBody(req).then(({ parsed }) => {
      if (parsed.method === "initialize") {
        initializeCount++;
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": `sess-${initializeCount}` });
        res.end(jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }));
        return;
      }
      if (parsed.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      if (parsed.method === "tools/call") {
        sideEffects.push("performed"); // the upstream DID the work, then answered 404
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(404); res.end();
    });
  });
  const client = createMcpClient({ target: url, headers: {} }, budget());
  const session = await client.initialize();
  await expect(client.callTool(session, "demo", {})).rejects.toMatchObject({ kind: "http_status", status: 404 });
  expect(sideEffects).toEqual(["performed"]);
  expect(initializeCount).toBe(1);
});

it("INVARIANT §5.5 (#24): beforeSend fires exactly once, before the tools/call body is written, and never for handshake posts", async () => {
  const order: string[] = [];
  const url = await serve((req, res) => {
    readBody(req).then(({ parsed }) => {
      order.push(`server:${parsed.method}`);
      if (parsed.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" });
        res.end(jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }));
        return;
      }
      if (parsed.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jsonRpcResponse(parsed.id as string, { result: { content: [] } }));
    });
  });
  const client = createMcpClient({ target: url, headers: {} }, budget());
  const session = await client.initialize();
  expect(order.filter((o) => o.startsWith("client:"))).toEqual([]);
  await client.callTool(session, "demo", {}, { beforeSend: () => order.push("client:beforeSend") });
  const sendIndex = order.indexOf("client:beforeSend");
  const callIndex = order.indexOf("server:tools/call");
  expect(sendIndex).toBeGreaterThan(-1);
  expect(sendIndex).toBeLessThan(callIndex);
  expect(order.filter((o) => o === "client:beforeSend")).toHaveLength(1);
});

it("INVARIANT §5.5 (#24): connection loss at the write — zero bytes delivered — still fires beforeSend first, so the failure classifies post-dispatch", async () => {
  let initialized = false;
  const server = createServer((req, res) => {
    readBody(req).then(({ parsed }) => {
      if (parsed.method === "initialize") {
        initialized = true;
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" });
        res.end(jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }));
        return;
      }
      if (parsed.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      // unreachable for tools/call: the socket is destroyed on connect below
    });
  });
  // Destroy the THIRD connection (the tools/call POST) before any byte is read.
  let connections = 0;
  server.on("connection", (socket) => { connections++; if (connections >= 3) socket.destroy(); });
  const url = await listen(server); // reuse the file's listen helper; keep-alive must be off so each POST is a new socket
  const client = createMcpClient({ target: url, headers: {} }, budget());
  const session = await client.initialize();
  expect(initialized).toBe(true);
  let fired = false;
  await expect(client.callTool(session, "demo", {}, { beforeSend: () => { fired = true; } })).rejects.toMatchObject({ kind: "network" });
  expect(fired).toBe(true);
});
```

If the file's `serve` helper enables keep-alive, add `server.keepAliveTimeout = 0` and `Connection: close` handling so the third POST opens a new socket; if that is impractical, destroy on `server.on("request")` when `req.method === "POST"` and a flag set after `initialized` is true — the assertion is the same: hook fired, rejection is `network`, no retry.

- [ ] **Step 3: Write the failing upstream tests** (`upstream.test.ts`)

```ts
it("INVARIANT §5.5: the caller advances the dispatch cell — initializing before the handshake, dispatched before the governed call", async () => {
  const states: string[] = [];
  const { port } = await serve((request, res) => {
    const parsed = JSON.parse(request.body) as { id: string; method: string };
    states.push(`server:${parsed.method}:${cell.state}`);
    if (parsed.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "0" } } }));
      return;
    }
    if (parsed.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { content: [] } }));
  });
  const cell = createDispatchCell();
  const caller = createMcpUpstreamCaller({ egress: { allowPrivate: true } });
  await caller.call({ tool, source: sourceAt(port), input: {}, auth: { headers: {} }, timeoutMs: 5000, dispatch: cell });
  expect(states).toEqual(["server:initialize:initializing", "server:notifications/initialized:initializing", "server:tools/call:dispatched"]);
  expect(cell.state).toBe("dispatched");
});

it("INVARIANT §7 (#21): a side-effect-then-404 upstream surfaces as ONE dispatch and an HTTP 404 upstream error with the cell at dispatched", async () => {
  const { port, requests } = await serve((request, res) => {
    const parsed = JSON.parse(request.body) as { id: string; method: string };
    if (parsed.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "0" } } }));
      return;
    }
    if (parsed.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    res.writeHead(404); res.end();
  });
  const cell = createDispatchCell();
  const caller = createMcpUpstreamCaller({ egress: { allowPrivate: true } });
  await expect(caller.call({ tool, source: sourceAt(port), input: {}, auth: { headers: {} }, timeoutMs: 5000, dispatch: cell }))
    .rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream, message: expect.stringContaining("HTTP 404") });
  expect(requests.filter((r) => r.body.includes('"tools/call"'))).toHaveLength(1);
  expect(requests.filter((r) => r.body.includes('"initialize"'))).toHaveLength(1);
  expect(cell.state).toBe("dispatched");
});
```

- [ ] **Step 4: Run all three test files to verify failure**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk src/pipeline/dispatch.test.ts src/pipeline/mcp-client.test.ts src/pipeline/upstream.test.ts`
Expected: FAIL — `dispatch.js` missing; `beforeSend` ignored; `callTool` still retries (initializeCount 2).

- [ ] **Step 5: Implement `dispatch.ts` and the error class**

```ts
// packages/sdk/src/pipeline/dispatch.ts
/**
 * §5.5: a host-side, monotonic per-call cell recording how far the governed
 * call got. `initializing` = session/handshake traffic started (never
 * counts as dispatch). `dispatched` = the write that submits the governed
 * `tools/call` body is about to be attempted — BEFORE the write, because a
 * failure inside it may have transmitted part or all of the body (§7).
 * Nothing ever lowers the cell. Read at settle time by the invoker and by
 * the manager's direct arm; never an error field, so it survives every
 * wrapping and replacement error.
 */
export type DispatchState = "none" | "initializing" | "dispatched";

export interface DispatchCell {
  readonly state: DispatchState;
  advance(to: DispatchState): void;
}

const ORDER: Record<DispatchState, number> = { none: 0, initializing: 1, dispatched: 2 };

export function createDispatchCell(): DispatchCell {
  let state: DispatchState = "none";
  return {
    get state() {
      return state;
    },
    advance(to) {
      if (ORDER[to] > ORDER[state]) state = to;
    },
  };
}
```

`errors.ts`:

```ts
/**
 * §7: a governed call failed AFTER its body write was attempted, so the
 * upstream may have performed it. Host-side and terminal, like
 * ConduitReplayDivergence: the invoker's outermost catch lets it through
 * unchanged, the journaling wrapper turns it into a guest-uncatchable
 * terminal signal, and the manager settles `failed` under this name — the
 * SAME name the crash-terminal sweep uses, so every reader keys on one string.
 */
export const OUTCOME_AMBIGUOUS_ERROR_NAME = "ConduitOutcomeAmbiguous";

export class ConduitOutcomeAmbiguous extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = OUTCOME_AMBIGUOUS_ERROR_NAME;
  }
}
```

- [ ] **Step 6: Implement the client hook and remove the `tools/call` retry** (`mcp-client.ts`)

- `openPost<T>(body, session, onResponse, beforeSend?: () => void)`: insert `beforeSend?.();` as the statement immediately preceding `req.end(payload);`. Nothing else in the function changes.
- `postClassified(body, ctx, beforeSend?)` → `openPost(body, ctx.session, (res) => readClassified(res, ctx), beforeSend)`.
- `requestAndAwait(body, session, id, legacyAccept, beforeSend?)` threads it to `postClassified`. `listToolsOnce` passes nothing.
- `callToolOnce(session, name, args, beforeSend?)` passes it through.
- `McpClient.callTool(session, name, args, hooks?: { beforeSend?: () => void })` and the returned implementation:

```ts
    callTool(session, name, args, hooks) {
      // §7: NO session-expiry retry for a governed tools/call. The upstream
      // may have performed the call before answering 404; re-sending it after
      // re-initialization would be a second dispatch under one approval.
      // Session renewal may prepare a LATER, separately authorized call
      // (the next `initialize`), never this one. `listTools`/`initialize`
      // keep the retry: they have no side effects.
      return callToolOnce(session, name, args, hooks?.beforeSend);
    },
```

Update the `withSessionExpiryRetry` doc comment: it now serves `listTools` only.

- [ ] **Step 7: Wire `upstream.ts`**

`UpstreamRequest` gains `dispatch?: DispatchCell` (doc: "§5.5 per-call dispatch cell; advanced by this caller"). In `call()`: immediately before `await withinDeadline(scope.acquire(...))`: `request.dispatch?.advance("initializing");`. The `freshClient.callTool(...)` call gains the fourth argument `{ beforeSend: () => request.dispatch?.advance("dispatched") }`. Update the header comment that mentions "one 404-retry" to say the retry applies to the handshake's `tools/list` only.

- [ ] **Step 8: Exports**

`index.ts`: `export type { DispatchCell, DispatchState } from "./pipeline/dispatch.js"; export { createDispatchCell } from "./pipeline/dispatch.js";` and add `ConduitOutcomeAmbiguous`, `OUTCOME_AMBIGUOUS_ERROR_NAME` to the `errors.js` export.

- [ ] **Step 9: Run the three files, then the SDK suite**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk`
Expected: PASS. The ledger rows at `INVARIANTS.md` lines 52–54 (§18-C4 404 retry) are reworded in Task 11.

- [ ] **Step 10: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): per-call dispatch cell; no 404 retry for governed tools/call"
```

---

### Task 6: Invoker — scope check, attribution, per-call cell, ambiguity classification, deadline gate before credentials (§5.5; rows #24 invoker half, #27 invoker half)

**Files:**
- Modify: `packages/sdk/src/pipeline/invoker.ts`
- Modify: `packages/sdk/src/pipeline/invoker.test.ts`
- Modify: `packages/mcp/src/runtime.ts` (pass the new options through)

**Interfaces:**
- Consumes: Task 1 `Projection`, `EffectiveScope`; Task 5 `DispatchCell`, `createDispatchCell`, `ConduitOutcomeAmbiguous`.
- Produces: `CreateToolInvokerOptions` gains REQUIRED `projection: Projection` and `clientId: string | null`, and OPTIONAL `scope?: () => Promise<EffectiveScope>` (already bound to the drive's client id) and `dispatch?: DispatchCell` (a direct drive's one cell; absent → a fresh cell per call). Every `TraceEvent` the invoker appends carries `projection` and `clientId`.

- [ ] **Step 1: Write the failing tests** (`invoker.test.ts`; update the existing `createToolInvoker(deps, { executionId })` calls to add `projection: "code", clientId: null` first)

```ts
const permitAll = async () => buildEffectiveScope({ projections: { code: true, direct: true, discovery: true }, allow: ALL_TOOLS }, await store.tools.list());
const permitOnly = (names: string[]) => async () =>
  buildEffectiveScope({ projections: { code: true, direct: true, discovery: true }, allow: names }, await store.tools.list());

describe("§5.5 scope check", () => {
  it("INVARIANT §5.5: an out-of-scope tool is treated exactly as an unknown tool — blocked, audited, no upstream contact", async () => {
    const { caller, requests } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_s", projection: "code", clientId: "acme", scope: permitOnly(["github.delete_repo"]) });
    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.policyBlocked,
      message: 'Tool "github.list_issues" is outside this client\'s scope.',
    });
    expect(requests).toHaveLength(0);
    const [row] = await store.trace.listByExecution("exec_s");
    expect(row).toMatchObject({ toolName: "github.list_issues", policyVerdict: "block", projection: "code", clientId: "acme" });
  });

  it("the refusal names only the tool, never the profile's other entries", async () => {
    const invoke = createToolInvoker(deps(recordingUpstream().caller), { executionId: "exec_o", projection: "direct", clientId: "acme", scope: permitOnly(["github.delete_repo"]) });
    await expect(invoke("github.list_issues", {})).rejects.toSatisfy((e: Error) => !e.message.includes("delete_repo"));
  });

  it("a permitted tool proceeds; an absent scope behaves as today", async () => {
    const { caller, requests } = recordingUpstream();
    await createToolInvoker(deps(caller), { executionId: "exec_p", projection: "code", clientId: null, scope: permitAll })("github.list_issues", {});
    await createToolInvoker(deps(caller), { executionId: "exec_q", projection: "code", clientId: null })("github.list_issues", {});
    expect(requests).toHaveLength(2);
  });

  it("INVARIANT §4.3 (#27): every trace row carries projection and clientId, on allow and on refusal", async () => {
    const invoke = createToolInvoker(deps(recordingUpstream().caller), { executionId: "exec_t", projection: "discovery", clientId: "acme" });
    await invoke("github.list_issues", {});
    await invoke("github.delete_repo", {}).catch(() => {});
    const rows = await store.trace.listByExecution("exec_t");
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([r.projection, r.clientId]).toEqual(["discovery", "acme"]);
  });
});

describe("§7 post-dispatch classification", () => {
  function dispatchingCaller(fail: () => Error): UpstreamCaller {
    return { async call(request) { request.dispatch?.advance("initializing"); request.dispatch?.advance("dispatched"); throw fail(); } };
  }
  it("INVARIANT §7 (#24): an upstream failure after dispatch surfaces as ConduitOutcomeAmbiguous, not a guest-catchable upstream error", async () => {
    const invoke = createToolInvoker(deps(dispatchingCaller(() => upstreamError("HTTP 404"))), { executionId: "exec_a", projection: "code", clientId: null });
    await expect(invoke("github.list_issues", {})).rejects.toBeInstanceOf(ConduitOutcomeAmbiguous);
  });
  it("INVARIANT §7 (#24): classification survives error REPLACEMENT — a failing refusal audit after dispatch is still ambiguous", async () => {
    const failingTrace = { ...store, trace: { ...store.trace, append: () => Promise.reject(new Error("disk full")) } } as ConduitStore;
    const invoke = createToolInvoker(deps(dispatchingCaller(() => upstreamError("HTTP 404")), { store: failingTrace }), { executionId: "exec_b", projection: "code", clientId: null });
    await expect(invoke("github.list_issues", {})).rejects.toBeInstanceOf(ConduitOutcomeAmbiguous);
  });
  it("a failure while the cell is initializing (handshake) keeps its own classification", async () => {
    const initOnly: UpstreamCaller = { async call(request) { request.dispatch?.advance("initializing"); throw upstreamError("handshake refused"); } };
    const invoke = createToolInvoker(deps(initOnly), { executionId: "exec_c", projection: "code", clientId: null });
    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream });
  });
  it("a caller-supplied cell (direct drive) is the one advanced", async () => {
    const cell = createDispatchCell();
    const invoke = createToolInvoker(deps(recordingUpstream().caller), { executionId: "exec_d", projection: "direct", clientId: null, dispatch: cell });
    await invoke("github.list_issues", {});
    expect(cell.state).toBe("none"); // the recording caller never advances; the cell was handed over intact
  });
  it("INVARIANT §5.3 quarantine gate: an exhausted deadline refuses BEFORE credentials are resolved", async () => {
    const resolve = vi.fn();
    const credentials = { resolve: async (c: Connection) => { resolve(); return createStoreCredentialResolver(store.secrets).resolve(c); } };
    const invoke = createToolInvoker(deps(recordingUpstream().caller, { credentials }), { executionId: "exec_e", projection: "code", clientId: null, deadline: () => 0 });
    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream, message: expect.stringContaining("budget is exhausted") });
    expect(resolve).not.toHaveBeenCalled();
  });
});
```

Imports to add: `buildEffectiveScope`, `ALL_TOOLS` from `../scope.js`; `createDispatchCell` from `./dispatch.js`; `ConduitOutcomeAmbiguous` from `./errors.js`; `Connection` type.

- [ ] **Step 2: Run to verify failure**

Run: `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk src/pipeline/invoker.test.ts`
Expected: FAIL (type errors on the new options; scope ignored; ambiguity not raised).

- [ ] **Step 3: Implement**

`CreateToolInvokerOptions`:

```ts
  /** §4.3: recorded on every Trace row this invoker appends. */
  projection: Projection;
  clientId: string | null;
  /** §5.2/§5.5: the resolver already bound to this drive's client id, awaited per call. */
  scope?: () => Promise<EffectiveScope>;
  /** §5.5: a direct drive's one dispatch cell. Absent → one fresh cell per call. */
  dispatch?: DispatchCell;
```

`createToolInvoker` body:

```ts
  return async (path, input) => {
    const dispatch = options.dispatch ?? createDispatchCell();
    try {
      return await runCall(deps, options, log, ceiling, path, input, dispatch);
    } catch (cause) {
      // §7: whatever error reaches here, the CELL decides. Once the body
      // write was attempted the effect is unknowable; classify ambiguous
      // before any pass-through, so a replaced error cannot hide it.
      if (dispatch.state === "dispatched") {
        throw new ConduitOutcomeAmbiguous(
          `[ToolInvoker] Upstream call failed after dispatch: the upstream may have performed the call. Context: { tool: ${path} }`,
          { cause },
        );
      }
      if (cause instanceof ConduitReplayDivergence || cause instanceof ConduitCallError) throw cause;
      throw infraError(cause, log);
    }
  };
```

`runCall` step 1 becomes:

```ts
  let tool = await deps.store.tools.get(path).catch((cause) => { throw infraError(cause, log); });
  // §5.5: scope is authority recomputed per call. Out of scope ≡ unknown.
  let outOfScope = false;
  if (tool !== undefined && options.scope !== undefined) {
    const scope = await options.scope().catch((cause) => { throw infraError(cause, log); });
    if (!scope.permits(options.projection, path)) { tool = undefined; outOfScope = true; }
  }
```

and the unknown-tool branch's allow-reason becomes
`outOfScope ? `Tool "${path}" is outside this client's scope.` : `Unknown tool "${path}": not in the catalog, so it is blocked.``.

Move the `remaining <= 0` refusal to run right after connection resolution (step 3) and BEFORE `deps.credentials.resolve` (step 4); keep its trace append and message.

Pass `dispatch` on the `UpstreamRequest`: `...(dispatch !== undefined ? { dispatch } : {})` — always defined here, so simply `dispatch`.

`appendTrace`: `projection: options.projection, clientId: options.clientId` on the event.

`runtime.ts`: `makeInvoker: ({ executionId, decisions, deadline, upstreamSession, projection, clientId, scope, dispatch }) => createToolInvoker({...}, { executionId, log, projection, clientId, ...(deadline...), ...(upstreamSession...), ...(scope !== undefined ? { scope } : {}), ...(dispatch !== undefined ? { dispatch } : {}) })`. (The manager's `makeInvoker` argument type gains these fields in Task 8; until then pass `projection: "code", clientId: null` literally so the package compiles.)

- [ ] **Step 4: Run the invoker suite, then the SDK suite, then root typecheck**

Expected: PASS; 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src packages/mcp/src/runtime.ts
git commit -m "feat(sdk): invoker scope check, trace attribution, post-dispatch ambiguity"
```

---

### Task 7: Scoped catalog tool host (§5.4 last paragraph, §5.3 filter-before-rank; row #43 catalog half — D-A6)

**Files:**
- Modify: `packages/sdk/src/execute.ts`
- Modify: `packages/sdk/src/execute.test.ts`
- Modify: `packages/sdk/src/index.ts`

**Interfaces:**
- Produces: `createScopedCatalogToolHost(catalog: Catalog, invoke: ToolInvoker, scope: () => Promise<EffectiveScope>, projection: Projection): ToolHost`.

- [ ] **Step 1: Write the failing tests** (`execute.test.ts`)

```ts
describe("createScopedCatalogToolHost (§5.2, #43)", () => {
  const mk = (name: string, description: string): Tool => ({ name, namespace: name.split(".")[0] as string, description, inputSchema: { type: "object" }, outputSchema: {}, riskClass: "safe", sourceSemantics: { kind: "mcp" } });
  const catalog = new InMemoryCatalog();
  // ten disallowed tools that out-rank the one allowed tool on the query "deploy"
  catalog.upsert(Array.from({ length: 10 }, (_, i) => mk(`ops.deploy_${i}`, "deploy deploy deploy")));
  catalog.upsert([mk("allowed.thing", "deploy")]);
  const scope = async () => buildEffectiveScope({ projections: { code: true, direct: false, discovery: false }, allow: ["allowed"] }, [...Array.from({ length: 10 }, (_, i) => mk(`ops.deploy_${i}`, "")), mk("allowed.thing", "")]);
  const invoke = vi.fn(async () => ({}));

  it("INVARIANT §5.3 (#43): eligibility is applied BEFORE ranking and the limit — an allowed tool ranked below ten disallowed ones is still returned", async () => {
    const host = createScopedCatalogToolHost(catalog, invoke, scope, "code");
    const hits = await host.search({ query: "deploy" });
    expect(hits.map((h) => h.path)).toEqual(["allowed.thing"]);
  });
  it("describe of an out-of-scope tool is undefined, indistinguishable from nonexistent", async () => {
    const host = createScopedCatalogToolHost(catalog, invoke, scope, "code");
    expect(await host.describe("ops.deploy_1")).toBeUndefined();
    expect(await host.describe("nope.tool")).toBeUndefined();
    expect((await host.describe("allowed.thing"))?.path).toBe("allowed.thing");
  });
  it("a flag turned off empties search and describe for that projection", async () => {
    const off = async () => buildEffectiveScope({ projections: { code: false, direct: false, discovery: false }, allow: ALL_TOOLS }, [mk("allowed.thing", "")]);
    const host = createScopedCatalogToolHost(catalog, invoke, off, "code");
    expect(await host.search({ query: "deploy" })).toEqual([]);
    expect(await host.describe("allowed.thing")).toBeUndefined();
  });
  it("the limit still applies after filtering", async () => {
    const wide = async () => buildEffectiveScope(DEFAULT_PROFILE_GRANT, Array.from({ length: 10 }, (_, i) => mk(`ops.deploy_${i}`, "")));
    const host = createScopedCatalogToolHost(catalog, invoke, wide, "code");
    expect(await host.search({ query: "deploy", limit: 3 })).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `createScopedCatalogToolHost` is not exported.

- [ ] **Step 3: Implement** (`execute.ts`)

```ts
/**
 * §5.2/§5.4: a live filtered view of the catalog for one drive. `search`
 * applies eligibility to the WHOLE ranked candidate set, then the limit —
 * filtering the top ten would hide an allowed tool that ranks below ten
 * disallowed ones (§5.3, row #43). `describe` of an out-of-scope tool is
 * `undefined`, indistinguishable from a nonexistent one. One snapshot is
 * awaited per op; the Catalog interface gains nothing.
 */
export function createScopedCatalogToolHost(
  catalog: Catalog,
  invoke: ToolInvoker,
  scope: () => Promise<EffectiveScope>,
  projection: Projection,
): ToolHost {
  const DEFAULT_LIMIT = 10;
  return {
    search: async (options) => {
      const snapshot = await scope();
      const ranked = catalog.search({ query: options.query, limit: Number.MAX_SAFE_INTEGER });
      return ranked
        .filter((hit) => snapshot.permits(projection, hit.path))
        .slice(0, options.limit ?? DEFAULT_LIMIT);
    },
    describe: async (path, options) =>
      (await scope()).permits(projection, path) ? catalog.describe(path, options) : undefined,
    call: (path, input) => invoke(path, input),
  };
}
```

Export it from `index.ts` beside `createCatalogToolHost`.

- [ ] **Step 4: Run, then commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): scoped catalog tool host filters before rank and limit"
```

---

### Task 8: Manager `start` — attribution, `create`, provenance capture on pause, scope threading, Code Mode ambiguity (§4.1, §5.4, §5.5; rows #15 start half, #16 running-program half, #18/#25 manager half, #21/#24 Code Mode side)

**Files:**
- Modify: `packages/sdk/src/execution/manager.ts`
- Modify: `packages/sdk/src/execution/manager.test.ts`
- Modify: `packages/mcp/src/runtime.ts` (`makeToolHost` second argument)

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces:
  - `ExecutionManager.start(code, opts?: { limits?; requestKey?; clientId?: string | null; scope?: ScopeResolver })`
  - `ExecutionManagerDeps.makeInvoker(args: { executionId; decisions?; deadline?; upstreamSession?; projection: Projection; clientId: string | null; scope?: () => Promise<EffectiveScope>; dispatch?: DispatchCell })`
  - `ExecutionManagerDeps.makeToolHost(invoke, scoped?: { scope: () => Promise<EffectiveScope>; projection: "code" })`
  - `CapturedDriveState.catalogChanged?: ExecutionError` (internal)
  - The journaling wrapper's `onApprovalPause` becomes `() => Promise<PendingApproval>`.

- [ ] **Step 1: Write the failing tests** (`manager.test.ts`; extend `makeHarness` so `deps.makeInvoker` forwards `projection`, `clientId`, `scope`, `dispatch`, and `deps.makeToolHost = (invoke, scoped) => scoped ? createScopedCatalogToolHost(catalog, invoke, scoped.scope, scoped.projection) : createCatalogToolHost(catalog, invoke)`)

```ts
describe("R1 start: attribution, provenance, scope (§4.1, §5.4)", () => {
  it("INVARIANT §4.1: start persists clientId and projection for a code row; default profile is null/code", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const a = await m.start("return 1");
    const b = await m.start("return 1", { clientId: "acme" });
    expect(await m.get(a.executionId)).toMatchObject({ kind: "code", clientId: null, projection: "code" });
    expect(await m.get(b.executionId)).toMatchObject({ kind: "code", clientId: "acme", projection: "code" });
  });

  it("INVARIANT §4.1 (#19): the persisted code row carries the sentinel in `code` and the program in `program` — end to end", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const { executionId } = await m.start("return 7");
    const raw = await (active.store as unknown as { client?: never }) // use the harness's libsql client instead
    void raw;
  });
  // (Write the sentinel assertion with the harness's raw client: SELECT code, program FROM executions WHERE id = ?; expect sentinel / "return 7".)

  it("INVARIANT §4.1: a pause captures namespace and sourceGeneration equal to the store's current generation", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const out = await m.start('await tools.github.create_issue({ title: "x" }); return 1;');
    expect(out.status).toBe("paused");
    const row = await m.get(out.executionId);
    const gen = await active.store.sources.getGeneration("github");
    expect(row?.pausedOn).toMatchObject({ toolName: "github.create_issue", namespace: "github", sourceGeneration: gen });
  });

  it("D-A7: a pause whose namespace has no source row terminalizes ConduitCatalogChanged instead of writing an unstamped pause", async () => {
    active = await makeHarness();
    await active.store.sources.remove("src_gh"); // tools and policies remain; the invoker refuses before it needs the source
    const m = createExecutionManager(active.deps);
    const out = await m.start('await tools.github.create_issue({ title: "x" }); return 1;');
    expect(out).toMatchObject({ status: "failed", error: { name: "ConduitCatalogChanged" } });
    expect((await m.get(out.executionId))?.pausedOn).toBeUndefined();
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.2 (#15 start half): a narrowed scope makes in-sandbox search hide, describe null, and a direct tools[path]() call fail closed", async () => {
    active = await makeHarness();
    const scope: ScopeResolver = async () => buildEffectiveScope({ projections: { code: true, direct: false, discovery: false }, allow: ["github.list_issues"] }, await active!.store.tools.list());
    const m = createExecutionManager(active.deps);
    const out = await m.start(`
      const { items } = await tools.search({ query: "issue" });
      const described = await tools.describe.tool({ path: "github.create_issue" });
      try { await tools.github.create_issue({ title: "x" }); return { items: items.map(i => i.path), described, blocked: false }; }
      catch (e) { return { items: items.map(i => i.path), described, blocked: e.name }; }
    `, { clientId: "acme", scope });
    expect(out).toMatchObject({ status: "completed", value: { items: ["github.list_issues"], described: null, blocked: "ConduitPolicyBlocked" } });
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.2 (#16): turning the code flag off mid-drive bites on the running program's NEXT call", async () => {
    active = await makeHarness();
    let codeOn = true;
    const scope: ScopeResolver = async () => buildEffectiveScope({ projections: { code: codeOn, direct: false, discovery: false }, allow: ALL_TOOLS }, await active!.store.tools.list());
    const m = createExecutionManager(active.deps);
    const out = await m.start(`
      await tools.github.list_issues({});
      await tools.github.list_issues({}); // second call is the one that lands after the flag flips
      return "reached";
    `, { scope });
    // arrange the flip: the recording server flips the flag on the FIRST tools/call
    // (add an `onCall` hook to startMcpServer that runs before it responds; set codeOn = false there)
    expect(out).toMatchObject({ status: "failed", error: { name: "ConduitPolicyBlocked" } });
    expect(active.calls).toHaveLength(1);
  });

  it("INVARIANT §4.1 (#25, manager half): a named client's requestKey conflicts within that client and returns the SAME client's id; another client with the same key runs", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const first = await m.start("return 1", { clientId: "acme", requestKey: "k" });
    const again = await m.start("return 2", { clientId: "acme", requestKey: "k" });
    expect(again).toEqual({ status: "conflict", executionId: first.executionId });
    const other = await m.start("return 3", { clientId: "beta", requestKey: "k" });
    expect(other.status).toBe("completed");
    const dflt = await m.start("return 4", { requestKey: "k" });
    expect(dflt.status).toBe("completed");
  });

  it("INVARIANT §7 (#21/#24, Code Mode): a side-effect-then-404 upstream terminalizes the execution ConduitOutcomeAmbiguous even inside a guest try/catch, and the call is never re-sent", async () => {
    active = await makeHarness({ respondToCall: (res) => { res.writeHead(404); res.end(); } }); // extend startMcpServer with an injectable tools/call responder that still records the call
    const m = createExecutionManager(active.deps);
    const out = await m.start('try { await tools.github.list_issues({}); } catch (e) { return "caught " + e.name; } return "ok";');
    expect(out).toMatchObject({ status: "failed", error: { name: "ConduitOutcomeAmbiguous" } });
    expect(active.calls).toHaveLength(1);
    expect((await m.get(out.executionId))?.error?.name).toBe("ConduitOutcomeAmbiguous");
  });
});
```

Harness additions: `startMcpServer(options?: { onCall?: (call: UpstreamCall) => void; respondToCall?: (res: ServerResponse, payload) => void })`; `makeHarness` accepts and forwards them.

- [ ] **Step 2: Run to verify failure**

Run (unsandboxed — loopback): `./packages/sdk/node_modules/.bin/vitest run --root packages/sdk src/execution/manager.test.ts -t "R1 start"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ExecutionManagerDeps`:

```ts
  makeInvoker: (args: {
    executionId: string;
    decisions?: ApprovalDecisions;
    deadline?: () => number;
    upstreamSession?: UpstreamSessionScope;
    /** §4.3/§5.5: attribution and authority for THIS drive. */
    projection: Projection;
    clientId: string | null;
    /** The resolver bound to the drive's client id; absent = default profile (D-A3). */
    scope?: () => Promise<EffectiveScope>;
    /** §5.5: a direct drive's one cell (Task 10). */
    dispatch?: DispatchCell;
  }) => ToolInvoker;
  /** Second argument present iff the drive runs under a resolver: the host must be the scoped view (§5.4). */
  makeToolHost: (invoke: ToolInvoker, scoped?: { scope: () => Promise<EffectiveScope>; projection: "code" }) => ToolHost;
```

`ExecutionManager.start` signature: `opts?: { limits?; requestKey?; clientId?: string | null; scope?: ScopeResolver }`.

In `createExecutionManager`:

```ts
  /** Bind a resolver to one client id; absent resolver → default profile (D-A3). */
  function bindScope(scope: ScopeResolver | undefined, clientId: string | null): () => Promise<EffectiveScope> {
    const resolver = scope ?? defaultScopeResolver(deps.store);
    return () => resolver(clientId);
  }
```

`CapturedDriveState` gains `catalogChanged?: ExecutionError`. `journal()`'s `onApprovalPause` type becomes `() => Promise<PendingApproval>`; in the `isRequireApproval` branch:

```ts
          try {
            captured.pending = await onApprovalPause();
          } catch (cause) {
            if (cause instanceof CatalogChangedAtPause) {
              captured.catalogChanged = { name: "ConduitCatalogChanged", message: cause.message };
              throw new ConduitApprovalPause(true);
            }
            throw cause;
          }
          throw new ConduitApprovalPause();
```

Add, beside `isReplayDivergence`: `function isOutcomeAmbiguous(error: unknown): boolean { return error instanceof Error && error.name === OUTCOME_AMBIGUOUS_ERROR_NAME; }` and a branch in `journal()`'s catch, before the generic journaled-failure path:

```ts
        if (isOutcomeAmbiguous(error)) {
          // §7 Code Mode side: the cell read `dispatched` when the call failed.
          // Host-side, guest-uncatchable, terminal — exactly the divergence path.
          captured.ambiguous = { name: OUTCOME_AMBIGUOUS_ERROR_NAME, message: (error as Error).message };
          throw new ConduitApprovalPause(true);
        }
```

`assemblePending` becomes async and stamps provenance:

```ts
    class CatalogChangedAtPause extends Error {}
    async function assemblePending(path: string, input: unknown): Promise<PendingApproval> {
      const namespace = namespaceOf(path);
      const generation = namespace === undefined ? undefined : await deps.store.sources.getGeneration(namespace);
      if (namespace === undefined || generation === undefined) {
        // D-A7: no provenance → no pause. The call did not run.
        throw new CatalogChangedAtPause(
          `[ExecutionManager] Approval pause refused: no source for the tool's namespace; re-approve after the catalog settles. Context: { executionId: ${ctx.executionId}, tool: ${path} }`,
        );
      }
      return { callId: newId(), toolName: path, namespace, sourceGeneration: generation, input,
        reason: lastApprovalReason ?? `${path} requires approval before it can run.`, expiresAt: now() + resolveApprovalTtlMs() };
    }
```

(`CatalogChangedAtPause` is module-scope, not inside the wrapper.) In `drive()`, after the divergence/ambiguous checks: `if (captured.catalogChanged !== undefined) return finish(execution, { status: "failed", error: captured.catalogChanged });`.

`start`:

```ts
    async start(code, opts) {
      const clientId = opts?.clientId ?? null;
      const scope = bindScope(opts?.scope, clientId);
      const execution: Execution = {
        id: `exec_${newId()}`, kind: "code", code, status: "running", seeds: generateSeeds(), startedAt: now(),
        clientId, projection: "code",
        ...(opts?.requestKey !== undefined ? { requestKey: opts.requestKey } : {}),
      };
      try {
        await deps.store.executions.create(execution);
      } catch (cause) {
        const text = String(cause);
        if (opts?.requestKey !== undefined &&
            (text.includes("UNIQUE constraint failed: executions.request_key") ||
             text.includes("UNIQUE constraint failed: request_keys.client_id, request_keys.key"))) {
          const existing = await deps.store.executions.getByRequestKey(opts.requestKey, clientId);
          if (existing !== undefined) return { status: "conflict", executionId: existing.id };
        }
        throw cause;
      }
      // ... unchanged session/invoker window, with:
      invoke = deps.makeInvoker({ executionId: execution.id, deadline: deadlineFor(opts?.limits), upstreamSession, projection: "code", clientId, scope });
      return await drive(execution, invoke, [], undefined, opts?.limits, { scope, projection: "code" });
```

`drive(execution, invoke, prefix, secret, limits, scoped?)` passes `scoped` to `deps.makeToolHost(invoke, scoped)`. `drive` must narrow: `execution.kind === "code"` (it is the only caller until Task 10); pass `execution.code`/`execution.seeds` from the narrowed value.

`runtime.ts`: `makeToolHost: (invoke, scoped) => scoped ? createScopedCatalogToolHost(catalog, invoke, scoped.scope, scoped.projection) : createCatalogToolHost(catalog, invoke)`.

- [ ] **Step 4: Run the manager suite (unsandboxed), SDK suite, root typecheck** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src packages/mcp/src/runtime.ts
git commit -m "feat(sdk): start carries client attribution, provenance-stamped pauses, live scope"
```

---

### Task 9: Manager `resume` — post-claim read-side guard, generation check, scope revalidation, both kinds (§5.4 steps 2–4; rows #14, #15, #16 resume half, #17, #42, #50)

**Files:**
- Modify: `packages/sdk/src/execution/manager.ts`
- Modify: `packages/sdk/src/execution/manager.test.ts`

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces: `ExecutionManager.resume(executionId, decision, callId, scope?: ScopeResolver): Promise<ResumeOutcome>`. New terminal error names on the resume path: `ConduitCatalogChanged` (`decisionApplied: false`, no `corruptPause`), `ConduitScopeRevoked` (`decisionApplied: false`), and `ConduitInternalError` + `corruptPause: true` for every disposition-table row marked "terminalize corrupt". A direct row reaching step 5 is handed to Task 10's arm; until Task 10 lands, `resume` on a direct row terminalizes `failed` `ConduitInternalError` "direct resume not yet implemented" so the guard tests can run against direct rows.

- [ ] **Step 1: Write the failing tests** — one per §5.4 disposition row, plus the D3 and scope pins. Use `makeBareStore()` + `makeStubDeps()` for hand-built rows (the guard fires BEFORE any drive) and the real harness for the D3/scope end-to-end cases.

Helper (top of the R1 resume block):

```ts
async function seedPaused(store: ConduitStore, row: Execution, rawPausedOn?: string): Promise<void> {
  await store.executions.create(row);
  if (rawPausedOn !== undefined) {
    await (store as unknown as { client: ReturnType<typeof createClient> }).client; // NOT available — use the bare client kept by makeBareStore
  }
}
```
(Make `makeBareStore` return `{ store, client }` so a test can `UPDATE executions SET paused_on = ? WHERE id = ?` with hand-crafted JSON. Keep the tool row seeded: `await store.tools.replaceNamespace("github", [tool("github.list_issues")])` and a source row via `store.sources.upsert(...)` so `getGeneration` answers.)

```ts
const pause = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  callId: "c1", toolName: "github.list_issues", namespace: "github", sourceGeneration: 0, input: { a: 1 }, reason: "r", expiresAt: 9e12, ...over,
});
const directCall = (over: Partial<DirectCall> = {}): DirectCall => ({ toolName: "github.list_issues", namespace: "github", request: '{"a":1}', ...over });
const permitAll: ScopeResolver = async () => buildEffectiveScope({ projections: { code: true, direct: true, discovery: true }, allow: ALL_TOOLS }, await store.tools.list());

describe("§5.4 step 2 — post-claim read-side guard (row #50), one test per disposition row", () => {
  let store: ConduitStore; let client: ReturnType<typeof createClient>; let manager: ExecutionManager;
  beforeEach(async () => {
    ({ store, client } = await makeBareStoreWithClient());
    await store.sources.upsert({ id: "src_gh", type: "mcp", namespace: "github", location: "https://gh" });
    await store.tools.replaceNamespace("github", [tool({ name: "github.list_issues", namespace: "github" })]);
    manager = createExecutionManager(makeStubDeps(store, throwingSandbox()));
  });
  const currentGen = async () => (await store.sources.getGeneration("github")) as number;

  async function resumeRaw(id: string, rawPausedOn: string, callId = "c1") {
    await client.execute({ sql: "UPDATE executions SET paused_on = ? WHERE id = ?", args: [rawPausedOn, id] });
    return manager.resume(id, { kind: "approve" }, callId, permitAll);
  }
  const corrupt = { status: "failed", decisionApplied: false, corruptPause: true, error: { name: "ConduitInternalError" } };

  it.each([
    ["toolName not text", { ...pause(), toolName: 5 }],
    ["reason not text", { ...pause(), reason: null }],
    ["input absent", (() => { const { input: _i, ...rest } = pause(); return rest; })()],
    ["expiresAt not finite", { ...pause(), expiresAt: "never" }],
    ["namespace present, sourceGeneration absent", (() => { const { sourceGeneration: _g, ...rest } = pause(); return rest; })()],
    ["namespace not text", { ...pause(), namespace: 7 }],
    ["sourceGeneration not finite", { ...pause(), sourceGeneration: "7" }],
  ])("terminalizes corrupt: %s", async (_label, stored) => {
    await store.executions.create(codeRow({ id: "e", status: "paused", pausedOn: pause({ sourceGeneration: await currentGen() }) }));
    expect(await resumeRaw("e", JSON.stringify(stored))).toMatchObject(corrupt);
    expect((await store.executions.get("e"))?.status).toBe("failed");
  });

  it("terminalizes corrupt: namespace disagrees with the grammar-derived namespace of toolName", async () => {
    await store.executions.create(codeRow({ id: "e", status: "paused", pausedOn: pause({ sourceGeneration: await currentGen() }) }));
    expect(await resumeRaw("e", JSON.stringify(pause({ namespace: "slack", sourceGeneration: await currentGen() })))).toMatchObject(corrupt);
  });

  it("terminalizes corrupt: namespace agrees with the grammar but not with the resolved tool row's namespace COLUMN", async () => {
    await client.execute("UPDATE tools SET namespace = 'b' WHERE name = 'github.list_issues'"); // { name: 'github.x', namespace: 'b' }
    await store.executions.create(codeRow({ id: "e", status: "paused", pausedOn: pause({ sourceGeneration: await currentGen() }) }));
    expect(await resumeRaw("e", JSON.stringify(pause({ sourceGeneration: await currentGen() })))).toMatchObject(corrupt);
  });

  it("catalog change, not corruption: toolName no longer resolves → ConduitCatalogChanged", async () => {
    await store.executions.create(codeRow({ id: "e", status: "paused", pausedOn: pause({ toolName: "github.gone", sourceGeneration: await currentGen() }) }));
    const out = await manager.resume("e", { kind: "approve" }, "c1", permitAll);
    expect(out).toMatchObject({ status: "failed", decisionApplied: false, error: { name: "ConduitCatalogChanged" } });
    expect((out as { corruptPause?: true }).corruptPause).toBeUndefined();
  });

  it("legacy pause (both provenance fields absent) → ConduitCatalogChanged before any source read (§5.4 step 3, row #14)", async () => {
    const legacy = { callId: "c1", toolName: "github.list_issues", input: {}, reason: "r", expiresAt: 9e12 };
    await store.executions.create(codeRow({ id: "e", status: "paused", pausedOn: legacy }));
    const spy = vi.spyOn(store.sources, "getGeneration");
    const out = await manager.resume("e", { kind: "approve" }, "c1", permitAll);
    expect(out).toMatchObject({ status: "failed", decisionApplied: false, error: { name: "ConduitCatalogChanged" } });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["toolName", directCall({ toolName: "github.other" })],
    ["namespace", directCall({ namespace: "slack" })],
    ["request", directCall({ request: '{"a":1000}' })],
  ])("direct row: direct_call disagrees with pausedOn on %s → terminalize corrupt, the call never runs", async (_f, call) => {
    await store.executions.create(directRow({ id: "d", status: "paused", call, pausedOn: pause({ sourceGeneration: await currentGen() }) }));
    expect(await manager.resume("d", { kind: "approve" }, "c1", permitAll)).toMatchObject(corrupt);
  });

  it("INVARIANT §5.4 step 3 (#14/#42, D3 authority): generation mismatch → ConduitCatalogChanged for BOTH kinds", async () => {
    const gen = await currentGen();
    await store.executions.create(codeRow({ id: "c", status: "paused", pausedOn: pause({ sourceGeneration: gen }) }));
    await store.executions.create(directRow({ id: "d", status: "paused", pausedOn: pause({ sourceGeneration: gen }) }));
    await client.execute("UPDATE sources SET location = 'https://moved' WHERE id = 'src_gh'"); // trigger bumps
    for (const id of ["c", "d"]) {
      expect(await manager.resume(id, { kind: "approve" }, "c1", permitAll)).toMatchObject({ status: "failed", decisionApplied: false, error: { name: "ConduitCatalogChanged" } });
    }
  });

  it("INVARIANT §4.1a (#17): remove then re-add never revives a paused row of either kind", async () => {
    const gen = await currentGen();
    await store.executions.create(codeRow({ id: "c", status: "paused", pausedOn: pause({ sourceGeneration: gen }) }));
    await store.sources.remove("src_gh");
    await store.sources.upsert({ id: "src_gh", type: "mcp", namespace: "github", location: "https://gh" });
    expect(await manager.resume("c", { kind: "approve" }, "c1", permitAll)).toMatchObject({ error: { name: "ConduitCatalogChanged" } });
  });

  it("INVARIANT §5.4 step 4 (#16): a projection flag turned off, or the grant narrowed, revokes on resume — ConduitScopeRevoked", async () => {
    const gen = await currentGen();
    await store.executions.create(codeRow({ id: "c", status: "paused", pausedOn: pause({ sourceGeneration: gen }) }));
    const codeOff: ScopeResolver = async () => buildEffectiveScope({ projections: { code: false, direct: true, discovery: true }, allow: ALL_TOOLS }, await store.tools.list());
    expect(await manager.resume("c", { kind: "approve" }, "c1", codeOff)).toMatchObject({ status: "failed", decisionApplied: false, error: { name: "ConduitScopeRevoked" } });
    await store.executions.create(directRow({ id: "d", status: "paused", pausedOn: pause({ sourceGeneration: gen }) }));
    expect(await manager.resume("d", { kind: "approve" }, "c1")).toMatchObject({ error: { name: "ConduitScopeRevoked" } }); // D-A3: no resolver = default profile, direct off
  });
});

describe("§5.4 resume under scope — real stack", () => {
  it("INVARIANT §5.4 (#15): a code row that paused under a narrowed profile resumes UNDER that profile — an out-of-scope call after resume is blocked", async () => {
    active = await makeHarness();
    const narrow: ScopeResolver = async () => buildEffectiveScope({ projections: { code: true, direct: false, discovery: false }, allow: ["github.create_issue"] }, await active!.store.tools.list());
    const m = createExecutionManager(active.deps);
    const paused = await m.start('await tools.github.create_issue({ title: "x" }); try { await tools.github.list_issues({}); return "leaked"; } catch (e) { return e.name; }', { clientId: "acme", scope: narrow });
    expect(paused.status).toBe("paused");
    const out = await m.resume(paused.executionId, { kind: "approve" }, await pendingCallOf(m, paused.executionId), narrow);
    expect(out).toMatchObject({ status: "completed", value: "ConduitPolicyBlocked", decisionApplied: true });
    expect(active.calls.map((c) => c.name)).toEqual(["create_issue"]);
  });

  it("INVARIANT §4.1 (#14): a provision AFTER the pause invalidates it — resume fails closed re-approve and the upstream never sees the call", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const paused = await m.start('await tools.github.create_issue({ title: "x" }); return 1;');
    const callId = await pendingCallOf(m, paused.executionId);
    await active.store.provisionSource({ /* same source/integration/connection as makeHarness, tools: normalizeMcp(...) */ } as never);
    expect(await active.store.executions.get(paused.executionId)).toMatchObject({ status: "paused" }); // no sweep in the SDK; the daemon runs it (Lane B)
    const out = await m.resume(paused.executionId, { kind: "approve" }, callId);
    expect(out).toMatchObject({ status: "failed", decisionApplied: false, error: { name: "ConduitCatalogChanged" } });
    expect(active.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** (unsandboxed) — FAIL: resume accepts no fourth argument; guard branches absent.

- [ ] **Step 3: Implement** — in `resume`, after the existing `claimCallId`/`isPendingApproval`/TTL block (keep it; `pausedOn` is now `StoredPendingApproval`), insert steps 2–4. Add a local helper:

```ts
      const terminalize = async (
        reason: string, errorName: string, flag: { corruptPause?: true } = {},
      ): Promise<ResumeOutcome> => {
        await deps.store.executions.failClaimedResume(executionId, reason, errorName);
        return { status: "failed", executionId, error: { name: errorName, message: `[ExecutionManager] ${reason}. Context: { executionId: ${executionId} }` }, decisionApplied: false, ...flag };
      };
      const CORRUPT = { corruptPause: true as const };
```

then, in order (§5.4 step 2):

```ts
      // legacy branch: no provenance → step 3 fails it closed, before any source read
      if (!hasProvenance(pausedOn)) {
        return terminalize("catalog changed — re-approve (pause predates provenance)", "ConduitCatalogChanged");
      }
      // namespace agreement, grammar half
      if (namespaceOf(pausedOn.toolName) !== pausedOn.namespace) {
        return terminalize("stored pause's namespace disagrees with its tool name (corrupt state); the pending call did not run", "ConduitInternalError", CORRUPT);
      }
      // namespace agreement, column half; a missing tool is catalog change, not corruption
      const toolRow = await deps.store.tools.get(pausedOn.toolName);
      if (toolRow === undefined) {
        return terminalize("catalog changed — re-approve (tool no longer exists)", "ConduitCatalogChanged");
      }
      if (toolRow.namespace !== pausedOn.namespace) {
        return terminalize("stored pause's namespace disagrees with the tool row's namespace column (corrupt state); the pending call did not run", "ConduitInternalError", CORRUPT);
      }
      // direct rows: the call the row was started for IS the call it paused on
      if (execution.kind === "direct") {
        const { call } = execution;
        if (call.toolName !== pausedOn.toolName || call.namespace !== pausedOn.namespace || call.request !== JSON.stringify(pausedOn.input)) {
          return terminalize("direct_call disagrees with the stored pause (corrupt state); the pending call did not run", "ConduitInternalError", CORRUPT);
        }
      }
      // step 3: generation check (D3 authority)
      const currentGeneration = await deps.store.sources.getGeneration(pausedOn.namespace);
      if (currentGeneration === undefined || currentGeneration !== pausedOn.sourceGeneration) {
        return terminalize("catalog changed — re-approve", "ConduitCatalogChanged");
      }
      // step 4: revalidate flag AND grant under the ROW's client and projection
      const scope = bindScope(scopeResolver, execution.clientId);
      if (!(await scope()).permits(execution.projection, pausedOn.toolName)) {
        return terminalize("the client's scope no longer permits this call — re-approve is not possible", "ConduitScopeRevoked");
      }
```

`resume(executionId, decision, callId, scopeResolver?)` — thread `scope` into `makeInvoker({ ..., projection: execution.projection, clientId: execution.clientId, scope })` and `drive(running, invoke, prefix, undefined, undefined, { scope, projection: "code" })` for code rows. For `execution.kind === "direct"`: `return terminalize("direct resume not yet implemented", "ConduitInternalError")` — replaced in Task 10.

Also: the existing corrupt-state message for the `isPendingApproval` failure stays; the existing "no pending approval" branch stays.

- [ ] **Step 4: Run manager suite, SDK suite, root typecheck** — PASS (`connection.ts` compiles: the fourth argument is optional).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): post-claim read-side guard, generation check, scope revalidation on resume"
```

---

### Task 10: Manager direct arm — `DirectDrive`, `startDirect`, direct resume, result states, latch/fence/retention (§5.3, §5.4, §4.1; rows #1, #3, #22, #28, #41 manager half, #45)

**Files:**
- Create: `packages/sdk/src/execution/direct.ts`
- Modify: `packages/sdk/src/execution/manager.ts`
- Modify: `packages/sdk/src/execution/manager.test.ts`
- Modify: `packages/sdk/src/index.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
// direct.ts
export interface DirectBudgets { driveBudgetMs: number; settleWriteBudgetMs: number; slotRetentionMs: number; resultBytesMax: number }
export const DIRECT_DEFAULTS: DirectBudgets = { driveBudgetMs: 60_000, settleWriteBudgetMs: 5_000, slotRetentionMs: 30_000, resultBytesMax: 262_144 };
export type DirectOutcome =
  | ExecutionOutcome                                         // completed arm may carry `resultTooLarge: true`
  | { status: "unknown"; executionId: string; reason: "persist-timeout" };
export interface DirectDriveHandle {
  executionId: string;
  /** Client-visible. Resolves within driveBudgetMs + settleWriteBudgetMs. Never rejects. */
  outcome: Promise<DirectOutcome>;
  /** "released" when the continuation finished within slotRetentionMs of settle; else "abandoned". Never rejects. */
  retention: Promise<"released" | "abandoned">;
  /** Resolves when the continuation and any tracked settle write have actually stopped. Never rejects. */
  finished: Promise<void>;
}
export interface DirectDrive {
  readonly executionId: string; readonly attempt: string; readonly dispatch: DispatchCell;
  /** Remaining budget in ms; the invoker's deadline(). */
  deadline(): number;
  /** Take the settle latch. True iff this caller is the first. */
  settle(): boolean;
  readonly settled: boolean;
}
export function createDirectDrive(args: { executionId: string; attempt: string; now: () => number; budgetMs: number }): DirectDrive;
// manager.ts
startDirect(toolName: string, input: unknown, opts: { clientId: string | null; projection: "direct" | "discovery"; requestKey?: string; scope?: ScopeResolver }): DirectDriveHandle;
// ExecutionOutcome completed arm gains `resultTooLarge?: true`
// ExecutionManagerDeps gains `direct?: Partial<DirectBudgets>`
```

- [ ] **Step 1: Write the failing tests** (`manager.test.ts`, new `describe("R1 direct arm (§5.3/§5.4)")`; real harness with a scope permitting `direct` and `discovery`; small budgets via `deps.direct`)

```ts
const permitDirect: ScopeResolver = async () => buildEffectiveScope({ projections: { code: true, direct: true, discovery: true }, allow: ALL_TOOLS }, await active!.store.tools.list());
const fast = { driveBudgetMs: 400, settleWriteBudgetMs: 200, slotRetentionMs: 150, resultBytesMax: 262_144 };

it("INVARIANT §5.4 (#1): a direct call runs the same policy path — safe tool allowed, destructive tool blocked, review tool paused; exactly one upstream call for the allowed one", async () => {
  active = await makeHarness();
  const m = createExecutionManager({ ...active.deps, direct: fast });
  const ok = await m.startDirect("github.list_issues", { owner: "o" }, { clientId: null, projection: "direct", scope: permitDirect }).outcome;
  expect(ok).toMatchObject({ status: "completed", value: { ok: true, tool: "list_issues" } });
  const blocked = await m.startDirect("github.delete_repo", { repo: "r" }, { clientId: null, projection: "direct", scope: permitDirect }).outcome;
  expect(blocked).toMatchObject({ status: "failed", error: { name: "ConduitPolicyBlocked" } });
  const paused = await m.startDirect("github.create_issue", { title: "t" }, { clientId: null, projection: "direct", scope: permitDirect }).outcome;
  expect(paused).toMatchObject({ status: "paused", pending: { toolName: "github.create_issue", namespace: "github" } });
  expect(active.calls.map((c) => c.name)).toEqual(["list_issues"]);
  const row = await m.get(paused.executionId);
  expect(row).toMatchObject({ kind: "direct", status: "paused", projection: "direct", call: { toolName: "github.create_issue", namespace: "github", request: '{"title":"t"}' } });
});

it("INVARIANT §4.1 (#41): a synchronous completion is `delivered` — result on the wire, NOT stored", async () => {
  active = await makeHarness();
  const m = createExecutionManager({ ...active.deps, direct: fast });
  const out = await m.startDirect("github.list_issues", {}, { clientId: null, projection: "direct", scope: permitDirect }).outcome;
  expect(out.status).toBe("completed");
  const row = await m.get(out.executionId);
  expect(row).toMatchObject({ kind: "direct", status: "completed", resultState: "delivered" });
  expect(row?.result).toBeUndefined();
});

it("INVARIANT §5.4 (#3): approve resumes a paused direct call, performs EXACTLY that call once, persists the result REDACTED as `retained`, reports decisionApplied", async () => {
  active = await makeHarness();
  await active.store.policies.upsert({ toolName: "github.create_issue", action: "require_approval", seededFrom: "review", manualOverride: true, redactFields: ["tool"] });
  const m = createExecutionManager({ ...active.deps, direct: fast });
  const paused = await m.startDirect("github.create_issue", { title: "t" }, { clientId: null, projection: "direct", scope: permitDirect }).outcome;
  const out = await m.resume(paused.executionId, { kind: "approve" }, await pendingCallOf(m, paused.executionId), permitDirect);
  expect(out).toMatchObject({ status: "completed", decisionApplied: true, value: { ok: true, tool: "[redacted]" } });
  expect(active.calls).toEqual([{ name: "create_issue", arguments: { title: "t" } }]);
  const row = await m.get(paused.executionId);
  expect(row).toMatchObject({ resultState: "retained", result: { ok: true, tool: "[redacted]" } });
});

it("INVARIANT §5.4 (#3): deny resolves the direct call as blocked with decisionApplied:true and no upstream call", async () => {
  active = await makeHarness();
  const m = createExecutionManager({ ...active.deps, direct: fast });
  const paused = await m.startDirect("github.create_issue", { title: "t" }, { clientId: null, projection: "direct", scope: permitDirect }).outcome;
  const out = await m.resume(paused.executionId, { kind: "deny" }, await pendingCallOf(m, paused.executionId), permitDirect);
  expect(out).toMatchObject({ status: "failed", decisionApplied: true, error: { name: "ConduitPolicyBlocked" } });
  expect(active.calls).toHaveLength(0);
});

it("INVARIANT §4.1 (#41): a deliverable over RESULT_BYTES_MAX is settled `discarded` in ONE write — sync AND resumed; an expanding redaction that fits raw but not redacted is discarded", async () => {
  // upstream fixture returns a 300 KB string for list_issues → sync discard
  active = await makeHarness({ respondToCall: (res, payload) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { big: "x".repeat(300_000) } })); } });
  const m = createExecutionManager({ ...active.deps, direct: fast });
  const out = await m.startDirect("github.list_issues", {}, { clientId: null, projection: "direct", scope: permitDirect }).outcome;
  expect(out).toMatchObject({ status: "completed", resultTooLarge: true });
  expect((out as { value?: unknown }).value).toBeUndefined();
  expect(await m.get(out.executionId)).toMatchObject({ status: "completed", resultState: "discarded" });
  // expanding redaction: build a fixture whose result is a 250 KB tree of 20,000 empty objects nested 65 deep
  // → raw 250 KB fits; redacted, every depth-64 object becomes the 12-byte "[redacted]" → > 256 KiB → resumed path settles discarded
  // (assert resultState "discarded", result undefined, outcome resultTooLarge:true, decisionApplied:true)
});

it("INVARIANT §5.3 (#22/#28): exactly-once settlement — the timer wins, a delayed SUCCESS never overwrites `failed`, the late continuation is discarded", async () => {
  active = await makeHarness({ respondToCall: (res, payload) => setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { late: true } })); }, 900) });
  const m = createExecutionManager({ ...active.deps, direct: fast });
  const handle = m.startDirect("github.list_issues", {}, { clientId: null, projection: "direct", scope: permitDirect });
  const out = await handle.outcome;
  expect(out).toMatchObject({ status: "failed", error: { name: "ConduitOutcomeAmbiguous" } }); // the body was written before the stall
  await handle.finished;
  expect(await m.get(out.executionId)).toMatchObject({ status: "failed", error: { name: "ConduitOutcomeAmbiguous" } });
});

it("INVARIANT §5.3 (#22): a delayed REFUSAL after timeout leaves the row failed under the timeout's own classification (pre-dispatch)", async () => {
  // a store whose tools.get stalls 900ms: the drive times out before dispatch
  active = await makeHarness();
  const slowStore = { ...active.store, tools: { ...active.store.tools, get: (n: string) => new Promise((r) => setTimeout(() => r(active!.store.tools.get(n)), 900)) } } as ConduitStore;
  const m = createExecutionManager({ ...active.deps, store: slowStore, direct: fast });
  const handle = m.startDirect("github.list_issues", {}, { clientId: null, projection: "direct", scope: permitDirect });
  const out = await handle.outcome;
  expect(out).toMatchObject({ status: "failed", error: { name: "ConduitExecutionInterrupted" } });
  expect(active.calls).toHaveLength(0);
  await handle.finished;
  expect(active.calls).toHaveLength(0); // late preparation never dispatches: deadline() expired before the write
});

it("INVARIANT §5.3 (#22 quarantine, #45): a never-returning store read still yields the timeout outcome within budget; retention reports `abandoned`; finished stays pending", async () => {
  active = await makeHarness();
  const never = new Promise<never>(() => {});
  const stuck = { ...active.store, tools: { ...active.store.tools, get: () => never } } as ConduitStore;
  const m = createExecutionManager({ ...active.deps, store: stuck, direct: fast });
  const t0 = Date.now();
  const handle = m.startDirect("github.list_issues", {}, { clientId: null, projection: "direct", scope: permitDirect });
  const out = await handle.outcome;
  expect(Date.now() - t0).toBeLessThan(fast.driveBudgetMs + fast.settleWriteBudgetMs + 200);
  expect(out).toMatchObject({ status: "failed", error: { name: "ConduitExecutionInterrupted" } });
  expect(await handle.retention).toBe("abandoned");
  expect(await Promise.race([handle.finished.then(() => "finished"), new Promise((r) => setTimeout(() => r("pending"), 50))])).toBe("pending");
});

it("INVARIANT §5.3 (#45): a stalled settle write yields status:\"unknown\" within budget, never a claimed terminalization; the write stays tracked", async () => {
  active = await makeHarness();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slowSettle = { ...active.store, executions: { ...active.store.executions,
    settleDirect: async (...a: Parameters<ConduitStore["executions"]["settleDirect"]>) => { await gate; return active!.store.executions.settleDirect(...a); } } } as ConduitStore;
  const m = createExecutionManager({ ...active.deps, store: slowSettle, direct: fast });
  const handle = m.startDirect("github.list_issues", {}, { clientId: null, projection: "direct", scope: permitDirect });
  const out = await handle.outcome;
  expect(out).toMatchObject({ status: "unknown", reason: "persist-timeout" });
  expect((await m.get(out.executionId))?.status).toBe("running"); // not yet persisted — honest
  release();
  await handle.finished;
  expect(await m.get(out.executionId)).toMatchObject({ status: "completed", resultState: "delivered" });
});

it("INVARIANT §5.3 (#22): retention is `released` when the continuation finishes within slotRetentionMs", async () => {
  active = await makeHarness();
  const m = createExecutionManager({ ...active.deps, direct: fast });
  const handle = m.startDirect("github.list_issues", {}, { clientId: null, projection: "direct", scope: permitDirect });
  await handle.outcome;
  expect(await handle.retention).toBe("released");
});

it("INVARIANT §4.1 (#25, discovery): a requestKey on the discovery projection conflicts within the client", async () => {
  active = await makeHarness();
  const m = createExecutionManager({ ...active.deps, direct: fast });
  const a = await m.startDirect("github.list_issues", {}, { clientId: "acme", projection: "discovery", requestKey: "k", scope: permitDirect }).outcome;
  const b = await m.startDirect("github.list_issues", {}, { clientId: "acme", projection: "discovery", requestKey: "k", scope: permitDirect }).outcome;
  expect(b).toEqual({ status: "conflict", executionId: a.executionId });
});

it("a direct row writes NO replay_journal rows and its Trace row carries projection/clientId", async () => {
  active = await makeHarness();
  const m = createExecutionManager({ ...active.deps, direct: fast });
  const out = await m.startDirect("github.list_issues", {}, { clientId: "acme", projection: "discovery", scope: permitDirect }).outcome;
  expect(await active.store.replayJournal.listByExecution(out.executionId)).toEqual([]);
  expect(await active.store.trace.listByExecution(out.executionId)).toMatchObject([{ projection: "discovery", clientId: "acme" }]);
});
```

- [ ] **Step 2: Run to verify failure** (unsandboxed) — `startDirect` is not a function.

- [ ] **Step 3: Implement `direct.ts`**

```ts
import { createDispatchCell, type DispatchCell } from "../pipeline/dispatch.js";
import type { ExecutionOutcome } from "./manager.js";

export interface DirectBudgets { /* as in Interfaces */ }
export const DIRECT_DEFAULTS: DirectBudgets = { driveBudgetMs: 60_000, settleWriteBudgetMs: 5_000, slotRetentionMs: 30_000, resultBytesMax: 262_144 };
export type DirectOutcome = ExecutionOutcome | { status: "unknown"; executionId: string; reason: "persist-timeout" };
export interface DirectDriveHandle { /* as in Interfaces */ }
export interface DirectDrive { /* as in Interfaces */ }

export function createDirectDrive(args: { executionId: string; attempt: string; now: () => number; budgetMs: number }): DirectDrive {
  const end = args.now() + args.budgetMs;
  let settled = false;
  return {
    executionId: args.executionId,
    attempt: args.attempt,
    dispatch: createDispatchCell(),
    deadline: () => end - args.now(),
    settle() { if (settled) return false; settled = true; return true; },
    get settled() { return settled; },
  };
}

/** UTF-8 size of what will be sent AND stored (§4.1 rev 17). */
export function deliverableBytes(deliverable: unknown): number {
  return Buffer.byteLength(JSON.stringify(deliverable) ?? "null", "utf8");
}
```

- [ ] **Step 4: Implement the manager arm** (`manager.ts`)

Types: `ExecutionOutcome`'s completed arm becomes `{ status: "completed"; executionId: string; value: unknown; resultTooLarge?: true }`. `ExecutionManagerDeps.direct?: Partial<DirectBudgets>`. `ExecutionManager.startDirect` per Interfaces.

Shared core used by BOTH `startDirect` and the direct resume arm:

```ts
  interface DirectRun {
    execution: Extract<Execution, { kind: "direct" }>;
    drive: DirectDrive;
    scope: () => Promise<EffectiveScope>;
    decisions?: ApprovalDecisions;
    /** resumed path: redact before measuring; sync path: raw */
    redactFields?: readonly string[];
    resolveOutcome: (o: DirectOutcome) => void;
    tracked: Promise<unknown>[]; // settle writes still in flight
  }

  /** Bounded settle: resolve the outcome at most settleWriteBudgetMs after the write starts. */
  async function settleBounded(run: DirectRun, settle: DirectSettle, outcome: DirectOutcome): Promise<void> {
    const write = deps.store.executions.settleDirect(run.execution.id, run.drive.attempt, settle).catch(() => false);
    run.tracked.push(write);
    const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), budgets.settleWriteBudgetMs));
    const winner = await Promise.race([write.then(() => "written" as const), timer]);
    run.resolveOutcome(winner === "written" ? outcome : { status: "unknown", executionId: run.execution.id, reason: "persist-timeout" });
  }

  function classifyDirectFailure(run: DirectRun, cause: unknown): ExecutionError {
    if (run.drive.dispatch.state === "dispatched" || (cause instanceof Error && cause.name === OUTCOME_AMBIGUOUS_ERROR_NAME)) {
      return { name: OUTCOME_AMBIGUOUS_ERROR_NAME, message: `[ExecutionManager] Direct call failed after dispatch; the upstream may have performed the call. Context: { executionId: ${run.execution.id} }` };
    }
    return toSandboxError(cause);
  }

  /** The one continuation. Never throws. */
  async function runDirect(run: DirectRun): Promise<void> {
    const { execution, drive } = run;
    const timer = setTimeout(() => {
      if (!drive.settle()) return;
      const error: ExecutionError = drive.dispatch.state === "dispatched"
        ? classifyDirectFailure(run, new Error("budget elapsed after dispatch"))
        : { name: "ConduitExecutionInterrupted", message: `[ExecutionManager] Direct drive budget elapsed before dispatch (${budgets.driveBudgetMs}ms). Context: { executionId: ${execution.id} }` };
      void settleBounded(run, { status: "failed", error }, { status: "failed", executionId: execution.id, error });
    }, budgets.driveBudgetMs);
    let upstreamSession: UpstreamSessionScope | undefined;
    try {
      upstreamSession = makeUpstreamSession();
      const invoke = deps.makeInvoker({ executionId: execution.id, deadline: drive.deadline, upstreamSession, projection: execution.projection, clientId: execution.clientId, scope: run.scope, dispatch: drive.dispatch, ...(run.decisions !== undefined ? { decisions: run.decisions } : {}) });
      const value = await invoke(execution.call.toolName, JSON.parse(execution.call.request));
      if (!drive.settle()) return; // timer won; discard
      const deliverable = run.redactFields === undefined ? value : redactSensitiveFields(value, run.redactFields);
      if (deliverableBytes(deliverable) > budgets.resultBytesMax) {
        await settleBounded(run, { status: "completed", resultState: "discarded" }, { status: "completed", executionId: execution.id, value: undefined, resultTooLarge: true });
      } else if (run.redactFields === undefined) {
        await settleBounded(run, { status: "completed", resultState: "delivered" }, { status: "completed", executionId: execution.id, value: deliverable });
      } else {
        await settleBounded(run, { status: "completed", resultState: "retained", result: deliverable }, { status: "completed", executionId: execution.id, value: deliverable });
      }
    } catch (cause) {
      if (!drive.settle()) return;
      if (cause instanceof Error && cause.name === GUEST_ERROR_NAMES.policyDenied && run.decisions === undefined) {
        // §5.4 startDirect step 5: pause, provenance read immediately before the write
        const namespace = execution.call.namespace;
        const generation = await deps.store.sources.getGeneration(namespace);
        if (generation === undefined) {
          const error = { name: "ConduitCatalogChanged", message: `[ExecutionManager] Approval pause refused: no source for namespace. Context: { executionId: ${execution.id} }` };
          await settleBounded(run, { status: "failed", error }, { status: "failed", executionId: execution.id, error });
          return;
        }
        const pending: PendingApproval = { callId: newId(), toolName: execution.call.toolName, namespace, sourceGeneration: generation, input: JSON.parse(execution.call.request), reason: cause.message, expiresAt: now() + resolveApprovalTtlMs() };
        await settleBounded(run, { status: "paused", pausedOn: pending }, { status: "paused", executionId: execution.id, pending });
        return;
      }
      const error = classifyDirectFailure(run, cause);
      await settleBounded(run, { status: "failed", error }, { status: "failed", executionId: execution.id, error });
    } finally {
      clearTimeout(timer);
      await upstreamSession?.dispose().catch(() => {});
      await Promise.allSettled(run.tracked);
    }
  }
```

`startDirect`:

```ts
    startDirect(toolName, input, opts) {
      const executionId = `exec_${newId()}`;
      const attempt = newId();
      const drive = createDirectDrive({ executionId, attempt, now, budgetMs: budgets.driveBudgetMs }); // timer starts here, before any async prep
      let resolveOutcome!: (o: DirectOutcome) => void;
      const outcome = new Promise<DirectOutcome>((r) => { resolveOutcome = r; });
      let markSettled!: () => void;
      const settledAt = new Promise<void>((r) => { markSettled = r; });
      const finished = (async () => {
        const request = JSON.stringify(input);
        if (request === undefined) { // decoder guarantees a JSON value; defend the public SDK entrypoint
          const error = { name: "ConduitInternalError", message: "[ExecutionManager] startDirect refused: input is not a JSON value." };
          resolveOutcome({ status: "failed", executionId, error }); return;
        }
        const execution: Extract<Execution, { kind: "direct" }> = {
          id: executionId, kind: "direct", status: "running", startedAt: now(), clientId: opts.clientId, projection: opts.projection,
          call: { toolName, namespace: namespaceOf(toolName) ?? "", request },
          ...(opts.requestKey !== undefined ? { requestKey: opts.requestKey } : {}),
        };
        try { await deps.store.executions.create(execution, { attempt }); }
        catch (cause) { /* same conflict mapping as start(); resolveOutcome({status:"conflict",...}) or failed */ return; }
        const run: DirectRun = { execution, drive, scope: bindScope(opts.scope, opts.clientId), resolveOutcome: (o) => { resolveOutcome(o); markSettled(); }, tracked: [] };
        await runDirect(run);
      })().catch(() => {});
      const retention = Promise.race([
        finished.then(() => "released" as const),
        settledAt.then(() => new Promise<"abandoned">((r) => setTimeout(() => r("abandoned"), budgets.slotRetentionMs))),
      ]);
      return { executionId, outcome, retention, finished };
    },
```

(Keep timers from pinning the event loop in tests: `.unref()` the retention timer; clear it in `finished.then`.)

Direct resume arm — replaces Task 9's placeholder, after step 4:

```ts
        if (execution.kind === "direct") {
          const decisions = makeDecisions();
          decisions.stage(executionId, { op: "call", toolName: execution.call.toolName, request: execution.call.request }, decision);
          const policyRow = await deps.store.policies.get(execution.call.toolName);
          const drive = createDirectDrive({ executionId, attempt: resumeAttemptId, now, budgetMs: budgets.driveBudgetMs });
          let resolveOutcome!: (o: DirectOutcome) => void;
          const outcome = new Promise<DirectOutcome>((r) => { resolveOutcome = r; });
          const running = { ...execution, status: "running" as const }; delete running.pausedOn;
          void runDirect({ execution: running, drive, scope, decisions, redactFields: policyRow?.redactFields ?? [], resolveOutcome, tracked: [] });
          const settled = await outcome;
          const decisionApplied = decisions.consumed(executionId);
          if (settled.status === "unknown") {
            // D-A11: the wire has no "unknown" arm yet (Lane B). Honest failure name; the write stays tracked.
            return { status: "failed", executionId, error: { name: "ConduitPersistTimeout", message: `[ExecutionManager] Settle write did not complete within budget; the row may still update. Context: { executionId: ${executionId} }` }, decisionApplied };
          }
          return { ...settled, decisionApplied };
        }
```

(`bindScope` for resume was computed in Task 9 step 4 as `scope`.) `budgets = { ...DIRECT_DEFAULTS, ...deps.direct }` at manager construction.

- [ ] **Step 5: Exports** — `index.ts`: `DirectBudgets`, `DirectDriveHandle`, `DirectOutcome`, `DirectDrive` types; `DIRECT_DEFAULTS`, `createDirectDrive`, `deliverableBytes`.

- [ ] **Step 6: Run the manager suite (unsandboxed), SDK suite, root typecheck** — PASS. `payloads.ts`'s `outcomeToPayload` still compiles: the completed arm's extra optional field is ignored by the projection (Lane B adds `resultTooLarge` to the wire).

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src
git commit -m "feat(sdk): direct execution arm — startDirect, direct resume, result states, exactly-once settle"
```

---

### Task 11: D5 harness, ledger rows, G1–G3, retry-row rewording (§9.1–§9.3; rows #2, #10, #11, #27, #42 via the harness)

**Files:**
- Create: `packages/sdk/src/execution/projection-harness.test.ts`
- Modify: `INVARIANTS.md`
- Modify: `packages/mcp/src/server.test.ts` (G1 rename, line ~185)
- Modify: `packages/sdk/src/store/sqlite.test.ts` (G2 rename, lines ~188 and ~204)

**Interfaces:** consumes everything above; produces no code interface.

- [ ] **Step 1: Write the harness** — ONE fixture set, parameterized over the three valid `(kind, projection)` pairs. A per-projection copy of any of these tests is a review REJECT (§9.2).

```ts
// packages/sdk/src/execution/projection-harness.test.ts
import { afterEach, describe, expect, it } from "vitest";
// reuse makeHarness / pendingCallOf / SECRET / PREFIX by extracting them from manager.test.ts into
// packages/sdk/src/execution/manager-harness.ts (test-only module; not exported from index.ts)
import { ALL_TOOLS, buildEffectiveScope, type ScopeResolver } from "../scope.js";
import { createExecutionManager, type ExecutionManager } from "./manager.js";
import { type Harness, makeHarness, pendingCallOf } from "./manager-harness.js";

type Pair = { kind: "code"; projection: "code" } | { kind: "direct"; projection: "direct" } | { kind: "direct"; projection: "discovery" };
const PAIRS: Pair[] = [{ kind: "code", projection: "code" }, { kind: "direct", projection: "direct" }, { kind: "direct", projection: "discovery" }];
const permitAll: (h: Harness) => ScopeResolver = (h) => async () =>
  buildEffectiveScope({ projections: { code: true, direct: true, discovery: true }, allow: ALL_TOOLS }, await h.store.tools.list());

/** One entry point per pair: performs `tool(input)` once, returns the outcome and the execution id. */
async function performOnce(m: ExecutionManager, h: Harness, pair: Pair, tool: string, input: unknown, opts: { clientId: string | null; requestKey?: string }) {
  if (pair.kind === "code") {
    const path = tool.split(".").join(".");
    return m.start(`return await tools.${path}(${JSON.stringify(input)});`, { ...opts, scope: permitAll(h) });
  }
  return m.startDirect(tool, input, { ...opts, projection: pair.projection, scope: permitAll(h) }).outcome;
}

describe.each(PAIRS)("D5 harness — kind=$kind projection=$projection", (pair) => {
  let active: Harness | undefined;
  afterEach(async () => { await active?.cleanup(); active = undefined; });

  it("INVARIANT §9.2 (#2): the credential never appears in the result, the Trace, or the replay journal", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const out = await performOnce(m, active, pair, "github.list_issues", { owner: "o" }, { clientId: "acme" });
    expect(out.status).toBe("completed");
    const everything = JSON.stringify([out, await active.store.trace.listByExecution(out.executionId), await active.store.replayJournal.listByExecution(out.executionId), await m.get(out.executionId)]);
    expect(everything).not.toContain("ghp_manager_secret");
  });

  it("INVARIANT §4.3 (#10/#27): every Trace row carries this pair's projection and the client id, so Trace is comparable across projections", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const out = await performOnce(m, active, pair, "github.list_issues", {}, { clientId: "acme" });
    const rows = await active.store.trace.listByExecution(out.executionId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect([r.projection, r.clientId, r.toolName, r.policyVerdict]).toEqual([pair.projection, "acme", "github.list_issues", "allow"]);
  });

  it("INVARIANT §4.1 (#11): the same requestKey from the same client conflicts and returns the first execution's id; a different client does not", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const a = await performOnce(m, active, pair, "github.list_issues", {}, { clientId: "acme", requestKey: "rk" });
    const b = await performOnce(m, active, pair, "github.list_issues", {}, { clientId: "acme", requestKey: "rk" });
    expect(b).toEqual({ status: "conflict", executionId: a.executionId });
    const c = await performOnce(m, active, pair, "github.list_issues", {}, { clientId: "beta", requestKey: "rk" });
    expect(c.status).toBe("completed");
  });

  it("INVARIANT §4.1 (#42/#14): a re-provisioned namespace makes the paused row resume to ConduitCatalogChanged", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const paused = await performOnce(m, active, pair, "github.create_issue", { title: "t" }, { clientId: null });
    expect(paused.status).toBe("paused");
    await active.reprovision(); // harness helper: provisionSource with the same rows → triggers bump the generation
    const out = await m.resume(paused.executionId, { kind: "approve" }, await pendingCallOf(m, paused.executionId), permitAll(active));
    expect(out).toMatchObject({ status: "failed", decisionApplied: false, error: { name: "ConduitCatalogChanged" } });
    expect(active.calls.map((c) => c.name)).not.toContain("create_issue");
  });
});
```

Note the discovery pair passes `requestKey` on the `startDirect` call and the direct pair passes none for the conflict test — adjust: for `projection: "direct"` the #11 case asserts instead that `startDirect` is called WITHOUT a key (A4) and two identical calls both complete (two executions). Write that as a branch inside the test on `pair.projection === "direct"`.

- [ ] **Step 2: Extract the harness** — move `startMcpServer`, `makeHarness`, `pendingCallOf`, `SECRET`, `PREFIX`, `mcpToolsList`, `Harness` from `manager.test.ts` into `manager-harness.ts` (same directory, `*.ts` not `*.test.ts`, so vitest does not run it as a suite; import it from `manager.test.ts`). Add `Harness.reprovision(): Promise<void>`.

- [ ] **Step 3: Run the harness and the manager suite** (unsandboxed) — PASS, 12 harness cases.

- [ ] **Step 4: G1 and G2 renames**

- `packages/mcp/src/server.test.ts:185`: rename `"tools/list exposes exactly execute + check_execution, with fresh connections"` → `"INVARIANT §4.2: the Code Mode projection advertises exactly two tools — execute + check_execution — with fresh connections"`.
- `packages/sdk/src/store/sqlite.test.ts:188`: rename `"claimForResume: exactly one caller wins the paused→running transition"` → `"INVARIANT §5.5: claimForResume is an exactly-one-winner CAS — one caller wins the paused→running transition"`; `:204` → `"INVARIANT §5.5: claimForResume returns false when the row is not paused"`.

- [ ] **Step 5: Ledger edits** (`INVARIANTS.md`)

Reword (the §18-C4 retry rows, lines 52–54): prefix each claim with "For side-effect-free operations only (`initialize`, `tools/list`; a governed `tools/call` is NEVER retried — §7, row #21 below): ". Reword lines 23 and 37 ("execute surface …") to "the Code Mode projection's `execute` surface …" citing "spec §18 R1 entry".

Add ONE row for G1 and G2 each:
- `| §4.2 — the Code Mode projection advertises exactly two tools | packages/mcp/src/server.test.ts ("INVARIANT §4.2: the Code Mode projection advertises exactly two tools …") | ✅ pinned |`
- `| §5.5 — claimForResume is an exactly-one-winner CAS | packages/sdk/src/store/sqlite.test.ts ("INVARIANT §5.5: claimForResume is an exactly-one-winner CAS …") | ✅ pinned |`

Add a new section header `### R1 (spec 2026-09-05, §9.1)` and one row per §9.1 row #1–#50 (excluding #46 and #49, already present), copying the claim column VERBATIM from the spec's table and the test column as the spec names it. Status:
- ✅ for rows pinned in this PR: #1, #2 (harness), #3, #8, #9, #10, #11, #14 (manager + store halves; the `daemon/provision.test.ts` sweep-placement half stays ⏳ and is noted in the row), #15, #16 (manager half; daemon half ⏳ noted), #17, #18 (manager half; daemon half ⏳ noted), #19, #21 (client + manager; the Lane C description statement noted ⏳), #22, #24, #25, #27, #28, #41 (manager + store; `payloads.test.ts` half ⏳ noted), #42, #43 (execute.test.ts — note the D-A6 file deviation), #45, #47, #50.
- ⏳ for every Lane B/C row: #4, #5, #6, #7, #12, #13, #20, #23, #26, #29, #30–#40, #44, #48.

Add the two data-model pins (§9.1 tail): request round-trip (`sqlite.test.ts`) and the kind guard (`sqlite.test.ts`), both ✅. Add the three ambiguity invariants (§7): crash-before-persist over a direct row (`sqlite.test.ts`, ✅), keyless no-retry (`mcp-client.test.ts`, ✅; Lane C description ⏳), timeout-unknown pre/post dispatch (`manager.test.ts`, ✅).

- [ ] **Step 6: Root verify**

Run (unsandboxed): `pnpm typecheck && pnpm test && pnpm lint`
Expected: PASS across sdk, mcp, cli.

- [ ] **Step 7: Commit**

```bash
git add packages INVARIANTS.md
git commit -m "test(sdk): D5 projection harness; ledger R1 rows, G1–G3, retry rows reworded"
```

- [ ] **Step 8: Open the PR (do not merge)**

```bash
git push -u origin feat/r1-lane-a
gh pr create --draft --title "feat(sdk): R1 Lane A — store + manager (kind, provenance, direct arm, D5 harness)" --body-file <scratchpad>/pr-body.md
```

PR body must carry: the two one-way doors (404 retry removed for Code Mode; sentinel in `code` for every new row), the "Deviations" section (D-A6, D-A11, plus anything logged during execution), and the gauntlet checklist from CLAUDE.md (Tier 2: `/pr-review-toolkit:review-pr all parallel` pre-PR; `code-review:code-review` post-PR; `aikido:scan` + `/security-review`; raw `codex exec` at `high` — triggers: authorization boundary, persistence invariant, concurrency/latch, >8 files). Then `/explain-diff` and post the artifact title in the PR (never the URL). Merge only on the founder's word after a full quiz pass.

## Self-review (run after all tasks are written)

1. **Spec coverage.** Every §10 Lane A item maps to a task: §4 columns (T2–T4), §5.4 (T8–T10), §5.5 dispatch cell (T5–T6), `EffectiveScope`/`ScopeResolver` types (T1), request keys (T3), D5 harness (T11), ambiguity invariants manager side (T5, T6, T10), rows #1–#3/#9/#15/#16/#17/#18/#19/#21/#25/#41/#42/#47/#50 (per task map), G1–G3 (T11). Gaps knowingly left: row #45's "unknown" wording on the RESUME wire (D-A11, Lane B); row #14's sweep-placement half and row #43's `catalog.test.ts` naming (D-A6) — all recorded as deviations.
2. **Placeholder scan.** Two test bodies in Task 8 and one in Task 10 carry a `// (…)` instruction instead of full code (the raw-client sentinel assertion, the flag-flip hook, the expanding-redaction fixture, the `reprovision` helper). The executor writes them from the instruction; each names the exact assertion. Everything else is complete.
3. **Type consistency.** Names used across tasks: `create`/`put`/`settleDirect`/`invalidatePaused`/`getByRequestKey(key, clientId)`/`getGeneration` (T2–T4 → T8–T10); `bindScope`, `defaultScopeResolver`, `namespaceOf`, `buildEffectiveScope`, `ALL_TOOLS` (T1 → T6–T10); `createDispatchCell`, `DispatchCell`, `OUTCOME_AMBIGUOUS_ERROR_NAME`, `ConduitOutcomeAmbiguous` (T5 → T6, T8, T10); `makeInvoker` args and `makeToolHost(invoke, scoped?)` (T8 → T9, T10, runtime.ts); `DirectSettle` (T2 → T10); `hasProvenance` (T1 → T9). Checked consistent.
