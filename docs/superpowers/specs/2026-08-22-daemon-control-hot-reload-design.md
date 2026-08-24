# Daemon control surface + catalog hot-reload — design (§17 step 3)

Status: revision 2, post-review (three-pass audit folded in — see §11)
Date: 2026-08-22
Scope: §17 v1 build-sequence step 3 (foundations cut — see §1)
Builds on: `2026-08-15-daemon-ownership-design.md` (steps 1–2, shipped)

## 1. Scope decision: foundations now, HTTP with step 4

Spec §17 step 3 reads: "Typed control-plane API + hot-reload — the
console's own local HTTP API (distinct from the `/mcp` transport). It
MUST invalidate/reload so a source saved in the console is visible to
the running server without a restart. The API accepts an abstract
actor/principal now (anonymous-local)."

The daemon-ownership design records (§9 open item 5) that step 3 and
step 4 must ship as one externally-reachable increment: an
unauthenticated loopback HTTP listener without the §16
request-authenticity floor is the exact exploitable cut §17 warns
about. The console — the API's only consumer — is step 5.

**Decision (2026-08-22, human-confirmed): this step ships the
foundations and no HTTP listener.**

**Ledger honesty:** this step does NOT complete the spec's step-3 line.
The hot-reload MUST is satisfied at the daemon boundary; the "local
HTTP API" half completes when step 4 mounts the handlers behind the
§16 floor. The build-sequence marking stays "partial" until then.

In scope:

- The long-lived runtime and catalog hot-reload inside `conduitd`
  (§2) — including rewiring the serve `search`/`describe` handlers off
  their per-call store snapshots.
- A typed control capability over the existing UDS RPC, with a
  `conduit daemon` CLI (§3).
- Version-skew diagnosis on every daemon-handshaking operator client
  (§4).
- Two deferred operational items that belong to a long-lived daemon:
  the unbounded `conduitd.log` (§5) and the `AGENT_VERSION` ↔
  `package.json` sync guard (§6).
- The actor/principal seam step 4 will mount over HTTP (§7).

Out of scope: any HTTP route, port, listener, or CORS/CSRF machinery
(step 4); every console screen (step 5); `/mcp`-over-HTTP (deferred
out of v1); Windows named pipes (step 7); idle-exit (step 7).

## 2. Long-lived runtime + catalog hot-reload

### 2.1 One runtime per daemon process

Today the daemon builds a fresh `ApprovalRuntime`
(`createApprovalRuntime` in `packages/mcp/src/runtime.ts`) per
`execute` and per `approvals.resume` (`connection.ts:658,772`), and —
separately — the serve `search`/`describe` handlers build a fresh
catalog snapshot straight from the store per call
(`connection.ts:413-418`), bypassing the runtime entirely. Both are
the recorded M6 workaround for stale-connection visibility in the
no-owner era. The daemon owns the store now; the workaround inverts
into waste.

Change, both halves explicitly:

1. `conduitd` builds **one** `ApprovalRuntime` at daemon start (after
   the store opens, before the socket binds) and every connection uses
   it. `createApprovalRuntime`'s per-call contract comment is
   rewritten to the new lifetime.
2. The serve `search`/`describe` handlers are rewired to read the
   shared runtime's catalog. `snapshotCatalog` (the per-call store
   snapshot) is deleted. Without this half, the hottest read path
   keeps the old mechanism and every test stays green — a per-call
   store snapshot also sees new tools — so §9 pins the shared-catalog
   read path directly.

Startup failure is fail-closed: if catalog hydration throws (malformed
persisted row), the daemon exits before binding the socket, with the
error in its log. A credential boundary does not limp.

Why the shared lifetime is safe — verified against the shipped code:

- **Sandbox.** The QuickJS WASM module is already module-level shared
  across all sandbox instances in a process, with poison-detection and
  coalesced rebuild (`getModule()` + `poisonModule()`,
  `packages/sdk/src/sandbox/quickjs.ts`). `QuickJSSandbox` itself is a
  stateless wrapper: one context per run, one runtime per context.
- **Manager.** `ExecutionManager` keeps no in-memory execution state;
  every read and write round-trips `store.executions`, and resume
  ownership is a store-level CAS (`claimForResume`). Pause → resume
  already tolerates a *different* manager process, so it trivially
  tolerates the same long-lived one.
