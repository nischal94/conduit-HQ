# Daemon ownership — §17 v1 surface-product step 2

**Status:** design, revision 7 — pass-6 specification breaks fixed; pass 7 pending
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
by design, and `--doctor --offline` runs under the exclusive maintenance
lock (§9.1). The accurate claim is *one owner during normal runtime;
offline maintenance tools take exclusive ownership via the lock.*

### 3.1 The daemon (`conduitd`)

A long-lived process that opens the store once and serves requests. It
owns:

- the single libsql client and `ConduitStore`
- the execution manager and sandbox
- the catalog cache (one instance, invalidated on write — this is what
  step 3's hot-reload builds on)
- the upstream MCP session scope

**Concurrency cap (eng-review T3).** N clients now drive executions in
ONE process sharing ONE QuickJS module, and §16's budgets are
per-execution — nothing bounds the daemon. The daemon caps concurrent
executions (v1 default: 4; a constant, not config) and queues the rest
in a queue that is bounded in BOTH dimensions — a deadline per entry
AND a hard global capacity constant (v1: 16). A deadline alone is not a
size bound: at a high enough arrival rate, requests accumulate faster
than deadlines expire, and queued frames/connections grow without
limit. Queue-full → immediate typed "daemon busy" refusal. Entries are
removed on deadline expiry AND on client disconnect. During a §16
module recovery, dispatch suspends but the four active slots are
retained, so the recovery wave cannot admit extra concurrency. Required
tests: sustained overload, expiry cleanup, disconnect cleanup, recovery
wave. Known coupling, stated honestly: a sandbox
overflow triggers the §16 module recovery, and during that window every
client's executions stall behind the rebuild — the recovery tests put
worst-case waves at ~16s. That is the cost of one shared module; it was
per-process before and is per-daemon now. The cap keeps the blast radius
bounded; removing the shared-module coupling is explicitly step-7+
territory, not this step.

**The spawn boundary — the daemon's environment is constructed, never
inherited.** A spawned child ordinarily inherits the client's entire
environment — including `CONDUIT_MASTER_KEY`, `CONDUIT_DB`,
`CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS`, and even `HOME` (which determines
where `~/.conduit` resolves). Auto-start from an arbitrary client would
therefore let that client smuggle security config into the daemon,
defeating §9.3's default-only decision. So:

- The auto-starting client spawns the daemon with an **allowlisted,
  constructed environment** of explicitly enumerated platform variables
  with daemon-derived values. Every `CONDUIT_*` variable is stripped —
  and **`PATH` is fixed to a daemon-owned constant** (platform system
  paths), never reused from the client: an inherited `PATH` would let
  the client influence executable resolution in the long-lived daemon
  and its future subprocesses.
- **The daemon executable is resolved to an absolute trusted path by the
  client before spawn** (the client's own installation directory — it is
  running the same package), never looked up through `PATH`.
- **The child's working directory is set explicitly** to the state
  directory, never inherited — an inherited cwd would silently anchor
  any relative path the daemon, sandbox, or an upstream session ever
  resolves.
- **Stdio and file-descriptor inheritance is explicitly configured**:
  stdin closed, stdout/stderr to the daemon's own log destination, no
  other descriptors inherited from the client.
- The daemon derives its state directory from the **authenticated OS
  UID** (`os.userInfo().homedir`-equivalent resolved from the uid, not
  the inherited `HOME` string).
- The daemon resolves configuration itself — key-file-first as step 1
  built it — and receives it as explicit resolved values into the store
  opener, not implicitly via `openStoreFromEnv(process.env)`. The env
  *override* path (`CONDUIT_MASTER_KEY`) remains supported only for a
  daemon an operator starts BY HAND with that env set; it never
  transfers through auto-start.
- Required tests: hostile client values for `HOME`, `PATH`, cwd,
  `CONDUIT_MASTER_KEY`, `CONDUIT_DB`, and the private-egress flag must
  all be inert through auto-start; executable resolution must not
  consult the client's `PATH`.

**Lock descriptors never survive into daemon children.** The daemon
spawns its own subprocesses (sandbox tooling, upstream helpers). If a
lifecycle or maintenance lock descriptor is inherited across `exec`, a
long-lived or hostile child retains the lock after the daemon exits —
the socket refuses while the kernel still reports a daemon-like lock
state, and rotation is wedged indefinitely. Therefore both lock
descriptors are opened **close-on-exec** and never passed to children;
the chosen locking primitive's fork/exec semantics must be verified on
both platforms. The primitive is SQLite's POSIX record locks (fcntl),
not BSD `flock`: fcntl locks are per-process and notoriously released
when the process closes ANY descriptor on the file — SQLite manages its
descriptors internally to survive that footgun, and opens them
close-on-exec. Both properties are pinned by the named lock-db tests
(§3.5), never trusted from this paragraph. Required real-process test:
start a daemon child that outlives its daemon, kill the daemon, prove
both locks become immediately acquirable while the child still runs.

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
   file mode alone.

   **Enforcement mechanism (eng-review T2):** Node stdlib exposes no
   `getpeereid()`/`SO_PEERCRED` on `net.Socket`, and a native addon is
   off the table under the supply-chain rules. The different-UID boundary
   is therefore enforced at the **state directory**: mode 0700,
   owner-verified by `lstat` before every bind and connect. A
   different-UID process cannot traverse a 0700 directory on macOS or
   Linux, so it can never reach the socket pathname at all — kernel
   enforcement one level up, on a primitive whose semantics ARE
   guaranteed. The socket file itself is additionally 0600
   (defense-in-depth on Linux, where it is honored). If a maintained
   zero-dependency peer-credential mechanism becomes available in a
   future Node release, adopt it; until then per-connection peer
   verification is a DOCUMENTED v1 LIMIT layered under the directory
   boundary, not a silent assumption.
2. **Same-UID processes are indistinguishable.** Mode 0600 cannot
   separate two processes running as the same user, and most of the
   stated threat model ("other local processes may be hostile") is
   same-UID. A token in the same user-readable directory does not fix
   this either.

**Threat-model scope, stated explicitly rather than left implied:**

- *Different UID* — IN scope, must fail closed: lstat-verified 0700
  state directory (the enforcement mechanism, above) plus client-side
  verification that the socket is owned by the expected UID. On macOS
  the `st_mode` check is NOT sufficient alone: an extended ACL can grant
  another user directory-search rights invisible to the mode bits, so
  the directory check REJECTS any extended ACL on the state directory
  (verified per-platform by test; Linux POSIX-ACL leakage is checked the
  same way).
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
client's behalf.** The plaintext never leaves the daemon. Fresh secrets
supplied at onboarding still travel client→daemon once (unavoidable —
the operator is providing them), but never daemon→client.

**The client MUST NOT pair a credential with a destination.** An earlier
revision had `add-mcp` send "validate this URL, using the credential
sealed under ref X." That is a **credential-forwarding oracle**: a client
able to name both halves can instruct the daemon to attach credential X
to an attacker-chosen URL Y, turning the daemon into an exfiltration
tool for secrets it is holding precisely so nobody else can read them.
Redirects reintroduce the same problem even with a well-formed initial
URL.

Required shape instead — the daemon derives BOTH halves from stored
state:

- The client names a **source/connection identity**, never a
  `(url, credentialRef)` pair.
- The daemon looks up that identity's URL and credential ref from its own
  store. A ref the client supplies is never honored.
- Before attaching a credential the daemon enforces scheme, host, and
  port against the stored source's origin.
- **Redirects are not followed with the credential attached.** A
  cross-origin redirect drops the credential or fails the request; the
  §9.3 egress guard and its pinned lookup still apply on every hop.
- Onboarding a *new* source, where no stored identity exists yet, is the
  one case where the operator supplies both URL and secret in the same
  request — that is the operator's own data going in, not a stored
  credential being redirected out. The daemon still applies §9.3 and
  never echoes the secret back.

This is a real behavior change to `add-mcp`, not a default swap, and the
plan must budget for it. **Invariant test required:** a client naming a
foreign destination cannot cause any stored credential to be sent there.

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

**Rotation and daemon startup must share the kernel-held maintenance
lock** (§3.5's two-lock table: daemon holds it SHARED for its lifetime;
rotation takes it EXCLUSIVE):

- Rotate acquires it exclusively BEFORE reading the key, opening the db,
  or touching `.next`, and holds it through key promotion, directory
  fsync, checkpoint, and hygiene. It cannot acquire while any daemon
  holds it shared — the kernel enforces stop-first.
- Daemon startup acquires it shared before resolving its key or opening
  the db.
- An auto-start that finds it held exclusive reports "rotation in
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

**Two kernel locks, not one.** An earlier revision used a single
exclusive lock for both daemon lifetime and rotation exclusion. That
excludes correctly but is **undiagnosable**: an anonymous held lock
cannot tell a client whether rotation is running, a daemon is starting,
or a daemon is draining — and since pidfile metadata is explicitly
non-authoritative, nothing is left to branch on. Those three states need
opposite client behavior (fail fast / connect / wait-then-start), so the
lock must carry that distinction structurally.

| lock | daemon holds | rotation holds | purpose |
|---|---|---|---|
| **maintenance** | SHARED, for its lifetime | EXCLUSIVE | mutual exclusion between normal runtime and offline maintenance |
| **lifecycle** | EXCLUSIVE, for its lifetime | — | singleton enforcement among daemons |

**Lock primitive (eng-review T1): SQLite lock databases, not `flock`.**
Node ≥20 stdlib has no `flock(2)` and no `fcntl` lock API, and the
supply-chain rules forbid a casual native dep. The kernel lock we already
ship is SQLite's own POSIX advisory locking, via `@libsql/client`. Each
lock is a dedicated, empty, single-purpose database file in the state
directory (`conduitd-lifecycle.lock.db`, `conduitd-maintenance.lock.db`),
forced to `journal_mode=DELETE` (WAL changes lock semantics; rollback
journal gives true shared/exclusive fcntl ranges):

- **Hold EXCLUSIVE** = `BEGIN EXCLUSIVE` on a dedicated connection, held
  open for the holder's lifetime.
- **Hold SHARED** = an open read transaction held open — and the
  transaction MUST actually read the database: `BEGIN` is deferred and
  acquires nothing, and `SELECT 1` need not touch the file. The
  canonical hold is `BEGIN` + `SELECT count(*) FROM sqlite_schema`,
  which forces the database SHARED lock. Rollback-journal SQLite then
  blocks any EXCLUSIVE while that reader lives.
- **Probe modes (normative — an EXCLUSIVE probe cannot distinguish
  holders, so detection ALWAYS probes SHARED):**

  | question | probe | result meaning |
  |---|---|---|
  | is rotation running? | attempt SHARED hold on maintenance, `busy_timeout=0` | BUSY = rotation (only an EXCLUSIVE holder blocks a reader); success = no rotation — roll back immediately |
  | is a daemon alive/starting? | attempt SHARED hold on lifecycle | BUSY = daemon holds it; success = none — roll back immediately |
  | acquire (rotation, or daemon lifecycle) | `BEGIN EXCLUSIVE`, `busy_timeout=0` | BUSY = refuse per the decision table |

  Every successful probe is rolled back and its connection closed at
  once; probes never linger as accidental holders.
- **libsql-client behavior is pinned by test, not assumed.** The pattern
  requires a dedicated file-URL client whose transaction handle pins one
  physical connection, with `journal_mode=DELETE` and `busy_timeout=0`
  applied on that same connection. Pooling, lazy connect, transaction
  expiry, or client GC would silently invalidate it. Named real-process
  tests, mandatory in the plan:
  `lock-db-shared-blocks-exclusive-through-libsql`,
  `lock-db-probe-distinguishes-shared-and-exclusive`,
  `lock-db-transaction-remains-held-until-explicit-close`,
  `lock-db-sibling-connection-close-does-not-release-lock`,
  `lock-db-releases-after-sigkill-with-orphan-child-alive`.
- Locks are fcntl-backed, so the kernel releases them on process death —
  crash-safe with no cleanup protocol.
- SQLite internally works around the POSIX close-drops-locks footgun and
  opens its fds close-on-exec — precisely the two hand-rolled-fcntl traps
  this choice avoids. The plan must still pin both properties with the
  orphan-child test rather than trusting this paragraph.
- Step 1 already verified the underlying behavior empirically ("a held
  `transaction("write")` = `BEGIN IMMEDIATE` refuses a second writer with
  SQLITE_BUSY").

The lock-db files carry no data; their contents are never read. They are
kernel lock handles with a `.db` extension.

**The total acquisition protocol** (order is normative — two separate
locks cannot be observed atomically, so coherence comes from ordering
plus re-probing, not from a snapshot):

1. **Daemon startup:** acquire lifecycle EXCLUSIVE **first**, then
   maintenance SHARED, both non-blocking, BEFORE resolving keys or
   opening the db. If maintenance is held exclusive (rotation), release
   lifecycle immediately and report "rotation in progress". This
   ordering means "maintenance shared + lifecycle free" is not a
   reachable daemon state.
2. **The daemon itself acquires its own locks.** The auto-starting
   client never acquires a lock and hands it to the child — there is no
   reliable cross-process lock handoff; the client only spawns and then
   probes like any other client.
3. **Rotation:** attempt maintenance EXCLUSIVE **non-blocking**. Held
   shared (live daemon) → refuse with the daemon's identity from
   diagnostic metadata. Never block-wait: blocking would starve behind
   daemon lifetimes and stack rotations behind each other invisibly.
4. **Shutdown:** release maintenance BEFORE lifecycle; lifecycle release
   is the very last act (§ drain machine).
5. **Clients re-probe after every wait.** A client's view is stale the
   moment it is taken; any branch taken on lock state is revalidated
   after a wait completes (e.g. after a lifecycle-release wait, probe
   maintenance again before deciding "start" vs "rotation in
   progress").

Client decision table (each row re-checked after any wait):

- Maintenance EXCLUSIVE → rotation → **fail fast**, no retry spin.
- Lifecycle held + socket connectable → healthy daemon → connect (and
  see the readiness gate below).
- Lifecycle held + socket refuses → starting or draining → wait under
  one bounded deadline for lifecycle release, then **re-probe from the
  top**.
- Neither lock held → spawn the daemon (§3.1 spawn boundary), then probe
  again.

Rotation taking maintenance EXCLUSIVE is blocked while any daemon holds
it SHARED — step 1's stop-first precondition, now kernel-enforced
instead of operator-trusted.

Two clients racing to auto-start must produce one daemon: both spawn,
one child wins lifecycle, the other child exits, both clients converge
by re-probing. This race is a required test, not an edge case — two MCP
clients starting together at login is the normal case.

A pidfile may exist as **diagnostic metadata only** (for error messages:
which process, since when). A PID plus `kill(pid, 0)` is not proof of
liveness — PIDs are reused — so no control flow may branch on it.

**Idle exit — DEFERRED to step 7 (eng-review T4, reversing the
provisional yes).** In this step the daemon runs until stopped: operator
signal (`SIGTERM`/`SIGINT`) or a future `conduit daemon stop`. The
eng review's reasoning: the DRAINING complexity, the READY gate's
hardest race, and the §9.4 browser-console conflict all existed *only to
serve idle-exit* — and idle-exit was itself provisional. Deferring it
makes step 2 smaller and strictly safer, and step 7 (service lifecycle)
is idle-exit's natural home alongside supervision. The liveness
analysis below is KEPT because it establishes that exiting is *safe*
whenever it happens — which shutdown-on-signal still needs.

A pending paused approval does not keep the daemon alive — it is durable
data, and the next client to ask auto-starts a daemon that reads it
back.

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

**Exact idle definition and the drain state machine.** A connection
counts from `accept`, not from its first complete frame. A request stays
in-flight until DB finalization, upstream-session disposal, AND response
drain complete.

Daemon states: `RUNNING → DRAINING → STOPPED`.

- `RUNNING`: listener open, requests served.
- `DRAINING`: stop signal received (idle-exit deferred to step 7 — the
  only triggers in this step are operator signal or explicit stop).
  Close the listener, re-check
  accepted/in-flight/queued work, finish everything, remove the socket
  under the §3.2 device+inode check, then release the locks —
  maintenance first, lifecycle last. Draining is not cancellable; a
  daemon that has begun draining completes its exit.

**The readiness gate** (closes the successful-connect race): a
`connect()` can succeed at the kernel level — queued in the listen
backlog — moments before the daemon closes its listener, and the queued
connection is then discarded without ever being accepted. A client that
wrote request bytes on such a connection would get `outcome unknown` at
an ordinary idle boundary, and the §3.5 wait path would never engage
because its trigger is a *failed* connect. Therefore:

- After connecting, a client sends **no operation bytes** until the
  daemon sends a `READY` preface on that connection.
- The daemon sends `READY` only for connections it has accepted while in
  `RUNNING`; a connection accepted-or-queued during `DRAINING` never
  receives one.
- A connection that has received `READY` counts as active work — drain
  cannot begin beneath it.
- No `READY` within the bounded deadline → the client treats it exactly
  like a refused connect: wait for lifecycle release, re-probe from the
  top. Nothing was written, so retrying is a first attempt, not a
  replay.
- `STOPPED`: no locks held, no socket.

**The client contract during DRAINING** (closes the liveness hole where a
client could fail to connect, fail to auto-start because the lifecycle
lock is still held, and burn its retry against a daemon that will never
serve it):

- A client that cannot connect but observes the lifecycle lock held —
  and the maintenance lock NOT held exclusive — treats the daemon as
  starting-or-draining and **waits under one bounded startup deadline**
  for the lifecycle lock to release, then races to acquire-and-start or
  connects to whichever daemon won.
- The wait happens BEFORE any request bytes are written, so it composes
  with §5's retry rule: the client has not sent anything, so the
  eventual attempt against the new daemon is a first attempt, not a
  replay.
- Rotation contention stays fail-fast and never enters this wait path —
  the exclusive maintenance lock is distinguishable by mode (§ two-lock
  table above).

**The browser-console conflict is RESOLVED by the deferral.** A browser
cannot launch a local binary, so idle-exit would have made a bookmarked
console URL fail after timeout — the conflict recorded in earlier
revisions. With idle-exit deferred, the daemon is durable until stopped,
which is exactly §17's *"durable background service."* When step 7
introduces idle-exit (if it still wants it), it owns this conflict with
full context: supervision exists by then, so the daemon can be
launchd/systemd-woken rather than client-woken.

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
| maintenance lock held EXCLUSIVE (rotation) | fail fast, "rotation in progress", no retry spin, never the wait path |
| lifecycle lock held, socket refuses (starting/draining) | wait under one bounded startup deadline for lock release, then connect-or-start (§3.5 drain contract) |
| custom `CONDUIT_DB` in client env | typed handshake refusal — v1 daemon is default-paths-only (§9.3) |

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
- a signal-stopped daemon exits with no paused work stranded (idle-exit
  deferred to step 7)
- a paused approval created before daemon exit is resumable after restart
- secrets never enter the `conduit serve` process (§9.2, extending the
  existing credential-boundary test to the new process split)

**Security and lifecycle tests the process split introduces** (real
processes, not mocks):

- a different-UID process cannot reach the socket (0700 directory
  traversal denied on both platforms); an extended ACL on the state
  directory is rejected at bind and at connect
- a symlinked / wrong-owner / mode-wider-than-0700 state directory is
  refused
- a pre-created socket cannot be used to impersonate the daemon
- a failed connect to a LIVE listener never unlinks it (the split-brain
  guard)
- a stale pidfile whose PID now belongs to another process changes
  nothing (pidfile is non-authoritative)
- a client arriving during signal-triggered listener closure, and one that
  connects but does not write
- response backpressure during shutdown drain
- rotation racing auto-start (both orders)
- oversized, partial, malformed, and slow IPC frames
- lost acknowledgement after a non-idempotent request → `outcome unknown`,
  never replay
- an execution left `running` by a killed daemon reaches a defined
  terminal state on restart
- a client naming a foreign destination cannot cause any stored
  credential to be sent there (the §3.3.1 anti-oracle invariant)
- a cross-origin redirect never carries a stored credential
- rotation's exclusive maintenance acquisition blocks while a daemon
  holds it shared, and vice versa (kernel-enforced stop-first)
- a client arriving during DRAINING waits, then reaches whichever daemon
  wins — no burned retry against a draining daemon
- a client with custom `CONDUIT_DB` gets the typed handshake refusal;
  daemon config never inherits the auto-starting client's env
- hostile client `HOME` / `CONDUIT_MASTER_KEY` / `CONDUIT_DB` /
  private-egress values are inert through auto-start (spawn boundary)
- a connection queued during listener close gets no READY and the client
  writes nothing (readiness-gate race)
- lock-order test: daemon startup during rotation releases lifecycle and
  reports; rotation during a live daemon refuses non-blocking

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
layout; the queue-capacity constant's exact value; log line wording.

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

1. **`--doctor` — DECIDED: split it.** It is not read-only today: it
   calls `openStoreFromEnv` (`bin.ts:15`), and that path creates/heals
   files, sets journal mode, runs migrations, and may bootstrap the key
   canary (`store/sqlite.ts:140`). Leaving it as an unguarded direct
   opener would be a second writer outside the ownership model. v1 shape:
   - **Daemon-backed diagnosis** is the default `--doctor` path: connect,
     handshake, report the daemon's own health (key source, db path,
     source count) — this is what a working install needs.
   - **Offline diagnostic** (`--doctor --offline`) for diagnosing a sick
     daemon: acquires the maintenance lock EXCLUSIVE (so it cannot run
     beside a live daemon or a rotation), and runs a genuinely
     non-mutating inspection — it must NOT call `openStoreFromEnv`;
     it opens read-only and reports, never heals. If the current opener
     cannot do that, the offline mode reports what it can without
     opening the store (file existence, permissions, key-file shape).
   The current direct, potentially-mutating path outside any lock is
   retired in the same PR that introduces the daemon.
2. ~~Idle timeout value~~ — RESOLVED by deferral: no idle-exit in this
   step (§3.5, eng-review T4).
3. **Daemon identity and config — DECIDED: option (a), default-only
   v1.** The daemon serves exactly the default pair
   (`~/.conduit/conduit.db` + key file), mirroring rotation's own
   default-paths-only decision from step 1. Security-relevant behavior is
   NEVER inherited from the auto-starting client's environment:
   - The daemon resolves its config from its own canonical source
     (key-file resolution as today, default db path). A client-side
     `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` or `CONDUIT_DB` does NOT
     transfer to the daemon.
   - A client whose env sets `CONDUIT_DB` to a custom path gets a typed
     refusal from the daemon handshake ("custom db paths bypass the
     daemon in v1") — the same delete-and-re-onboard posture step 1 took
     for custom-path rotation. Custom-path installs keep direct store
     access and forgo daemon features in v1; this is a documented limit.
   - The handshake reports protocol version, db path, and effective
     non-secret security settings; clients print them on mismatch.
   This removes the "first client silently sets global egress policy"
   hole by construction rather than by validation.
4. ~~Idle-exit vs. the browser console~~ — RESOLVED by the idle-exit
   deferral (§3.5): the daemon is durable until stopped, so the console
   always finds it. Step 7 re-inherits the conflict only if it
   reintroduces idle-exit, with supervision available by then.
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

**Second pass (2026-08-15, document inlined): NOT CONVERGED — 5
category-(c) breaks, all fixed in revision 3:**

1. Config identity was an open item, not a decision → DECIDED
   default-paths-only v1; daemon config never inherited from client env
   (§9.3).
2. One anonymous lock could not distinguish rotation / starting /
   draining → two-lock design: shared/exclusive maintenance +
   exclusive lifecycle (§3.5), giving kernel-enforced stop-first.
3. Drain had a client liveness hole (retry burned against a draining
   daemon) → explicit RUNNING→DRAINING→STOPPED machine with a
   wait-under-deadline client contract (§3.5).
4. The rev-2 credential fetch was a forwarding oracle (client named both
   URL and credential ref) → daemon derives both from stored source
   identity; no credential on cross-origin redirects; anti-oracle
   invariant test (§3.3.1).
5. `--doctor` had no ownership contract and mutates today → split:
   daemon-backed default + non-mutating offline mode under the exclusive
   maintenance lock; the unguarded direct path retires with this PR
   (§9.1).

Second-pass items accepted without change: same-UID scope (documented
decision), QuickJS counter reset (best-effort layer), idle-exit vs.
console (provisional pending §9.4), crash-recovery mechanism selection
(deferred to planning as a stop-and-ask).

**Third pass (2026-08-15): NOT CONVERGED — oracle and --doctor fixes
confirmed complete; 3 category-(c) refinements, all fixed in revision 4:**

1. Config decision was defeatable through the spawn environment (child
   inherits `HOME`/`CONDUIT_*`) → constructed allowlisted spawn env,
   uid-derived state dir, explicit resolved config into the opener
   (§3.1).
2. Lock protocol lacked acquisition order and atomic observation →
   normative total order (lifecycle EXCLUSIVE then maintenance SHARED,
   both non-blocking; rotation non-blocking; daemon acquires its own
   locks, no handoff; release maintenance before lifecycle; clients
   re-probe after every wait) (§3.5).
3. A kernel-queued `connect()` could succeed just before listener close
   and be discarded → READY preface gate: no operation bytes until the
   daemon confirms RUNNING-state acceptance; a READY connection blocks
   drain; a missing READY is treated as a refused connect (§3.5).

**Fourth pass (2026-08-15): NOT CONVERGED — READY gate and lock ordering
confirmed complete; 2 residual breaks, fixed in revision 5:**

1. The spawn boundary stripped `CONDUIT_*` but left `PATH`, executable
   resolution, cwd, and fd inheritance client-controlled → daemon-owned
   fixed `PATH`, absolute pre-resolved executable, explicit cwd = state
   dir, explicit stdio/fd configuration, hostile-`PATH`/cwd tests
   (§3.1).
2. Lock descriptors could be inherited by daemon children across `exec`,
   letting a long-lived child wedge rotation after daemon death → both
   locks opened close-on-exec, never passed to children; fork/exec
   semantics of the primitive verified per platform; orphan-child
   real-process test (§3.1).

**Engineering review (2026-08-16, `plan-eng-review`, platform-focused):**
the codex arc reviewed the design as logic; this pass reviewed it against
the Node runtime and found two buildability landmines the arc structurally
could not see — **Node ≥20 stdlib has neither `flock(2)` nor
`SO_PEERCRED`/`getpeereid`**, and both were load-bearing. Resolutions,
applied in revision 6: T1 locks re-expressed over SQLite lock databases
(fcntl-backed, crash-safe, already shipped via `@libsql/client`; §3.5);
T2 different-UID enforcement moved to the lstat-verified 0700 state
directory, per-connection peer verification demoted to a documented v1
limit (§3.2); T3 daemon concurrency cap added (§3.1); T4 idle-exit
DEFERRED to step 7 — reversing the pass-2..5 provisional yes — which
dissolves the §9.4 console conflict and shrinks drain to
shutdown-on-signal (§3.5). Test additions for the plan: multi-process
harness task, concurrency-under-load, daemon log destination, one real
stdio-client E2E. Lock-primitive change confirmed by codex pass 6 below.

**Sixth pass (2026-08-16, on the rev-6 platform changes): NOT
CONVERGED — 5 specification breaks, all fixed in revision 7.** The lock
idea, directory posture, cap, and idle-exit deferral were each confirmed
viable; the breaks were completions: (1) a SHARED hold must actually
read the db (`SELECT count(*) FROM sqlite_schema`, since deferred
`BEGIN`/`SELECT 1` acquire nothing) and probe modes are now normative —
detection always probes SHARED, because an EXCLUSIVE probe cannot
distinguish holders; (2) libsql client behavior (connection pinning,
per-connection pragmas) pinned by five named real-process tests;
(3) macOS extended ACLs can grant traversal invisible to `st_mode` →
the state-directory check rejects any extended ACL; stale normative
peer-UID text removed from §3.2/§7; (4) the queue gains a hard capacity
constant (16) — a deadline alone is not a size bound — with
expiry/disconnect removal and recovery-wave dispatch suspension;
(5) stale idle-exit requirements removed from §7/§8 (BSD-`flock`
wording also corrected to POSIX record locks).

**Fifth pass (2026-08-15): CONVERGED.** Both pass-4 fixes verified
correct and complete; no new in-scope breaks; zero category-(c) findings.
Remaining items are all documented decisions (same-UID scope, direct
rotation, single-daemon choice, provisional idle exit, deferred
crash-recovery mechanism, default-paths-only identity, macOS/Linux v1,
diagnostic-only pidfile) or explicit best-effort layers (QuickJS
process-scoped counters). The idle-exit/browser-console conflict and the
crash-recovery mechanism are bounded planning obligations, not defects in
this ownership decision. Five-pass arc: 9 → 5 → 3 → 2 → 0.
