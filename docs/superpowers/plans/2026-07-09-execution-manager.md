# §5.5 Execution Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build pause/resume of agent executions via deterministic replay (spec §5.5): a `require_approval` policy verdict suspends the execution as durable data; a human approves/denies out-of-band; resume replays a clean prefix journal and runs the approved call live.

**Architecture:** A new `execution/` layer sits ABOVE the sandbox and is the only writer to `ExecutionRepository`. The sandbox stays policy-oblivious (gains only a `paused` result arm). A separate `replay_journal` table (distinct from the audit Trace) holds the clean prefix. A request-bound one-shot `ApprovalDecisions` seam on the invoker turns an approved call into `allow` without mutating stored policy. The manager owns the state machine, the atomic paused→running claim, the journaling ToolHost wrapper (durable-append barrier), TTL/expiry, and the attempt-marker/outcome-ambiguous discipline.

**Tech Stack:** TypeScript/ESM, pnpm workspaces, quickjs-emscripten (sync build), libSQL/SQLite, Ajv+Zod, Vitest. All per spec §20.

**Authoritative design:** `docs/superpowers/specs/2026-07-09-execution-manager-design.md` (decisions D1–D9, adversarially converged). This plan implements it; where the plan and design disagree, the design wins and the deviation is logged.

## Global Constraints

- **The agent NEVER installs packages.** This work adds ZERO new dependencies (all stdlib + existing deps). If that turns out false, STOP and hand the user the install command.
- **Sandbox stays policy-oblivious.** The sandbox core (`quickjs.ts`) must not learn about policies, credentials, connections, `reason`, or `callId`. Its only new concept: a performed call can resolve to "pause" (D2). `reason`/`callId`/`toolName`/`input` for the `PendingApproval` originate host-side in the journaling ToolHost wrapper, never in the sandbox (design D2, C3).
- **Credentials are request-scoped and NEVER persisted** (§9.2). The replay journal and Trace store hold only host-classified upstream results. Credential scrubbing of results is BEST-EFFORT defense-in-depth (design D7), not a boundary.
- **Replay payload is credential-scrubbed but semantically-unredacted** (D7). §11 semantic redaction (a later MVP step) may touch display projections only; it MUST NOT alter the replay payload.
- **Invariant-in-same-commit rule** (CLAUDE.md): the module implementing the §5.5 invariant (the manager, Task 7) lands WITH its `INVARIANT §5.5` test AND the INVARIANTS.md ledger flip in the SAME commit.
- **Binaries:** `packages/sdk/node_modules/.bin/{vitest,tsc}` (run `cd packages/sdk` first); `node_modules/.bin/biome` from repo root.
- **Loopback-server tests run OUTSIDE the Bash sandbox** (`dangerouslyDisableSandbox: true`) — loopback listen hangs silently inside it. The pre-commit hook runs them unsandboxed and doubles as verification.
- **Every test that pins a spec invariant carries the `INVARIANT §x.y:` prefix in its name.**
- **Commit routing:** this is product code touching the credential/policy boundary → fully load-bearing. Branch → PR → CI green + CodeRabbit → Tier 2 review + `/security-review` + a `codex exec` convergence pass on the security surface → `/explain-diff` + full-pass quiz → human-named merge.

---

## File Structure

**New files:**
- `packages/sdk/src/execution/decisions.ts` — `ApprovalDecisions` seam + in-memory impl (Task 4).
- `packages/sdk/src/execution/decisions.test.ts`
- `packages/sdk/src/execution/scrub.ts` — best-effort credential scrub of results (Task 5).
- `packages/sdk/src/execution/scrub.test.ts`
- `packages/sdk/src/execution/journal.ts` — TraceEvent-free replay-journal reconstruction + pausedOn-identity check, pure functions (Task 6).
- `packages/sdk/src/execution/journal.test.ts`
- `packages/sdk/src/execution/manager.ts` — the ExecutionManager: state machine, journaling ToolHost wrapper, TTL, attempt discipline (Task 7).
- `packages/sdk/src/execution/manager.test.ts`

