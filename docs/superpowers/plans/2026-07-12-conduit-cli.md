# conduit CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the minimal `conduit` CLI (spec §17 step 3: `serve`, `add-mcp`, `approvals list|approve|deny`) as a new `packages/cli`, over SDK/mcp seams extracted for reuse.

**Architecture:** Two lanes. **Lane A** adds/extracts the shared seams in `packages/sdk` and `packages/mcp` (each lands with its INVARIANT test in the same commit). **Lane B** builds the CLI commands, which consume Lane A. Read-current-state-first governs every `add-mcp` second-run path. Credentials never reach argv or output.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspace, tsup (build), vitest (test), biome (lint), `@libsql/client` (SQLite), `@modelcontextprotocol/sdk`.

**Design source (authoritative):** `docs/superpowers/specs/2026-07-12-conduit-cli-design.md`. Read it before starting; every task below traces to a section there.

## Global Constraints

- The agent NEVER installs packages. If a dep is needed, STOP and hand the user the exact command; `packages/cli` should need ZERO new third-party deps (reuse sdk/mcp deps).
- Node `>=20`; `"type": "module"`; ESM imports carry `.js` extensions (NodeNext).
- No secrets in the repo; `.env*` gitignored. A credential value NEVER appears in stdout/stderr/logs/errors on any path.
- A module implementing a spec/mcp invariant MUST land with its invariant test in the SAME commit; the `INVARIANTS.md` ledger row flips in that commit. Invariant test names carry an `INVARIANT §x.y:` (or `INVARIANT /mcp Mx:`) prefix.
- Conventional Commits (`feat:`/`refactor:`/`test:`). Load-bearing PR: branch from `origin/main`, PR routing, Tier 2 + `/security-review` + real `codex exec` pass, `/explain-diff` + full-pass quiz, human-named merge. The agent does NOT merge.
- Binaries: `packages/sdk/node_modules/.bin/{vitest,tsc}` (cd into the package); `node_modules/.bin/biome` from repo root. Loopback/spawned-bin suites HANG in the Bash sandbox — the pre-commit hook (unsandboxed) is the authoritative run.

---

## TWEAKABLE INTERFACES (review these first — highest blast radius)

These three signatures are the load-bearing, hardest-to-reverse decisions. If any changes, it changes multiple downstream tasks. **The implementer must STOP and ask if reality forces a deviation from any of these three.** Everything after them is mechanical.

### T-I1 — `ExecutionRepository.listPaused` (Task 1)
```ts
// packages/sdk/src/store/store.ts — add to interface ExecutionRepository
/** Paused executions awaiting a human, oldest-first (spec §10.2 approval queue). */
listPaused(): Promise<Execution[]>;
```
Impl: `SELECT * FROM executions WHERE status='paused' ORDER BY started_at ASC, id ASC` through the existing `hydrateExecutionRow`. Full `Execution[]` (not a projection — design §3). The `id` tiebreak is load-bearing for determinism.

### T-I2 — `ConduitStore.provisionSource` (Task 2)
```ts
// packages/sdk/src/store/store.ts — add to interface ConduitStore (atomic §5.3 chain)
/**
 * Atomically write the §5.3 resolution chain for one source (spec §17 CLI).
 * All-or-nothing: a mid-chain failure leaves ZERO rows for this source.
 * `secret`/`credentialRef` are paired — provide both or neither.
 */
provisionSource(input: {
  source: Source;
  integration: Integration;
  connection: Connection;      // connection.credentialRef already resolved by the caller (preserve/clear decided upstream)
  secret?: { ref: string; value: string };  // present iff a NEW secret is being stored this run
  tools: readonly Tool[];
}): Promise<void>;
```
Runs as ONE libSQL transaction (same `client.batch(..., "write")` mechanism `replaceNamespace` uses). Writes NO policy rows (design §2.2). The caller resolves `connection.credentialRef` BEFORE calling (read-current-state-first, design §4) — this method does not read existing state.

### T-I3 — `createApprovalRuntime` (Task 5)
```ts
// packages/mcp/src/runtime.ts (new) — exported from packages/mcp/src/index.ts
export interface ApprovalRuntime { manager: ExecutionManager; }
/**
 * The shared manager composition (design §7.3): fresh catalog snapshot + policy
 * + credentials + egress-aware upstream + sandbox, wired to the decisions seam.
 * Used by BOTH server.ts's execute handler AND the CLI's approvals commands, so
 * the security-critical wiring (esp. the egress env) has ONE home.
 */
export async function createApprovalRuntime(opts: {
  store: ConduitStore;
  allowPrivateEgress: boolean;
  log?: (line: string) => void;
}): Promise<ApprovalRuntime>;
```
The `manager` is a fully-composed `ExecutionManager` (see `ExecutionManagerDeps` — Task 5 shows the exact body lifted from server.ts:184-200).