- **Policy and credentials.** `createStorePolicyEngine` and
  `createStoreCredentialResolver` read the store live per decision.
  The catalog is the only cached state in the composition.

Concurrency under sharing is asserted-then-tested, not assumed: §9
includes overlapping executions through the one runtime.

Side benefit: the per-call QuickJS/WASM churn that made the sdk §16
stress tests heavy enough to OOM a CI worker (PR #49's flake class)
stops happening in production paths.

### 2.2 Hot-reload: refresh at the provisioning tail

`source.provision` and `source.revalidate` share one handler tail
(`fetchAndProvision`, `packages/mcp/src/daemon/provision.ts`) that
fetches `tools/list` and commits the source's tools. It is today the
sole code path that changes stored tools (verified: no source-removal
path exists anywhere), so it is the hot-reload hook: after the store
commit succeeds — and still inside the held per-namespace source lock
(`source-lock.ts`) — the daemon synchronously updates the shared
catalog: `removeNamespace(namespace)` then `upsert(tools)`. The
`Catalog` interface (`packages/sdk/src/catalog.ts`) already carries
exactly these two verbs; no SDK change is needed.

Properties, stated at their true strength:

- **Atomic between the two calls.** Both catalog calls run
  synchronously in one tick; no request can observe the
  removed-but-not-upserted state. This does NOT extend to a request
  that resolved a tool object before the swap and continues using it
  across an await — that request completes against the old object,
  exactly as today's snapshot behavior does.
- **Ordered.** The catalog update runs inside the source lock that
  already serializes provisioning per namespace, so catalog
  publication order matches commit order; a late continuation cannot
  publish an older generation over a newer one.
- **Recoverable, per namespace.** If the catalog update throws after
  the commit, the daemon retries the refresh of THAT NAMESPACE — not a
  whole-catalog rehydrate. The scope is the lock's: the refresh holds
  the per-namespace source lock, and `store.tools.list()` spans every
  namespace, so republishing the full list would write outside the
  lock and could resurrect a tool a concurrently-committing namespace
  had just retired. The read is filtered to this namespace so the
  write scope matches the lock scope.
  If the retry ALSO fails, the daemon logs and stops there. The line
  says only what is verifiable: the failure can land on either
  mutation, so this namespace's entries may be MISSING OR PARTIAL —
  not merely stale — until the next provision/revalidate of it, or a
  restart, rehydrates them from the store. Every other namespace is
  untouched. §9 pins both rungs with injected failures.
- **Crash-consistent.** Daemon death between commit and catalog
  update loses nothing: the next start rehydrates from the store.
- **Bounded input.** The provisioning tail's existing upstream
  response limits are the cap on what can enter the shared catalog;
  the build verifies a cap on tool count and per-tool text sizes
  exists on this path and adds one if absent (a malicious upstream's
  `tools/list` must not be able to OOM the daemon).
- **Epoch-swap alternative rejected.** Rebuilding the whole runtime
  per invalidation churns the sandbox and manager for no correctness
  gain.

**Accepted behavior — mid-execution catalog change.** A `--replace` or
revalidate while an execution is in flight (or paused awaiting
approval) changes tool resolution for that execution's subsequent
calls. This is not new in kind: resume has always rebuilt the catalog,
so a provision between pause and resume already did this. Credentials
and policy are resolved live from the store per call either way, so
the store stays the single authority. The sharper edge — an operator
approves a paused call and the namespace is retargeted before resume,
so the approval's intent no longer matches the tool that runs — also
exists today; closing it needs source/tool revision pinning on
executions, recorded in §10 as a named future hardening, not done
here.

**Source removal:** no removal verb exists today (the dogfood friction
log already wants one). When one is added (console step 5, or an
`add-mcp --remove`), it MUST call `removeNamespace` on the shared
catalog the same way; this spec's hook covers every tools-writing path
that exists now.

### 2.3 Invariant

The daemon-ownership design named the invariant this step completes:
"a source added via one client is visible to another with no restart."
Step 2 pinned it via per-call rehydration; this step must keep it
green while removing the mechanism that made it true. The e2e shape:
spawned daemon → `serve` client connects and searches → `add-mcp`
client provisions a namespace → the *same already-connected* `serve`
client searches again and sees the new tools. Prefix `INVARIANT §17:`.
Because that e2e passes under either mechanism, §9 additionally pins
the mechanism itself: a search RPC must observe a direct mutation of
the shared catalog without any store write (impossible under per-call
snapshots).

## 3. Control capability: `daemon.status` and `daemon.stop`

### 3.1 Vocabulary

New CAPABILITIES row in `packages/mcp/src/daemon/rpc.ts`:

    control: { handshake, daemon.status, daemon.stop }

The `serve`, `approvals`, and `add-mcp` rows are unchanged. The
daemon-ownership design's prohibition stands: the agent-facing `serve`
client never gains an administrative verb.

**What the row is and is not:** capability is client-declared at
handshake (`connection.ts:405`) and scopes honest clients; it is NOT a
privilege boundary against a hostile same-UID process — that is the
parent design's accepted v1 same-UID limit (its §7/§8). Adding
`control` strengthens nothing and weakens nothing there; the state
dir's 0700 lstat-verified boundary remains the actual wall.

- `daemon.status` — nullary. Answered **outside** the execution queue
  (direct dispatch, like `approvals.list`): a wedged daemon must still
  answer status, and a busy daemon must not answer its own stop with
  `busy`. Response projection, computed daemon-side, with defined
  semantics: `pid`; `agentVersion`; `startedAt`; `dbPath`; active
  connections (READY-granted open sockets, the caller included);
  executions in flight (currently running queue entries); queue depth
  (admitted, waiting); log path and active-file size (the current
  `conduitd.log` only, not `.1`). No credential-adjacent material, no
  repository rows. `dbPath`/log path are same-UID-operator diagnostics
  and stay (accepted: they reveal nothing the caller cannot already
  stat). Status reads can fail like any RPC; failures surface through
  the existing `error` response codes — §8's "cannot corrupt state"
  claim is about state, not infallibility.
- `daemon.stop` — nullary, also outside the queue. The daemon writes
  and **flushes** the acknowledgement frame, then triggers the
  existing `StopSignal` (identical to SIGTERM). Repeated stops and a
  SIGTERM racing an RPC stop are idempotent (`StopSignal.request`
  already is). Paused approvals are durable and survive.

**Verb-set decision (human-confirmed): `status` + `stop` only.** No
`restart` verb — restart is `stop` plus the auto-start every client
already performs. No auto-restart anywhere (§4).

### 3.2 CLI

`conduit daemon status` and `conduit daemon stop` in `packages/cli`,
speaking the `control` capability through the existing daemon client.

**Neither verb ever spawns a daemon.** Both connect with the client's
existing `autoStart: false` mode. The CLI keys "no daemon" on the
`DaemonUnavailable` error **code**, not its message text (the current
message misnames the default dir as custom, `client.ts:590-597`; the
build either keys on code alone or adds the default-dir message
variant — not load-bearing either way).

- No daemon running: `status` prints "not running", `stop` prints
  "not running" (idempotent — the operator wanted it stopped; it is).
  Exit codes: `stop` exits 0 (idempotent); `status` exits 0 when a
  daemon is running and 3 when none is (the systemctl convention, so
  scripts never read "not running" as healthy).
- A **draining** daemon is a third observable state: connect may be
  refused while the lifecycle lock is still held, and the client's
  bounded wait can elapse before reporting. `status` may therefore
  report "not running" for a daemon still exiting; accepted,
  documented.
- **`stop` waits for termination.** After the ack, the CLI polls
  (bounded, covering the drain window) until the socket is gone and a
  lifecycle-lock probe confirms release, then reports "stopped". If
  the bound elapses first it reports "stop requested, daemon still
  draining" and exits nonzero. This is what makes the §4 rotate flow
  real: `daemon stop` → `key rotate` must work back-to-back, and
  rotate's maintenance lock needs the daemon actually gone, not
  acked.
- **Pre-step-3 daemons:** the currently shipped daemon rejects a
  `control` handshake as invalid — the new CLI cannot RPC-stop the
  very daemon the first upgrade leaves running. On that handshake
  rejection, both verbs print the explicit manual remediation
  (terminate the running `conduitd` by signal — the exact
  command/instruction, naming SIGTERM's safety: paused work is
  durable). One-time transition path, tested.

### 3.3 Stop-drain: defined order

Order of operations at stop (normative; matches the shipped SIGTERM
path and the parent design §3.5, which releases the maintenance lock
BEFORE the lifecycle lock): acknowledge (flushed) → stop accepting →
drain in-flight work, bounded by the existing `DRAIN_DEADLINE_MS` →
close remaining connections → unlink socket → release maintenance
lock → release lifecycle lock → exit.

The stop-issuing connection closes client-side right after the
response (the client's existing one-shot `exchange`), so the drain
never waits on it; §9 pins that stop completes promptly rather than
riding the full drain deadline.

A client arriving mid-drain finds the socket refused or unlinked; its
auto-start may spawn a daemon that blocks on the lifecycle lock until
release. Both are bounded: the child's lock acquisition uses the
existing 1s lifecycle busy handler and exits "already running" on
failure; the client's attempt budget bounds the wait, and a long
drain can exhaust it — the same terminal error as any busy window. No
new machinery; this pins the sequence so the race stays bounded, not
absent.

## 4. Version-skew diagnosis

The handshake already reports the daemon's `agentVersion` as a plain
diagnostic; `protocol` remains the wire-compatibility gate (skew
never blocks an RPC — it warns).

- **Which clients warn — mechanical rule:** every CLI entry point that
  performs a daemon handshake except `serve` prints the warning
  (today: `approvals`, `add-mcp`, `daemon`). `key rotate` never
  handshakes (direct-db by design) and is excluded by the rule, not
  by enumeration. On mismatch, one stderr line:

      conduit: daemon is <X>, this CLI is <Y> — run `conduit daemon stop`;
      the next command auto-starts a matching daemon.

- An **absent** `agentVersion` (pre-D-B1 daemon) is skew by
  definition: same warning with "an older build" in place of the
  version — and because such a daemon also predates `control`, the
  warning appends the §3.2 manual remediation instead of naming
  `daemon stop`.
- The daemon-supplied version string is untrusted display input:
  length-capped and control-character-stripped before printing (a
  stale daemon must not get terminal-escape injection into operator
  stderr).
- The `serve` client logs the same line once per process through its
  existing stderr log; never into an MCP response.
- **No client ever kills or restarts the daemon on its own initiative
  (human-confirmed).** Clients of different builds coexist against one
  daemon; automatic restart would flap. Version strings carry no
  reliable ordering for dev builds. Skew is diagnosed loudly; the fix
  is one explicit operator command.

`conduit key rotate`'s stop-first guidance gains the concrete command
it always described: "stop running conduit processes first" now names
`conduit daemon stop`.

## 5. Daemon log bound (deferred item #2)

Current reality (verified): `spawnDaemon` opens `conduitd.log`
append-only, 0600, uncapped, and passes it as the child's inherited
stdout/stderr (`spawn.ts:122,147`); the daemon's log sink defaults to
`console.error` (`conduitd.ts:394`), i.e. fd 2. Rename-and-reopen
therefore CANNOT bound this file — append fds follow the inode, and
Node has no dup2 to rebind stderr. The mechanism is redesigned:

- **Owned sink.** The daemon's `log` callback writes through a
  daemon-owned fd (opened by the daemon on the log path), not through
  stderr. Rotation is: rename `conduitd.log` → `conduitd.log.1`
  (replacing any previous `.1`), open a fresh owned fd, continue.
  Rotation happens entirely inside the lstat-verified 0700 state dir
  (`assertStateDir` is the existing wall against symlink games).
- **Byte-accurate cap.** The sink tracks bytes written in memory and
  rotates when the counter reaches the cap (5 MB) — no stat cadence,
  no 100-write undershoot window. Individual log lines are
  length-capped, so a single write cannot blow past the cap
  materially. Worst case on disk: two files, ~10 MB, plus the
  residual-stderr allowance below.
- **Residual stderr, named honestly.** Stray fd-2 traffic (Node
  warnings, unexpected-fault stack traces, sandbox diagnostics) still
  follows the inherited fd into whichever inode it points at — after
  the first rotation, `.1`. This residue is accepted as
  bounded-in-practice best-effort: it is rare, not per-admission, and
  not attacker-drivable at volume (per-admission logging is the thing
  §5 turns off). The §9 rotation test asserts the on-disk active file
  stops growing under real daemon logging — the property the design
  claims — not merely that the sink object rotates.
- **Volume.** Per-admission INFO lines drop behind a debug toggle,
  default off. Mechanism: a `--debug` flag on the daemon argv,
  threaded by `spawnDaemon` only when the spawning environment opts in
  (`CONDUIT_DAEMON_DEBUG=1` read by the spawner, not inherited by the
  daemon — the constructed-env discipline stands). Lifecycle events
  (start, ready, stop, sweep results, provision outcomes, errors)
  stay at default. Log content follows the existing §9.2 redaction
  discipline; provision/upstream error text on this path was already
  reviewed for credential echo in Lane B.
- **Failure.** If rename or reopen fails, the sink keeps the old fd
  and retries at the next cap-hit; under `ENOSPC` logging degrades
  best-effort. The daemon never dies for its log.
- **Concurrent appenders, stated correctly.** Rotation is safe not
  because the daemon is the only writer (it is not: the spawning
  client's failure line and a losing auto-start child's "already
  running" line share the inode) but because concurrent appenders
  follow the renamed inode — their occasional lines land in `.1`,
  which is correct.
- **Hand-started carve-out.** A daemon started by hand in a terminal
  (stderr is a TTY, no state-dir log fd) logs to stderr as today and
  performs no rotation.

## 6. Version-sync guard (deferred item #4)

`AGENT_VERSION` (`packages/mcp/src/env.ts:27`) and `package.json`
carry the version independently; nothing enforces the match, and §4
makes the string operator-facing. Fix: a test in `packages/mcp`
asserting `AGENT_VERSION === package.json.version` at test time. No
build-system change. Known residual: a stale built dist can still
report an old version until rebuilt — that is the standing
rebuild-after-merge quirk the skew warning exists to surface, not a
gap this test can close.

## 7. The step-4 seam: actor/principal

The two control handlers take an explicit principal parameter:

    type Principal = { kind: "anonymous-local" }

**Provenance rule:** the principal is constructed by the transport
layer server-side — for the UDS transport, unconditionally
`anonymous-local`. It is never decoded from, or influenced by, any
field of the request payload; `decodeRequest` accepts no principal
field. Step 4's HTTP mount constructs its own principal from
authenticated connection state behind the §16 floor. Authorization
stays separate from identity: adding an authenticated principal
variant later does not implicitly grant the control verbs — the
capability row (and, post-step-4, the floor) still gates.

Handlers live transport-agnostic (module separate from the UDS
connection plumbing) so step 4 mounts them without touching their
bodies. Nothing else about step 4 is anticipated here.

## 8. Error handling

- Control requests from a non-`control` capability are rejected by
  the existing capability gate before any work; the `control` row is
  equally narrow in the other direction (no execute/search/provision).
- `daemon.status` failures surface as normal RPC errors; `daemon.stop`
  cannot corrupt state at any interruption point — its first effect
  is the signal path the daemon already survives.
- Catalog hydration failure at startup: fail-closed before bind (§2.1).
- Catalog refresh failure after commit: per-namespace retry from the
  store, then stop — the namespace's entries may be missing or partial
  and the log says so; other namespaces are unaffected (§2.2).
- Log rotation failure: keep old fd, retry at next cap-hit (§5).

## 9. Testing

Ledger discipline: invariant tests land in the same commit as the
module, `INVARIANT §17:` prefix, ledger row flips in that commit.

Hot-reload:
- The §2.3 e2e over a real spawned daemon (headline invariant).
- Mechanism pin: a search RPC observes a direct shared-catalog
  mutation with no store write (kills the per-call-snapshot bypass).
- Revalidate refreshes the catalog (the shared-tail hook).
- Injected catalog-update failure after commit → the per-namespace
  retry runs; search still serves the committed tools.
- Injected UPSERT failure (the other rung's failure point): the
  provision still answers success, and the rung-2 log line reports the
  namespace as missing-or-partial rather than merely stale.
- Concurrent executions through the one shared runtime complete
  correctly (overlap, not just two sequential runs).
- Long-lived runtime: sequential executions share one runtime
  (injectable `createRuntime` seam counts invocations).

Control surface:
- `daemon.stop` drains: an actively running execution completes (or
  hits its own deadline) and a queued request resolves before exit —
  not merely "a paused approval survives" (durable state would
  survive a kill). Paused-approval-resumable-after-restart stays as a
  second assertion.
- Stop is prompt: with nothing else in flight, the CLI observes
  termination well before the drain deadline.
- Double stop and SIGTERM-racing-RPC-stop are idempotent.
- Capability enforcement both directions: serve→`daemon.stop`
  rejected AND control→`execute`/`search`/`source.provision` rejected.
- `daemon.status` against a RUNNING daemon: projection shape, defined
  metric semantics, and the no-credential-material property.
- `status`/`stop` with no daemon: no spawn occurs; output as §3.2.
- Pre-control daemon: handshake rejection produces the manual
  remediation text.

Skew + version:
- Mismatched and absent `agentVersion` both warn; matched does not.
- Version string sanitization (control chars stripped, length cap).
- `AGENT_VERSION === package.json.version`.

Log:
- Over-cap log rotates once, `.1` replaced, daemon keeps logging, and
  the on-disk ACTIVE file verifiably stops growing under daemon
  logging (the fd-ownership property, not just the sink object).

## 10. Explicitly not in this step

Restated from §1 plus review adjudications: HTTP listener/routes
(step 4); console (step 5); `restart` verb (rejected §3.1);
auto-restart on skew (rejected §4); Linux ACL CI coverage (deferred
item #3, human decision — with the note that other-UID enforcement of
the state-dir wall remains pinned by the existing darwin e2e + unit
tests until then); machine-readable/JSON status output (console-era
concern; text contract only for now); execution-level source/tool
revision pinning to close the approve-then-retarget window (named
future hardening — predates this step, becomes more visible with
hot-reload; candidates: pin provision revision at pause, fail closed
on mismatch at resume); a source-removal verb (wanted by the dogfood
friction log; §2.2 defines its catalog obligation when it arrives);
same-UID privilege separation (parent design's accepted v1 limit).

## 11. Decision + review trail

- 2026-08-22 — scope: foundations now, HTTP with step 4
  (human-confirmed; honors daemon-design §9 item 5).
- 2026-08-22 — verbs: `status` + `stop` only; skew warns, never
  auto-restarts (human-confirmed).
- 2026-08-22 — fold-ins: deferred items #2 (log bound) and #4
  (version-sync guard); #3 stays parked (human-confirmed).
- 2026-08-22 — pre-spec edge-case pass (human-requested) found: the
  no-spawn requirement, stop-drain/auto-start ordering, the
  revalidate hook, mid-execution catalog change (accepted),
  absent-`agentVersion` handling; cleared sandbox-poisoning and
  manager-lifetime as non-issues on code inspection.
- 2026-08-22 — **three-pass design review** (revision 2 folds it in):
  an in-session eng review, a codex cross-model pass (36 findings),
  and a code-verifying fable audit (11 findings). Independently
  triple-found: the inherited-stderr log-fd flaw (§5 redesigned to an
  owned sink), the pre-control-daemon stop bootstrap (§3.2/§4), and
  stop's ack-vs-exit gap (§3.2 wait-for-termination). Fable-only:
  the `search`/`describe` snapshot bypass (§2.1 half 2 + §9
  mechanism pin) and the maintenance-before-lifecycle release order
  (§3.3). Codex-only, adopted: commit-then-refresh recovery, source-
  lock-ordered publication, provisioning input caps, drain test must
  cover live work, principal provenance, version-string
  sanitization, byte-accurate log cap, atomicity claim narrowed,
  status fallibility + metric semantics, ledger honesty (§1).
  Codex findings adjudicated OUT as documented accepted limits (per
  the adversarial-convergence criterion): same-UID capability
  "forgery" and principal trust (parent design's accepted v1 limit,
  restated in §3.1/§7); approval-TOCTOU beyond documentation (named
  in §10 as future hardening); Linux ACL deferral (human decision);
  wire-compat beyond the existing `protocol` field; JSON output
  contract (deferred, §10).
- 2026-08-22 — `status` exit code: 0 running / 3 not running
  (human-confirmed; codex #19 adopted). No open items remain.
- 2026-08-23 — divergence fix (d0ea117 shipped the per-namespace
  refresh; this spec still described a whole-catalog rehydrate). §2.2
  and §8 now match the implementation: the recovery ladder is
  per-namespace because the write scope must equal the held source
  lock's scope, and the rung-2 log line claims only what is
  verifiable. Found by the Tier-2 five-specialist review of
  `feat/daemon-control`; the same review corrected the rung-2 wording
  in code, which had asserted "serving the previous catalog" even when
  an upsert failure had left the namespace empty or partial.
