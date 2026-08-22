# Daemon control surface + catalog hot-reload — design (§17 step 3)

Status: draft for review · 2026-08-22
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

In scope:

- The long-lived runtime and catalog hot-reload inside `conduitd`
  (§2) — the MUST above, satisfied at the daemon boundary.
- A typed control capability over the existing UDS RPC, with a
  `conduit daemon` CLI (§3).
- Version-skew diagnosis on every operator-facing client (§4).
- Two deferred operational items that belong to a long-lived daemon:
  the unbounded `conduitd.log` (§5) and the `AGENT_VERSION` ↔
  `package.json` sync guard (§6).
- The actor/principal seam step 4 will mount over HTTP (§7).

Out of scope: any HTTP route, port, listener, or CORS/CSRF machinery
(step 4); every console screen (step 5); `/mcp`-over-HTTP (deferred
out of v1); Windows named pipes (step 7); idle-exit (step 7).

## 2. Long-lived runtime + catalog hot-reload

### 2.1 One runtime per daemon process

Today every unit of work builds a fresh `ApprovalRuntime`
(`createApprovalRuntime` in `packages/mcp/src/runtime.ts`, called
per-request from `packages/mcp/src/daemon/connection.ts`). That
per-call rehydration is the recorded M6 workaround for
stale-connection visibility in the no-owner era. The daemon owns the
store now; the workaround inverts into waste.

Change: `conduitd` builds **one** `ApprovalRuntime` at daemon start
(after the store opens, before the socket binds) and every connection
uses it. `createApprovalRuntime`'s per-call contract comment is
rewritten to the new lifetime.

Why this is safe — verified against the shipped code, not assumed:

- **Sandbox.** The QuickJS WASM module is already module-level shared
  across all sandbox instances in a process, with poison-detection and
  coalesced rebuild (`getModule()` + `poisonModule()`,
  `packages/sdk/src/sandbox/quickjs.ts`). `QuickJSSandbox` itself is a
  stateless wrapper: one context per run, one runtime per context. A
  long-lived instance changes nothing.
- **Manager.** `ExecutionManager` keeps no in-memory execution state;
  every read and write round-trips `store.executions`, and resume
  ownership is a store-level CAS (`claimForResume`). Pause → resume
  already tolerates a *different* manager process, so it trivially
  tolerates the same long-lived one.
- **Policy and credentials.** `createStorePolicyEngine` and
  `createStoreCredentialResolver` read the store live per decision.
  The catalog is the only cached state in the composition.

