# Design: the minimal `conduit` CLI (spec §17 step 3)

**Status:** design, pre-implementation
**Date:** 2026-07-12
**Scope:** spec §17 MVP build order step 3 — a minimal `conduit` CLI:
`serve`, `add-mcp`, `approvals list|approve|deny`.
**Review trail:** `superpowers:brainstorming` (7 decisions) → `grilling`
(6 adversarial questions, source-verified) → `plan-eng-review` (4 sections +
real `codex exec` cross-model outside voice, 7 findings) → coherence audit
(1 cross-decision conflict found + fixed). Every decision below is grounded in
a same-turn read of the cited source, not memory.

---

## 1. Purpose and scope

A new package `packages/cli` (`@conduithq/cli`) exposing a `conduit` binary
with three command groups. It is a thin composition layer over surfaces that
already exist in `@conduithq/sdk` and `@conduithq/mcp`; it adds exactly one new
SDK storage-seam method (`listPaused`) and extracts three shared runtime units
from `packages/mcp` (see §7). It is NOT a rewrite of anything.

**In scope:** `serve`, `add-mcp`, `approvals list|approve|deny`, plus the SDK/mcp
extractions the commands require and their tests/invariants.

**Load-bearing** (new package under the routing floor `packages/`): branch from
`origin/main`, PR per commit routing, Tier 2 + `/security-review` + a real
`codex exec` pass, `/explain-diff` + full-pass quiz, human-named merge.

---

## 2. Commands

### 2.1 `conduit serve`

Launches the stdio MCP server — the same server the existing `conduit-mcp` bin
runs. It calls the extracted `runStdioServer(...)` (§7.1); it does NOT
re-implement the env/store/server startup.

### 2.2 `conduit add-mcp --url <mcp-url> --namespace <ns> --prefix <service.org.env>`

Onboards (or re-syncs) an upstream MCP source. It formalizes `scripts/seed-demo.mjs`
by keeping what is real and shedding demo scaffolding (see §8 Deviations).

**First-run write chain (spec §5.3 resolution order):**
`sources.upsert` → `integrations.upsert` → `connections.upsert` →
`secrets.put` (only if a credential is supplied) → `tools.replaceNamespace`.

**Writes NO policy rows.** The policy engine's §10.2 fail-closed default
(safe→allow, review/destructive→require_approval) is the designed,
invariant-pinned behavior. A row without `manualOverride` is inert (ignored by
`createStorePolicyEngine`, [policy.ts:214-219]); forging `manualOverride:true`
(as the demo does) fights the §7 non-revert invariant. So seeding at ingest is
either inert noise or a forged override — the CLI writes neither.

**Args are named flags; ids are derived, not typed.** ids (`src_<ns>`,
`int_<ns>`, `conn_<ns>`) and `credentialRef` are derived deterministically from
`--namespace`; the operator supplies only the meaningful fields (url, namespace,
prefix). `namespace` is validated against `[a-z0-9_-]` and rejected before any
write if malformed. The CLI owns bookkeeping; the human owns intent.

**Tools are fetched from `--url` as a hard precondition** (`tools/list`, 5s
timeout, via the same path `seed-demo.mjs` uses). Fetch + `normalizeMcp` run
BEFORE any store write. On an unreachable/invalid upstream, `add-mcp` FAILS LOUD
and writes NOTHING:
`[conduit add-mcp] upstream unreachable at <url>; nothing was written. Re-run when reachable.`
(exit non-zero). There is NO fixture-fallback in `packages/cli` — that demo
scaffolding stays in the throwaway script (see §5, Grilling Q6).

**After a successful write, print a read-only risk-class COUNT summary** mapped
to the §10.2 default action, e.g.:
`seeded 12 tools under github.acme.prod: 8 safe (auto-allow), 3 review (approval), 1 destructive (approval)`.
Counts only, computed from each `Tool.riskClass` (already in hand); NO per-tool
names (that is a future `conduit tools` inspection command, out of MVP scope).
This makes the fail-closed posture stated rather than silent. `--json` emits a
compact `{safe, review, destructive}` breakdown.

**Credential input (§9.1, security):** read from the env var
`CONDUIT_ADD_SECRET` only — never a flag (out of shell history and argv;
same-user-only readable; matches the `CONDUIT_MASTER_KEY` channel). It goes
straight into `SecretBox`-encrypted storage via `store.secrets.put` and is
NEVER echoed in any output, log, or error. The credential is OPTIONAL, mirroring
the resolver's own contract ([credentials.ts:22-27, 57-59]): a connection with
no `credentialRef` resolves to empty material (a legitimate unauthenticated
source, §9.1). Mandatory-credential is rejected: it contradicts §9.1, blocks
public MCP sources, and would push operators to paste dummy tokens the resolver
would faithfully attach as garbage `Authorization` headers.
Accepted limitation: a wrong/expired token only surfaces as a 401 at first tool
call (add-mcp cannot authenticate at add time — `tools/list` may be public).