**Degrees of freedom (implementer may improvise WITHOUT asking):** test-file internal structure and helper names; error-message wording (keep the `[Module] ...` format); column ordering in `approvals list` human output; exact `--json` field casing as long as it round-trips; whether Task 4's `openStoreFromEnv` returns `{env, store}` or a richer object (callers use `.store` and `.env.allowPrivateEgress`).

**Must STOP and ask:** any change to T-I1/T-I2/T-I3 signatures; adding a third-party dep; touching the §9.2/§9.3 boundary semantics; any change to what `replaceNamespace` or `claimForResume` do; making `provisionSource` read existing state (it must not — the caller does that).

---

# LANE A — SDK/mcp seams (MUST land before Lane B)

### Task 1: `listPaused` on ExecutionRepository

**Files:**
- Modify: `packages/sdk/src/store/store.ts` (add method to `ExecutionRepository`)
- Modify: `packages/sdk/src/store/sqlite.ts` (implement in the `executions` object, ~line 428-495)
- Test: `packages/sdk/src/store/sqlite.test.ts`
- Modify: `INVARIANTS.md` (new row)

**Interfaces:**
- Consumes: existing `hydrateExecutionRow(row, id)`, existing `Execution` type.
- Produces: `ExecutionRepository.listPaused(): Promise<Execution[]>` (T-I1).

- [ ] **Step 1: Write the failing test**
```ts
// in sqlite.test.ts
it("INVARIANT: listPaused returns only paused rows, oldest-first with id tiebreak", async () => {
  const store = await freshStore(); // use the file's existing store-factory helper
  const base = { code: "x", seeds: { now: 1, random: 1 }, startedAt: 0 } as const;
  const pending = { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 9e12 };
  // two paused rows with the SAME startedAt → id tiebreak must order them
  await store.executions.put({ ...base, id: "exec_b", status: "paused", startedAt: 100, pausedOn: pending });
  await store.executions.put({ ...base, id: "exec_a", status: "paused", startedAt: 100, pausedOn: pending });
  await store.executions.put({ ...base, id: "exec_old", status: "paused", startedAt: 50, pausedOn: pending });
  await store.executions.put({ ...base, id: "exec_done", status: "completed", startedAt: 10 });
  const paused = await store.executions.listPaused();
  expect(paused.map((e) => e.id)).toEqual(["exec_old", "exec_a", "exec_b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd packages/sdk && node_modules/.bin/vitest run src/store/sqlite.test.ts -t "listPaused"`
Expected: FAIL — `listPaused is not a function`.

- [ ] **Step 3: Add the interface method**
In `store.ts`, inside `interface ExecutionRepository`, add after `failClaimedResume`:
```ts
  /** Paused executions awaiting a human, oldest-first (spec §10.2 approval queue). */
  listPaused(): Promise<Execution[]>;
```

- [ ] **Step 4: Implement in sqlite.ts**
In the `executions` object (after `failClaimedResume`):
```ts
      async listPaused(): Promise<Execution[]> {
        const rs = await client.execute(
          "SELECT * FROM executions WHERE status = 'paused' ORDER BY started_at ASC, id ASC",
        );
        return rs.rows.map((row) => hydrateExecutionRow(row, text(row, "id")));
      },
```

- [ ] **Step 5: Run test to verify it passes**
Run: `cd packages/sdk && node_modules/.bin/vitest run src/store/sqlite.test.ts -t "listPaused"`
Expected: PASS.

- [ ] **Step 6: Flip the INVARIANTS row + commit**
Add to `INVARIANTS.md` table:
`| /mcp CLI — approvals queue lists paused executions oldest-first (deterministic (started_at, id)) | packages/sdk/src/store/sqlite.test.ts | ✅ pinned |`
```bash
git add packages/sdk/src/store/store.ts packages/sdk/src/store/sqlite.ts packages/sdk/src/store/sqlite.test.ts INVARIANTS.md
git commit -F <msg>   # feat: listPaused — paused-execution queue for approvals list (deterministic order)
```