**Modified files:**
- `packages/sdk/src/store/store.ts` — add `ReplayJournalRepository` to `ConduitStore`; add `claimForResume` + attempt-state methods to `ExecutionRepository` (Tasks 1, 2).
- `packages/sdk/src/store/sqlite.ts` — `replay_journal` table + impl; `claimForResume` guarded UPDATE; attempt columns (Tasks 1, 2).
- `packages/sdk/src/store/sqlite.test.ts` — store-level tests for the above.
- `packages/sdk/src/sandbox/sandbox.ts` — `SandboxResult` gains `paused` arm; `PendingToolCall`-shaped pending (Task 3).
- `packages/sdk/src/sandbox/quickjs.ts` — `perform` resolves `require_approval` to pause; pin `new Date()` (Task 3).
- `packages/sdk/src/sandbox/quickjs.test.ts` — sandbox pause + Date-pin tests (Task 3).
- `packages/sdk/src/pipeline/invoker.ts` — optional `decisions?` dep, checked before policy; fail-closed identity (Task 4).
- `packages/sdk/src/pipeline/invoker.test.ts`
- `packages/sdk/src/types.ts` — `Execution` gains an attempt/ambiguous sub-state field if needed (Task 7); `PendingApproval` already exists.
- `packages/sdk/src/index.ts` — export new public surfaces.
- `packages/sdk/src/e2e.smoke.test.ts` — Phase 6 behavior change + end-to-end pause/resume assertions (Task 8).
- `INVARIANTS.md` — flip the §5.5 row (Task 7, same commit as the manager).
- `conduitspec.html` + `conduitspec.md` (regen via `html2md.py`) — §18 + §5.5 "doubles as" migration (Task 9).

---

## Tweakable data models & interfaces (LEAD — most likely to change; confirm before deep implementation)

These are the shapes every task consumes. They come from the design's §4 and D-sections. **If any of these change, re-derive the affected tasks.**

```ts
// ── Sandbox (Task 3) — the MINIMAL policy-oblivious pause arm (design D2, C3) ──
type SandboxResult =
  | { status: "completed"; value: unknown; seeds: ExecutionSeeds; journal: JournalEntry[] }
  | { status: "failed"; error: SandboxError; seeds: ExecutionSeeds; journal: JournalEntry[] }
  | { status: "interrupted"; reason: InterruptReason; seeds: ExecutionSeeds; journal: JournalEntry[] }
  | { status: "paused"; pending: { op: "call"; request: string }; seeds: ExecutionSeeds; journal: JournalEntry[] };
//    ^ sandbox carries ONLY {op,request}. reason/callId/toolName/input are added host-side (Task 7 wrapper).

// ── Approval seam (Task 4) — request-bound, one-shot, approve|deny (design D6) ──
interface ApprovalDecisions {
  /** Decision for the pending call, bound to its identity; consumed on use. undefined = none staged. */
  take(executionId: string, call: PendingCallIdentity): ApprovalDecision | undefined;
}
interface PendingCallIdentity {
  op: "call";
  toolName: string;
  /** The EXACT sandbox bridge request string — same serialization the divergence guard compares. Not a new hash. */
  request: string;
}
type ApprovalDecision = { kind: "approve" } | { kind: "deny"; reason?: string };

// ── Replay journal store (Task 1) — SEPARATE from audit Trace (design D4/F7) ──
interface ReplayJournalRepository {
  /** Append one journal entry at the next ordinal. Idempotent on (executionId, ordinal). */
  append(executionId: string, entry: ReplayJournalRow): Promise<void>;
  /** The prefix, in ordinal order — what resume replays. */
  listByExecution(executionId: string): Promise<ReplayJournalRow[]>;
}
interface ReplayJournalRow {
  ordinal: number;
  op: "search" | "describe" | "call";
  request: string;                 // canonical bridge request string
  outcome: { ok: true; value: unknown } | { ok: false; error: SandboxError };
}

// ── Execution store (Task 2) — atomic claim + attempt discipline (design D4/F4, D8/F5) ──
interface ExecutionRepository {
  put(execution: Execution): Promise<void>;
  get(id: string): Promise<Execution | undefined>;
  /** Atomic paused→running for ONE resume. True iff THIS caller won (design F4). */
  claimForResume(id: string, resumeAttemptId: string): Promise<boolean>;
}

// ── Manager (Task 7) — public API (design §4) ──
interface ExecutionManager {
  start(code: string, opts?: { limits?: Partial<SandboxLimits> }): Promise<ExecutionOutcome>;
  resume(executionId: string, decision: ApprovalDecision): Promise<ExecutionOutcome>;
  get(executionId: string): Promise<Execution | undefined>;
}
type ExecutionOutcome =
  | { status: "completed"; value: unknown }
  | { status: "failed"; error: SandboxError }
  | { status: "paused"; pending: PendingApproval }
  | { status: "expired"; pending: PendingApproval }
  | { status: "conflict" };
```

