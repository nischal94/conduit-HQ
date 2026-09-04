# /mcp stdio server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real MCP client (Claude Desktop / Cursor) spawns `conduit-mcp` over stdio, sees `execute` + `check_execution`, and drives a real upstream call through the existing §5.3 pipeline — spec §17 build-order step 2.

**Architecture:** New thin package `packages/mcp` (`@conduithq/mcp`: library `createConduitMcpServer` + bin `conduit-mcp`) composing the existing SDK exactly as `e2e.smoke.test.ts` does, over the official MCP SDK's low-level `Server` + `StdioServerTransport`. One deliberate SDK change: outcome persistence on every terminal transition, a `requestKey` correlation column, WAL/busy_timeout pragmas, and a concurrency-safe migration.

**Tech Stack:** TypeScript strict ESM, Node ≥ 20, pnpm workspace, `@modelcontextprotocol/sdk` (exact `1.29.0`), vitest, tsup, libSQL.

**Source of truth:** `docs/superpowers/specs/2026-07-11-mcp-stdio-server-design.md` (rev 2, converged). Section references (M1–M9) are to that file.

## Global Constraints

- **The agent NEVER installs packages.** Any `pnpm install`/`add` is handed to the user to run in their own terminal (Socket Firewall). Tasks below mark these as **STOP** steps.
- `@modelcontextprotocol/sdk` is pinned **exactly** `"1.29.0"` — no caret (M2).
- `packages/sdk` gains **zero** new dependencies.
- stdout of the bin carries JSON-RPC frames ONLY; all logging → stderr (M8).
- Existing §4.2 invariant: execute definition ≤ 1,044 estimated tokens — must stay green, including with the M1 `requestKey` extension and capped connection list.
- Vitest suites that bind loopback sockets HANG in the sandboxed Bash tool — run them unsandboxed; the pre-commit hook (unsandboxed, full suite + biome + spec-drift) is the authoritative verification on every commit.
- Do NOT use `git stash` (project rule for dispatched implementers).
- Binaries: `cd packages/sdk && node_modules/.bin/vitest run` / `node_modules/.bin/tsc --noEmit`; biome from repo root: `node_modules/.bin/biome check .`. `packages/mcp` gets its own vitest/tsc via workspace install.
- Conventional commits; each task commits its own slice.
- Branch: `feat/mcp-stdio-server` (exists; design doc committed).

## File Structure

```
packages/sdk/src/
  types.ts                 (modify — Execution gains result/error/requestKey)
  store/store.ts           (modify — ExecutionRepository.getByRequestKey)
  store/sqlite.ts          (modify — columns, pragmas, safe migration, mapping)
  execution/manager.ts     (modify — outcome-aware terminals, requestKey)
  execute.ts               (modify — capped connection listing)
packages/mcp/
  package.json, tsconfig.json, tsup.config.ts, vitest.config.ts (create)
  src/payloads.ts          (create — envelopes, check_execution def, tool JSON helpers)
  src/server.ts            (create — createConduitMcpServer, handlers)
  src/env.ts               (create — env parsing, key decode, doctor checks)
  src/bin.ts               (create — stdio entry, flags, stderr discipline)
  src/payloads.test.ts, src/server.test.ts, src/env.test.ts (create — ring 1)
  src/integration.test.ts  (create — ring 2, spawned bin)
  README.md                (create — M7/M8 doc obligations)
scripts/seed-demo.mjs       (create)
scripts/approve-demo.mjs    (create)
conduitspec.html + conduitspec.md (modify — §14/§18/§20; regenerate via html2md.py)
INVARIANTS.md              (modify — new rows)
```

---

### Task 1: SDK — Execution outcome + requestKey (types, store interface, sqlite)

**Files:**
- Modify: `packages/sdk/src/types.ts` (Execution interface)
- Modify: `packages/sdk/src/store/store.ts` (ExecutionRepository)
- Modify: `packages/sdk/src/store/sqlite.ts` (schema, migration, mapping)
- Test: `packages/sdk/src/store/sqlite.test.ts`

**Interfaces:**
- Consumes: existing `Execution`, `SandboxError`, sqlite helpers (`text`, `maybeText`, `integer`, `maybeInteger`, `parseJson`).
- Produces: `Execution.result?: unknown`, `Execution.error?: SandboxError`, `Execution.requestKey?: string`; `ExecutionRepository.getByRequestKey(key: string): Promise<Execution | undefined>`; columns `result TEXT`, `error TEXT`, `request_key TEXT` + unique index `idx_executions_request_key`.

- [ ] **Step 1: Write the failing tests** — append to `packages/sdk/src/store/sqlite.test.ts`. The file's existing fixture is module-level `store`/`client` over `:memory:` in a `beforeEach` — the new blocks need their OWN helpers; define them at the top of the new describe block:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// (merge with the file's existing imports; createClient/openSqliteStore/SecretBox are already imported)

const KEY_BYTES = SecretBox.generateKeyBytes();
async function testSecretBox() {
  return SecretBox.fromKeyBytes(KEY_BYTES);
}
async function openTestStore(url = ":memory:") {
  return openSqliteStore({ client: createClient({ url }), secretBox: await testSecretBox() });
}
function tempFileDbUrl(): string {
  return `file:${join(mkdtempSync(join(tmpdir(), "conduit-m4-")), "t.db")}`;
}
/** Builds a pre-M4 executions table on a temp FILE db; returns { url, client }. */
async function legacyDb() {
  const url = tempFileDbUrl();
  const client = createClient({ url });
  await client.execute(`CREATE TABLE executions (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, status TEXT NOT NULL,
    seeds TEXT NOT NULL, paused_on TEXT, started_at INTEGER NOT NULL,
    ended_at INTEGER, resume_attempt TEXT)`);
  await client.execute(`INSERT INTO executions (id, code, status, seeds, started_at, ended_at)
    VALUES ('exec_old', '1', 'completed', '{"now":1,"random":0.5}', 1, 2)`);
  return { url, client };
}