---

### Task 2: `provisionSource` — atomic §5.3 chain

**Files:**
- Modify: `packages/sdk/src/store/store.ts` (add `provisionSource` to `ConduitStore`)
- Modify: `packages/sdk/src/store/sqlite.ts` (implement; reuse the `client.batch(stmts, "write")` pattern from `replaceNamespace`)
- Test: `packages/sdk/src/store/sqlite.test.ts`
- Modify: `INVARIANTS.md`

**Interfaces:**
- Consumes: existing `Source`/`Integration`/`Connection`/`Tool` types; the libSQL `client`.
- Produces: `ConduitStore.provisionSource(input)` (T-I2).

- [ ] **Step 1: Write the failing test** (atomicity — a bad tool row rolls back the whole chain)
```ts
it("INVARIANT: provisionSource is atomic — a mid-chain failure leaves 0 rows", async () => {
  const store = await freshStore();
  const good = { source: { id: "src_x", type: "mcp", namespace: "x", location: "http://u" },
    integration: { id: "int_x", sourceId: "src_x", namespace: "x" },
    connection: { id: "conn_x", integrationId: "int_x", prefix: "x.acme.prod", credentialRef: "cred_x" },
    secret: { ref: "cred_x", value: "Bearer t" },
    tools: [/* one INVALID tool that violates a NOT NULL/CHECK to force rollback */] };
  await expect(store.provisionSource(good as any)).rejects.toThrow();
  expect(await store.sources.get("src_x")).toBeUndefined();
  expect(await store.connections.getByPrefix("x.acme.prod")).toBeUndefined();
  expect(await store.secrets.reveal("cred_x")).toBeUndefined();
});
// plus a happy-path test: provisionSource writes all rows + NO policy rows.
```
(Implementer note: construct the invalid tool from the `tools` insert's actual NOT NULL/CHECK columns — read the `replaceNamespace` INSERT in sqlite.ts to see which column to violate. This is a degree of freedom.)

- [ ] **Step 2: Run to verify FAIL** — `provisionSource is not a function`.

- [ ] **Step 3: Add interface method** (T-I2 block) to `ConduitStore` in `store.ts`.

- [ ] **Step 4: Implement in sqlite.ts** as one write-batch. Build the statement array in §5.3 order (source, integration, connection, secret if present — encrypt via the same path `secrets.put` uses, tools DELETE+INSERT like `replaceNamespace`), then `await client.batch(statements, "write")`. Read `replaceNamespace` and `secrets.put` in the same file for the exact SQL and the SecretBox encryption call; mirror them. NO policy INSERTs.

- [ ] **Step 5: Run to verify PASS** (both atomicity + happy-path).

- [ ] **Step 6: Flip INVARIANTS row + commit**
`| /mcp CLI — add-mcp provisioning is atomic + seeds NO policy rows | packages/sdk/src/store/sqlite.test.ts | ✅ pinned |`
Commit: `feat: provisionSource — atomic §5.3 chain for add-mcp (no policy rows)`

---

### Task 3: extract `runStdioServer` + fold in the M8 redirect

**Files:**
- Create: `packages/mcp/src/runtime-stdio.ts` (the extracted startup)
- Modify: `packages/mcp/src/bin.ts` (becomes a thin shim calling it; drops its own top-level redirect)
- Modify: `packages/mcp/src/index.ts` (export `runStdioServer`)
- Test: `packages/mcp/src/integration.test.ts` (existing M8 test stays; behavior unchanged)

**Interfaces:**
- Consumes: `resolveEnv`, `ensureDbDir`, `openSqliteStore`, `SecretBox`, `createConduitMcpServer`, `StdioServerTransport`.
- Produces: `runStdioServer(opts?: { env?: NodeJS.ProcessEnv }): Promise<void>`.

- [ ] **Step 1** — Verify current M8 test passes as baseline:
`cd packages/mcp && npm run build && node_modules/.bin/vitest run src/integration.test.ts -t "stdout"`
Expected: PASS (this is the regression anchor — it MUST stay green after the move).

- [ ] **Step 2** — Create `runtime-stdio.ts`. Move bin.ts's body verbatim: the `openStoreFromEnv` sequence (Task 4 will factor this further — for now inline it), egress warning, empty-catalog notice, `createConduitMcpServer`, `connect(new StdioServerTransport())`. Make the `console.*`→stderr redirect the FIRST statements INSIDE the exported function (not module top-level):
```ts
export async function runStdioServer(opts: { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const toStderr = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(" ")}\n`);
  console.log = toStderr; console.info = toStderr; console.warn = toStderr; console.error = toStderr;
  const env = resolveEnv(opts.env ?? process.env);
  // ...rest of the moved startup...
}
```

- [ ] **Step 3** — Rewrite `bin.ts` as a shim: keep `--version`/`--help`/`--doctor` handling (those stay in the bin), and for the serve path call `await runStdioServer()`. Remove the module-top-level `console.*` reassignment (runStdioServer owns it now). Export `runStdioServer` from `index.ts`.

- [ ] **Step 4** — Rebuild + run the FULL mcp suite (M8 test + flags/doctor tests must all pass):
`cd packages/mcp && npm run build && node_modules/.bin/vitest run`
Expected: all PASS — proves the extraction preserved observable behavior (M8 on the old door).

- [ ] **Step 5: Commit** — `refactor: extract runStdioServer; fold M8 redirect into it (shared by conduit-mcp + conduit serve)`

---

### Task 4: extract `openStoreFromEnv`

**Files:**
- Modify: `packages/mcp/src/runtime-stdio.ts` (use the extracted helper) OR a small `packages/mcp/src/store-open.ts`
- Modify: `packages/mcp/src/index.ts` (export it)
- Test: `packages/mcp/src/env.test.ts` or a new unit test

**Interfaces:**
- Consumes: `resolveEnv`, `ensureDbDir`, `createClient`, `openSqliteStore`, `SecretBox`.
- Produces: `openStoreFromEnv(env?: NodeJS.ProcessEnv): Promise<{ env: ResolvedEnv; store: ConduitStore }>`.

- [ ] **Step 1** — Write a unit test: `openStoreFromEnv` with a valid env opens a store whose `sources.list()` returns `[]` on a fresh temp db; with a missing key it rejects with the `resolveEnv` message.
- [ ] **Step 2** — Run → FAIL.
- [ ] **Step 3** — Implement (lift the sequence from bin.ts/runtime-stdio); have `runStdioServer` call it internally.
- [ ] **Step 4** — Run the unit test + full mcp suite → PASS (behavior preserved).
- [ ] **Step 5: Commit** — `refactor: extract openStoreFromEnv (shared env→store for CLI + server)`

---

### Task 5: extract `createApprovalRuntime`

**Files:**
- Create: `packages/mcp/src/runtime.ts`
- Modify: `packages/mcp/src/server.ts` (execute handler calls the factory instead of inlining the composition at ~184-200)
- Modify: `packages/mcp/src/index.ts` (export `createApprovalRuntime`, `ApprovalRuntime`)
- Test: `packages/mcp/src/runtime.test.ts` + existing `server.test.ts` must stay green

**Interfaces:**
- Consumes: `createExecutionManager`, `createToolInvoker`, `createCatalogToolHost`, `InMemoryCatalog`, `createStorePolicyEngine`, `createStoreCredentialResolver`, `createMcpUpstreamCaller`, `QuickJSSandbox`.
- Produces: `createApprovalRuntime(opts)` (T-I3).

- [ ] **Step 1** — Write a test: `createApprovalRuntime({store, allowPrivateEgress:false})` returns `{manager}`; the manager can `start` a trivial code string and reach a terminal outcome (reuse a fixture like server.test.ts's).
- [ ] **Step 2** — Run → FAIL.
- [ ] **Step 3** — Implement `runtime.ts` by lifting the EXACT block from server.ts:184-200 (the `createExecutionManager({store, sandbox, makeInvoker, makeToolHost})` composition), parameterized by `{store, allowPrivateEgress, log}`. Build `sandbox/policy/credentials/upstream` inside (same lines as server.ts:119-124). `makeToolHost` uses a freshly-hydrated `InMemoryCatalog` from `store.tools.list()`.
- [ ] **Step 4** — Rewrite server.ts's execute handler to `const { manager } = await createApprovalRuntime({ store, allowPrivateEgress: options.allowPrivateEgress === true, log });`. Run the FULL mcp suite → all PASS (server behavior preserved; M1 human-only-approval invariant intact).
- [ ] **Step 5: Commit** — `refactor: extract createApprovalRuntime — one home for the manager wiring (server + CLI)`

---

# LANE B — the CLI (consumes Lane A)

### Task 6: `packages/cli` scaffold + `conduit` bin dispatch

**Files:**
- Create: `packages/cli/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/bin.ts`, `src/dispatch.ts`
- Test: `packages/cli/src/dispatch.test.ts`

**Interfaces:**
- Produces: a `conduit` bin routing `serve|add-mcp|approvals` + `--help`/`--version`.

- [ ] **Step 1** — `package.json`: name `@conduithq/cli`, `"type":"module"`, `bin: {"conduit":"./dist/bin.js"}`, deps `@conduithq/sdk`/`@conduithq/mcp` `workspace:*` + `@libsql/client` (copy versions from packages/mcp/package.json — NO new versions), scripts `build`/`typecheck`/`test` mirroring packages/mcp. tsconfig/tsup: copy packages/mcp's.
- [ ] **Step 2** — Write `dispatch.test.ts`: unknown command → non-zero exit + stderr usage; `--version` prints version to stdout; `--help` lists the three commands.
- [ ] **Step 3** — Run → FAIL.
- [ ] **Step 4** — Implement `dispatch.ts` (pure arg→route function, testable without spawning) + `bin.ts` (`#!/usr/bin/env node`, calls dispatch). NOTE: `conduit`'s bin does NOT redirect stdout globally (only `serve` does, via runStdioServer).
- [ ] **Step 5** — Run → PASS. Commit: `feat: conduit CLI scaffold + command dispatch`