**Degrees of freedom (implementer may improvise):** the internal carrier for threading `reason`/`callId` from the wrapper to the outcome (side-channel vs. a richer internal type); the exact SQL column types; test-helper factoring. **Must stop and ask:** any change that puts policy/credential concepts into the sandbox core; any change that would journal a `require_approval`; anything that redacts the replay `output`; adding a dependency.

---

### Task 1: Replay-journal store (separate table)

**Files:**
- Modify: `packages/sdk/src/store/store.ts` (add `ReplayJournalRepository` to `ConduitStore`)
- Modify: `packages/sdk/src/store/sqlite.ts` (schema + impl)
- Test: `packages/sdk/src/store/sqlite.test.ts`

**Interfaces:**
- Produces: `ReplayJournalRepository` (see Tweakable section), `ReplayJournalRow`.

- [ ] **Step 1: Write the failing test** in `sqlite.test.ts`:

```ts
it("replay journal: append + listByExecution returns rows in ordinal order", async () => {
  const { store } = await openTestStore();
  await store.replayJournal.append("exec_1", { ordinal: 0, op: "search", request: '{"query":"x"}', outcome: { ok: true, value: [{ path: "a" }] } });
  await store.replayJournal.append("exec_1", { ordinal: 1, op: "call", request: '{"path":"a","input":null}', outcome: { ok: true, value: { done: true } } });
  const rows = await store.replayJournal.listByExecution("exec_1");
  expect(rows.map((r) => [r.ordinal, r.op])).toEqual([[0, "search"], [1, "call"]]);
  expect(rows[1]?.outcome).toEqual({ ok: true, value: { done: true } });
});

it("replay journal: append is idempotent on (executionId, ordinal)", async () => {
  const { store } = await openTestStore();
  const row = { ordinal: 0, op: "call" as const, request: "{}", outcome: { ok: true as const, value: 1 } };
  await store.replayJournal.append("exec_2", row);
  await store.replayJournal.append("exec_2", row); // second write must not duplicate or throw
  expect(await store.replayJournal.listByExecution("exec_2")).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/store/sqlite.test.ts -t "replay journal"`
Expected: FAIL (`store.replayJournal` undefined).

- [ ] **Step 3: Add the schema** in `sqlite.ts` `SCHEMA` array (after the `trace_events` block):

```ts
`CREATE TABLE IF NOT EXISTS replay_journal (
  execution_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('search', 'describe', 'call')),
  request TEXT NOT NULL,
  outcome TEXT NOT NULL,
  PRIMARY KEY (execution_id, ordinal)
)`,
```

The `PRIMARY KEY (execution_id, ordinal)` gives idempotency: use `INSERT ... ON CONFLICT(execution_id, ordinal) DO NOTHING`.

- [ ] **Step 4: Add the interface** in `store.ts`:

```ts
export interface ReplayJournalRow {
  ordinal: number;
  op: "search" | "describe" | "call";
  request: string;
  outcome: { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } };
}
export interface ReplayJournalRepository {
  append(executionId: string, entry: ReplayJournalRow): Promise<void>;
  listByExecution(executionId: string): Promise<ReplayJournalRow[]>;
}
```
Add `readonly replayJournal: ReplayJournalRepository;` to `ConduitStore`.

- [ ] **Step 5: Implement** in `sqlite.ts` (add to the `return {}` store object, following the `trace` repo pattern):

```ts
replayJournal: {
  async append(executionId, entry) {
    await client.execute({
      sql: `INSERT INTO replay_journal (execution_id, ordinal, op, request, outcome)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(execution_id, ordinal) DO NOTHING`,
      args: [executionId, entry.ordinal, entry.op, entry.request, JSON.stringify(entry.outcome)],
    });
  },
  async listByExecution(executionId) {
    const rs = await client.execute({
      sql: "SELECT ordinal, op, request, outcome FROM replay_journal WHERE execution_id = ? ORDER BY ordinal",
      args: [executionId],
    });
    return rs.rows.map((row) => ({
      ordinal: Number(row.ordinal),
      op: String(row.op) as ReplayJournalRow["op"],
      request: String(row.request),
      outcome: parseJson(String(row.outcome), (cause) => `[SqliteStore] Failed to read replay_journal outcome: ${cause}`) as ReplayJournalRow["outcome"],
    }));
  },
},
```
(Reuse the existing `parseJson` helper in the file.)