### 2.3 `conduit approvals list|approve|deny`

- **`list`** enumerates paused executions via the new SDK method
  `ExecutionRepository.listPaused()` (§3), oldest-first. Human output is aligned
  columns: exec id · tool · waiting-since · expiry. A row past its
  `pausedOn.expiresAt` is LABELED `EXPIRED (finalizes on next resume)` — computed
  at display time from the real expiry timestamp, NEVER mutated. `--json`
  available.
- **`approve` / `deny`** resume one paused execution via
  `manager.resume(execId, {kind:"approve"|"deny"})` and print the resulting
  `ExecutionOutcome.status`. Exit non-zero on `conflict`/`failed`. On an
  `expired` outcome (from EITHER verb), print an explicit line: the approval
  expired before the decision applied, the execution was finalized as expired,
  **and no tool call was made.**

The manager composition these commands drive is a SHARED runtime factory (§7.3),
NOT a hand-rolled copy of `approve-demo.mjs`.

---

## 3. SDK storage-seam addition: `listPaused`

Add to `ExecutionRepository`:

```ts
/** Paused executions awaiting a human, oldest-first (spec §10.2 approval queue). */
listPaused(): Promise<Execution[]>;
```

- Returns **full `Execution[]`**, ordered `ORDER BY started_at ASC, id ASC`
  (the `id` tiebreak makes the queue deterministic for equal `startedAt` — a
  cross-model finding).
- **Impl:** `SELECT * FROM executions WHERE status='paused' ORDER BY started_at ASC, id ASC`
  mapped through the EXISTING `hydrateExecutionRow` — no second parser, no
  drift.
- **Why full `Execution[]`, not a narrowed projection** (grilling Q1, a reversal
  of the first instinct): the row's `code` is the operator's own approval
  context (not a leak — same user, same master key). A projection would be a
  drift-prone second parser plus a rigid parity contract that breaks the moment
  a second caller wants an omitted field. Field-level exposure control belongs
  at the DISPLAY layer (`approvals list` shows only id/tool/waiting/expiry by
  default), not baked into the storage seam. Every other read on this repository
  already returns the whole `Execution`; `listPaused` stays consistent.
- **Parity:** the storage seam is the D1/Worker parity boundary — a second
  backend implements one `SELECT ... WHERE status='paused'`, no filter grammar,
  no cap policy, no write-on-read.

**Expiry is presentation, not mutation.** The manager remains the single expiry
authority: it transitions a paused row to `expired` lazily, INSIDE `resume`'s
claimed critical section ([manager.ts:631]), so an expired call can never fire a
tool. `approvals list` therefore truthfully reports stored state (`paused`) and
computes the effective "will-expire" label at display time. The list→approve
window is cosmetic (an expired call is finalized as `expired`, never executed),
so it is handled purely by legible wording — no locks, leases, or write-on-read.

**Perf (deferred, tracked):** there is no index on `executions.status`, so
`listPaused` is a full scan. Trivial at MVP/demo scale; the `executions` table
is written on the hot `claimForResume` compare-and-swap path, so an index is
write-amplification there. Tracked with a concrete trigger: add a PARTIAL index
`ON executions(status) WHERE status='paused'` (or composite `(status, started_at)`)
when the table grows / before Phase-1 hosted, weighed against the CAS write cost.

---

## 4. Re-run / existing-state semantics

The design's recurring risk is the SEAM BETWEEN correct decisions, not the
decisions themselves (a second run against existing state, cross-decision
interactions). This section is the systemic answer.

**Organizing principle: READ CURRENT STATE FIRST.** Every second-run decision
resolves against the read row BEFORE any write:

1. Read the existing Source/Connection by derived id/namespace.
2. If `--url` (or `--prefix`) DIFFERS from the stored value → **C3 gate**:
   refuse without an explicit `--replace` flag; when `--replace` is used, WARN
   that manual policy overrides (keyed by tool name, §7) carry over to the new
   upstream. This makes retargeting an operator's trust a conscious act, not a
   silent side effect. (The structural fix — re-keying policies by source
   identity — is deferred as a tracked SDK item; the flag-gate is the MVP
   answer.)
3. If `--url` MATCHES → idempotent re-sync (successful-fetch tools/list drives
   `replaceNamespace`, correctly picking up upstream add/remove).