### Task 7: `conduit serve`

**Files:** Create `packages/cli/src/commands/serve.ts`; Test via ring-2 in `packages/cli/src/integration.test.ts` (create).
**Interfaces:** Consumes `runStdioServer` (Task 3). Produces the `serve` command.

- [ ] **Step 1** — Ring-2 test (mirror packages/mcp/integration.test.ts): spawn the compiled `conduit` bin with `serve`, connect an MCP `Client` over stdio, assert `tools/list` returns the two tools. PLUS the **M8-on-serve** test: assert every stdout byte the client didn't consume is protocol-framed (copy the mcp M8 assertion).
- [ ] **Step 2** — Run → FAIL (no serve command).
- [ ] **Step 3** — Implement `serve.ts`: `await runStdioServer()`. Wire into dispatch.
- [ ] **Step 4** — `npm run build` then run integration → PASS.
- [ ] **Step 5** — Add INVARIANTS row: `| /mcp M8 — stdout purity holds through \`conduit serve\` (shared runStdioServer) | packages/cli/src/integration.test.ts | ✅ pinned |`. Commit: `feat: conduit serve — stdio MCP server via shared runStdioServer`

> **Lane A PR #31 review carry-over (Greptile P2, runtime-stdio.ts:19):** `runStdioServer`'s `console.*` redirect is process-permanent by design (scoped to the call, not module-top-level). Lane B ring-2 tests spawn a SEPARATE bin process, so they're unaffected — but any IN-PROCESS test that imports `@conduithq/mcp` and calls `runStdioServer` before a stdout write would silence that write. Do NOT call `runStdioServer` in-process before asserting CLI stdout; drive serve only via the spawned bin (as this task's ring-2 test already does). This is the tripwire to remember when writing serve.ts's tests.