describe("execution outcome persistence (mcp design M4)", () => {
  it("round-trips result, error, and requestKey", async () => {
    const store = await openTestStore(); // use the file's existing helper name
    await store.executions.put({
      id: "exec_a", code: "return 1", status: "completed",
      seeds: { now: 1, random: 0.5 }, startedAt: 1, endedAt: 2,
      result: { ok: true }, requestKey: "key_a",
    });
    const a = await store.executions.get("exec_a");
    expect(a?.result).toEqual({ ok: true });
    expect(a?.requestKey).toBe("key_a");
    await store.executions.put({
      id: "exec_b", code: "throw", status: "failed",
      seeds: { now: 1, random: 0.5 }, startedAt: 1, endedAt: 2,
      error: { name: "ConduitExecutionError", message: "boom" },
    });
    expect((await store.executions.get("exec_b"))?.error?.message).toBe("boom");
  });

  it("resolves by requestKey and rejects duplicates", async () => {
    const store = await openTestStore();
    await store.executions.put({
      id: "exec_k1", code: "1", status: "running",
      seeds: { now: 1, random: 0.5 }, startedAt: 1, requestKey: "dup",
    });
    expect((await store.executions.getByRequestKey("dup"))?.id).toBe("exec_k1");
    expect((await store.executions.getByRequestKey("nope"))).toBeUndefined();
    await expect(store.executions.put({
      id: "exec_k2", code: "1", status: "running",
      seeds: { now: 1, random: 0.5 }, startedAt: 1, requestKey: "dup",
    })).rejects.toThrow(/UNIQUE|unique/);
  });

  it("failClaimedResume records its reason as the error payload", async () => {
    const store = await openTestStore();
    await store.executions.put({
      id: "exec_f", code: "1", status: "paused",
      seeds: { now: 1, random: 0.5 }, startedAt: 1,
      pausedOn: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 9 },
    });
    await store.executions.claimForResume("exec_f", "attempt");
    await store.executions.failClaimedResume("exec_f", "prep failed");
    const row = await store.executions.get("exec_f");
    expect(row?.status).toBe("failed");
    expect(row?.error).toEqual({ name: "ConduitInternalError", message: "prep failed" });
  });

  it("migrates a legacy db: columns added, legacy completed row reads with result undefined", async () => {
    const { client } = await legacyDb();
    const store = await openSqliteStore({ client, secretBox: await testSecretBox() });
    const old = await store.executions.get("exec_old");
    expect(old?.status).toBe("completed");
    expect(old?.result).toBeUndefined(); // legacy NULL — accepted (design M1)
  });

  it("a near-§16-cap result survives persist + re-read (design M9)", async () => {
    const store = await openTestStore();
    const big = "x".repeat(900_000); // just under the 1MB output cap
    await store.executions.put({
      id: "exec_big", code: "1", status: "completed",
      seeds: { now: 1, random: 0.5 }, startedAt: 1, endedAt: 2, result: { big },
    });
    expect(((await store.executions.get("exec_big"))?.result as { big: string }).big.length).toBe(900_000);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run (unsandboxed): `cd packages/sdk && node_modules/.bin/vitest run src/store/sqlite.test.ts`
Expected: FAIL — unknown columns / `getByRequestKey` not a function.

- [ ] **Step 3: Implement**

`types.ts` — extend `Execution` (after `pausedOn`):

```ts
  /** Caller-generated correlation key (mcp design M1); unique, persisted before the sandbox runs. */
  requestKey?: string;
  /** Persisted settle-state (mcp design M4): completed → result. undefined normalized to null at the surface. */
  result?: unknown;
  /** Persisted settle-state (mcp design M4): failed → error, ALWAYS present on a stored failed row. */
  error?: SandboxError;
```

(`SandboxError` is imported where `types.ts` needs it — it lives in `sandbox/sandbox.ts`; if importing it into `types.ts` creates a cycle, declare the structural shape inline: `{ name: string; message: string }` under a local `ExecutionError` alias and use it in both places consistently.)

`store/store.ts` — add to `ExecutionRepository`:

```ts
  /** Resolve by the caller-generated correlation key (mcp design M1). */
  getByRequestKey(key: string): Promise<Execution | undefined>;
```

`store/sqlite.ts`:
1. `CREATE TABLE executions` gains `result TEXT, error TEXT, request_key TEXT` and after the CREATE statements add `CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_request_key ON executions(request_key)` (SQLite unique indexes ignore NULLs — multiple NULL keys are fine).
2. Retrofit block (same pattern as the existing `resume_attempt` retrofit): `PRAGMA table_info(executions)` → for each missing column of `result`/`error`/`request_key`, `ALTER TABLE executions ADD COLUMN …`, then the `CREATE UNIQUE INDEX IF NOT EXISTS`.
3. `put`: the statement is `INSERT … ON CONFLICT(id) DO UPDATE SET <explicit list>` — extend **BOTH** halves: add `result, error, request_key` to the INSERT column list + `?` placeholders + args (`execution.result === undefined ? null : JSON.stringify(execution.result)`, `execution.error === undefined ? null : JSON.stringify(execution.error)`, `execution.requestKey ?? null`) **and** add `result = excluded.result, error = excluded.error, request_key = excluded.request_key` to the `DO UPDATE SET` list — `finish()`'s settle is the UPDATE arm; without this the outcome never lands on the existing row.
4. `get`: after `endedAt`, hydrate the three fields via `maybeText(row, "result")` / `"error"` / `"request_key"` with the file's `parseJson` + `executionReadError` pattern (`request_key` is a plain string, no JSON parse).
5. `getByRequestKey(key)`: `SELECT * FROM executions WHERE request_key = ?` sharing `get`'s row-hydration (extract the existing hydration body into a local `hydrateExecutionRow(row, id)` used by both).
6. `failClaimedResume(id, reason)`: the UPDATE gains `error = ?` with `JSON.stringify({ name: "ConduitInternalError", message: reason })` (drop the `_` prefix from the parameter).

- [ ] **Step 4: Run to verify pass**

Run (unsandboxed): `cd packages/sdk && node_modules/.bin/vitest run src/store/sqlite.test.ts` → PASS; then full `node_modules/.bin/vitest run` + `node_modules/.bin/tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/types.ts packages/sdk/src/store/store.ts packages/sdk/src/store/sqlite.ts packages/sdk/src/store/sqlite.test.ts
git commit -m "feat(sdk): persist execution outcome + requestKey (mcp design M4/M1)"
```

---

### Task 2: SDK — WAL/busy_timeout pragmas + concurrency-safe migration

**Files:**
- Modify: `packages/sdk/src/store/sqlite.ts` (openSqliteStore preamble + retrofit hardening)
- Test: `packages/sdk/src/store/sqlite.test.ts`

**Interfaces:**
- Consumes: Task 1's retrofit blocks.
- Produces: every `openSqliteStore` on a `file:` URL runs `PRAGMA busy_timeout = 5000` then `PRAGMA journal_mode = WAL` **before any schema statement**; every conditional schema statement (ADD retrofits AND the §11 `DROP COLUMN output`) is wrapped in `tolerateSchemaRace()`.

- [ ] **Step 1: Failing tests** (append to `sqlite.test.ts`):

```ts
describe("multi-process store hygiene (mcp design M5)", () => {
  it("sets WAL and busy_timeout on file databases", async () => {
    const url = tempFileDbUrl();
    const client = createClient({ url });
    await openSqliteStore({ client, secretBox: await testSecretBox() });
    const mode = await client.execute("PRAGMA journal_mode");
    expect(String(Object.values(mode.rows[0] ?? {})[0]).toLowerCase()).toBe("wal");
    const busy = await client.execute("PRAGMA busy_timeout");
    expect(Number(Object.values(busy.rows[0] ?? {})[0])).toBe(5000);
  });

  it("two simultaneous opens of a legacy db both succeed (migration race, M5)", async () => {
    const { url } = await legacyDb(); // Task 1's fixture — a FILE db, shared by both clients
    const [a, b] = await Promise.all([
      openSqliteStore({ client: createClient({ url }), secretBox: await testSecretBox() }),
      openSqliteStore({ client: createClient({ url }), secretBox: await testSecretBox() }),
    ]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  it("two simultaneous opens of a pre-§11 db (legacy `output` column) both succeed", async () => {
    // The §11 mask-then-DROP migration is also a cross-process race surface:
    // the DROP loser sees "no such column". Build a trace_events table WITH the
    // legacy `output` column per the §11 pre-migration shape (copy the CREATE from
    // sqlite.ts and add `output TEXT`), then open twice concurrently as above.
  });
});
```

- [ ] **Step 2: Run to verify failure** — the pragma test fails (journal_mode = delete); the race tests may pass flakily — that is exactly why the fix must be by construction, not by observed pass. Every retrofit `ALTER` wrapped in `tolerateSchemaRace` IS the by-construction guarantee; the tests are tripwires.

- [ ] **Step 3: Implement** in `openSqliteStore`, first statements before any CREATE/PRAGMA table_info:

```ts
  // M5: multi-process hygiene — BEFORE the first schema statement so the
  // migration itself benefits. WAL is a no-op error on :memory:; tolerate.
  await client.execute("PRAGMA busy_timeout = 5000").catch(() => {});
  await client.execute("PRAGMA journal_mode = WAL").catch(() => {});
```

Add the helper and wrap EVERY conditional schema statement in the file — Task 1's three ADDs, the existing `resume_attempt` and `redact_fields` ADD retrofits, **and the ENTIRE §11 detect→mask→drop migration block** (shape rule, not per-statement patching: the §11 design defines the `output` column's ABSENCE as the migration-done marker, so a "no such column" error at ANY step of that block — the masking `UPDATE`s included, which race a concurrent opener's completed `DROP` — means another process finished the migration; that is SUCCESS, skip the rest of the block):

```ts
/**
 * M5: the PRAGMA table_info → ALTER ladder is idempotent sequentially but
 * races across processes (two fresh servers at login both see the schema
 * delta pending; one ALTER loses). For ADD COLUMN the loser sees "duplicate
 * column name"; for DROP COLUMN it sees "no such column". Either way the
 * schema is already in the state the retrofit promises — SUCCESS, not failure.
 */
async function tolerateSchemaRace(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const text = String(error);
    if (!text.includes("duplicate column name") && !text.includes("no such column")) {
      throw error;
    }
  }
}
```

For the §11 block specifically, wrap the WHOLE detect→mask→drop sequence in one
`tolerateSchemaRace(async () => { /* mask UPDATEs; DROP */ })` call — a
"no such column" from any inner statement aborts the remainder of the block as
already-done (the column absence IS the §11 done marker), rather than wrapping
each statement individually (which would let a later statement run after an
earlier one proved the migration complete).

- [ ] **Step 4: Run to verify pass** (unsandboxed, full sdk suite + tsc) → green.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/store/sqlite.ts packages/sdk/src/store/sqlite.test.ts
git commit -m "feat(sdk): WAL + busy_timeout + cross-process-safe migration (mcp design M5)"
```

---

### Task 3: SDK — manager: outcome-aware terminals + requestKey

**Files:**
- Modify: `packages/sdk/src/execution/manager.ts`
- Test: `packages/sdk/src/execution/manager.test.ts`

**Interfaces:**
- Consumes: Task 1's `Execution.result/error/requestKey`, `getByRequestKey`, unique-violation throw on `put`.
- Produces: `ExecutionManager.start(code, opts?: { limits?: Partial<SandboxLimits>; requestKey?: string })`; a stored `completed` row carries `result`; a stored `failed` row ALWAYS carries `error` (synthetic `ConduitPersistError` on the fallback path); `expired` carries neither; duplicate requestKey → `{ status: "conflict", executionId: <existing id> }` without a second execution.

- [ ] **Step 1: Failing tests** (append to `manager.test.ts`, using the file's existing fake sandbox/store fixtures):

```ts
describe("outcome persistence (mcp design M4)", () => {
  it("persists result on completed and error on failed", async () => {
    // completed: sandbox fixture resolves { status: "completed", value: { n: 1 } }
    const done = await manager.start("return 1");
    expect(done.status).toBe("completed");
    expect((await store.executions.get(done.executionId))?.result).toEqual({ n: 1 });
    // failed: sandbox fixture resolves { status: "failed", error: {...} }
    const failed = await failingManager.start("throw");
    expect((await store.executions.get(failed.executionId))?.error?.name).toBeTruthy();
  });

  it("INVARIANT M4: a stored failed row always explains itself — fallback carries ConduitPersistError", async () => {
    // store fixture whose put() throws ONCE on the settle write, then succeeds.
    // Run the SAME fault-injection against EVERY terminal path (design M9):
    // (a) completed settle faulted, (b) failed settle faulted, (c) paused
    // persistence faulted, (d) expired persistence faulted. Parameterize with
    // it.each over sandbox fixtures {completing, failing, pausing} + the
    // clock-advanced resume for (d). In all four cases the stored row must be
    // status "failed" (or "expired"'s fallback "failed") WITH error.name ===
    // "ConduitPersistError" — never a payload-less terminal row.
    const outcome = await flakyStoreManager.start("return 1");
    const row = await store.executions.get(outcome.executionId);
    expect(row?.status).toBe("failed");
    expect(row?.error?.name).toBe("ConduitPersistError");
  });

  it("expired rows carry neither result nor error", async () => {
    // pause, advance clock past TTL, resume → expired
    const paused = await manager.start(pausingCode);
    clock.advancePast(paused /* pending.expiresAt */);
    await manager.resume(paused.executionId, { kind: "approve" });
    const row = await store.executions.get(paused.executionId);
    expect(row?.status).toBe("expired");
    expect(row?.result).toBeUndefined();
    expect(row?.error).toBeUndefined();
  });
});

describe("requestKey (mcp design M1)", () => {
  it("persists the key BEFORE the sandbox runs", async () => {
    // sandbox fixture that THROWS synchronously — the initial put already happened
    await expect(throwingSandboxManager.start("x", { requestKey: "k1" })).rejects.toThrow();
    expect((await store.executions.getByRequestKey("k1"))).toBeDefined();
  });

  it("duplicate key → conflict with the existing execution's id, no second run", async () => {
    const first = await manager.start("return 1", { requestKey: "k2" });
    const second = await manager.start("return 2", { requestKey: "k2" });
    expect(second).toEqual({ status: "conflict", executionId: first.executionId });
    expect(sandboxRunCount).toBe(1); // fixture counter — the second start never drove
  });
});
```

- [ ] **Step 2: Run to verify failures** — `cd packages/sdk && node_modules/.bin/vitest run src/execution/manager.test.ts`.

- [ ] **Step 3: Implement** in `manager.ts`:

1. `ExecutionManager.start` signature: `start(code: string, opts?: { limits?: Partial<SandboxLimits>; requestKey?: string }): Promise<ExecutionOutcome>` (interface + impl).
2. In `start`: build the execution with `...(opts?.requestKey !== undefined ? { requestKey: opts.requestKey } : {})`; wrap the initial `await deps.store.executions.put(execution)` in a try/catch — on an error whose `String(error)` includes `"UNIQUE constraint failed: executions.request_key"`, look up `const existing = await deps.store.executions.getByRequestKey(opts!.requestKey!)` and `return { status: "conflict", executionId: existing?.id ?? "" }` (an `existing` of undefined is a store fault — rethrow the original error in that case).
3. `finish()`: build `persisted` with the outcome folded in:

```ts
    const persisted: Execution = {
      ...execution,
      status: outcome.status,
      endedAt: now(),
      ...(outcome.status === "completed" ? { result: outcome.value ?? null } : {}),
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
    };
```

   (`outcome.value ?? null` is the M1 undefined→null normalization at persistence.)
4. `persistOrFinalizeFailed()` fallback: the synthetic failed row gains an error payload — replace the fallback construction with:

```ts
      const failed: Execution = {
        ...execution,
        status: "failed",
        endedAt: now(),
        error: execution.error ?? {
          name: "ConduitPersistError",
          message: `[ExecutionManager] Settle write failed; outcome not persisted. Context: { executionId: ${execution.id}, cause: ${String(cause)} }`,
        },
      };
      delete failed.pausedOn;
```

5. The expired path already spreads the paused execution (no result/error present) — no change; the test pins it.

- [ ] **Step 4: Run to verify pass** — manager suite, then full sdk suite + tsc (unsandboxed) → green. The e2e smoke §9.2 raw-dump assertion runs in the full suite — it must stay green with the new columns present.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/execution/manager.ts packages/sdk/src/execution/manager.test.ts
git commit -m "feat(sdk): outcome-aware terminal transitions + requestKey conflict (mcp design M4/M1)"
```

---

### Task 4: SDK — capped connection listing in the execute description

**Files:**
- Modify: `packages/sdk/src/execute.ts`
- Test: `packages/sdk/src/execute.test.ts`

**Interfaces:**
- Consumes: existing `buildExecuteTool`, `estimateTokens`.
- Produces: listing shows at most `MAX_LISTED_CONNECTIONS = 10` lines; more append `- …and K more — search the catalog`; description notes staleness ("connection list as of your client's last refresh; search the catalog for current tools").

- [ ] **Step 1: Failing test** (append to `execute.test.ts`):

```ts
it("INVARIANT §4.2: the definition stays under budget with 100 connections (capped listing)", () => {
  const connections = Array.from({ length: 100 }, (_, i) => ({
    prefix: `service${i}.org.main`,
    label: `Service ${i} connection with a fairly long label`,
  }));
  const definition = buildExecuteTool({ connections });
  expect(estimateTokens(definition)).toBeLessThanOrEqual(1_044);
  expect(definition.description).toContain("…and 90 more — search the catalog");
});
```

- [ ] **Step 2: Run to verify failure** — token estimate blows past 1,044.

- [ ] **Step 3: Implement** in `buildExecuteTool`:

```ts
const MAX_LISTED_CONNECTIONS = 10;
// inside buildExecuteTool:
  const listed = options.connections.slice(0, MAX_LISTED_CONNECTIONS);
  const overflow = options.connections.length - listed.length;
  const connectionLines =
    options.connections.length > 0
      ? [
          ...listed.map((c) => `- ${c.prefix} : ${c.label}`),
          ...(overflow > 0 ? [`- …and ${overflow} more — search the catalog`] : []),
        ].join("\n")
      : "- (none configured yet)";
```

And append one sentence to the description body (after the search-guidance line): `Connection list is as of your client's last refresh; search the catalog for current tools.`

- [ ] **Step 4: Run to verify pass** — execute suite + full sdk suite + tsc (unsandboxed). The existing small-fixture §4.2 pins must also stay green.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/execute.ts packages/sdk/src/execute.test.ts
git commit -m "feat(sdk): cap execute-description connection listing to hold the §4.2 token pin"
```

---

### Task 5: packages/mcp scaffolding + dependency install (STOP)

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/tsup.config.ts`, `packages/mcp/vitest.config.ts`

**Interfaces:**
- Produces: an installable workspace package `@conduithq/mcp` with bin `conduit-mcp`; later tasks import `@conduithq/sdk` and `@modelcontextprotocol/sdk`.

- [ ] **Step 1: Write the package files**

`packages/mcp/package.json`:

> **Amended 2026-09-04:** the `license` field below read `MIT` as originally
> written, which was correct on 2026-07-11. Apache-2.0 was decided
> 2026-08-03 (spec §18), and this plan is a TEMPLATE a later session copies
> from, so the stale value is corrected here rather than left to be pasted
> into a new manifest. Verify against the repo's `LICENSE` file, never from
> a doc, if this is ever used again.

```json
{
  "name": "@conduithq/mcp",
  "version": "0.1.0",
  "description": "Conduit MCP server — stdio transport (spec §17 step 2).",
  "license": "Apache-2.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "bin": { "conduit-mcp": "./dist/bin.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@conduithq/sdk": "workspace:*",
    "@modelcontextprotocol/sdk": "1.29.0"
  },
  "devDependencies": {
    "@types/node": "26.0.1",
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^3.2.6"
  }
}
```

`packages/mcp/tsconfig.json` (mirror `packages/sdk/tsconfig.json`, same strict base):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/mcp/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts" },
  format: "esm",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
});
```

`packages/mcp/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```

(Also create a placeholder `packages/mcp/src/index.ts` exporting nothing yet — `export {};` — so build/typecheck have an entry; Tasks 6–8 fill it.)

- [ ] **Step 2: STOP — hand the install to the user**

The agent must NOT run this. Tell the user to run in their own terminal (routes through Socket Firewall; `minimumReleaseAge` applies):

```bash
cd ~/projects/conduit-HQ && pnpm install
```

Wait for confirmation that it succeeded before proceeding.

- [ ] **Step 3: Verify the workspace resolves**

Run: `cd packages/mcp && node_modules/.bin/tsc --noEmit` → clean; `node -e "import('@modelcontextprotocol/sdk/server/index.js').then(() => console.error('ok'))"` → prints `ok` on stderr.
Also verify the lockfile pinned exactly 1.29.0: `grep -A1 '"@modelcontextprotocol/sdk"' packages/mcp/package.json` shows `"1.29.0"`.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/package.json packages/mcp/tsconfig.json packages/mcp/tsup.config.ts packages/mcp/vitest.config.ts packages/mcp/src/index.ts pnpm-lock.yaml
git commit -m "chore(mcp): scaffold @conduithq/mcp package (exact-pinned MCP SDK 1.29.0)"
```

---

### Task 6: packages/mcp — payloads: envelopes + check_execution definition

**Files:**
- Create: `packages/mcp/src/payloads.ts`
- Test: `packages/mcp/src/payloads.test.ts`

**Interfaces:**
- Consumes: `ExecutionOutcome`, `Execution`, `PendingApproval`, `estimateTokens`-style budget (local re-implementation not needed — import `estimateTokens` shape via a local helper, see below).
- Produces (used by Task 7):
  - `CHECK_EXECUTION_TOOL: { name: "check_execution"; description: string; inputSchema: JsonSchema }`
  - `extendExecuteDefinition(def: ExecuteToolDefinition): ExecuteToolDefinition` — adds optional `requestKey` input property.
  - `outcomeToPayload(outcome: ExecutionOutcome): ExecutePayload`
  - `executionToCheckPayload(execution: Execution | undefined, now: number): CheckPayload`
  - `toTextResult(payload: unknown): { content: [{ type: "text"; text: string }] }`
  - Error envelope type: `{ code: string; message: string; hint?: string; retryable: boolean }`.

- [ ] **Step 1: Failing tests** — `packages/mcp/src/payloads.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildExecuteTool } from "@conduithq/sdk";
import {
  CHECK_EXECUTION_TOOL, estimateDefinitionTokens, executionToCheckPayload,
  extendExecuteDefinition, outcomeToPayload,
} from "./payloads.js";

const seeds = { now: 1, random: 0.5 };

describe("tool definitions", () => {
  it("INVARIANT: check_execution definition ≤ 256 estimated tokens", () => {
    expect(estimateDefinitionTokens(CHECK_EXECUTION_TOOL)).toBeLessThanOrEqual(256);
  });
  it("INVARIANT §4.2: extended execute definition (requestKey) stays ≤ 1044 tokens", () => {
    const base = buildExecuteTool({ connections: [{ prefix: "github.acme.prod", label: "Acme GitHub" }] });
    const extended = extendExecuteDefinition(base);
    expect(extended.inputSchema.properties?.requestKey).toBeDefined();
    expect(estimateDefinitionTokens(extended)).toBeLessThanOrEqual(1_044);
  });
});

describe("outcomeToPayload (execute)", () => {
  it("completed normalizes undefined result to null and requires the field", () => {
    const p = outcomeToPayload({ status: "completed", executionId: "e1", value: undefined });
    expect(p).toEqual({ status: "completed", executionId: "e1", result: null });
  });
  it("failed wraps the error envelope", () => {
    const p = outcomeToPayload({
      status: "failed", executionId: "e2",
      error: { name: "ConduitExecutionError", message: "boom" },
    });
    expect(p.error).toEqual({ code: "ConduitExecutionError", message: "boom", retryable: false });
  });
  it("paused message tells the agent to report to the human and STOP", () => {
    const p = outcomeToPayload({
      status: "paused", executionId: "e3",
      pending: { callId: "c", toolName: "github.delete_repo", input: {}, reason: "destructive", expiresAt: 99 },
    });
    expect(p.pending).toEqual({ toolName: "github.delete_repo", reason: "destructive", expiresAt: 99 });
    expect(p.message).toMatch(/report .* to the (user|human)/i);
    expect(p.message).toMatch(/stop/i);
    expect(p.message).toMatch(/check_execution/);
  });
  it("conflict (duplicate requestKey) points at check_execution", () => {
    const p = outcomeToPayload({ status: "conflict", executionId: "e4" });
    expect(p.status).toBe("conflict");
    expect(p.message).toMatch(/check_execution/);
  });
});

describe("executionToCheckPayload (check_execution)", () => {
  const base = { id: "e", code: "1", seeds, startedAt: 1 } as const;
  it("not_found for unknown executions", () => {
    expect(executionToCheckPayload(undefined, 10)).toEqual({ status: "not_found" });
  });
  it("running passes through", () => {
    expect(executionToCheckPayload({ ...base, status: "running" }, 10).status).toBe("running");
  });
  it("paused past expiresAt presents expired READ-ONLY with a retry message", () => {
    const p = executionToCheckPayload({
      ...base, status: "paused",
      pausedOn: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 5 },
    }, 10);
    expect(p.status).toBe("expired");
    expect(p.message).toMatch(/re-issue|retry/i);
  });
  it("paused before expiresAt carries pending", () => {
    const p = executionToCheckPayload({
      ...base, status: "paused",
      pausedOn: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 50 },
    }, 10);
    expect(p.status).toBe("paused");
    expect(p.pending?.toolName).toBe("t");
  });
  it("completed requires result (null when absent/legacy)", () => {
    expect(executionToCheckPayload({ ...base, status: "completed", endedAt: 2 }, 10))
      .toEqual({ status: "completed", executionId: "e", result: null });
  });
  it("failed always carries the envelope", () => {
    const p = executionToCheckPayload({
      ...base, status: "failed", endedAt: 2,
      error: { name: "ConduitPersistError", message: "m" },
    }, 10);
    expect(p.error?.code).toBe("ConduitPersistError");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd packages/mcp && node_modules/.bin/vitest run src/payloads.test.ts` → module not found.

- [ ] **Step 3: Implement `packages/mcp/src/payloads.ts`** (complete file):

```ts
import type { ExecuteToolDefinition, ExecutionOutcome } from "@conduithq/sdk";
import type { Execution, JsonSchema, PendingApproval } from "@conduithq/sdk";

/** Shared agent-visible error envelope (design M8). */
export interface ErrorEnvelope {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
}

export interface PendingView {
  toolName: string;
  reason: string;
  expiresAt: number;
}

export interface ExecutePayload {
  status: "completed" | "failed" | "paused" | "expired" | "conflict";
  executionId: string;
  result?: unknown;
  error?: ErrorEnvelope;
  pending?: PendingView;
  message?: string;
}

/** Independent of ExecutePayload — check adds "running"/"not_found" states. */
export interface CheckPayloadBody {
  status: "running" | "completed" | "failed" | "paused" | "expired";
  executionId: string;
  result?: unknown;
  error?: ErrorEnvelope;
  pending?: PendingView;
  message?: string;
}
export type CheckPayload = { status: "not_found" } | CheckPayloadBody;

/** ~4 chars/token heuristic, same shape as the sdk's estimateTokens. */
export function estimateDefinitionTokens(definition: unknown): number {
  return Math.ceil(JSON.stringify(definition).length / 4);
}

const PAUSE_MESSAGE =
  "A human must approve this call out-of-band. Report the pending approval and this " +
  "executionId to the user, then STOP — do not poll in a loop; approval may take hours. " +
  "When the user says it is approved, call check_execution with this executionId (or your requestKey).";

const EXPIRED_MESSAGE =
  "The approval expired before a human decided (TTL lapsed). You may re-issue execute to retry.";

const CONFLICT_MESSAGE =
  "This requestKey was already used by an earlier execute call. Call check_execution with the " +
  "requestKey to retrieve that execution's outcome instead of re-running.";

export const CHECK_EXECUTION_TOOL: {
  name: "check_execution";
  description: string;
  inputSchema: JsonSchema;
} = {
  name: "check_execution",
  description:
    "Check a Conduit execution started by the execute tool. Identify it by executionId or by the " +
    "requestKey you passed to execute. Returns status plus: pending (paused), result (completed — " +
    "a null result can be legitimate), or error (failed). Note: under the single-process runtime, " +
    "'running' can also mean the host that ran it crashed.",
  inputSchema: {
    type: "object",
    properties: {
      executionId: { type: "string", description: "The exec_… id returned by execute." },
      requestKey: { type: "string", description: "The correlation key you passed to execute." },
    },
    additionalProperties: false,
  },
};

/** Adds the optional requestKey input (design M1) to the sdk's canonical definition. */
export function extendExecuteDefinition(def: ExecuteToolDefinition): ExecuteToolDefinition {
  const properties = {
    ...(def.inputSchema.properties as Record<string, unknown>),
    requestKey: {
      type: "string",
      description:
        "Optional correlation key you generate. Persisted before the run starts, so if this " +
        "response is lost you can recover the outcome via check_execution({ requestKey }). " +
        "Reuse of a key never starts a second execution.",
    },
  };
  return { ...def, inputSchema: { ...def.inputSchema, properties } };
}

/** Known-cause hints keyed on error text (bounded, documented — not a denylist). */
function hintFor(message: string): string | undefined {
  if (/egress/i.test(message)) {
    return (
      "Blocked by the §9.3 egress policy (private address). A deliberate operator-level " +
      "override exists — see the Conduit server log and troubleshooting docs."
    );
  }
  return undefined;
}

export function toErrorEnvelope(error: { name: string; message: string }): ErrorEnvelope {
  const hint = hintFor(error.message);
  return {
    code: error.name,
    message: error.message,
    ...(hint !== undefined ? { hint } : {}),
    retryable: false,
  };
}

function toPendingView(pending: PendingApproval): PendingView {
  return { toolName: pending.toolName, reason: pending.reason, expiresAt: pending.expiresAt };
}

export function outcomeToPayload(outcome: ExecutionOutcome): ExecutePayload {
  switch (outcome.status) {
    case "completed":
      return { status: "completed", executionId: outcome.executionId, result: outcome.value ?? null };
    case "failed":
      return { status: "failed", executionId: outcome.executionId, error: toErrorEnvelope(outcome.error) };
    case "paused":
      return {
        status: "paused",
        executionId: outcome.executionId,
        pending: toPendingView(outcome.pending),
        message: PAUSE_MESSAGE,
      };
    case "expired":
      return { status: "expired", executionId: outcome.executionId, message: EXPIRED_MESSAGE };
    case "conflict":
      return { status: "conflict", executionId: outcome.executionId, message: CONFLICT_MESSAGE };
  }
}

export function executionToCheckPayload(execution: Execution | undefined, now: number): CheckPayload {
  if (execution === undefined) {
    return { status: "not_found" };
  }
  switch (execution.status) {
    case "running":
      return { status: "running", executionId: execution.id };
    case "paused": {
      const pending = execution.pausedOn;
      if (pending !== undefined && now > pending.expiresAt) {
        // Read-only expired presentation (design M1): the durable lazy
        // expiry-on-resume transition is untouched; we only present.
        return { status: "expired", executionId: execution.id, message: EXPIRED_MESSAGE };
      }
      return {
        status: "paused",
        executionId: execution.id,
        ...(pending !== undefined ? { pending: toPendingView(pending), message: PAUSE_MESSAGE } : {}),
      };
    }
    case "completed":
      return { status: "completed", executionId: execution.id, result: execution.result ?? null };
    case "failed":
      return {
        status: "failed",
        executionId: execution.id,
        error: toErrorEnvelope(
          execution.error ?? { name: "ConduitUnknownError", message: "failed with no recorded error (legacy row)" },
        ),
      };
    case "expired":
      return { status: "expired", executionId: execution.id, message: EXPIRED_MESSAGE };
  }
}

export function toTextResult(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}
```

- [ ] **Step 4: Run to verify pass** — payloads suite + `node_modules/.bin/tsc --noEmit` → green. (If sdk type names differ from the imports above — e.g. `ExecutionOutcome` export — fix the import, not the test.)

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/payloads.ts packages/mcp/src/payloads.test.ts
git commit -m "feat(mcp): payload envelopes, check_execution definition, execute extension"
```

---

### Task 7: packages/mcp — createConduitMcpServer (handlers over the SDK)

**Files:**
- Create: `packages/mcp/src/server.ts`
- Modify: `packages/mcp/src/index.ts` (exports)
- Test: `packages/mcp/src/server.test.ts`

**Interfaces:**
- Consumes: everything from Task 6; sdk: `openSqliteStore` NOT here (store is injected), `InMemoryCatalog`, `createCatalogToolHost`, `createExecutionManager`, `createToolInvoker`, `createMcpUpstreamCaller`, `createStorePolicyEngine`, `createStoreCredentialResolver`, `buildExecuteTool`, `QuickJSSandbox`, `ConduitStore`.
- Produces: `createConduitMcpServer(options: ConduitMcpServerOptions): Server` where

```ts
export interface ConduitMcpServerOptions {
  store: ConduitStore;
  /** §9.3 opt-in — CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS (M7). Default false. */
  allowPrivateEgress?: boolean;
  /** Injectable for tests. */
  now?: () => number;
  log?: (line: string) => void; // defaults to console.error
}
```

- [ ] **Step 1: Failing tests** — `packages/mcp/src/server.test.ts`, ring 1 over `InMemoryTransport`. Fixtures: an in-memory store via `openSqliteStore({ client: createClient({ url: ":memory:" }), secretBox })` seeded like the smoke test (source/integration/connection/secret/tools) but with a **fake upstream**: since ring 1 must not bind sockets, seed only tools whose calls the tests avoid, or drive `execute` code that only uses `tools.search` — the load-bearing assertions here are protocol-shaped:

```ts
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function connect(server: ReturnType<typeof createConduitMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

it("tools/list exposes exactly execute + check_execution, with fresh connections", async () => {
  const client = await connect(server);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["check_execution", "execute"]);
  const execute = tools.find((t) => t.name === "execute");
  expect(execute?.description).toContain("github.acme.prod");
  expect((execute?.inputSchema.properties as Record<string, unknown>).requestKey).toBeDefined();
});

it("execute runs code through the sandbox and returns a completed payload", async () => {
  const client = await connect(server);
  const res = await client.callTool({
    name: "execute",
    arguments: { code: "const { items } = await tools.search({ query: \"issues\" }); return items.length;" },
  });
  const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
  expect(payload.status).toBe("completed");
  expect(payload.executionId).toMatch(/^exec_/);
});

it("check_execution resolves by executionId and by requestKey; unknown → not_found", async () => {
  const client = await connect(server);
  const run = await client.callTool({
    name: "execute",
    arguments: { code: "return 42;", requestKey: "rk-1" },
  });
  const { executionId } = JSON.parse((run.content as Array<{ text: string }>)[0].text);
  for (const args of [{ executionId }, { requestKey: "rk-1" }]) {
    const res = await client.callTool({ name: "check_execution", arguments: args });
    const p = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(p.status).toBe("completed");
    expect(p.result).toBe(42);
  }
  const missing = await client.callTool({ name: "check_execution", arguments: { executionId: "exec_nope" } });
  expect(JSON.parse((missing.content as Array<{ text: string }>)[0].text)).toEqual({ status: "not_found" });
});

it("INVARIANT M1: there is no resume/approve tool on the MCP surface", async () => {
  const client = await connect(server);
  const { tools } = await client.listTools();
  expect(tools.some((t) => /resume|approve/i.test(t.name))).toBe(false);
  await expect(client.callTool({ name: "resume", arguments: {} })).rejects.toThrow();
});

it("malformed arguments → InvalidParams protocol error (handler-owned validation)", async () => {
  const client = await connect(server);
  await expect(client.callTool({ name: "execute", arguments: {} })).rejects.toThrow(/invalid|params/i);
  await expect(
    client.callTool({ name: "check_execution", arguments: {} }),
  ).rejects.toThrow(/invalid|params/i); // neither executionId nor requestKey
});

it("a new connection appears on the NEXT tools/list without restart (M6)", async () => {
  const client = await connect(server);
  await store.integrations.upsert({ id: "int2", sourceId: "src2", namespace: "stripe" });
  await store.connections.upsert({ id: "conn2", integrationId: "int2", prefix: "stripe.acme.live" });
  const { tools } = await client.listTools();
  expect(tools.find((t) => t.name === "execute")?.description).toContain("stripe.acme.live");
});
```

Plus a pause-shaped test: seed a `destructive` tool with a `require_approval` policy row, call execute with code invoking it via a loopback-free fake? A policy pause happens BEFORE upstream is reached, so no socket is needed: the invoker refuses at the policy step. Include:

```ts
it("a require_approval policy pauses; payload carries pending + stop-and-report message", async () => {
  const client = await connect(server);
  const res = await client.callTool({
    name: "execute",
    arguments: { code: "return await tools.github.delete_repo({ repo: \"x\" });" },
  });
  const p = JSON.parse((res.content as Array<{ text: string }>)[0].text);
  expect(p.status).toBe("paused");
  expect(p.pending.toolName).toBe("github.delete_repo");
  expect(p.message).toMatch(/stop/i);
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement `packages/mcp/src/server.ts`** (complete file):

```ts
import {
  buildExecuteTool,
  type ConduitStore,
  createCatalogToolHost,
  createExecutionManager,
  createMcpUpstreamCaller,
  createStoreCredentialResolver,
  createStorePolicyEngine,
  createToolInvoker,
  type ExecutionOutcome,
  InMemoryCatalog,
  QuickJSSandbox,
} from "@conduithq/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  CHECK_EXECUTION_TOOL,
  executionToCheckPayload,
  extendExecuteDefinition,
  outcomeToPayload,
  toTextResult,
} from "./payloads.js";

export interface ConduitMcpServerOptions {
  store: ConduitStore;
  /** §9.3 opt-in (CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS). Default false — fail closed. */
  allowPrivateEgress?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * One line per namespace by construction — §18 v1: single connection per
 * namespace; the invoker FAILS CLOSED on multi-connection integrations, so an
 * integration with >1 connection is deliberately NOT advertised ("every
 * advertised connection is selectable" — design M6). Ambiguous namespaces get
 * one stderr line so the operator knows why they're absent.
 */
async function listConnections(
  store: ConduitStore,
  log: (line: string) => void,
): Promise<{ prefix: string; label: string }[]> {
  const [connections, integrations] = await Promise.all([
    store.connections.list(),
    store.integrations.list(),
  ]);
  const namespaceById = new Map(integrations.map((i) => [i.id, i.namespace]));
  const byIntegration = new Map<string, typeof connections>();
  for (const c of connections) {
    byIntegration.set(c.integrationId, [...(byIntegration.get(c.integrationId) ?? []), c]);
  }
  const listed: { prefix: string; label: string }[] = [];
  for (const [integrationId, group] of byIntegration) {
    const namespace = namespaceById.get(integrationId) ?? "unknown";
    if (group.length === 1 && group[0] !== undefined) {
      listed.push({ prefix: group[0].prefix, label: `${namespace} tools` });
    } else {
      log(
        `[ConduitMcp] namespace ${namespace} has ${group.length} connections — v1 addressing is single-connection per namespace (§18); not advertised.`,
      );
    }
  }
  return listed;
}

async function hydrateCatalog(store: ConduitStore): Promise<InMemoryCatalog> {
  const catalog = new InMemoryCatalog();
  catalog.upsert(await store.tools.list());
  return catalog;
}

export function createConduitMcpServer(options: ConduitMcpServerOptions): Server {
  const { store } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => Date.now());
  const sandbox = new QuickJSSandbox();
  const policy = createStorePolicyEngine(store.policies);
  const credentials = createStoreCredentialResolver(store.secrets);
  const upstream = createMcpUpstreamCaller(
    options.allowPrivateEgress === true ? { egress: { allowPrivate: true } } : {},
  );

  const server = new Server(
    { name: "conduit", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const definition = extendExecuteDefinition(
      buildExecuteTool({ connections: await listConnections(store, log) }),
    );
    return { tools: [definition, CHECK_EXECUTION_TOOL] };
  });

  /** M2: the low-level API validates nothing — the handler owns it, including
   * unknown-key rejection (`additionalProperties: false` is advertisement,
   * not enforcement). */
  function assertOnlyKeys(args: unknown, allowed: readonly string[], tool: string): Record<string, unknown> {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new McpError(ErrorCode.InvalidParams, `[ConduitMcp] ${tool}: arguments must be an object.`);
    }
    const record = args as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) {
        throw new McpError(ErrorCode.InvalidParams, `[ConduitMcp] ${tool}: unknown argument ${JSON.stringify(key)}.`);
      }
    }
    return record;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "execute") {
      const record = assertOnlyKeys(args ?? {}, ["code", "requestKey"], "execute");
      const code = record.code;
      const requestKey = record.requestKey;
      if (typeof code !== "string" || code === "") {
        throw new McpError(ErrorCode.InvalidParams, "[ConduitMcp] execute requires a non-empty string `code`.");
      }
      if (requestKey !== undefined && typeof requestKey !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "[ConduitMcp] `requestKey` must be a string when present.");
      }
      // M6: fresh catalog snapshot + fresh manager per call (sync makeToolHost
      // is fixed at manager creation; composing per-call is the recorded fix).
      const catalog = await hydrateCatalog(store);
      const manager = createExecutionManager({
        store,
        sandbox,
        makeInvoker: ({ executionId, decisions }) =>
          createToolInvoker(
            { store, policy, credentials, upstream, ...(decisions !== undefined ? { decisions } : {}) },
            { executionId, log },
          ),
        makeToolHost: (invoke) => createCatalogToolHost(catalog, invoke),
      });
      let outcome: ExecutionOutcome;
      try {
        outcome = await manager.start(code, requestKey !== undefined ? { requestKey } : undefined);
      } catch (cause) {
        const correlationId = `mcp_${Math.random().toString(36).slice(2, 10)}`;
        log(`[ConduitMcp] execute failed with an infra fault. Context: { correlationId: ${correlationId}, cause: ${String(cause)} }`);
        throw new McpError(ErrorCode.InternalError, `[ConduitMcp] Internal error (correlation ${correlationId}).`);
      }
      return toTextResult(outcomeToPayload(outcome));
    }
    if (name === "check_execution") {
      const a = assertOnlyKeys(args ?? {}, ["executionId", "requestKey"], "check_execution");
      const executionId = a.executionId;
      const requestKey = a.requestKey;
      if (typeof executionId !== "string" && typeof requestKey !== "string") {
        throw new McpError(
          ErrorCode.InvalidParams,
          "[ConduitMcp] check_execution requires `executionId` or `requestKey` (exactly one; strings).",
        );
      }
      if (typeof executionId === "string" && typeof requestKey === "string") {
        throw new McpError(
          ErrorCode.InvalidParams,
          "[ConduitMcp] check_execution takes `executionId` OR `requestKey`, not both.",
        );
      }
      const execution =
        typeof executionId === "string"
          ? await store.executions.get(executionId)
          : await store.executions.getByRequestKey(requestKey as string);
      return toTextResult(executionToCheckPayload(execution, now()));
    }
    throw new McpError(ErrorCode.InvalidParams, `[ConduitMcp] Unknown tool: ${name}`);
  });

  return server;
}
```

`packages/mcp/src/index.ts`:

```ts
export { ensureDbDir, KEYGEN_ONE_LINER, resolveEnv, type ResolvedEnv } from "./env.js";
export { CHECK_EXECUTION_TOOL, executionToCheckPayload, extendExecuteDefinition, outcomeToPayload } from "./payloads.js";
export { type ConduitMcpServerOptions, createConduitMcpServer } from "./server.js";
```

(The `./env.js` line lands with Task 8, which creates that file — add it there; noted here so the export list is complete in one place. `doctor` stays bin-internal: it is a CLI mode, not library API.)

(Verify at implementation time: `McpError`/`ErrorCode` export names and the `CallToolRequestSchema` handler return type in v1.29.0 — if the SDK names differ, adapt the import, keep the behavior. This is the only file that touches the SDK's server API.)

- [ ] **Step 4: Run to verify pass** — `cd packages/mcp && node_modules/.bin/vitest run src/server.test.ts` (unsandboxed if it opens file DBs) + `tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/server.ts packages/mcp/src/index.ts packages/mcp/src/server.test.ts
git commit -m "feat(mcp): createConduitMcpServer — two-tool surface over the SDK pipeline"
```

---

### Task 8: packages/mcp — env parsing + bin (stdio entry, --doctor)

**Files:**
- Create: `packages/mcp/src/env.ts`, `packages/mcp/src/bin.ts`
- Test: `packages/mcp/src/env.test.ts`

**Interfaces:**
- Consumes: `SecretBox` (sdk), `createClient` (`@libsql/client` — comes via the sdk's dependency; import from `@libsql/client` requires it in packages/mcp deps: **add `"@libsql/client": "^0.14.0"` to packages/mcp dependencies in Task 5's package.json** — it is already in the workspace lockfile).
- Produces:

```ts
export interface ResolvedEnv {
  dbPath: string;            // default ~/.conduit/conduit.db
  keyBytes: Uint8Array;      // canonical base64-decoded, exactly 32 bytes
  allowPrivateEgress: boolean;
}
export function resolveEnv(env: NodeJS.ProcessEnv): ResolvedEnv; // throws per-cause messages
export function ensureDbDir(dbPath: string): void;               // 0700 parent dir
// (doctor is bin-internal — a CLI mode in bin.ts, not exported library API)
```

Task 8 also appends the env exports to `index.ts` (see Task 7's complete export list).

- [ ] **Step 1: Failing tests** — `packages/mcp/src/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveEnv } from "./env.js";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("resolveEnv (design M7/M8)", () => {
  it("resolves defaults and decodes the key", () => {
    const r = resolveEnv({ CONDUIT_MASTER_KEY: KEY });
    expect(r.dbPath.endsWith("/.conduit/conduit.db")).toBe(true);
    expect(r.keyBytes.length).toBe(32);
    expect(r.allowPrivateEgress).toBe(false);
  });
  it("missing key → per-cause message including the generation one-liner", () => {
    expect(() => resolveEnv({})).toThrow(/CONDUIT_MASTER_KEY.*randomBytes\(32\)/s);
  });
  it("malformed key (wrong length) → per-cause message", () => {
    expect(() => resolveEnv({ CONDUIT_MASTER_KEY: Buffer.alloc(16).toString("base64") }))
      .toThrow(/32 bytes/);
  });
  it("non-canonical base64 (invalid characters) → per-cause message, not silent 32 bytes", () => {
    const valid = Buffer.alloc(32, 7).toString("base64");
    expect(() => resolveEnv({ CONDUIT_MASTER_KEY: `!!${valid.slice(2)}` })).toThrow(/canonical|encoding/i);
  });
  it("egress opt-in", () => {
    expect(resolveEnv({ CONDUIT_MASTER_KEY: KEY, CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1" }).allowPrivateEgress).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`packages/mcp/src/env.ts` (complete file):

```ts
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const KEYGEN_ONE_LINER =
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`;

export interface ResolvedEnv {
  dbPath: string;
  keyBytes: Uint8Array;
  allowPrivateEgress: boolean;
}

export function resolveEnv(env: NodeJS.ProcessEnv): ResolvedEnv {
  const raw = env.CONDUIT_MASTER_KEY;
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `[ConduitMcp] Missing CONDUIT_MASTER_KEY: set it in your MCP client config. ` +
        `Generate one with: ${KEYGEN_ONE_LINER}`,
    );
  }
  const trimmed = raw.trim();
  const keyBytes = Buffer.from(trimmed, "base64");
  // Canonical-encoding check (design M8): Buffer.from silently ignores
  // invalid base64 characters — re-encode and compare so a corrupted key is
  // a loud per-cause failure, not 32 quietly-wrong bytes.
  if (keyBytes.length !== 32 || keyBytes.toString("base64") !== trimmed) {
    throw new Error(
      `[ConduitMcp] Malformed CONDUIT_MASTER_KEY: expected canonical base64 of exactly 32 bytes ` +
        `(got ${keyBytes.length} bytes${keyBytes.toString("base64") !== trimmed ? ", non-canonical encoding" : ""}). ` +
        `Generate a valid key with: ${KEYGEN_ONE_LINER}`,
    );
  }
  const dbPath = env.CONDUIT_DB?.trim() || join(homedir(), ".conduit", "conduit.db");
  return {
    dbPath,
    keyBytes,
    allowPrivateEgress: env.CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS === "1",
  };
}

/** Creates the db's parent directory 0700 (it holds encrypted secrets — design M7). */
export function ensureDbDir(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
}
```

`packages/mcp/src/bin.ts` (complete file):

```ts
#!/usr/bin/env node
import { createClient } from "@libsql/client";
import { openSqliteStore, SecretBox } from "@conduithq/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureDbDir, KEYGEN_ONE_LINER, resolveEnv } from "./env.js";
import { createConduitMcpServer } from "./server.js";

// M8: stdout carries protocol frames ONLY. Route console.* to stderr as
// defense-in-depth; the spawned-bin stdout-purity test pins the invariant.
const toStderr = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(" ")}\n`);
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.error = toStderr;

const VERSION = "0.1.0";
const HELP = `conduit-mcp ${VERSION} — Conduit MCP server (stdio)
Env: CONDUIT_DB (default ~/.conduit/conduit.db) · CONDUIT_MASTER_KEY (base64, 32 bytes;
generate: ${KEYGEN_ONE_LINER}) · CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1 (dev/demo ONLY)
· CONDUIT_APPROVAL_TTL (milliseconds)
Flags: --version · --help · --doctor (validate config without an MCP client)`;

async function openStoreFromEnv() {
  const env = resolveEnv(process.env);
  ensureDbDir(env.dbPath);
  const client = createClient({ url: `file:${env.dbPath}` });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(env.keyBytes),
  });
  return { env, store };
}

async function doctor(): Promise<number> {
  try {
    const { env, store } = await openStoreFromEnv();
    const sources = await store.sources.list();
    console.error(`ok: key decodes (32 bytes)`);
    console.error(`ok: database opens at ${env.dbPath}`);
    console.error(`ok: ${sources.length} source(s) in catalog${sources.length === 0 ? " — seed with scripts/seed-demo.mjs" : ""}`);
    console.error(`egress opt-in: ${env.allowPrivateEgress ? "ENABLED (unsafe — dev/demo only)" : "off (fail-closed default)"}`);
    return 0;
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 1;
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--version") {
    console.error(VERSION);
    return;
  }
  if (arg === "--help") {
    console.error(HELP);
    return;
  }
  if (arg === "--doctor") {
    process.exitCode = await doctor();
    return;
  }
  let opened: Awaited<ReturnType<typeof openStoreFromEnv>>;
  try {
    opened = await openStoreFromEnv();
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
  const { env, store } = opened;
  if (env.allowPrivateEgress) {
    console.error(
      "[ConduitMcp] WARNING: CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1 — private-network egress " +
        "is OPEN. Dev/demo only; unset it for anything real (§9.3).",
    );
  }
  if ((await store.sources.list()).length === 0) {
    console.error("[ConduitMcp] 0 sources in catalog — seed with scripts/seed-demo.mjs");
  }
  const server = createConduitMcpServer({ store, allowPrivateEgress: env.allowPrivateEgress });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(`[ConduitMcp] Fatal: ${String(error instanceof Error ? error.message : error)}`);
  process.exit(1);
});
```

Also add `"@libsql/client": "^0.14.0"` to `packages/mcp/package.json` dependencies (if not already done in Task 5) — **STOP** again for the user to re-run `pnpm install` if the lockfile changes.

- [ ] **Step 4: Run to verify pass** — env suite + `tsc --noEmit`; then `node_modules/.bin/tsup` builds `dist/bin.js`; `node dist/bin.js --doctor` (with test env vars) exits per expectation.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/env.ts packages/mcp/src/bin.ts packages/mcp/src/env.test.ts packages/mcp/package.json pnpm-lock.yaml
git commit -m "feat(mcp): conduit-mcp bin — env contract, --doctor, stderr discipline"
```

---

### Task 9: seed + interim approve scripts

**Files:**
- Create: `scripts/seed-demo.mjs`, `scripts/approve-demo.mjs`

(Deviation from the design's `.ts` filenames, recorded: the workspace has no TS
script runner and Node 20 has no stable strip-types — plain `.mjs` importing the
**built dists** (`packages/sdk/dist/index.js`, `packages/mcp/dist/index.js`) runs
with bare `node` on the Node ≥ 20 baseline, zero new dependencies. Both packages
must be built first: `pnpm -r build`. The README and all doc snippets use the
`.mjs` names.)

**Interfaces:**
- Consumes: built dists of both packages; the same `CONDUIT_DB`/`CONDUIT_MASTER_KEY` env contract as the bin (`resolveEnv`/`ensureDbDir` are exported from `@conduithq/mcp` — Task 7/8 export list).
- Produces: `scripts/seed-demo.mjs <upstream-mcp-url>` — seeds source + integration + connection + secret + tools (via `normalizeMcp` against the upstream's `tools/list`, or an inline tool fixture for the demo), upserts **allow-only `Policy` rows for every seeded tool** (check `types.ts` `Policy` exact shape at implementation), prints (stderr) a ready-to-paste client config snippet with the honest command (`node <absolute repo path>/packages/mcp/dist/bin.js`) and env vars. `scripts/approve-demo.mjs <executionId>` — opens the store from the same env, composes a manager exactly as `server.ts` does, calls `resume(executionId, { kind: "approve" })`, prints the outcome status. Task 10's ring-2 suite execs `approve-demo.mjs` as its cross-process approver.

- [ ] **Step 1: Write both scripts** (complete, runnable with bare `node` after `pnpm -r build`).
- [ ] **Step 2: Exercise manually against a temp DB** (unsandboxed): seed → `node packages/mcp/dist/bin.js --doctor` shows 1 source → pause/approve/poll once by hand.
- [ ] **Step 3: Commit**

```bash
git add scripts/seed-demo.mjs scripts/approve-demo.mjs
git commit -m "feat(scripts): demo seed (allow-only policies, config snippet) + interim approve"
```

---

### Task 10: Ring 2 — integration tests against the spawned bin

**Files:**
- Create: `packages/mcp/src/integration.test.ts`

**Interfaces:**
- Consumes: built `dist/bin.js` (the test builds first via `execFile` of tsup, or a `pretest` hook — implementer's degree of freedom, but the test MUST spawn the **compiled bin**, not a TS runner, or the stdout-purity claim is weakened); `scripts/approve-demo.mjs` from Task 9 (the cross-process approver).
- Produces: the M9 ring-2 suite.

- [ ] **Step 1: Write the suite** (test-first is impractical for pure integration — write it, watch it fail against gaps, fix). Reuse `e2e.smoke.test.ts`'s loopback MCP upstream fixture pattern (copy the `startMcpServer` helper shape — a `node:http` server answering JSON-RPC `tools/call`; keep the fixture local to this file). Cases:

```ts
// Setup once: temp dir; CONDUIT_DB=<tmp>/it.db; CONDUIT_MASTER_KEY=<generated>;
// CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1 (loopback upstream — the demo case);
// seed the db in-process via openSqliteStore (source/integration/connection/
// secret/tools from normalizeMcp, allow-only policies), then spawn:
//   new StdioClientTransport({ command: "node", args: ["dist/bin.js"], env, stderr: "pipe" })

it("4-step workflow end-to-end through the spawned bin", ...);
  // execute code = the §6 search→describe→call flow; assert completed payload,
  // upstream saw the prefix-stripped name and the auth header.

it("stdout purity: every stdout byte the client transport did NOT consume is protocol-framed", ...);
  // Drive a full call with the empty-catalog hint + egress warning active
  // (they must land on stderr). Assert transport stderr got the warnings and
  // the protocol conversation succeeded (a corrupted stdout kills the session).

it("pause → approve from a SEPARATE child process → poll sees the persisted result", ...);
  // policy require_approval on one tool; execute pauses; exec Task 9's
  // scripts/approve-demo.mjs <executionId> as the one-shot child process
  // (execFile("node", ["scripts/approve-demo.mjs", executionId], { env }));
  // then check_execution via the STILL-RUNNING first bin returns
  // { status: "completed", result: ... }.

it("client timeout on a slow call: server survives; the row settles; requestKey recovers it", ...);
  // execute code that busy-waits ~3s with a client timeout of 1s and
  // requestKey "slow-1": callTool rejects (timeout); afterwards poll
  // check_execution({ requestKey: "slow-1" }) until { status: "completed" }.

it("parallel tools/call executes run concurrently and both settle", ...);

it("egress fail-closed: WITHOUT the opt-in env, the loopback call fails and the
    agent-visible error hints at the operator override WITHOUT naming the env var", ...);
  // Second spawned bin with CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS unset:
  // payload.status === "failed"; payload.error.hint matches /operator/i and
  // does NOT contain "CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS".
```

- [ ] **Step 2: Run (unsandboxed — loopback sockets + spawned processes):** `cd packages/mcp && node_modules/.bin/tsup && node_modules/.bin/vitest run src/integration.test.ts`. Iterate until green.

- [ ] **Step 3: Full verification** — both packages: sdk suite, mcp suite, tsc both, `node_modules/.bin/biome check .` from repo root.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp/src/integration.test.ts
git commit -m "test(mcp): ring-2 integration — spawned bin, stdout purity, cross-process approval, timeout recovery"
```

---

### Task 11: Docs — README, spec §14/§18/§20, INVARIANTS.md

**Files:**
- Create: `packages/mcp/README.md`
- Modify: `conduitspec.html` (then regenerate `conduitspec.md` via `python3 html2md.py` — same commit, spec-drift hook enforces)
- Modify: `INVARIANTS.md`

**Interfaces:** none — prose, but load-bearing per design "Spec/doc obligations".

- [ ] **Step 1: README.md** — sections: what it is (one paragraph); Quick start (keygen one-liner → seed script → config snippet with honest command → restart client per §14); env table **with units** (`CONDUIT_DB` path default / `CONDUIT_MASTER_KEY` base64 32 bytes / `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` dev-demo only / `CONDUIT_APPROVAL_TTL` **milliseconds**, default 259200000); `--doctor`; Troubleshooting (tools don't appear → restart + client MCP log path `~/Library/Logs/Claude/mcp-server-*.log` on macOS; egress blocked → the env var, named HERE; wrong key fails at first decrypt, not startup; call timed out → `check_execution`/`requestKey`; back up the single db file before upgrading; upstreams: MCP-over-HTTP only in v1).
- [ ] **Step 2: conduitspec.html** — §18 resolved entries (two-tool surface wording; outcome persistence + retention deferral; `packages/mcp` in §20 monorepo list; `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS`; poll-is-skeleton-mechanism with MCP completion signaling as Phase-1 successor). §14 gains ALL of the design's "Spec/doc obligations": the config snippet pointer with the honest pre-publish command, the keygen one-liner + base64-of-32-bytes encoding statement, `chmod 600` on the client config, the seed and interim-approve invocations (`node scripts/seed-demo.mjs <url>` / `node scripts/approve-demo.mjs <execId>`), the env-var table **with units** (`CONDUIT_APPROVAL_TTL` in milliseconds), the restart caveat, and the troubleshooting pointers. Run `python3 html2md.py` in the same commit (spec-drift hook enforces). **Source-faithfulness discipline: before composing each §18 entry, re-read the design doc's exact decision sentences and quote them verbatim — compose against the source, never a paraphrase from memory.**
- [ ] **Step 3: INVARIANTS.md** — add rows (✅ pinned in the same PR): M1 human-only approval seam (`server.test.ts` no-resume-tool test); M8 stdout protocol purity (`integration.test.ts`); M1 `check_execution` ≤256 tokens (`payloads.test.ts`); M4 outcome persistence on every terminal path (`manager.test.ts`); §4.2 capped-listing budget (`execute.test.ts`).
- [ ] **Step 4: Commit**

```bash
git add packages/mcp/README.md conduitspec.html conduitspec.md INVARIANTS.md
git commit -m "docs: mcp server onboarding + spec §14/§18/§20 entries + invariant rows"
```

---

### Task 12: Credential-echo invariant test + final verification

**Files:**
- Modify: `packages/sdk/src/e2e.smoke.test.ts` (extend the existing echo/raw-dump machinery)

- [ ] **Step 1: Failing test** — after the existing resume phase, add: drive one more managed execution whose upstream RESPONSE embeds the fixture credential (`SECRET`) in its result body (extend the loopback fixture with an `/echoInBody` route returning `{ leaked: "<SECRET>" }` as the JSON-RPC result). After completion, re-run the raw-table dump scan (the file's existing dump helper) and assert `rawDump` does not contain `ghp_smoke` — pinning that the upstream caller's sanitize layer protects the **new outcome columns** exactly as it protects the journal.
- [ ] **Step 2: Run** (unsandboxed) — if it FAILS because the echoed secret reaches the persisted result, the upstream sanitize layer does not cover this path: STOP and surface to the user — that changes the design's M4 posture claim and must not be silently patched.
- [ ] **Step 3: On green, full final verification:** repo root `node_modules/.bin/biome check .`; both packages `tsc --noEmit`; full sdk + mcp suites (unsandboxed). Every commit already ran the pre-commit hook — this is the belt-and-suspenders final pass.
- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/e2e.smoke.test.ts
git commit -m "test(sdk): INVARIANT M4 — echoed credential never reaches persisted outcome columns"
```

---

## Post-plan (NOT tasks — project protocol, human-gated)

Push branch → PR per commit routing → Tier 2 review (`/pr-review-toolkit:review-pr all parallel` pre-PR, `code-review:code-review` post-PR, `/security-review` — this PR touches the sandbox-adjacent surface and supply chain) → real `codex exec` adversarial pass → `/explain-diff` + full quiz pass → **user-named merge**. Manual acceptance (Claude Desktop config) is the §17 gate-one half; gate two (edge-case pass on the running skeleton) follows steps 3–4.