- [ ] **Step 6: Run to verify pass**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/store/sqlite.test.ts -t "replay journal"`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/store/store.ts packages/sdk/src/store/sqlite.ts packages/sdk/src/store/sqlite.test.ts
git commit -m "feat: replay_journal store, separate from audit Trace (§5.5 design D4)"
```

---

### Task 2: Atomic `claimForResume` on ExecutionRepository

**Files:**
- Modify: `packages/sdk/src/store/store.ts`, `packages/sdk/src/store/sqlite.ts`
- Test: `packages/sdk/src/store/sqlite.test.ts`

**Interfaces:**
- Consumes: existing `Execution`, `executions` table.
- Produces: `ExecutionRepository.claimForResume(id, resumeAttemptId): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**:

```ts
it("claimForResume: exactly one caller wins the paused→running transition", async () => {
  const { store } = await openTestStore();
  await store.executions.put({ id: "e", code: "", status: "paused", seeds: { now: 0, random: 0 }, startedAt: 0 });
  const [a, b] = await Promise.all([
    store.executions.claimForResume("e", "attempt-A"),
    store.executions.claimForResume("e", "attempt-B"),
  ]);
  expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one won
  expect((await store.executions.get("e"))?.status).toBe("running");
});

it("claimForResume: returns false when not paused", async () => {
  const { store } = await openTestStore();
  await store.executions.put({ id: "e2", code: "", status: "running", seeds: { now: 0, random: 0 }, startedAt: 0 });
  expect(await store.executions.claimForResume("e2", "x")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/store/sqlite.test.ts -t "claimForResume"`
Expected: FAIL (`claimForResume` undefined).

- [ ] **Step 3: Add a `resume_attempt` column** to the `executions` schema in `sqlite.ts` (and the retrofit block that adds columns to existing tables, mirroring how `trace_events.output` was retrofitted):

```ts
// in CREATE TABLE executions: add
resume_attempt TEXT,
```

- [ ] **Step 4: Add to the interface** in `store.ts`:

```ts
export interface ExecutionRepository {
  put(execution: Execution): Promise<void>;
  get(id: string): Promise<Execution | undefined>;
  /** Atomic paused→running for a single resume. Returns true iff THIS caller won (design F4). */
  claimForResume(id: string, resumeAttemptId: string): Promise<boolean>;
}
```

- [ ] **Step 5: Implement** the guarded UPDATE in `sqlite.ts`:

```ts
async claimForResume(id, resumeAttemptId) {
  const rs = await client.execute({
    sql: `UPDATE executions SET status = 'running', resume_attempt = ?
          WHERE id = ? AND status = 'paused'`,
    args: [resumeAttemptId, id],
  });
  return rs.rowsAffected === 1;
},
```
(libSQL exposes `rowsAffected` on the result set — verify the field name against the existing client usage in the file; if it differs, use the file's convention.)

- [ ] **Step 6: Run to verify pass**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/store/sqlite.test.ts -t "claimForResume"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/store/store.ts packages/sdk/src/store/sqlite.ts packages/sdk/src/store/sqlite.test.ts
git commit -m "feat: atomic claimForResume (paused→running CAS) on ExecutionRepository (§5.5 design F4)"
```

---

### Task 3: Sandbox `paused` arm + pin `new Date()`

**Files:**
- Modify: `packages/sdk/src/sandbox/sandbox.ts` (SandboxResult), `packages/sdk/src/sandbox/quickjs.ts`
- Test: `packages/sdk/src/sandbox/quickjs.test.ts`

**Interfaces:**
- Consumes: existing `ToolHost`, `perform`, the `execute` loop.
- Produces: `SandboxResult` `paused` arm `{ status:"paused"; pending:{op:"call";request:string}; seeds; journal }`.

**How pause is signaled without policy in the sandbox (design D2):** `perform` calls the ToolHost, which throws on `require_approval`. The sandbox cannot see the policy, but the ToolHost wrapper (Task 7) marks the outcome as a pause via a sentinel the sandbox recognizes structurally. For THIS task, model the pause as: `perform` returns a discriminated result `{ kind: "pause" } | { kind: "entry"; entry: JournalEntry }`, and the `execute` loop returns `status:"paused"` on `kind:"pause"` without pushing to the journal. The ToolHost signals pause by throwing a dedicated `ConduitApprovalPause` error that `perform` catches and maps to `{ kind: "pause" }`. (The wrapper in Task 7 is what throws it; here we just wire the sandbox to honor it. Degree of freedom: the exact sentinel mechanism, as long as the sandbox stays policy-oblivious.)

- [ ] **Step 1: Write the failing test** in `quickjs.test.ts`:

```ts
it("INVARIANT §5.5: a tool call that signals approval-pause suspends without journaling it", async () => {
  const sandbox = new QuickJSSandbox();
  const tools = {
    search: async () => [{ path: "github.delete_repo", riskClass: "destructive", score: 1 }],
    describe: async () => ({ path: "github.delete_repo", namespace: "github", riskClass: "destructive" }),
    call: async () => { const e = new Error("approval required"); e.name = "ConduitApprovalPause"; throw e; },
  };
  const result = await sandbox.execute({
    code: `const { items } = await tools.search({ query: "delete" }); return await tools[items[0].path]({ repo: "x" });`,
    tools,
  });
  expect(result.status).toBe("paused");
  if (result.status === "paused") {
    expect(result.pending.op).toBe("call");
    // the search IS journaled (prefix), the paused call is NOT
    expect(result.journal.map((e) => e.op)).toEqual(["search"]);
  }
});

it("§5.5: new Date() is deterministic across replays (pinned like Date.now)", async () => {
  const sandbox = new QuickJSSandbox();
  const code = `return new Date().getTime();`;
  const r1 = await sandbox.execute({ code, tools: noopTools, seeds: { now: 1000, random: 5 } });
  const r2 = await sandbox.execute({ code, tools: noopTools, seeds: { now: 1000, random: 5 } });
  expect(r1.status).toBe("completed"); expect(r2.status).toBe("completed");
  if (r1.status === "completed" && r2.status === "completed") expect(r1.value).toEqual(r2.value);
});
```
(Provide `noopTools` = tools whose methods throw if called; the second test makes no tool calls.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && dangerouslyDisableSandbox vitest ... ` — actually run via the pre-commit path; direct: `cd packages/sdk && node_modules/.bin/vitest run src/sandbox/quickjs.test.ts -t "§5.5"`
Expected: FAIL (no `paused` status; `new Date()` differs or is unpinned).

- [ ] **Step 3: Add the `paused` arm** to `SandboxResult` in `sandbox.ts`:

```ts
| { status: "paused"; pending: { op: "call"; request: string }; seeds: ExecutionSeeds; journal: JournalEntry[] }
```

- [ ] **Step 4: Make `perform` recognize the pause sentinel** in `quickjs.ts`. Change `perform`'s return type to `Promise<JournalEntry | { pause: true }>`; in the `catch`, if `error instanceof Error && error.name === "ConduitApprovalPause"`, return `{ pause: true }`. In the `execute` loop, when `perform` returns `{ pause: true }`, `return { status: "paused", pending: run.pending, seeds, journal }` WITHOUT pushing to `journal`.

- [ ] **Step 5: Pin `new Date()`** in `bootstrapSource`. After the `Date.now` reassignment, override the `Date` constructor's no-arg path to use the same seeded clock:

```ts
// existing: Date.now = function () { return ${seeds.now} + tick++; };
var RealDate = Date;
function PinnedDate(y, mo, d, h, mi, s, ms) {
  if (arguments.length === 0) return new RealDate(Date.now());
  return new RealDate(y, mo, d, h, mi, s, ms);
}
PinnedDate.now = Date.now;
PinnedDate.prototype = RealDate.prototype;
Date = PinnedDate;
```
(Keep interpolation numbers-only. Degree of freedom: exact shim shape, as long as `new Date()` with no args returns the seeded, ticking time and parameterized `new Date(...)` still works.)

- [ ] **Step 6: Run to verify pass**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/sandbox/quickjs.test.ts -t "§5.5"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/sandbox/sandbox.ts packages/sdk/src/sandbox/quickjs.ts packages/sdk/src/sandbox/quickjs.test.ts
git commit -m "feat: sandbox paused arm + pin new Date() for deterministic replay (§5.5 design D2)"
```

---

### Task 4: `ApprovalDecisions` seam + invoker wiring (fail-closed identity)

**Files:**
- Create: `packages/sdk/src/execution/decisions.ts`, `decisions.test.ts`
- Modify: `packages/sdk/src/pipeline/invoker.ts`
- Test: `packages/sdk/src/pipeline/invoker.test.ts`

**Interfaces:**
- Produces: `ApprovalDecisions`, `PendingCallIdentity`, `ApprovalDecision`, `createInMemoryApprovalDecisions()`.
- Modifies: `ToolInvokerDeps` gains `decisions?: ApprovalDecisions`.

- [ ] **Step 1: Write the failing test** in `decisions.test.ts` (the seam) and `invoker.test.ts` (the wiring). Decisions unit test:

```ts
it("take: returns the staged decision once, only for the matching identity", () => {
  const d = createInMemoryApprovalDecisions();
  d.stage("exec_1", { op: "call", toolName: "github.delete_repo", request: '{"repo":"x"}' }, { kind: "approve" });
  // wrong identity → undefined
  expect(d.take("exec_1", { op: "call", toolName: "github.create_issue", request: '{"repo":"x"}' })).toBeUndefined();
  // right identity → approve, once
  expect(d.take("exec_1", { op: "call", toolName: "github.delete_repo", request: '{"repo":"x"}' })).toEqual({ kind: "approve" });
  expect(d.take("exec_1", { op: "call", toolName: "github.delete_repo", request: '{"repo":"x"}' })).toBeUndefined(); // consumed
});
```
Invoker wiring test (`invoker.test.ts`): with a staged `approve` for the exact call, a `require_approval` tool resolves to `allow` (upstream reached); with a MISMATCHED staged identity, it FAILS CLOSED (no allow).

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/execution/decisions.test.ts src/pipeline/invoker.test.ts -t "decision"`
Expected: FAIL.

- [ ] **Step 3: Implement `decisions.ts`** — an in-memory map keyed by `executionId`, storing `{ identity, decision }`, with `stage`, `take` (matches identity by `op`+`toolName`+`request` equality, deletes on match). No dependencies.

- [ ] **Step 4: Wire the invoker** (`invoker.ts`). Add `decisions?: ApprovalDecisions` to `ToolInvokerDeps`. In `runCall`, AFTER computing the tool but the decision check goes BEFORE policy evaluation: build `PendingCallIdentity` from `{ op: "call", toolName: path, request: <canonical request> }`; call `deps.decisions?.take(executionId, identity)`. If `approve` → skip policy, force `allow` (trace as operator approval). If `deny` → force `ConduitPolicyBlocked`. If a decision is staged for this execution but its identity does NOT match the current call → throw fail-closed (`policyError("block", "resume divergence: approved call does not match")`). If no decision → today's policy path unchanged.

- [ ] **Step 5: Run to verify pass**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/execution/decisions.test.ts src/pipeline/invoker.test.ts`
Expected: PASS (including existing invoker tests — the no-decision path is unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/execution/decisions.ts packages/sdk/src/execution/decisions.test.ts packages/sdk/src/pipeline/invoker.ts packages/sdk/src/pipeline/invoker.test.ts
git commit -m "feat: request-bound one-shot ApprovalDecisions seam, fail-closed on mismatch (§5.5 design D6)"
```

---

### Task 5: Best-effort credential scrub

**Files:**
- Create: `packages/sdk/src/execution/scrub.ts`, `scrub.test.ts`

**Interfaces:**
- Produces: `scrubCredential(result: unknown, secret: string | undefined): unknown`.

- [ ] **Step 1: Write the failing test**:

```ts
it("scrubCredential: removes a verbatim credential echo from a result (best-effort)", () => {
  const out = scrubCredential({ echoed: "Bearer ghp_secret_123", data: 1 }, "Bearer ghp_secret_123");
  expect(JSON.stringify(out)).not.toContain("ghp_secret_123");
  expect((out as { data: number }).data).toBe(1);
});
it("scrubCredential: no-op when secret is undefined", () => {
  expect(scrubCredential({ a: 1 }, undefined)).toEqual({ a: 1 });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/sdk && node_modules/.bin/vitest run src/execution/scrub.test.ts` → FAIL.

- [ ] **Step 3: Implement** `scrub.ts` — reuse the scan approach in `pipeline/upstream.ts` (read it first; do NOT invent a parallel one). Serialize, replace verbatim occurrences of `secret` with a `[redacted]` marker, parse back; label it best-effort in a doc comment (per design D7, this is defense-in-depth, not a boundary).

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/execution/scrub.ts packages/sdk/src/execution/scrub.test.ts
git commit -m "feat: best-effort credential scrub for persisted/replayed results (§5.5 design D7)"
```

---

### Task 6: Journal reconstruction + pausedOn-identity (pure functions)

**Files:**
- Create: `packages/sdk/src/execution/journal.ts`, `journal.test.ts`

**Interfaces:**
- Consumes: `ReplayJournalRow` (Task 1), `PendingCallIdentity` (Task 4), `JournalEntry` (sandbox).
- Produces: `toSandboxJournal(rows: ReplayJournalRow[]): JournalEntry[]`; `matchesPending(identity, pausedOn): boolean`.

- [ ] **Step 1: Write the failing test**: `toSandboxJournal` maps rows in ordinal order to `JournalEntry[]`; `matchesPending` returns true only when `op`+`toolName`+`request` all match.

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement** pure functions, no store/sandbox imports beyond types.

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/execution/journal.ts packages/sdk/src/execution/journal.test.ts
git commit -m "feat: replay-journal reconstruction + pausedOn identity check (§5.5 design D4/F2)"
```

---

### Task 7: The ExecutionManager (+ INVARIANT §5.5 test + ledger flip — SAME commit)

**Files:**
- Create: `packages/sdk/src/execution/manager.ts`, `manager.test.ts`
- Modify: `packages/sdk/src/index.ts` (exports), `packages/sdk/src/types.ts` (attempt sub-state if needed)
- Modify: `INVARIANTS.md` (flip §5.5 row — MUST be this commit)

**Interfaces:**
- Consumes: everything from Tasks 1–6 + `Sandbox`, `ConduitStore`, `createToolInvoker`, `createCatalogToolHost`.
- Produces: `createExecutionManager(deps): ExecutionManager`; `ExecutionOutcome`.

**Behavior to implement (design D2/D3/D4/D6/D8/D9):**
1. `start`: persist `Execution{running}`, generate+persist seeds, build the **journaling ToolHost wrapper**, drive the sandbox. The wrapper: for each call, run the invoker; durably `replayJournal.append` the result at the next ordinal BEFORE returning to the sandbox (the barrier); on `require_approval`, throw `ConduitApprovalPause` (so the sandbox pauses) AND assemble the `PendingApproval` `{callId, toolName, input, reason, expiresAt}` host-side; write `Execution{paused, pausedOn}`.
2. `resume`: `claimForResume` (lose → `{status:"conflict"}`); check TTL (past `expiresAt` → `expired`); load the prefix via `toSandboxJournal(replayJournal.listByExecution)`; stage the `ApprovalDecision` bound to `pausedOn` identity; write attempt marker before the approved call; re-drive; the approved call runs live via the decision seam. Deny → stage deny → the call resolves `ConduitPolicyBlocked`.
3. Attempt marker + outcome-ambiguous: if a result append fails after the side effect → terminal `failed: outcome-ambiguous`, not resumable.
4. `get`: return the persisted Execution.

- [ ] **Step 1: Write the INVARIANT test** in `manager.test.ts`:

```ts
it("INVARIANT §5.5: pause/resume via deterministic replay — approve resumes and runs the approved call live", async () => {
  // set up store + catalog + a require_approval tool; start() → paused; capture exec_id + pending
  // resume(exec_id, {kind:"approve"}) → completed; the approved call reached upstream exactly once
});
it("INVARIANT §5.5: deny resolves the pending call as blocked", async () => { /* ... */ });
it("§5.5: concurrent resume → exactly one drives, the other returns conflict", async () => { /* ... */ });
it("§5.5: catalog change between pause and resume does not diverge replay (search/describe journaled)", async () => { /* ... */ });
```
(Write full arrange/act/assert bodies; these are invariant tests, name-prefixed.)

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement `manager.ts`** per the behavior list above.

- [ ] **Step 4: Run to verify pass** — `cd packages/sdk && node_modules/.bin/vitest run src/execution/manager.test.ts` → PASS.

- [ ] **Step 5: Flip the INVARIANTS.md §5.5 row** from ⏳ to ✅ with the test name, and export the manager from `index.ts`.

- [ ] **Step 6: Run the FULL suite unsandboxed** (pre-commit path) to confirm nothing regressed.

- [ ] **Step 7: Commit (module + invariant test + ledger flip together)**

```bash
git add packages/sdk/src/execution/manager.ts packages/sdk/src/execution/manager.test.ts packages/sdk/src/index.ts packages/sdk/src/types.ts INVARIANTS.md
git commit -m "feat: §5.5 execution manager — pause/resume via deterministic replay (flips INVARIANT §5.5)"
```

---

### Task 8: End-to-end pause/resume + Phase-6 behavior fix

**Files:**
- Modify: `packages/sdk/src/e2e.smoke.test.ts`

**Interfaces:**
- Consumes: the full stack + `createExecutionManager`.

- [ ] **Step 1: Update Phase 6** — change the assertion from "guest catches the require_approval and returns" to "the execution PAUSES" (drive it via the manager, assert `status:"paused"` + `pending.toolName`). Add a comment citing the intended behavior change (design D2).

- [ ] **Step 2: Add end-to-end pause→approve→resume** through the real stack (real store, real sandbox, real invoker + decisions): start an execution that hits `require_approval`, assert paused; resume approve; assert completed and the approved call reached the loopback upstream exactly once; assert NO secret in any guest-visible value, the replay journal, or the Trace display projection across the resume (extend the existing leak sweep).

- [ ] **Step 3: Run unsandboxed** (loopback) — `cd packages/sdk && node_modules/.bin/vitest run src/e2e.smoke.test.ts` with `dangerouslyDisableSandbox: true` → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/e2e.smoke.test.ts
git commit -m "test: e2e pause/resume + Phase-6 require_approval-pauses behavior fix (§5.5 design D2)"
```

---

### Task 9: Spec §18 + §5.5 migration (separate commit, same PR)

**Files:**
- Modify: `conduitspec.html`, then regenerate `conduitspec.md` via `python3 html2md.py`
- Modify: `INVARIANTS.md` only if the §5.5 row wording needs a spec-pointer update (the flip itself happened in Task 7)

- [ ] **Step 1: Edit `conduitspec.html`** — update the §18 "Trace as replay log" locked decision AND the §5.5 prose (the second "doubles as" location) to reflect the separate `replay_journal` table; note `search`/`describe` journaling is now done.

- [ ] **Step 2: Regenerate** — `python3 html2md.py`

- [ ] **Step 3: Verify** — `grep -c "doubles as" conduitspec.md` → expect `0`.

- [ ] **Step 4: Run the spec-drift check locally** (the pre-commit hook does this; confirm no mismatch).

- [ ] **Step 5: Commit**

```bash
git add conduitspec.html conduitspec.md
git commit -m "docs(spec): §18/§5.5 — replay journal is a separate table, not the Trace store (§5.5 execution manager)"
```

---

## Self-Review checklist (run after implementation, before PR)

- [ ] Every design decision D1–D9 maps to a task (D1→T3/T4 semantics, D2→T3, D3→T7, D4→T1/T6/T7, D5→T1/T7, D6→T4, D7→T5, D8→T7, D9→T7).
- [ ] No `require_approval` is ever written to `replay_journal` (grep the manager).
- [ ] The sandbox core imports nothing from `policy`/`credentials`/`store`.
- [ ] The replay `output`/payload is never redacted (only display projections are — but §11 redaction is a LATER MVP step; this plan must not add it).
- [ ] `pnpm audit` clean; no new dependency added.
- [ ] Full suite green unsandboxed; `INVARIANT §5.5` row is ✅.
- [ ] `grep "doubles as" conduitspec.md` → 0.

## Post-implementation gates (commit routing)

1. Open PR from a `feat/execution-manager` branch.
2. CI green + CodeRabbit.
3. Tier 2 review (3 agents) + `/security-review` + a `codex exec` convergence pass on the diff (security surface: the decision seam, the credential scrub, the pause/resume boundary).
4. `/explain-diff` + full-pass quiz.
5. Human names the PR for merge. (Agent never merges.)

## Deviations log

(Record implementation-time deviations in the scratchpad; summarize under a "Deviations" heading in the PR.)
