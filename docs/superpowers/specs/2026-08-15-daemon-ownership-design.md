# Daemon ownership — §17 v1 surface-product step 2

**Status:** design, awaiting review. No code.
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

**2.1 There is no owning process.** Five entry points independently call
`openStoreFromEnv` / `openStoreClientFromEnv`
(`packages/mcp/src/store-open.ts`) and each gets its own libsql client
against the same file:

| entry point | path |
|---|---|
| `conduit serve` | `packages/cli/src/commands/serve.ts` → `runStdioServer` |
| `conduit-mcp --doctor` | `packages/mcp/src/bin.ts` |
| `conduit add-mcp` | `packages/cli/src/commands/add-mcp.ts` |
| `conduit approvals` | `packages/cli/src/commands/approvals.ts` |
| `conduit key rotate` | `packages/cli/src/commands/key.ts` |

SQLite file locking is the only coordinator. Note `serve.ts` is a
one-line adapter over `runStdioServer`, so the ownership question lives
entirely in `packages/mcp` — the CLI surface barely changes.

**2.2 The catalog is re-read on every unit of work.**
`createApprovalRuntime` (`packages/mcp/src/runtime.ts`) calls
`hydrateCatalog` per call, and its own doc comment records this as the M6
fix for stale-connection visibility. That is a workaround for having no
process that can hold a cache anyone trusts. §17 step 3's hot-reload
requirement — *"a source saved in the console MUST be visible to the
running server without a restart"* — is the same problem asking for a
real answer.

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
  conduit add-mcp   ───────────────────────┤          (sole      (sole
  (step 3: console ──HTTP──> control API) ─┘           opener)    writer)

  conduit key rotate ──────────────────────────────────> conduit.db
        (deliberate exception — §3.4)