4. **Credential resolution (C2, preserve-not-remove):**
   - `CONDUIT_ADD_SECRET` set → store it; connection carries the derived
     `credentialRef`.
   - absent + an existing `credentialRef` → PRESERVE it. Because
     `connections.upsert` unconditionally writes `credential_ref = excluded.value`
     ([sqlite.ts:325-338] — there is no "leave this column alone"), "preserve"
     is implemented as READ-THEN-RE-WRITE-THE-SAME-VALUE: build the upserted
     Connection carrying the existing ref. Absence of the secret means "don't
     touch auth", NOT "remove auth" — never NULL a live ref (silent deauth +
     orphaned secret is the bug this prevents).
   - absent + no existing ref → unauthenticated connection (first-run path, §9.1).
   - `--clear-credential` → build with `credentialRef: undefined` AND
     `secrets.remove` the orphaned secret (the only deliberate-deauth path).
5. **THEN the resolved writes run atomically (C1).**

**Atomic provisioning (C1).** Today only `replaceNamespace` is transactional;
the source/integration/connection/secret writes are separate, so a mid-chain
failure leaves a partially-configured source. The write chain is wrapped in one
atomic store operation (a new SDK store method, e.g. `provisionSource(...)`, OR
a documented fail-safe ordering). Because the preserve/clear credential decision
is resolved in step 4 BEFORE the transaction opens, the transaction writes a
fully-resolved Connection — no conditional write inside it. C1 and C2 reinforce
each other under the read-first framing.

---

## 5. Error handling and edge cases

Fail-closed throughout:
- Bad env → the shared `resolveEnv` messages.
- Unreachable/invalid upstream → fail loud, write nothing (§2.2); fetch +
  normalize precede any write, so a down upstream never reaches the write block.
- Malformed `--namespace` → reject before any write.
- URL/prefix change without `--replace` → refuse, 0 writes (§4).
- `approve`/`deny` on a non-paused/expired/missing execution → the manager's
  `conflict`/`expired` outcome surfaced clearly, non-zero exit.
- No command prints a credential on any path.

---

## 6. Output format

Human-readable text by default (aligned columns for `approvals list`; plain
confirmation lines elsewhere). `--json` on read commands for the §4.2 token demo
and automation. For `serve`, stdout carries protocol frames ONLY (via
`runStdioServer`'s redirect, §7.1); every other command owns stdout normally —
which is why the redirect must NOT be process-global.

---

## 7. Shared runtime extractions (packages/mcp)

Three units are lifted so the CLI, the server, and the `conduit-mcp` bin share
ONE implementation each of security-sensitive startup. They nest at three
altitudes over one base.

### 7.1 `runStdioServer(...)` — the serve door (env→store→server→connect)

Extract the `conduit-mcp` bin's startup body (resolve env → ensure db dir →
open store → egress warning → empty-catalog notice → `createConduitMcpServer` →
`connect(StdioServerTransport)`) into an exported function. Both `conduit-mcp`
and `conduit serve` call it — one implementation of the env/security-boundary
startup.

The `console.*`→stderr redirect (M8 stdout purity) is folded INTO
`runStdioServer` as its FIRST RUNTIME ACTION — not at module top level (that
would hijack the whole `conduit` process's stdout on mere import, breaking
`add-mcp`/`approvals` which own stdout). This makes the function
self-protecting: "serve over stdio" structurally implies "stdout = frames only".
The `conduit-mcp` bin drops its own top-level redirect. `server.ts` writes to
stdout only via an injectable `options.log` defaulting to `console.error`, so it
never assumes a global redirect — safe to move.

### 7.2 `openStoreFromEnv(...)` — the base (env→store)

Lift the bin's store-open (`resolveEnv` → `ensureDbDir` → `createClient` →
`openSqliteStore{client, SecretBox.fromKeyBytes}`) into an exported function.
`add-mcp`, `approvals`, and `runStdioServer` all use it. ONE implementation of
the security-critical master-key→SecretBox construction — a security control,
not a style preference (a hardening fix must not land in one copy and silently
not the others). Throwaway scripts stay untouched.

### 7.3 `createApprovalRuntime({store, allowPrivateEgress})` — the approvals door (store→manager)

The manager composition (fresh catalog + policy + credentials + EGRESS-AWARE
upstream + sandbox + `makeInvoker`/`makeToolHost`) currently lives inside
`server.ts`'s request handler ([server.ts:182-189]) and is re-composed by hand
in `approve-demo.mjs`. Extract a shared, exported factory used by BOTH
`server.ts` and the CLI's `approvals`, so the security-critical wiring (esp. the
egress env) has a single home. This SUPERSEDES the earlier "compose exactly as
approve-demo does" plan.

**Layering:** `openStoreFromEnv` (env→store) is the base; `runStdioServer`
(→server→connect) and `createApprovalRuntime` (→manager) are siblings that both
consume it. Each command takes exactly the altitude it needs: `add-mcp` stops at
store; `approvals` goes to the runtime; `serve` goes to the server.