Side benefit: the per-call QuickJS/WASM churn that made the sdk §16
stress tests heavy enough to OOM a CI worker (PR #49's flake class)
stops happening in production paths.

### 2.2 Hot-reload: refresh at the provisioning tail

`source.provision` and `source.revalidate` share one handler tail that
fetches `tools/list` and commits the source's tools
(`packages/mcp/src/daemon/provision.ts`). That tail is the single
choke point where stored tools change, so it is the hot-reload hook:
after the store commit succeeds, the daemon synchronously updates the
shared catalog — `removeNamespace(namespace)` then `upsert(tools)` —
in the same tick. The `Catalog` interface (`packages/sdk/src/catalog.ts`)
already carries exactly these two verbs for source refresh and
removal; no SDK change is needed.

Properties:

- **Atomic enough.** Both catalog calls are synchronous on one event
  loop; no request can observe the removed-but-not-upserted state.
- **Ordered after commit.** A failed store write leaves the catalog
  untouched; the catalog never advertises a tool the store does not
  hold.
- **Crash-consistent.** If the daemon dies between commit and catalog
  update, the next daemon start rehydrates from the store and is
  correct. No durable catalog state exists outside the store.
- **Epoch-swap alternative rejected.** Rebuilding the whole runtime
  per invalidation would churn the sandbox and manager for no
  correctness gain; the catalog seam models incremental refresh by
  design.

**Accepted behavior — mid-execution catalog change.** A `--replace` or
revalidate while an execution is in flight changes tool resolution for
that execution's subsequent calls (and for replays after a pause).
This is not new in kind: resume has always rebuilt the catalog, so a
provision between pause and resume already did this. It is not a
boundary break — credentials and policy are resolved live from the
store per call either way, so the store stays the single authority.
Documented here as accepted, not fixed.

### 2.3 Invariant

The daemon-ownership design named the invariant this step completes:
"a source added via one client is visible to another with no restart."
Step 2 pinned it via per-call rehydration; this step must keep it
green while removing the mechanism that made it true. The e2e shape:
spawned daemon → `serve` client connects and searches → `add-mcp`
client provisions a namespace → the *same already-connected* `serve`
client searches again and sees the new tools. Prefix `INVARIANT §17:`;
if the row exists it stays green, and the test must exercise the
long-lived path (one runtime, no rebuild between the two searches).

## 3. Control capability: `daemon.status` and `daemon.stop`

### 3.1 Vocabulary

New CAPABILITIES row in `packages/mcp/src/daemon/rpc.ts`:

    control: { handshake, daemon.status, daemon.stop }

The `serve`, `approvals`, and `add-mcp` rows are unchanged. The
daemon-ownership design's prohibition stands: the agent-facing `serve`
client never gains an administrative verb.

- `daemon.status` — nullary (the client steers nothing). Response is a
  projection computed daemon-side: `pid`, `agentVersion`, `startedAt`,
  `dbPath`, active connection count, executions in flight, queue
  depth, log path and current size. No credential-adjacent material,
  no repository rows.
- `daemon.stop` — nullary. The daemon acknowledges with a result
  frame, then begins the exact drain SIGTERM triggers (the existing
  `StopSignal`): stop accepting connections → drain in-flight work →
  unlink the socket → release the lifecycle lock → exit. Paused
  approvals are durable and survive (already invariant-pinned).

**Verb-set decision (human-confirmed): `status` + `stop` only.** No
`restart` verb — restart is `stop` plus the auto-start every client
already performs, and a dedicated verb would duplicate the spawn path
for a two-command convenience. No auto-restart anywhere (§4).

### 3.2 CLI

`conduit daemon status` and `conduit daemon stop` in `packages/cli`,
speaking the `control` capability through the existing daemon client.

**Neither verb ever spawns a daemon.** Both connect with the client's
existing `autoStart: false` mode ("never spawn, just report if
absent"). No daemon running: `status` prints "not running" and exits
0; `stop` prints "not running" and exits 0 (idempotent — the operator
wanted it stopped; it is).

### 3.3 Stop-drain vs auto-start race — defined order

During a drain, in-flight work may run up to its deadline. A client
arriving mid-drain finds either (a) the socket still present but
connections refused, or (b) the socket unlinked — in which case its
auto-start spawns a daemon that blocks on the lifecycle lock until the
draining daemon releases it. Both are bounded by the client's existing
attempt budget; a long drain can exhaust that budget, and the client
reports the same terminal error as any busy window. Order of
operations at stop (normative): acknowledge → stop accepting → drain →
unlink socket → release lifecycle lock → exit. No new machinery — this
pins the sequence so the race stays bounded, not absent.

## 4. Version-skew diagnosis

The handshake already reports the daemon's `agentVersion` as a plain
diagnostic. This step acts on it:

- Every operator-facing client (`approvals`, `add-mcp`, `daemon`)
  compares the daemon's `agentVersion` with its own build's version.
  On mismatch it prints one stderr line and continues:

      conduit: daemon is <X>, this CLI is <Y> — run `conduit daemon stop`;
      the next command auto-starts a matching daemon.

- An **absent** `agentVersion` (a daemon built before the field
  existed) is skew by definition and produces the same warning with
  "an older build" in place of the version.
- The `serve` client logs the same line once per process through its
  existing stderr log; never into an MCP response.
- **No client ever kills or restarts the daemon on its own initiative
  (human-confirmed).** Multiple clients of different builds coexist
  against one daemon; automatic restart would let them flap the daemon
  toward their own versions and kill each other's in-flight work.
  Version strings carry no reliable ordering for dev builds, so
  "newer wins" is not decidable. Skew is diagnosed loudly; the fix is
  one explicit operator command.

`conduit key rotate`'s stop-first guidance gains the concrete command
it always described: "stop running conduit processes first" now names
`conduit daemon stop`.

## 5. Daemon log bound (deferred item #2)

`spawnDaemon` opens `conduitd.log` append-only with no cap, and the
daemon logs a line per admission; a long-lived daemon makes that
unbounded disk growth. Two-part fix, both daemon-side:

- **Volume:** per-admission INFO lines drop behind a debug flag
  (default off). Lifecycle events (start, ready, stop, sweep results,
  provision outcomes, errors) stay at default.
- **Cap:** the daemon re-stats its log every 100 writes; over the cap
  (5 MB) it renames `conduitd.log` → `conduitd.log.1` (replacing any
  previous `.1`) and reopens a fresh fd. Single-writer by ownership
  design, so the rotation is race-free. Worst case on disk: two files,
  ~10 MB.

Rotation is daemon-side, not spawn-side, deliberately: a rotate-only-
at-spawn scheme is defeated by exactly the long-livedness this step
creates.

## 6. Version-sync guard (deferred item #4)

`AGENT_VERSION` (`packages/mcp/src/env.ts`) and `package.json` carry
the version independently; nothing enforces the match, and §4 makes
the string operator-facing. Fix: a test in `packages/mcp` asserting
`AGENT_VERSION === package.json.version` at test time. No build-system
change.

## 7. The step-4 seam: actor/principal

The two control handlers take an explicit principal parameter:

    type Principal = { kind: "anonymous-local" }

— a single-variant union today, so handlers are written against "who
is asking" from birth and step 4/5 can add variants without rewriting
call sites (the spec's "accepts an abstract actor/principal now"
requirement). The handlers live transport-agnostic (module separate
from the UDS connection plumbing) so step 4 mounts them behind the §16
floor over HTTP without touching their bodies. Nothing else about
step 4 is anticipated here.

## 8. Error handling

- Control requests from a non-`control` capability are rejected by the
  existing capability gate before any work (no new path).
- `daemon.status` and `daemon.stop` cannot fail halfway in a way that
  corrupts state: status is a read; stop's first effect is the same
  signal SIGTERM sends, which the daemon already survives at any
  point.
- Rotation failure (rename/reopen error) logs one line to stderr and
  keeps the old fd — logging degrades, the daemon never dies for its
  log.
- Catalog refresh runs after commit and is synchronous and in-memory;
  it has no failure mode short of a programming error, which the e2e
  invariant test exists to catch.

## 9. Testing

Ledger discipline: invariant tests land in the same commit as the
module, `INVARIANT §17:` prefix, ledger row flips in that commit.

- Hot-reload e2e (§2.3) over a real spawned daemon — the headline
  invariant.
- Long-lived runtime: two sequential executions through one daemon
  share a runtime (observable via the injectable `createRuntime` seam
  counting invocations).
- Revalidate refreshes the catalog (the shared-tail hook, §2.2 —
  guards the found edge case).
- `daemon.stop` drains: a paused approval created before stop is
  resumable after the next auto-start (extends the existing
  signal-stop invariant to the RPC path).
- Capability enforcement: a `serve`-capability client sending
  `daemon.stop` is rejected.
- `status`/`stop` with no daemon running: no spawn occurs, exit 0.
- Skew warning: mismatched and absent `agentVersion` both fire it;
  matched does not.
- Rotation: over-cap log rotates once, `.1` replaced, daemon keeps
  logging.
- `AGENT_VERSION === package.json.version`.

## 10. Explicitly not in this step

Restated from §1 for review clarity: HTTP listener/routes (step 4),
console (step 5), `restart` verb (rejected §3.1), auto-restart on
skew (rejected §4), Linux ACL CI coverage (deferred item #3 — its own
housekeeping change), idle-exit and service install (step 7),
Windows named pipes (step 7).

## 11. Decision trail

- 2026-08-22 — scope: foundations now, HTTP with step 4
  (human-confirmed; honors daemon-design §9 item 5).
- 2026-08-22 — verbs: `status` + `stop` only; skew warns, never
  auto-restarts (human-confirmed).
- 2026-08-22 — fold-ins: deferred items #2 (log bound) and #4
  (version-sync guard); #3 stays parked (human-confirmed).
- 2026-08-22 — pre-spec edge-case pass (human-requested) found: the
  no-spawn requirement on `status`/`stop`, the stop-drain/auto-start
  ordering, the revalidate catalog hook, the mid-execution catalog
  change (accepted), absent-`agentVersion` skew handling; and cleared
  sandbox-poisoning and manager-lifetime as non-issues on code
  inspection.