### Task 8: `conduit add-mcp` (read-first, atomic, credential-safe)

**Files:** Create `packages/cli/src/commands/add-mcp.ts`, `src/mcp-fetch.ts` (tools/list fetch + timeout); Test: unit `add-mcp.test.ts` + ring-2.
**Interfaces:** Consumes `openStoreFromEnv` (Task 4), `provisionSource` (Task 2), `normalizeMcp`, `deriveRiskClass`-backed `Tool.riskClass`. Produces the `add-mcp` command.

- [ ] **Step 1 — unit tests (the security/edge invariants):**
  - malformed `--namespace` (e.g. `A B`) → reject, 0 writes.
  - unreachable `--url` → fail loud, 0 writes (mock fetch to throw).
  - existing namespace + differing `--url`, no `--replace` → refuse, 0 writes.
  - re-sync, no `CONDUIT_ADD_SECRET`, existing credentialRef → the Connection passed to `provisionSource` CARRIES the existing ref (read-then-rewrite; assert not null).
  - `--clear-credential` → Connection ref undefined AND `secrets.remove` called.
  - **secret never echoed:** capture stdout+stderr across a successful add with `CONDUIT_ADD_SECRET` set; assert the secret substring appears in NEITHER.
  - success → risk-class count summary printed; `--json` shape `{safe,review,destructive}` + `credential: present|absent`.
