# Daemon ownership — §17 v1 surface-product step 2

**Status:** design, revision 2 — adversarially reviewed and corrected
(see §10). No code.
**Date:** 2026-08-15
**Spec anchor:** §17 "⭑ v1 Surface Product", build sequence step (2) "decide
daemon ownership".
**Prior step:** §17 v1 step 1 — credential key lifecycle
(`2026-07-19-credential-key-lifecycle-design.md`, merged PR #41).

---

## 1. The decision

**One daemon process owns `~/.conduit/conduit.db`. Every other Conduit
surface becomes a client of it over a Unix domain socket.**

Spec §17 offered a fork: *"one daemon owns the store; the stdio `/mcp`
surface is a thin local client of it (or an explicitly safe shared-store
contract)."* This design takes the first branch and rejects the second.
§6 records why.

In scope: the daemon, the IPC transport, converting store consumers to
clients, and on-demand auto-start. Out of scope, deferred to §17 step 7
(service lifecycle): OS-level supervision — launchd/systemd units,
start-at-login, restart-on-crash, upgrade.

---

## 2. Why this is forced — three facts about the code today

Not theory. Each is verified in the tree at `ece9c92`.

**2.1 There is no owning process.** Six independent store openings exist
across five call sites. The precise set (verified — an earlier revision
of this doc listed `serve.ts` as a caller, which is wrong: `serve.ts` is
a one-line adapter and the opener is `runtime-stdio.ts`):

| opener | path | serves |
|---|---|---|
| `runStdioServer` | `packages/mcp/src/runtime-stdio.ts:29` | `conduit serve` AND `conduit-mcp` with no flag (`bin.ts:46`) |
| `doctor` | `packages/mcp/src/bin.ts:15` | `conduit-mcp --doctor` |
| `add-mcp` | `packages/cli/src/commands/add-mcp.ts:405` | onboarding |
| `approvals` | `packages/cli/src/commands/approvals.ts:46` | approval queue |
| `key rotate` | `packages/cli/src/commands/key.ts:46` | rotation |
| `countSealedRows` | `packages/cli/src/commands/key.ts:85-86` | a SECOND, direct `createClient` inside `key generate`/`rotate` |

That last row matters: `key.ts` bypasses the `store-open.ts` seam with
its own `createClient`, which `env.ts:99` implies should not happen. Any
ownership model must account for it explicitly rather than assume one
opener per command.

The ownership question for `serve` lives in `packages/mcp`, but three of
the five call sites (`add-mcp`, `approvals`, `key`) are CLI commands and
all must change. This is not a `packages/mcp`-only change.

**Not verified, do not assume:** nothing in `store-open.ts` or
`sqlite.ts` sets WAL mode or `busy_timeout` explicitly. The coordination
behavior between these openers is inherited SQLite default behavior, not
a configured contract. An implementer must establish what it actually is
before relying on it.

**2.2 The catalog is re-read on every unit of work.**
`createApprovalRuntime` (`packages/mcp/src/runtime.ts:48`) calls
`hydrateCatalog`, and its doc comment (`runtime.ts:28-30`) says
verbatim: *"Callers MUST invoke this fresh per unit of work (M6): a
freshly-hydrated catalog snapshot per call is the recorded fix for
stale-connection visibility."* That is a workaround for having no process
that can hold a cache anyone trusts.

Step 3's hot-reload requirement is related but must be quoted correctly.
`conduitspec.md:671-673` reads: *"It MUST invalidate/reload so a source
saved in the console is visible to the running server without a
restart."* The MUST governs **invalidate/reload**, and the requirement is
scoped to **the console's own control-plane API** — step 3, not step 2.
(An earlier revision of this doc moved the MUST onto *visibility* and
presented the rewording as a quotation.)

So this is not a step-2 requirement. It is evidence that step 3 will need
a cache-invalidation story, and that whatever step 2 decides about
ownership determines how hard step 3 is. That is a real input to this
decision, but it is weaker than a mandate — and §6 records that a
shared-store design has its own answer to it.

**2.3 `key rotate` cannot detect running processes.** Step 1's design
states the limit verbatim:

> Another writer holds the db write lock → `SQLITE_BUSY` within
> `busy_timeout` → refuse: "stop running conduit processes first."
> (…This is writer exclusion DURING the transaction — best-effort
> detection, **not process detection**; review #7.)

So rotate asks the operator to stop processes and trusts the answer. A
lock probe cannot distinguish "another conduit is running" from "nobody
is running."

**2.4 Paused approvals have no host.** §5.5 pauses are durable data, but
the process that created one dies when its MCP client (Claude Desktop,
Claude Code) exits. §17 names this as disqualifying: *"A console over a
throwaway foreground runtime that dies between agent sessions (and
strands §5.5 paused approvals) is not a product."* Step 5's console is
meant to be the human-usable resume path; it needs something alive to
resume into.

---

## 3. Architecture

```
  Claude Desktop ──stdio──> conduit serve ──┐
  Claude Code    ──stdio──> conduit serve ──┤
  conduit approvals ───────────────────────┼──UDS──> conduitd ──> conduit.db
  conduit add-mcp   ───────────────────────┤        (sole NORMAL-RUNTIME
  (step 3: console ──HTTP──> control API) ─┘         opener and writer)

  conduit key rotate ──────────────────────────────────> conduit.db
        (offline maintenance — takes the exclusive
         maintenance lock; §3.4)
```

"Sole opener" is deliberately qualified: rotation retains direct access
by design, and `--doctor`'s status is an open item (§9). The accurate
claim is *one owner during normal runtime; offline maintenance tools take
exclusive ownership via the lock.*

### 3.1 The daemon (`conduitd`)

A long-lived process that opens the store once and serves requests. It
owns:

- the single libsql client and `ConduitStore`
- the execution manager and sandbox
- the catalog cache (one instance, invalidated on write — this is what
  step 3's hot-reload builds on)
- the upstream MCP session scope

It does **not** own the master key beyond what `openStoreFromEnv`
already resolves. Key resolution is unchanged from step 1: key-file-first
with env override, canary-verified at open.

### 3.2 Transport: Unix domain socket

`~/.conduit/conduitd.sock`, inside a state directory validated as
described below.

Rejected alternative: loopback TCP. The decisive reason is **§16 surface**:
a loopback TCP port is reachable by any local process and by a browser
page (the CSRF-to-localhost / DNS-rebinding class §17 flags), which would
pull step 4's request-authenticity floor forward into this step. A UDS is
not addressable from a web page. Secondary: no port allocation or
conflicts.

**Socket permissions are NOT authentication.** An earlier revision of this
doc said mode 0600 "replaces a bearer-token scheme." That is wrong twice:

1. **Portability.** Linux honors pathname-socket permissions; POSIX does
   not guarantee it, and portable code is warned not to rely on socket
   file mode alone. Peer identity must be checked explicitly —
   `getpeereid()` (macOS) / `SO_PEERCRED` (Linux) — and verified on the
   daemon side for every accepted connection, failing closed.
2. **Same-UID processes are indistinguishable.** Mode 0600 cannot
   separate two processes running as the same user, and most of the
   stated threat model ("other local processes may be hostile") is
   same-UID. A token in the same user-readable directory does not fix
   this either.

**Threat-model scope, stated explicitly rather than left implied:**

- *Different UID* — IN scope, must fail closed: 0700 state directory,
  peer-UID verification on accept, client-side verification that the
  socket is owned by the expected UID.
- *Same UID* — OUT of scope for v1, and this is a documented limit, not
  an oversight. A same-UID attacker can already read the 0600 master key
  and the database directly; the socket is not the weak link. Solving it
  needs an OS capability/broker model, which is not a v1 problem.

**Endpoint ownership (prevents squatting and split-brain):** before bind,
`lstat` the state directory — reject a symlink, wrong owner, or mode
wider than 0700. Validate any pre-existing socket entry is a socket owned
by the expected UID. Bind while holding the lifecycle lock (§3.5),
record the bound socket's device+inode, and on shutdown unlink only if
the pathname still resolves to that same object. **Clients never unlink
the socket** — see §3.5.

This IPC is **not** the control API. Step 3 builds a typed local HTTP API
for the console; §9 open item 5 records that step 3 and step 4 must ship
as one externally-reachable increment.

Windows note: v1 targets macOS/Linux. Named-pipe support is a step-7
concern, called out so the transport seam accepts an alternative rather
than hardcoding `net.connect(path)`.

This IPC is **not** the control API. Step 3 builds a typed local HTTP API
for the console, with its own §16 floor in step 4. Step 2 builds only
process-to-process plumbing for surfaces that already exist.

Windows note: v1 targets macOS/Linux. Windows named-pipe support is a
step-7 concern, called out here so the transport seam is written to
accept an alternative rather than hardcoding `net.connect(path)`.

### 3.3 Clients — narrow service RPCs, NOT a remote store

**The daemon does not expose `ConduitStore` over the socket.** This is the
central correction from review. An earlier revision proposed swapping the
injected `openStore` default for a daemon-backed one, and claimed
"converting a consumer means changing a default, not rewriting call
sites." That is false, and the reason it is false is a security problem,
not an effort problem:

- `ApprovalsDeps.openStore` is typed to return a full `ConduitStore`
  (`approvals.ts:25`), which is **nine repository interfaces plus
  `provisionSource()`** (`store/store.ts:20-31`). A daemon-backed default
  would mean implementing all of it as RPC proxies.
- `provisionSource` is an **atomic multi-table transaction**
  (`store.ts:31-41`, "all in one transaction… All-or-nothing").
  Proxying a transaction boundary over RPC is a design problem in itself.
- A generic store proxy would expose `secrets.reveal` over the socket,
  and would let an agent-facing `serve` client reach administrative
  operations (approve, deny, mutate sources) purely by method name.
- `add-mcp` injects no `createRuntime` at all (`add-mcp.ts:56-60`), so
  the claimed "matching DI convention" did not exist.

**Instead: each surface gets a narrow, capability-scoped RPC set.** The
socket carries service operations, never database access.

| client | permitted operations |
|---|---|
| `conduit serve` (agent-facing) | execute, search, describe — no administrative verbs |
| `conduit approvals` | list, approve, deny |
| `conduit add-mcp` | source provisioning (see §3.3.1) |

Contract requirements, all mandatory: every request and response is
schema-validated, versioned, length-framed, size-capped, depth-capped,
and deadline-bounded. **No RPC returns a master key, a plaintext
credential, a credential-bearing header, or a pre-authenticated upstream
request.**

#### 3.3.1 The `add-mcp` credential problem (§9.2)

`add-mcp.ts:303` calls `store.secrets.reveal(existingConnection.credentialRef)`
to obtain a stored credential for its onboarding fetch. Under a naive
conversion that plaintext credential crosses the socket into the CLI
process.

An earlier revision of this doc claimed "the §9.2 credential boundary is
strengthened, not weakened" while proposing exactly that. Both cannot be
true. The §9.2 requirement is that secrets never reach the agent, model,
or sandbox heap — the CLI is not the agent, so this is not a §9.2
violation on its face, but shipping plaintext across a new IPC boundary
in a product built on credential containment is the wrong default.

**Decision: the daemon performs the credential-bearing fetch on the
client's behalf.** `add-mcp` sends "validate this source URL, using the
credential already sealed under ref X" and receives back the tool list or
a typed error. The plaintext never leaves the daemon. Fresh secrets
supplied at onboarding still travel client→daemon once (unavoidable —
the operator is providing them), but never daemon→client.

This is a real behavior change to `add-mcp`, not a default swap, and the
plan must budget for it.

`conduit serve` keeps its stdio MCP surface toward the agent. Behind it,
tool calls become daemon RPCs. The M8 stdout-purity invariant
(`runtime-stdio.ts:15-19`, pinned by `INVARIANTS.md:33,39`) is untouched.
Note `runtime-stdio.ts:35-43` reads `env.allowPrivateEgress` and
`store.sources.list()` at startup — both become daemon calls at process
start, so "daemon absent at boot" is a first-class path, not an edge
case.

### 3.4 The deliberate exception: `key rotate`

`key rotate` keeps direct db access and does **not** route through the
daemon. Routing it through would be incoherent: step 1's design makes
rotation *stop-first* — it is only correct when nothing else holds the
db. A rotate that runs inside the daemon would be asking the daemon to
re-encrypt the database out from under itself.

**A liveness query is NOT sufficient.** An earlier revision had rotate
"ask the daemon registry" whether anything is live, then proceed. That is
racy: an unrelated client can auto-start the daemon in the window between
the check and the rotation — including after rotate has loaded the old
key but before the re-seal transaction commits. Auto-start makes this
worse than the status quo, because daemons now appear spontaneously.

**Rotation and daemon startup must share one kernel-held exclusive
maintenance lock** — the same lock as §3.5's lifecycle lock:

- Rotate acquires it BEFORE reading the key, opening the db, or touching
  `.next`, and holds it through key promotion, directory fsync,
  checkpoint, and hygiene.
- Daemon startup acquires it before resolving its key or opening the db.
- An auto-start that finds rotation's lock held reports "rotation in
  progress" and does not spawn — and must not spin retrying.

The registry may still report *metadata* for a good error message ("which
process, since when"), but the **lock** provides the exclusion. This
closes the 2.3 gap without touching the rotation sequence itself, which
stays exactly as step 1 built and codex-converged it.

Note `key.ts:85-86`'s second direct `createClient` (§2.1) sits inside
this boundary too and must be covered by the same lock.

### 3.5 Lifecycle

**On-demand auto-start.** A client that finds no live daemon starts one
and retries.

Sourcing this honestly: the line *"`call`, `resume`, `tools …`
auto-start the local daemon if needed"* is at `conduitspec.md:574`,
inside **§15 "Public API / CLI surface (initial)"** — NOT §17. (§15 runs
559–578; §17 starts at 615.) An earlier revision of this doc attributed
it to §17 and used it to argue auto-start was already-settled v1 policy.
It is not: §15 is an initial CLI-surface sketch. Auto-start is therefore
a **decision made here**, consistent with §15's sketch but not mandated
by it.

The argument for it stands on its own: without auto-start every command
must handle "daemon absent," which is a worse failure mode than today,
where direct access simply works. See §3.5's lock discussion — auto-start
is also what makes rotation exclusion non-trivial, and §9 open item 4
records that idle-exit + auto-start together do not survive contact with
a browser console.

**Single instance — one kernel-held lifecycle lock.** An exclusive
`flock`/`O_EXCL` lock file held for the daemon's ENTIRE lifetime, acquired
before bind and released last, after the socket is safely removed. Two
clients racing to auto-start must result in one daemon: the loser detects
the winner's socket and connects. This race is a required test, not an
edge case — two MCP clients starting together at login is the normal
case.

A pidfile may exist as **diagnostic metadata only**. A PID plus
`kill(pid, 0)` is not proof of liveness: PIDs are reused, so a stale
pidfile can name an unrelated live process. Nothing may branch on it.

**Idle exit — PROVISIONALLY yes, but see the console conflict below.**
The daemon exits after a period with no connected clients and no
in-flight requests. A pending paused approval does not keep it alive — it
is durable data, and the next client to ask auto-starts a daemon that
reads it back.

The evidence that supports this, stated at its true scope: **nothing
expires on a timer.** Zero `setTimeout`/`setInterval` in
`packages/sdk/src/execution/` or `store/`; approval expiry is computed
lazily at read time (`manager.ts:746`). A whole-sdk sweep finds timers
only in `pipeline/upstream.ts:187` and `pipeline/mcp-client.ts` — all
per-request deadlines scoped to an in-flight call, never background
loops.

That establishes the *approval-expiry* axis only. An earlier revision
generalized it to "idle-exit strands nothing," which is too strong. Two
other liveness dependencies exist:

- **QuickJS holds process-global state** (`sandbox/quickjs.ts:27-31`):
  `sharedModule`, `modulePoisoned`, `moduleBuildInFlight`,
  `moduleRecoveryCount`, plus a process-global diagnostics sink
  (`quickjs.ts:38`). Idle exit discards the warmed WASM module and resets
  the poison/recovery counters, silently re-scoping the §16 DoS
  mitigation those counters exist for. Not a blocker — a fresh process
  starts unpoisoned, which is safe — but the recovery-bounding property
  is per-process and an exiting daemon resets it.
- **`upstream-session.ts:46` holds a live session Map** with a
  `dispose()` contract. Idle exit must not race an in-flight scope; this
  is what "no in-flight requests" must actually mean (§5).

**Exact idle definition.** A connection counts from `accept`, not from
its first complete frame. A request stays in-flight until DB
finalization, upstream-session disposal, AND response drain complete.
Shutdown enters a draining state: close the listener, re-check
accepted/in-flight/queued work, then release the lifecycle lock last.

**Unresolved conflict — idle-exit vs. the console (step 3).** A browser
cannot launch a local binary. Once the typed HTTP API and console exist,
a bookmarked console URL fails after idle exit unless an MCP/CLI client
happens to restart the daemon. An idle HTTP connection or polling loop is
not a reliable lifecycle mechanism. This must be resolved BEFORE step 3
ships, by one of: disabling idle exit once the control API exists; moving
service supervision (step 7) ahead of the console; or providing a native
launcher that starts the daemon before opening the browser. §17 calls for
a *"durable background service"*, and an idle-exiting daemon is in
tension with that phrase. Recorded as §9 open item 4.

**Crash recovery.** A stale socket (daemon killed, machine rebooted) must
not wedge the system — but **a client must never unlink it.** A failed
connect does not prove the daemon is dead: it may be starting, its
backlog may be transiently full, or shutdown may be racing. Unlinking a
live UDS does not close the listener; it only frees the name, letting a
second daemon bind and produce two database owners. Only a process
holding the lifecycle lock may inspect and remove a stale endpoint, under
the §3.2 validation rules.

**Durable execution state after a crash.** `manager.ts:758-766` records
that process-crash recovery of a `running` execution is DEFERRED (design
D8/F5) — a crash can leave a row durably `running`. "Daemon dies
mid-request → client reports failure" does not repair that row. On
restart, executions owned by a dead daemon need a defined terminal
transition (e.g. `failed: outcome-ambiguous`), never automatic replay.
**This may require a daemon epoch/lease in durable state — i.e. a schema
change**, which contradicts §8's "no schema change anticipated." Resolve
during planning; §8 is updated accordingly.

---

## 4. Data flow

**Tool call from an agent:** agent → `conduit serve` (stdio) → UDS
request → daemon → execution manager → policy/credential/upstream →
result back over UDS → stdio → agent.

**Effect on §9.2, stated precisely.** For the agent-facing path this is a
genuine improvement: credentials resolve inside the daemon and never
enter the `conduit serve` process, so the process the agent talks to
holds no plaintext. But this **concentrates** the boundary inside a more
privileged daemon rather than eliminating it, and it only holds because
§3.3.1 forbids credential-returning RPCs. Without that rule the split
would move plaintext *outward* into CLI processes and be a net
regression. The strengthening is conditional on §3.3's contract, not on
the process split by itself.

**Approval:** `conduit approvals list` → UDS → daemon reads
`listPaused()` from its live store. `approve`/`deny` → UDS → daemon's
manager resumes. Today's per-call `createApprovalRuntime` becomes one
long-lived manager, and the M6 fresh-catalog workaround becomes
unnecessary — the daemon's catalog is authoritative because it is the
only writer.

**Source added:** `conduit add-mcp` → UDS → daemon writes and invalidates
its own catalog. Every connected `serve` sees the new source on its next
call, with no restart. **This is the §17 startup-reload caveat closing**,
and it is the direct payoff for step 3.

---

## 5. Error handling

Failure modes and required behavior:

| condition | behavior |
|---|---|
| no daemon running | auto-start, retry once, then fail with a clear message |
| stale socket | client NEVER unlinks (§3.5); auto-start attempt takes the lifecycle lock and the lock holder validates/removes |
| daemon start fails | surface the daemon's own startup error, not a generic "cannot connect" |
| daemon dies mid-request | `outcome unknown` with a stable request ID — see below |
| two clients race to start | exactly one daemon; loser connects to winner |
| key resolution fails | unchanged from step 1 — daemon refuses to start |
| maintenance lock held (rotation) | daemon refuses to start, "rotation in progress", no retry spin |

**Retry has one safe boundary, and it is narrower than "before
acceptance."** An earlier revision said retry is safe until the daemon
accepts the request. That is not observable: once a client has written
any bytes it cannot distinguish "the daemon never parsed it" from "the
upstream side effect happened and the acknowledgement was lost." An
explicit accept-ack has the same lost-ack ambiguity one layer up.

Therefore:

- Auto-start retry happens ONLY before any request bytes are written.
- After the first byte, connection loss returns **`outcome unknown`**
  carrying a stable request ID — never a silent retry.
- Operations wanting recovery use durable idempotency keys plus result
  lookup by request ID.
- **No automatic replay** of tool calls, approvals, or source mutations
  without proven deduplication.

This matters most for tool calls that reach a real upstream: a replayed
non-idempotent call is a side effect the operator never authorized.

**Startup-error compatibility.** An earlier revision promised
byte-identical startup errors. That is the wrong contract once auto-start
introduces readiness, child-process, and IPC failure layers. The contract
is instead: stable error codes, redacted cause, actionable operator
guidance. `runtime-stdio.ts:21-25`'s existing byte-identity guarantee is
between `--doctor` and the serve path and remains within the daemon.

Error messages follow the existing format (`[Module] Operation failed:
reason. Context: {...}`) and §11 redaction — no secret material in any
daemon log line.

---

## 6. Alternative considered and rejected: the shared-store contract

Spec §17's parenthetical: *"or an explicitly safe shared-store
contract."* This would keep N processes opening the db directly and
formalize the sharing — WAL mode, documented lock discipline, a process
registry.

It is the smaller change. An earlier revision of this doc rejected it as
technically unworkable; that argument was partly a strawman and is
withdrawn. The honest comparison:

**Hot-reload does NOT require a notification channel.** A shared-store
design has at least two workable answers: rehydrate per request (what
Conduit does today), or detect external commits via SQLite's
`PRAGMA data_version`, which exists precisely to invalidate in-memory
state across connections and processes. A version table is a third. The
earlier claim that this needs "a socket they all connect to" was wrong.

**Rotation exclusion does NOT require a registry.** The same kernel
maintenance lock from §3.4 works for N processes as well as for one.

So the shared-store contract is *technically viable*. The case for one
daemon is therefore a **simplicity and authority** argument, not an
impossibility argument:

- One cache that is authoritative, versus N caches each of which can be
  individually stale — fewer states, and the failure mode is not
  "different processes disagree."
- One writer, so write serialization is a program invariant rather than
  an emergent property of SQLite locking that nothing currently
  configures (§2.1's WAL/busy_timeout gap).
- One lifecycle to reason about, versus N processes with independent
  lifetimes.
- Stranded approvals: §17 names a runtime that "dies between agent
  sessions" as disqualifying. A shared-store design can satisfy this
  too — paused executions are durable and resumable by any process — but
  only by making some process durable, which is the daemon again.

**Decision: one daemon, on simplicity and single-authority grounds.** The
rejected alternative is workable; it is just a worse fit for a product
whose next three steps all assume something is reliably alive.

---

## 7. Testing

Following the INVARIANTS ledger discipline — a module implementing a spec
invariant lands with its invariant test in the same commit, and the
ledger row flips in that commit.

**Invariant-pinned.** Prefix: `INVARIANT §17:` — the ledger keys on spec
section numbers (existing rows use §5.5, §9.3, §16.3, §18-C), and the
daemon-ownership requirement lives in §17's v1 surface-product section.
If the spec grows a numbered subsection for it during implementation,
the prefix follows that number instead.

- exactly one daemon survives a concurrent auto-start race
- a client with no daemon auto-starts and completes its request
- a stale socket is recovered without manual intervention
- `key rotate` refuses with a true process answer when the daemon is live
- a source added via one client is visible to another with no restart
  (the hot-reload precondition)
- the daemon exits after idle timeout with no paused work stranded
- a paused approval created before daemon exit is resumable after restart
- secrets never enter the `conduit serve` process (§9.2, extending the
  existing credential-boundary test to the new process split)

**Security and lifecycle tests the process split introduces** (real
processes, not mocks):

- a client running as a different UID is refused (peer-UID check, both
  directions)
- a symlinked / wrong-owner / mode-wider-than-0700 state directory is
  refused
- a pre-created socket cannot be used to impersonate the daemon
- a failed connect to a LIVE listener never unlinks it (the split-brain
  guard)
- a stale pidfile whose PID now belongs to another process changes
  nothing (pidfile is non-authoritative)
- a client arriving exactly at the idle-timer boundary, and one that
  connects but does not write
- response backpressure during shutdown drain
- rotation racing auto-start (both orders)
- oversized, partial, malformed, and slow IPC frames
- lost acknowledgement after a non-idempotent request → `outcome unknown`,
  never replay
- an execution left `running` by a killed daemon reaches a defined
  terminal state on restart

**Not invariant, still required:** state-directory and socket modes;
stable error codes with redacted cause; same-UID exposure documented as
an accepted v1 limit rather than silently assumed away.

The concurrency tests need real processes, not mocks — step 1's LEARNINGS
recorded that `:memory:` libsql silently swaps databases under
`transaction()`, so file-backed temp dbs and genuinely spawned processes
are required. Each test must be verified to catch a real mutation before
being trusted.

---

## 8. Degrees of freedom for implementation

Per the tweakable-plans rule, marking where the implementer may improvise
versus stop and ask.

**May improvise:** wire encoding (JSON-RPC over the socket is the obvious
choice given the MCP SDK is already a dependency, but not mandated —
the §3.3 contract requirements are mandatory regardless); internal module
layout; the exact idle timeout value; log line wording.

**Stop and ask:**

- Any SQL schema change. **Correction from an earlier revision, which
  said none was anticipated:** crash-recovery of `running` executions
  (§3.5) may require a daemon epoch/lease in durable state. If the
  implementer concludes it does, that is a stop-and-ask, not an
  improvisation.
- Any new runtime dependency.
- Moving `key rotate` behind the daemon.
- Any RPC that would return a plaintext credential, key, or
  credential-bearing header (§3.3.1) — this is a hard line, not a
  preference.
- Widening a client's RPC set beyond its §3.3 row — especially giving the
  agent-facing `serve` client any administrative verb.
- Anything that pulls step 3's control API or step 4's §16 floor into
  this step.
- Treating same-UID isolation as solved.

---

## 9. Open items for review

1. **`--doctor` is not read-only today.** It calls `openStoreFromEnv`
   (`bin.ts:15`), and that path creates/heals files, sets journal mode,
   runs migrations, and may bootstrap the key canary
   (`store/sqlite.ts:140`). So "keep it direct, read-only" is not
   available as written — the current opener mutates. Either make doctor
   a daemon client (losing the ability to diagnose a sick daemon), or
   build a genuinely non-mutating offline diagnostic that participates in
   the maintenance lock. The diagnostic argument still favours the
   latter; it is more work than the earlier revision assumed.
2. Idle timeout value — proposed 15 minutes, trivially tunable, and
   subordinate to item 4.
3. **Daemon identity and config.** The endpoint is a fixed path, but
   `CONDUIT_DB`, `CONDUIT_MASTER_KEY`, approval TTL, and the
   security-relevant `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` are today
   process-local environment variables. With auto-start, **whichever
   client wins the startup race silently sets global behavior for every
   later client** — including enabling private egress. Unacceptable as-is.
   Pick one before implementing: (a) v1 supports only the default db,
   file key, and a canonical config source; or (b) the endpoint is keyed
   from a canonical db identity and the handshake carries protocol
   version, db identity, and effective non-secret security settings, with
   clients rejecting mismatches. Leaning (a) for v1.
4. **Idle-exit vs. the browser console (§3.5).** Must be resolved before
   step 3 ships. A browser cannot auto-start the daemon.
5. **Steps 3 and 4 must land as one externally-reachable increment.** The
   spec already says the §16 floor ships in the same increment as the
   console. A mutating loopback HTTP API must never bind between the two.
   Step 3 may define typed handlers internally, but the listener and any
   mutating route stay disabled until Host/Origin checks, nonce, CORS
   policy, and loopback fail-closed land with them. Recorded here because
   step 2's shape is what makes step 3 easy to start early.

---

## 10. Review record

Reviewed 2026-08-15 before any implementation:

- **Adversarial cross-model pass** (`codex exec`, high reasoning, per
  `codex-one-path`): 9 P1, 4 P2, 2 P3 — verdict REJECT / not ready. All
  P1s are addressed above: IPC authentication (§3.2), RPC contract
  (§3.3), socket-unlink split-brain (§3.5), rotation race (§3.4), daemon
  config identity (§9.3), retry semantics (§5), shutdown/crash state
  (§3.5), idle-exit vs. console (§9.4), step-3/4 coupling (§9.5).
- **Independent claim verification** against the tree: found this
  document's §2.1 entry-point table wrong (`serve.ts` is not an opener;
  `bin.ts` is two; `key.ts` has a sixth direct client), the
  "changing a default" conversion claim false, the auto-start quote
  misattributed to §17 when it is §15, and the hot-reload requirement
  reworded from the spec's actual MUST. All corrected above with the
  errors named rather than silently fixed.

The one finding that changed a decision: `add-mcp.ts:303` calls
`store.secrets.reveal`, so the original "swap the injected default"
conversion would have moved plaintext credentials across the new IPC
boundary while the document claimed the §9.2 boundary was strengthened.
§3.3.1 now forbids credential-returning RPCs and moves the
credential-bearing fetch into the daemon.