---

## 8. Testing and invariants

Mirror the `packages/mcp` bar: **unit tests** (arg parsing, output formatting,
namespace validation, the never-echo-secret guarantee) + **ring-2 spawned-bin
integration** (the real compiled `conduit` bin over child processes: `add-mcp` →
`serve` handshake → drive a `require_approval` tool → `approvals list` shows it →
`approvals approve` resumes it).

**New INVARIANT rows** (module + its invariant test in the same commit; ledger
row flips in that commit):
- `listPaused` returns oldest-first, deterministic `(started_at, id)` order.
- `add-mcp` writes the §5.3 chain and NO policy rows.
- `add-mcp` on a dead URL writes 0 rows.
- `add-mcp` re-sync without a secret PRESERVES an existing `credentialRef`;
  `--clear-credential` removes ref AND the orphaned secret.
- `add-mcp` with a differing `--url`/`--prefix` and no `--replace` refuses,
  0 writes.
- provisioning is atomic: a mid-write failure leaves 0 rows.
- a credential NEVER appears in stdout/stderr on any path.
- **M8 stdout purity on BOTH doors:** keep the existing ring-2 M8 test on
  `conduit-mcp` (proves the extraction didn't break the old door) AND add a new
  ring-2 M8 test on `conduit serve` (proves `runStdioServer` protects the new
  door). IRON RULE: the refactor touches tested behavior.

**Failure modes** — every new codepath has a test AND error handling AND is
non-silent (0 critical gaps). The two formerly-silent paths (credential
preserve, URL-change trust transfer) are now explicit and tested.

---

## 9. NOT in scope (deferred, with rationale)

- **npm publish / release pipeline.** `conduit` runs from
  `packages/cli/dist/bin.js` (or a workspace bin link), the same local-build
  model as `conduit-mcp` today. Publishing touches the supply-chain posture
  (provenance, `minimumReleaseAge`) and deserves its own PR; the MVP §17 gates
  are both local-run.
- **MCP transport maturity (C4).** The SDK upstream caller is a stateless
  `tools/call` POST; full HTTP MCP needs init/session/pagination. A known
  Phase-0 SDK simplification the whole system uses, not a CLI concern. Tracked
  SDK design item.
- **Round-trippable tool names (C5).** `normalizeMcp` ([mcp.ts:40]) stores only
  the transformed name (`foo/bar`→`foo.bar`); a source with non-round-trippable
  names adds OK but can't be called. Pre-existing SDK behavior (exists via
  `seed-demo` today), not CLI-introduced. Tracked SDK design item (store
  `upstreamName`, or reject at normalize time). Files: `mcp.ts`, `upstream.ts`,
  store schema.
- **Re-keying policies by source identity (C3 structural fix).** An SDK
  policy/store schema change; the `--replace` flag-gate is the MVP answer.
- **`executions.status` index (§3).** Deferred with a concrete trigger.
- **Per-tool `conduit tools` inspection command, web console, FTS5, Trace
  viewer, Phases 2-5** — per §17.

---

## 10. What already exists (reused, not rebuilt)

- `resolveEnv` / `ensureDbDir` / `KEYGEN_ONE_LINER` (mcp `env.ts`).
- The bin's store-open → lifted to exported `openStoreFromEnv` (§7.2).
- `createConduitMcpServer` + startup → extracted to `runStdioServer` (§7.1).
- The manager composition ([server.ts:182-189]) → extracted to
  `createApprovalRuntime` (§7.3).
- `normalizeMcp`, all store repositories, `manager.resume`,
  `createStorePolicyEngine`, `deriveRiskClass` — reused as-is.
- `scripts/seed-demo.mjs` / `scripts/approve-demo.mjs` — reference compositions,
  deliberately NOT transcribed (§8 Deviations).

---

## 11. Deviations from the HANDOFF framing

- `add-mcp` does NOT transcribe `seed-demo.mjs`: it drops the script's
  policy-seeding loop (§2.2) AND its fixture-fallback (§2.2 / Grilling Q6).
  "Formalize" means keep what is real and shed demo scaffolding.
- `approvals` does NOT transcribe `approve-demo.mjs`'s hand-composed manager:
  the composition is extracted into `createApprovalRuntime` (§7.3), a single
  home for the security wiring.

---

## 12. Implementation sequencing

Mostly sequential — the CLI commands depend on the extractions.

- **Lane A (must land first):** SDK/mcp changes — `listPaused` (+ tiebreak),
  atomic `provisionSource`, `openStoreFromEnv`, `runStdioServer` (+ redirect
  move), `createApprovalRuntime`. These are the seams every command consumes.
- **Lane B (depends on A):** the CLI commands and their tests.

Not independent enough to parallelize safely (Lane B consumes Lane A's seams).