- [ ] **Step 2** — Run → FAIL.
- [ ] **Step 3 — implement `add-mcp.ts`** following design §2.2/§4 exactly:
  1. validate `--namespace` against `/^[a-z0-9_-]+$/`.
  2. fetch `tools/list` (5s `AbortSignal.timeout`) → on failure, fail loud, RETURN before any store write. NO fixture fallback.
  3. `openStoreFromEnv`; read existing source by derived id.
  4. if existing && (`--url`≠stored location || `--prefix`≠stored prefix) && no `--replace` → refuse.
  5. resolve credentialRef: `CONDUIT_ADD_SECRET` set → derived ref + secret; else existing ref preserved (re-supply); `--clear-credential` → undefined + remove.
  6. `normalizeMcp` → build source/integration/connection/tools with derived ids → `provisionSource`.
  7. print risk-class counts (human or `--json`). NEVER print the secret.
- [ ] **Step 4** — Run unit → PASS. Add a ring-2 test: `add-mcp` against a stub upstream writes rows; a second `add-mcp` (same url) re-syncs; against a dead url writes 0 rows.
- [ ] **Step 5** — INVARIANTS rows: add-mcp dead-url→0 rows; secret-never-in-output; re-sync preserves credential. Commit: `feat: conduit add-mcp — atomic onboarding, read-first re-sync, credential-safe`

### Task 9: `conduit approvals list|approve|deny`

**Files:** Create `packages/cli/src/commands/approvals.ts`; Test: unit + ring-2.
**Interfaces:** Consumes `listPaused` (Task 1), `createApprovalRuntime` (Task 5) → `manager.resume`, `openStoreFromEnv`. Produces the `approvals` command.

- [ ] **Step 1 — unit tests:**
  - `list` renders paused rows oldest-first; a row with `expiresAt < now` shows `EXPIRED (finalizes on next resume)`; a live row shows time-remaining. `--json` shape.
  - `approve`/`deny` map to `manager.resume(id, {kind})`; `expired` outcome → the "no tool call was made" line (BOTH verbs); `conflict`/`failed` → non-zero exit.
- [ ] **Step 2** — Run → FAIL.
- [ ] **Step 3** — Implement: `list` = `store.executions.listPaused()` + display (compute expiry label from `pausedOn.expiresAt` vs `now`, no mutation). `approve`/`deny` = `createApprovalRuntime` → `manager.resume` → print `outcome.status`, exit code per outcome.
- [ ] **Step 4** — Run unit → PASS. Ring-2: drive a `require_approval` tool through `conduit serve` (or seed a paused execution), `approvals list` shows it, `approvals approve` resumes it to completion.
- [ ] **Step 5** — Commit: `feat: conduit approvals list|approve|deny — the human approval queue`

> **Lane A PR #31 review carry-over (Greptile P2 + opus whole-branch Minor, runtime.test.ts:30):** `createApprovalRuntime` is the single home for the §9.3 egress wiring, but Lane A's `runtime.test.ts` only proves the manager runs trivial code — the egress conditional (`allowPrivateEgress:false` → fail-closed `{}`) is pinned only TRANSITIVELY via server.test.ts. Two independent reviewers flagged this. Task 9 adds the SECOND caller (the CLI's approvals), so this is the point to add a DIRECT test pinning the invariant to the function that owns it: assert `createApprovalRuntime({store, allowPrivateEgress:false})`'s manager blocks a private-address upstream call, and that `true` opts in. Put it in `runtime.test.ts` (mcp) or a cli-side test — the seam is shared, so pin it once at the seam. Also covers the `runtime.ts:38` `log`-default path (Lane B's approvals caller omits `log`, exercising the default for the first time).

## Deviations log (fill during implementation — scratchpad)
Per entry: what forced the deviation, the conservative call taken, what to fold into the PR "Deviations" heading.

## Final steps (after Task 9)
- [ ] Full suite green (sdk + mcp + cli), tsc + biome clean (pre-commit hook is authoritative).
- [ ] Update `packages/cli/README.md` (onboarding, mirroring packages/mcp/README.md).
- [ ] PR body: Deviations heading; link the design doc; the C4/C5 out-of-scope tracked items go to HANDOFF carry-overs at session end.
- [ ] `/explain-diff` + full-pass quiz; Tier 2 + `/security-review` + real `codex exec` pass; human-named merge.
