# Daemon Ownership Implementation Plan (§17 v1 step 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One daemon (`conduitd`) owns `~/.conduit/conduit.db`; every other surface becomes a capability-scoped RPC client over a Unix domain socket.

**Architecture:** Lane A builds the daemon core inside `packages/mcp` (SQLite-backed kernel locks → framed IPC + READY gate → daemon runtime with spawn boundary, concurrency cap, drain → auto-start client → crash-terminal sweep). Lane B converts the consumers (`serve`, `approvals`, `add-mcp`, `key`/`--doctor`) and lands docs + ledger. **Two PRs, one per lane** (eng-review decision) — Lane B bases on merged Lane A.

**Tech Stack:** Node ≥20 stdlib (`net`, `fs`, `child_process`), `@libsql/client` (locks AND store), vitest with REAL spawned processes for all lock/lifecycle tests.

**Source of truth:** `docs/superpowers/specs/2026-08-15-daemon-ownership-design.md` (rev 8, CONVERGED). Section references below (§3.1, §3.5…) point THERE, not at conduitspec.

## Global Constraints

- **Zero new dependencies.** Locks use `@libsql/client` (already shipped). RPC validation is hand-written explicit decoders — no zod/ajv in `packages/mcp`.
- **NO SQL schema changes.** The crash-terminal sweep (Task 5) is an UPDATE on the existing `status` column. If an implementer concludes a schema change is needed anywhere: STOP and ask.
- **No RPC may return a master key, plaintext credential, credential-bearing header, or pre-authenticated request** (design §3.3). Hard line.
- **Clients NEVER unlink the socket** (design §3.5). Only the lifecycle-lock holder validates/removes endpoints.
- **Normative constants** (design §3.1): concurrency cap = 4, queue capacity = 16, frame cap = 1 MiB, JSON depth cap = 64. Not configurable.
- **All lock/lifecycle tests use file-backed temp dirs + REAL spawned child processes** — `:memory:` libsql silently swaps databases under `transaction()` (LEARNINGS 2026-07-20); in-process fakes prove nothing about fcntl.
- Run ALL test commands in the FOREGROUND (subagent background runs die with the turn). Commit with sandbox disabled (pre-commit hook mktemp), never `--no-verify`. Rebuild `packages/mcp/dist` (`pnpm -r build`) before cli tasks consume mcp changes.
- Invariant tests carry an `INVARIANT §17:` prefix; each task flips its `INVARIANTS.md` rows in the same commit.
- Branch: Lane A = `feat/daemon-core` from origin/main; Lane B = `feat/daemon-clients` from merged main.

## File Structure (Lane A)

```
packages/mcp/src/daemon/
  locks.ts        SQLite lock databases: exclusive/shared holds, SHARED-mode probes
  state-dir.ts    0700 state-directory validation: lstat, owner, ACL rejection
  frames.ts       length-prefixed JSON framing: caps, depth guard, encode/decode
  rpc.ts          typed RPC messages + hand-written decoders + capability tables
  conduitd.ts     the daemon: bind-under-lock, READY, cap+queue, drain, sweep
  spawn.ts        constructed-environment spawn boundary
  client.ts       daemon client: decision table, auto-start, outcome-unknown
packages/mcp/src/daemon/*.test.ts   (one per module)
packages/mcp/src/daemon/helpers/    spawned-process test fixtures (hold-lock.ts, …)
```

---

## Lane A — PR 1: daemon core

### Task 1: SQLite lock primitive (`locks.ts`)

**Files:**
- Create: `packages/mcp/src/daemon/locks.ts`
- Create: `packages/mcp/src/daemon/locks.test.ts`
- Create: `packages/mcp/src/daemon/helpers/hold-lock.ts` (spawned fixture)
- Modify: `INVARIANTS.md` (add §17 lock rows)

**Interfaces:**
- Produces:
  ```ts
  export interface HeldLock { release(): Promise<void>; }
  /** BEGIN EXCLUSIVE, busy_timeout=0, journal_mode=DELETE. null = BUSY. */
  export function acquireExclusive(lockDbPath: string): Promise<HeldLock | null>;
  /** BEGIN + SELECT count(*) FROM sqlite_schema (forces db SHARED lock). null = BUSY. */
  export function acquireShared(lockDbPath: string): Promise<HeldLock | null>;
  /** Attempt SHARED, roll back immediately. "busy" = an EXCLUSIVE holder exists. */
  export function probeShared(lockDbPath: string): Promise<"free" | "busy">;
  ```