```

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

`~/.conduit/conduitd.sock`, mode 0600, owner-only.

Rejected alternative: loopback TCP. A UDS is better here on three counts.
Filesystem permissions replace a bearer-token scheme — the OS enforces
"only this user." No port allocation, no conflicts, no
port-already-in-use. And critically: **no §16 request-authenticity
surface.** A loopback TCP port is reachable by any local process and by a
browser page (the CSRF-to-localhost / DNS-rebinding class §17 already
flags), which would pull step 4's request-authenticity floor forward into
this step. A UDS is not addressable from a web page at all.

This IPC is **not** the control API. Step 3 builds a typed local HTTP API
for the console, with its own §16 floor in step 4. Step 2 builds only
process-to-process plumbing for surfaces that already exist.

Windows note: v1 targets macOS/Linux. Windows named-pipe support is a
step-7 concern, called out here so the transport seam is written to
accept an alternative rather than hardcoding `net.connect(path)`.

### 3.3 Clients

Store consumers stop calling `openStoreFromEnv` and call a daemon client
instead. The codebase is already shaped for this: `ApprovalsDeps`
(`approvals.ts`) and `add-mcp`'s matching DI convention already inject
`openStore` and `createRuntime`. **Converting a consumer means changing a
default, not rewriting call sites** — and the existing tests that
substitute fakes keep working unchanged.

`conduit serve` keeps its stdio MCP surface toward the agent. Behind it,
tool calls become daemon RPCs rather than direct store reads. The M8
stdout-purity invariant (`runtime-stdio.ts` redirects `console.*` to
stderr) is untouched.

### 3.4 The deliberate exception: `key rotate`

`key rotate` keeps direct db access and does **not** route through the
daemon. Routing it through would be incoherent: step 1's design makes
rotation *stop-first* — it is only correct when nothing else holds the
db. A rotate that runs inside the daemon would be asking the daemon to
re-encrypt the database out from under itself.

Rotate improves anyway. Instead of a lock probe it asks the daemon
registry (§3.5) whether anything is live, and refuses with a true answer:
which process, since when. That closes the 2.3 gap without touching the
rotation sequence, which stays exactly as step 1 built and converged it.

### 3.5 Lifecycle

**On-demand auto-start.** A client that finds no live daemon starts one
and retries. This is already the spec's assumption (§17: *"`call`,
`resume`, `tools …` auto-start the local daemon if needed"*). Without it
every command must handle "daemon absent," which is a worse failure mode
than today, where direct access simply works.

**Single instance.** A pidfile at `~/.conduit/conduitd.pid` plus an
exclusive lock on the socket path. Two clients racing to auto-start must
result in one daemon: the loser detects the winner's socket and connects.
This race is a required test, not an edge case — two MCP clients starting
together at login is the normal case, not the rare one.

**Idle exit — decided: yes, with a timeout.** The daemon exits after a
period with no connected clients and no in-flight requests. A *pending
paused approval does not keep the daemon alive* — it is durable data, and
the next client to ask about it auto-starts a daemon that reads it back.

This was the one genuinely open question, and the code answers it:
**nothing expires on a timer.** There are zero `setTimeout`/`setInterval`
calls anywhere in `packages/sdk/src/execution/` or `store/`; approval
expiry is computed lazily at read time (`manager.ts:746`,
`now() > pausedOn.expiresAt`). So a paused approval does not need a live
process to expire correctly, and idle-exit strands nothing. Given that, a
daemon that lingers forever on a laptop is cost without benefit. Restart
is cheap because auto-start is in scope.

**Crash recovery.** A stale socket or pidfile (daemon killed, machine
rebooted) must not wedge the system. A client that finds a socket it
cannot connect to removes it and auto-starts. This mirrors the crash-state
reasoning from step 1's rotate design: every stale state has a defined
recovery, and no state requires manual repair.

---

## 4. Data flow

**Tool call from an agent:** agent → `conduit serve` (stdio) → UDS
request → daemon → execution manager → policy/credential/upstream →
result back over UDS → stdio → agent. The §9.2 credential boundary is
strengthened, not weakened: secrets now resolve inside the daemon and
never enter the `conduit serve` process at all.

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
| stale socket (no listener) | unlink, auto-start, retry |
| daemon start fails | surface the daemon's own startup error, not a generic "cannot connect" |
| daemon dies mid-request | client reports the request failed; never silently retries a non-idempotent call |
| two clients race to start | exactly one daemon; loser connects to winner |
| key resolution fails | unchanged from step 1 — daemon refuses to start, error is byte-identical to today's |
| db locked by `key rotate` | daemon refuses to start with "rotation in progress" |

The "never silently retries a non-idempotent call" row is load-bearing.
A tool call that reached the upstream before the daemon died must not be
replayed by a client that cannot know whether it ran. Retry is only safe
before the request is accepted.

Error messages follow the existing format (`[Module] Operation failed:
reason. Context: {...}`) and the §11 redaction rules — no secret material
in any daemon log line.

---

## 6. Alternative considered and rejected: the shared-store contract

Spec §17's parenthetical: *"or an explicitly safe shared-store
contract."* This would keep N processes opening the db directly and
formalize the sharing — WAL mode, documented lock discipline, a process
registry.

It is the smaller change, and it fails at the next step.

**Hot-reload (step 3) has no good answer.** "A source saved in the
console is visible without a restart" requires telling every process its
cache is stale. That means a notification channel between processes you
cannot enumerate — a table they poll, or a socket they all connect to.
Once that exists you have built most of a daemon while keeping the
consistency problem: N caches that can each be individually wrong.

**Rotate's gap survives.** True process detection needs a registry of
live processes. Adding a pidfile registry is daemon machinery without the
daemon.

**It does not fix stranded approvals.** Processes still die with their
MCP client, which §17 names as the disqualifying condition.

The shared-store contract is strictly more machinery to reach a strictly
worse end state. Rejected.

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

**Not invariant, still required:** socket file mode is 0600; daemon
startup failure messages stay byte-identical to today's; a mid-request
daemon death does not replay a non-idempotent call.

The concurrency tests need real processes, not mocks — step 1's LEARNINGS
recorded that `:memory:` libsql silently swaps databases under
`transaction()`, so file-backed temp dbs and genuinely spawned processes
are required. Each test must be verified to catch a real mutation before
being trusted.

---

## 8. Degrees of freedom for implementation

Per the tweakable-plans rule, marking where the implementer may improvise
versus stop and ask.

**May improvise:** wire format (JSON-RPC over the socket is the obvious
choice given the MCP SDK is already a dependency, but not mandated);
internal module layout within `packages/mcp`; the exact idle timeout
value; log line wording.

**Stop and ask:** any SQL schema change (none is anticipated — the
daemon changes who opens the db, not what is in it); any new runtime
dependency; moving `key rotate` behind the daemon; changing the §9.2
credential boundary's shape; anything that would pull step 3's control
API or step 4's §16 floor into this step.

---

## 9. Open items for review

1. Does `conduit-mcp --doctor` become a client, or keep direct read-only
   access as a diagnostic that works when the daemon is broken? The
   diagnostic argument for keeping it direct is strong — a doctor that
   requires a healthy daemon cannot diagnose a sick one. Leaning direct,
   read-only.
2. Idle timeout value. Proposed 15 minutes; no strong evidence either
   way, and it is trivially tunable.
3. Whether the daemon should refuse to start when `CONDUIT_DB` points at
   a custom path, mirroring rotate's refusal, or support one daemon per
   db path. Leaning: support custom paths, keyed by resolved db path, so
   the dogfood setup and tests are not special-cased.