- Consumes: nothing (leaf module).

Implementation notes the engineer needs (design §3.5, normative): one dedicated `createClient({ url: \`file:${path}\` })` per hold — never a shared client, pooling would migrate the transaction off its connection. Apply `PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0;` on that same connection before `BEGIN`. Detection ALWAYS probes SHARED — an EXCLUSIVE probe cannot distinguish a SHARED holder from an EXCLUSIVE holder. Map `SQLITE_BUSY` → `null`/`"busy"`; rethrow anything else.

- [ ] **Step 1: Write the five named failing tests** (titles verbatim from design §3.5; each spawns `helpers/hold-lock.ts` as a real child that acquires and holds until killed):

```ts
// locks.test.ts — pattern for all five; file-backed temp dir per test
import { execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function spawnHolder(mode: "shared" | "exclusive", db: string) {
  // helpers/hold-lock.ts: acquires, prints "HELD\n", then sleeps forever
  const child = spawn(process.execPath, [HELPER_JS, mode, db], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise<typeof child>((res) => child.stdout.once("data", () => res(child)));
}

test("INVARIANT §17: lock-db-shared-blocks-exclusive-through-libsql", async () => {
  const db = join(mkdtempSync(join(tmpdir(), "lk-")), "m.lock.db");
  const holder = await spawnHolder("shared", db);
  expect(await acquireExclusive(db)).toBeNull();       // blocked by child's SHARED
  holder.kill("SIGKILL");
  await waitFor(async () => (await acquireExclusive(db)) !== null); // released on death
});

test("INVARIANT §17: lock-db-probe-distinguishes-shared-and-exclusive", async () => {
  // child holds SHARED → probeShared = "free" (readers coexist), acquireExclusive = null
  // child holds EXCLUSIVE → probeShared = "busy"
});
test("INVARIANT §17: lock-db-transaction-remains-held-until-explicit-close", …);
test("INVARIANT §17: lock-db-sibling-connection-close-does-not-release-lock", …);
// second client on the same file is opened and closed while the hold lives; hold must survive
test("INVARIANT §17: lock-db-releases-after-sigkill-with-orphan-child-alive", …);
// holder spawns its OWN sleeping grandchild, is SIGKILLed; locks must free while grandchild runs
```

- [ ] **Step 2: Run, verify all fail** — `cd packages/mcp && node_modules/.bin/vitest run src/daemon/locks.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `locks.ts` + `helpers/hold-lock.ts`** per the interface block.
- [ ] **Step 4: Re-run → all PASS.** Foreground.
- [ ] **Step 5: Flip INVARIANTS.md rows (§17, quoting test titles verbatim); commit** `feat: SQLite lock primitive for daemon ownership (§17)`.

### Task 2: State-directory validation (`state-dir.ts`)

**Files:** Create `packages/mcp/src/daemon/state-dir.ts` + `state-dir.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  /** lstat (no symlink), owner uid === process uid, mode 0700, NO extended ACL.
      mode="bind" additionally STRIPS ACLs before verifying (daemon side);
      mode="connect" only verifies (clients never mutate). Throws typed errors. */
  export function assertStateDir(dir: string, mode: "bind" | "connect"): Promise<void>;
  ```

ACL handling (design §3.2; Node stdlib reads no ACLs): on darwin, bind-mode runs `execFile("/bin/chmod", ["-N", dir])` (strip), then both modes verify via `execFile("/bin/ls", ["-lde", dir])` — any output line matching `/^ \d+: /` is an ACL entry → reject. On linux, POSIX-ACL grants surface in the group-class bits of `st_mode`, so the 0700 check covers it; if `/usr/bin/getfacl` exists, verify no non-owner entries, else skip (documented best-effort layer). All binaries by absolute path — never PATH lookup.

- [ ] **Step 1: Failing tests** — symlinked dir rejected; wrong-mode (0755) rejected; foreign-owner rejected (skip when running as root is impossible — assert test env non-root); darwin-only: dir given `+a` ACL via `execFile("/bin/chmod", ["+a", "user:daemon allow list", d])` is stripped at bind and rejected at connect-before-strip (gate with `process.platform === "darwin"`).
- [ ] **Step 2: Run → FAIL.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat: state-directory boundary checks (0700, symlink, ACL) (§17)`.

### Task 3: Framing + RPC types (`frames.ts`, `rpc.ts`)

**Files:** Create `frames.ts`, `frames.test.ts`, `rpc.ts`, `rpc.test.ts` under `packages/mcp/src/daemon/`.

**Interfaces:**
- Produces (frames):
  ```ts
  export const FRAME_CAP = 1024 * 1024;   // 1 MiB, normative
  export const DEPTH_CAP = 64;            // normative
  export function encodeFrame(msg: unknown): Buffer;          // 4-byte BE length + JSON
  export class FrameDecoder {                                 // incremental, cap-enforcing
    push(chunk: Buffer): unknown[];       // throws FrameTooLarge / DepthExceeded / MalformedFrame
  }
  ```
- Produces (rpc): a discriminated union + per-message hand decoders:
  ```ts
  export type RpcRequest =
    | { kind: "handshake"; protocol: 1 }
    | { kind: "execute"; code: string; deadlineMs: number }
    | { kind: "search"; query: string }
    | { kind: "describe"; toolName: string }
    | { kind: "approvals.list" }
    | { kind: "approvals.resume"; executionId: string; decision: "approve" | "deny" }
    | { kind: "source.provision"; namespace: string; url: string; secret?: string }   // NEW source only
    | { kind: "source.revalidate"; namespace: string };  // stored identity — daemon derives url+credential (§3.3.1)
  export type RpcResponse =
    | { kind: "ready" }                                   // the READY preface
    | { kind: "handshake.ok"; protocol: 1; dbPath: string; allowPrivateEgress: boolean }
    | { kind: "result"; requestId: string; payload: unknown }
    | { kind: "error"; requestId: string; code: "busy" | "rotation-in-progress" | "refused-custom-db" | "invalid" | "internal"; message: string }
    | { kind: "outcome-unknown"; requestId: string };
  export function decodeRequest(v: unknown): RpcRequest;   // throws on anything else
  export const CAPABILITIES: Record<"serve" | "approvals" | "add-mcp", ReadonlySet<RpcRequest["kind"]>>;
  ```
  `CAPABILITIES` is the §3.3 table: serve = execute/search/describe/handshake; approvals = approvals.*/handshake; add-mcp = source.*/handshake. **No message shape carries a credential daemon→client; `source.provision.secret` is the one client→daemon secret (operator-supplied, never echoed).**

- [ ] **Step 1: Failing tests** — round-trip; oversized frame (cap+1) throws `FrameTooLarge` without buffering the payload; 65-deep nesting throws `DepthExceeded`; split-across-chunks frames reassemble; `decodeRequest` rejects unknown kinds, wrong field types, and a `source.revalidate` carrying a `url` field (anti-oracle shape: the field is not representable); capability table denies `approvals.resume` to `serve`.
- [ ] **Steps 2–4: RED → implement → GREEN.**  - [ ] **Step 5: Commit** `feat: daemon IPC framing and capability-scoped RPC types (§17)`.

### Task 4: The daemon runtime (`conduitd.ts`)

**Files:** Create `conduitd.ts`, `conduitd.test.ts`, `helpers/run-daemon.ts` (spawnable entry); Modify `packages/mcp/src/bin.ts` (add `--daemon` dispatch, ~line 42); Modify `INVARIANTS.md`.

**Interfaces:**
- Consumes: Tasks 1–3 (`acquireExclusive`/`acquireShared`/`probeShared`, `assertStateDir`, `FrameDecoder`, `decodeRequest`, `CAPABILITIES`) + existing `openStoreFromEnv` (`store-open.ts:34`) and `createApprovalRuntime` (`runtime.ts:32`).
- Produces:
  ```ts
  export interface DaemonPaths { stateDir: string; socket: string; lifecycleLockDb: string; maintenanceLockDb: string; }
  export function daemonPaths(stateDir: string): DaemonPaths;   // conduitd.sock, conduitd-{lifecycle,maintenance}.lock.db
  export function runDaemon(opts: { stateDir: string }): Promise<void>;  // exits process on stop
  ```

Normative startup order (design §3.5): `assertStateDir(bind)` → lifecycle EXCLUSIVE (BUSY → exit "already running") → maintenance SHARED (BUSY → release lifecycle, exit "rotation in progress") → **crash-terminal sweep (Task 5's function)** → resolve config ITSELF (default paths; refuse `CONDUIT_DB` clients at handshake) → validate any pre-existing socket entry is a socket owned by our uid, remove it (we hold the lifecycle lock — the one sanctioned remover) → bind, record device+inode → serve. Per connection: send `{kind:"ready"}` only in RUNNING; enforce the client's declared capability set from the handshake. Concurrency: 4 active slots, queue of 16 (deadline per entry, removal on expiry AND disconnect, queue-full → `error:busy`). On SIGTERM/SIGINT: DRAINING — close listener, finish accepted work, unlink socket only if device+inode still match, release maintenance then lifecycle, exit 0.

- [ ] **Step 1: Failing tests** (all spawn `helpers/run-daemon.ts` against a temp state dir):
  - `INVARIANT §17: exactly one daemon survives a concurrent auto-start race` (spawn two, one exits "already running", one serves)
  - `INVARIANT §17: a failed connect to a LIVE listener never unlinks it` (client refused mid-drain; socket path still present until daemon exits)
  - `INVARIANT §17: rotation's exclusive maintenance acquisition blocks while a daemon holds it shared` (both orders — daemon-then-rotate refuses; rotate-then-daemon exits "rotation in progress")
  - `INVARIANT §17: a connection queued during listener close gets no READY and the client writes nothing`
  - `INVARIANT §17: a signal-stopped daemon exits with no paused work stranded` (pause an approval, SIGTERM, restart, `approvals.list` still shows it)
  - queue tests: 5th concurrent execute queues; 21st refuses `busy`; disconnect removes queue entry; sustained overload never exceeds 16 queued (assert via daemon introspection log line)
  - handshake refusal test: client env `CONDUIT_DB=/tmp/x.db` → `error:refused-custom-db`
- [ ] **Steps 2–4: RED → implement → GREEN** (foreground; these are slow — budget minutes, not seconds).
- [ ] **Step 5: Flip ledger rows; commit** `feat: conduitd daemon runtime — locks, READY gate, cap+queue, drain (§17)`.

### Task 5: Crash-terminal sweep + spawn boundary + client (`spawn.ts`, `client.ts`)

**Files:** Create `spawn.ts`, `client.ts`, `client.test.ts`; Modify `conduitd.ts` (call the sweep in startup order); Create `sweep.ts` + `sweep.test.ts`; Modify `INVARIANTS.md`.

**Interfaces:**
- Produces (sweep — NO schema change; single-daemon + kernel-enforced stop-first means any `running` row at daemon startup is provably dead):
  ```ts
  /** UPDATE executions SET status='failed', … WHERE status='running'; returns count.
      Never replays. Trace line per swept row. */
  export function sweepOrphanedExecutions(store: ConduitStore): Promise<number>;
  ```
- Produces (spawn — design §3.1 constructed context):
  ```ts
  export function spawnDaemon(stateDir: string): void;
  // execPath resolved absolutely from the RUNNING package's own bin dir (never PATH);
  // env = { PATH: PLATFORM_PATH } only — every CONDUIT_* stripped, HOME not passed;
  // cwd = stateDir; stdio = ["ignore", logFd, logFd] (conduitd.log in stateDir); detached, unref.
  ```
- Produces (client — design §3.5 decision table + §5 retry rule):
  ```ts
  export function daemonRequest(opts: {
    stateDir: string; role: keyof typeof CAPABILITIES; request: RpcRequest; deadlineMs: number;
  }): Promise<RpcResponse>;
  // probeShared(maintenance)=="busy" → error rotation-in-progress, fail fast, no spawn
  // connect ok → wait READY → send (bytes only after READY)
  // connect refused + lifecycle busy → bounded wait for release → RE-PROBE FROM THE TOP
  // neither lock held → spawnDaemon → re-probe (once)
  // connection lost after first byte written → {kind:"outcome-unknown"} — NEVER retry
  ```
- [ ] **Step 1: Failing tests** — `INVARIANT §17: an execution left running by a killed daemon reaches a defined terminal state on restart` (SIGKILL daemon mid-execute, restart, row is `failed`, never re-runs — assert upstream fixture saw exactly one call); `INVARIANT §17: hostile client HOME/PATH/CONDUIT_* values are inert through auto-start` (spawn with poisoned env; daemon handshake reports default dbPath, egress off); `INVARIANT §17: a client with no daemon auto-starts and completes its request`; outcome-unknown test (daemon killed between request write and response → client returns outcome-unknown, no duplicate upstream call); rotation-fail-fast test.
- [ ] **Steps 2–4: RED → implement → GREEN.**
- [ ] **Step 5: Flip rows; commit** `feat: crash-terminal sweep, spawn boundary, auto-start client (§17)`.

**Lane A gate:** whole-branch review → PR `feat/daemon-core` → full load-bearing gauntlet (Tier-2 both mechanics + /security-review + codex correctness pass + /explain-diff quiz) → HUMAN-NAMED merge. Design + this plan ride the PR.

---

## Lane B — PR 2: client conversions (bases on merged Lane A)

### Task 6: `serve` through the daemon

**Files:** Modify `packages/mcp/src/runtime-stdio.ts` (replace `openStoreFromEnv` at :29 with `daemonRequest` role `"serve"`); Modify `packages/mcp/src/server.ts` (execute/search/describe handlers call the client); test files alongside.

- Consumes: Task 5's `daemonRequest`. M8 stdout purity: unchanged redirect (`runtime-stdio.ts:15-19`); the spawned-bin purity test must still pass verbatim.
- [ ] RED: integration test — stdio server answers `tools/list` with the daemon as the only store opener (assert the db file is opened by exactly one pid via the daemon's log). Startup-with-no-daemon test (auto-start path). GREEN → commit `feat: serve becomes a daemon client (§17)`.

### Task 7: `approvals` through the daemon

**Files:** Modify `packages/cli/src/commands/approvals.ts` — `PROD_DEPS.openStore`/`createRuntime` (:45-52) replaced by a `daemonClient` dep (role `"approvals"`); existing injected-fake tests keep passing untouched (the DI seam is the point).
- [ ] RED: real-path test — pause via daemon, `approvals list` shows it, `approve` resumes exactly once (`INVARIANT §17: a source added via one client is visible to another with no restart` also lands here: add-mcp fixture + serve fixture against one daemon). GREEN → commit.

### Task 8: `add-mcp` anti-oracle conversion

**Files:** Modify `packages/cli/src/commands/add-mcp.ts` (drop `openStoreFromEnv` + the `secrets.reveal` at :303; onboarding fetch moves daemon-side behind `source.provision` / `source.revalidate`); Modify `conduitd.ts` (implement both handlers using the EXISTING onboarding fetch internals).
- [ ] RED: `INVARIANT §17: a client naming a foreign destination cannot cause any stored credential to be sent there` (revalidate carries only a namespace; a crafted raw frame with an extra url field is rejected by `decodeRequest` — assert upstream fixture at the foreign URL never sees the credential); `INVARIANT §17: a cross-origin redirect never carries a stored credential` (fixture 302s to a second origin; second origin sees no Authorization header); secret-never-echoed test. GREEN → commit.

### Task 9: `key` + `--doctor` under the maintenance lock

**Files:** Modify `packages/cli/src/commands/key.ts` (rotate/generate: take maintenance EXCLUSIVE non-blocking before touching key or db — replaces the write-lock probe; `countSealedRows` at :85 runs under the same hold); Modify `packages/mcp/src/bin.ts` doctor (default = daemon-backed handshake report; `--offline` = maintenance EXCLUSIVE + read-only inspection, NO `openStoreFromEnv`).
- [ ] RED: rotate-vs-daemon both-orders test (reuses Task 4 fixtures from merged main); rotate refusal names the holder from diagnostic metadata; `--doctor --offline` on a live daemon refuses; offline doctor performs zero writes (fs mtime assertion on db + sidecars). GREEN → commit.

### Task 10: Docs + ledger closeout

**Files:** Modify `conduitspec.html` §17 (daemon-ownership decision recorded; regenerate `conduitspec.md` via `python3 html2md.py` SAME turn); Modify `packages/cli/README.md` + `packages/mcp/README.md` (daemon lifecycle, stop/start, rotation flow, doctor modes); Modify `INVARIANTS.md` (audit every §17 row flipped in Lanes A+B).
- [ ] Write docs; run spec-drift check (pre-commit enforces); commit `docs: daemon ownership shipped — spec §17, READMEs, ledger (§17)`.

**Lane B gate:** same full load-bearing gauntlet as Lane A → HUMAN-NAMED merge. Post-merge: `pnpm -r build`, re-wire the dogfood MCP entries (serve now auto-starts the daemon), real-db canary-verified open.

## Self-review record

Spec-coverage: every rev-8 normative section maps to a task (§3.1→T4/T5, §3.2→T2, §3.3/§3.3.1→T3/T8, §3.4→T9, §3.5→T1/T4/T5, §5→T3/T5, §7 test list→distributed, §9.1→T9, §9.3→T4/T5). Idle-exit: correctly ABSENT (deferred, design §3.5). Placeholder scan: the two `…` in Task 1's test list are title-only stubs whose bodies are specified by the adjacent pattern + design §3.5 table — acceptable; everything else is concrete. Type-consistency: `daemonRequest`/`CAPABILITIES`/`HeldLock` names verified consistent across tasks.
