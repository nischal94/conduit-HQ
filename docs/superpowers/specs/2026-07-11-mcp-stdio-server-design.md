# /mcp server, stdio transport — design (2026-07-11)

Spec §17 build-order step 2: the walking skeleton's front door. A real
MCP client (Claude Desktop / Cursor) spawns `conduit-mcp` as a stdio
subprocess, sees the `execute` tool, and drives a real upstream call
through the existing §5.3 pipeline. This package adds **zero core
logic** — it is §12's "thin shells over the core" made literal, and
§4.1's consequence ("adding a new entry point requires zero changes to
tools, schemas, or policies") holds except for one deliberate SDK
change (M4, outcome persistence), which is a gap the surface exposed,
not surface logic leaking into the core.

**Revision 2 (2026-07-11):** amended after the multi-voice review
(autoplan CEO/Eng/DX phases; codex cross-model voice per phase +
independent Claude subagents). The review trail and per-finding
dispositions live in the session debrief; every amendment below is
marked *(rev 2)*. The §17 "Built" gate spans build steps 2+3: this
step proves the surface; the step-3 CLI (`conduit approvals`)
completes the human approval story.

## Context and constraints

- Everything below the surface already exists and is pinned green:
  `buildExecuteTool` (§6 definition), `createCatalogToolHost`, the
  §5.3 invoker pipeline, `createExecutionManager` (start/resume/get,
  atomic cross-process resume claim), `openSqliteStore`, normalizers.
  `e2e.smoke.test.ts` is the wiring recipe this package lifts.
- §17 MVP gate: a real MCP client connects, sees one `execute` tool,
  drives a real call through the §9.2/§9.3 boundary; then a converged
  edge-case pass on the running skeleton. Stdio first; streamable-HTTP
  is Phase 1.
- stdio discipline: the client owns stdin/stdout. **stdout carries
  protocol frames only; all logging goes to stderr.** Config reaches
  the process via env vars in the client's config file, not a
  terminal session.
- MCP `tools/call` is request/response, but a §5.5 pause can outlive
  any client timeout (72h TTL) — the pause must return immediately
  and the result must be retrievable later, possibly from a different
  process than the one that resumes.
- Audit pass (2026-07-11) verified every claim below against source;
  corrections from that pass are folded in and marked where
  load-bearing.

## Decisions

### M1 — Tool surface: `execute` + `check_execution`; resume is human-only

The client sees exactly two tools:

- **`execute`** — the existing `buildExecuteTool` definition, plus
  *(rev 2)* one optional input: `requestKey`, a caller-generated
  correlation key **persisted before the sandbox runs** (unique,
  nullable column). If the response is lost (client timeout/cancel),
  the agent can resolve the outcome by the key it chose — closing
  the orphaned-id dead-end and, more importantly, letting an agent
  reconcile an *unknown outcome before retrying a potentially
  destructive action*. Results are returned as JSON text content. A
  pause returns `{ status: "paused", executionId, pending: {
  toolName, reason, expiresAt }, message }` — *(rev 2)* `message`
  instructs the agent to **report the pending approval and
  `executionId` to the human and stop** (agents are not durable
  background workers; polling until a human approves burns turns),
  then call `check_execution` when the user returns after approving
  out-of-band.
- **`check_execution`** — input `{ executionId }` or
  `{ requestKey }` *(rev 2)*. Full state contract *(rev 2)*:
  - `running` → `{ status: "running" }`. The tool description notes
    that under the single-process MVP a crashed host also reads as
    `running` (manager design §7/§8 posture) — an operator caveat,
    not a bug.
  - `paused` → status + `pending`. If `now > pending.expiresAt`, the
    tool reports `expired` **computed read-only** — no store write;
    the durable lazy-expiry-on-resume transition (manager D8) is
    unchanged. Pinned by test.
  - `completed` → status + `result` — the field is **required** in
    the payload. *(rev 2)* `undefined` is normalized to `null`
    **before** persistence and in both `execute` and
    `check_execution` responses (`JSON.stringify` would otherwise
    silently omit the key); a `null` result is legitimate and the
    description says so.
  - `failed` → status + `error` — **always present** (M4's synthetic
    persist-error guarantees it).
  - `expired` → status + a message telling the agent the approval
    TTL lapsed and it may re-issue `execute` to retry.
  - Unknown id → structured `{ status: "not_found" }` tool *result*
    (distinct from `expired`; an agent retrying a mistyped id must
    not look like a broken server).
  - `conflict` is a resume-time ephemeral outcome, never a persisted
    status — it cannot appear here.
- **`resume`/approve is deliberately NOT an MCP tool.** The §10.2
  approval seam is human-only; an agent must never approve its own
  paused call. Pinned by test (M9). Rejected: execute-only surface
  (agent can never retrieve a post-approval result — dead-end UX);
  blocking `tools/call` until approval (fights every client timeout;
  72h TTL makes it unreal).

The §4.2 "one tool" story becomes "one tool + a status check": the
execute definition's ≤1,044-token invariant is untouched —
*(rev 2)* which requires **capping the connection listing**
(`buildExecuteTool` concatenates every connection; unbounded
connections would blow the pin): the description lists the first N
connections plus "…and K more — search the catalog", pinned by a
large-connection-count test. `check_execution` gets its own pin
(≤256 tokens). *(rev 2)* The poll
design is **skeleton-scoped**: MCP-native completion signaling
(progress notifications / task semantics) is the recorded Phase-1
successor — deferred, not forgotten.

### M2 — Protocol: official `@modelcontextprotocol/sdk`, pinned ^1.x

Conformance against the real clients is the acceptance test, and the
official SDK is what those clients are tested against. *(rev 2)*
**Exact pin, not a caret**: `1.29.0` (a caret range admits untested
minors on fresh installs; upgrades happen by deliberate PR). The v2
packages (`@modelcontextprotocol/server` et al.) are `2.0.0-alpha` —
not production material, and `minimumReleaseAge` applies regardless.
SDK usage stays isolated to the server module (an adapter by
construction — the v2 migration surface is one file). Supply-chain
rule: the user runs the install in their own terminal.

Use the **low-level `Server` API** —
`setRequestHandler(ListToolsRequestSchema | CallToolRequestSchema)` —
not `McpServer.registerTool`: our tool definitions are already native
JSON Schema, and the execute description is dynamic (M6). Rejected:
hand-rolled JSON-RPC over stdio (we own conformance + every future
protocol revision; a framing bug presents as "Claude Desktop silently
ignores the server").

*(rev 2)* Consequences of the low-level choice, made explicit:
- Construct `Server` with capabilities `{ tools: { listChanged:
  false } }`.
- **The low-level API does not validate `tools/call` arguments** —
  the handler owns validation and the `InvalidParams` mapping,
  pinned by test.
- Initialization / protocol-version negotiation is SDK-managed;
  client cancellation surfaces as `extra.signal`. **A client cancel
  does not kill the durable execution** — it settles normally and
  remains retrievable via `check_execution` (pairs with the
  orphaned-id consideration in M8).

### M3 — Home: new `packages/mcp` (`@conduithq/mcp`)

A library — `createConduitMcpServer(deps)` — plus one bin,
`conduit-mcp` (the stdio entry, with `--version`/`--help` and
*(rev 2)* `--doctor`: runs M8's enumerated startup checks — env
presence, key decodes, DB opens, source count — as a command with
actionable exit codes, so a developer never debugs config through a
GUI-client restart loop; it is the troubleshooting doc's first step). Depends
on `@conduithq/sdk` (workspace) + `@modelcontextprotocol/sdk`. The
CLI (step 3) imports the library for `conduit serve`; the Phase-1
HTTP host mounts the same server over a different transport. Keeps
the MCP dependency out of the core SDK ("direct dependency count
stays deliberately small"). Rejected: starting `packages/cli` early
(a "cli" package that isn't a CLI, exporting server logic); an sdk
subpath export (drags the MCP dep into core). §20's monorepo list
gains the package — recorded in §18.

*(rev 2)* Trajectory watch-item: the package stays a **narrow
transport adapter**. If composition/lifecycle/config ownership grows,
that logic moves to a dedicated host package when the Phase-1 daemon
lands — do not let `packages/mcp` become a de facto host runtime.

### M4 — The one SDK change: persist the execution outcome

`Execution` gains persisted settle-state: `result?: unknown` /
`error?: SandboxError` (two nullable TEXT/JSON columns via the
established `PRAGMA table_info` + `ALTER TABLE` pattern), plus
*(rev 2)* the nullable unique `request_key` column backing M1's
correlation key (written at `start`, before the sandbox runs).
`check_execution` is then a pure store read, correct regardless of
which process resumed (`claimForResume` is an atomic CAS — the §5.5
"a different worker can pick it up" property, verified at
`store/sqlite.ts` claim site).

*(rev 2)* **Every terminal transition is outcome-aware**, not just
`finish()` — this was the review's highest-confidence finding (both
Eng voices, confidence 9-10):

- `finish()` persists `result` (completed) or `error` (failed).
- `persistOrFinalizeFailed`'s fallback row — which spreads the
  pre-settle snapshot today — carries a **synthetic
  `ConduitPersistError`** (bounded, serialized cause) so a transient
  primary-write fault can never persist `failed` with no payload.
- `failClaimedResume` (the stranded-running guard) records its reason
  as the error payload, as it already does textually.
- `expired` carries neither result nor error, by design.
- Invariant: a stored `failed` row **always explains itself**;
  `completed` → result; `expired` → neither. Tests fault the first
  `put` on each path to pin the fallbacks.

**Posture (audit correction C1, refined rev 2):** the persisted
result inherits exactly the replay journal's posture — raw at this
layer. The manager-level `scrubCredential` is structurally moot today
(both drive paths pass `secret: undefined`); the load-bearing
protections are §9.2's request-scoped, never-persisted credentials
plus the built-in MCP upstream caller's echo-sanitizer (a documented
best-effort tripwire, category (b) under the convergence rule), which
runs **before** results reach the journal or these columns. A new
invariant test pins that: a hostile upstream that echoes the fixture
credential on success and failure, followed by a post-completion
raw-table scan over the outcome columns. No new at-rest exposure
class: the replay journal already durably holds raw upstream results
(D7). The §11 decision covered the *audit* surface; this is the
*delivery* surface.

*(rev 2)* Size and retention: the persisted result is bounded by the
§16 sandbox output cap (1 MB default) and stored as JSON text.
**Retention/GC of settled outcomes is explicitly deferred** — recorded
as a §18 entry alongside the existing trace-retention deferral, so
the accumulation is a visible decision, not silence.

Rejected: durable-decision-plus-resume-on-poll (side effects fire at
poll time, maybe never; splits §15's approve semantics); no delivery
(gate demo ends with the agent unable to finish its own story).

### M5 — Multi-process store hygiene: WAL, busy_timeout, and a serialized migration

`openSqliteStore` currently sets no pragmas. The skeleton makes
multi-process access real (stdio server per client + step-3 CLI on
one file), so the same SDK change adds `PRAGMA journal_mode=WAL` and
`PRAGMA busy_timeout` (5000 ms) at the `openSqliteStore` choke point —
every consumer benefits; no per-surface config. *(rev 2)*
`busy_timeout` is set **before** the first schema statement so the
migration itself benefits.

*(rev 2)* **The migration ladder must be concurrency-safe**: two
clients configured (Claude Desktop + Cursor) and launched at login
spawn two servers whose first boot races the `PRAGMA table_info` →
`ALTER TABLE` check — the loser dies with "duplicate column name".
Fix: serialize schema setup (re-check inside a `BEGIN IMMEDIATE`
critical section, or treat duplicate-column as idempotent success —
either makes the ladder idempotent *across processes*, not just
sequentially). Pinned by a concurrent-open test against a pre-M4
on-disk database. (No-ops harmlessly on `:memory:` test databases.)

### M6 — Composition and freshness

`createConduitMcpServer(deps)` wires the smoke-test recipe:
`openSqliteStore` → hydrate `InMemoryCatalog` from `store.tools` →
`createToolInvoker` factory (per-execution, decisions seam on resume)
→ `QuickJSSandbox` → `createExecutionManager`.

*(rev 2)* Freshness mechanics made explicit (the original "fresh
snapshot at start" silently assumed an async `makeToolHost`, which
doesn't exist — `ExecutionManagerDeps.makeToolHost` is sync): the
handler **awaits catalog hydration, then composes a fresh
`ExecutionManager` per `tools/call`** — the manager is cheap closure
composition, and the resume path (potentially another process)
rehydrates anyway. `tools/list` likewise rebuilds the execute
description from the store on every call. A connection or source
added by another process appears on the client's next list/search
without a server restart. *(rev 2)* Honest freshness claim: clients
cache their tool list, so the *description's* connection listing can
be stale for a session — but the **sandbox catalog is hydrated fresh
per call**, so an un-advertised new connection is still fully usable
via `tools.search`; the description says exactly that ("connection
list as of your client's last refresh; search the catalog for
current tools"). The client-cache caveat is documented onboarding UX
(§14). `listChanged: false`.

Connection labels (audit C3): `Connection` has no label field — the
listing derives the label from the integration's namespace; real
labels are a step-3 concern, not a schema change now. *(rev 2,
final convergence pass)* Connection addressing is governed by the
locked §18 v1 decision: **single connection per namespace** — a
namespace resolves to its one configured connection, multiples fail
closed until per-call addressing ships (the resolver seam accepts a
`prefix` parameter from day one, unused in v1). The description's
listing is therefore one line per namespace by construction, and
every advertised connection is selectable.

Concurrency: QuickJS creates a fresh context per `execute`
(verified), so concurrent `tools/call`s are safe; SQLite serializes
writes (M5). *(rev 2)* Pinned by tests: parallel `tools/call`s on one
connection; concurrent starts against one store.

### M7 — Process & config model

One standalone process per client, spawned by the client, opening the
shared SQLite file directly — no daemon until Phase 1. *(rev 2)* Key
custody, stated: the stdio process **is** the §9.2 host — any host
form holds the master key; the Phase-1 daemon centralizes custody so
the key leaves per-client configs then. The onboarding snippet tells
users to `chmod 600` the client config and creates `~/.conduit` with
`0700` (it holds encrypted secrets).

Env surface (set in the client's config JSON):

- `CONDUIT_DB` — database path; default `~/.conduit/conduit.db`
  (created on first run).
- `CONDUIT_MASTER_KEY` — the SecretBox key. *(rev 2)* Encoding
  pinned: **base64 of 32 bytes**; the §14 snippet includes a
  copy-paste generation one-liner right above the config block.
- `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` *(rev 2: renamed from the
  audit's neutral name; the UNSAFE is the point)* — default **off**
  (§9.3 fail-closed stands); set to `1` for the loopback-upstream
  dev/demo case, which otherwise cannot run at all. Enabling it
  prints a loud stderr warning at startup. Dev/demo-only framing in
  docs; the Phase-1 shape is per-connection egress policy.
- `CONDUIT_APPROVAL_TTL` — already read by the manager; documented
  **with units (milliseconds)**.

*(rev 2)* Demo seeding is a **named deliverable**, not a gesture:
`scripts/seed-demo.ts` reads the same `CONDUIT_DB`/
`CONDUIT_MASTER_KEY` env vars as the server, seeds a source +
connection + secret with **allow-only policies** (so gate-one cannot
strand on a pause the step-3 CLI isn't there to approve), and prints
a ready-to-paste client-config snippet using the honest pre-publish
command (`node <abs path>/packages/mcp/dist/bin.js` — nothing is on
npm yet). A sibling interim approve/resume script is named alongside
it for deliberately exercising the pause path (ring-2 tests and
gate-two use it; the pause `message` gets updated to name the real
CLI command when step 3 lands). On an empty catalog the server logs
one stderr hint ("0 sources in catalog — seed with scripts/
seed-demo.ts").

The real `add-mcp`/key-management flow is step 3.

### M8 — Errors & known considerations

- Malformed `tools/call` arguments → MCP protocol error
  (`InvalidParams`) — the handler validates (M2). Unknown tool name →
  protocol error.
- Sandbox/execution failures → structured `failed` payload in the
  tool *result* (agent-visible data, not a protocol fault). An
  unexpected manager/infra throw → MCP internal error with a
  correlation id logged to stderr. *(rev 2)* All agent-visible error
  payloads share one envelope — `{ code, message, hint?, retryable,
  executionId? }` — so models react to a contract, not prose; a
  formal declared `outputSchema` is deferred with E5 to Phase 1.
- Store-open failure → exit nonzero. *(rev 2)* Startup failures are
  **enumerated with per-cause messages** in the repo's error format:
  missing `CONDUIT_MASTER_KEY` (message includes the generation
  one-liner), malformed key (length/encoding), unwritable
  `CONDUIT_DB` path. A *wrong* (well-formed, non-matching) key fails
  at first secret decrypt — call time, not startup; the
  troubleshooting doc says so.
- *(rev 2)* Egress-blocked failure: the agent-visible error names the
  §9.3 policy and that an operator-level override exists, pointing at
  the server log/troubleshooting doc — it does **not** spell the env
  var (an agent should not be taught to ask its human to flip a
  security control); the stderr line and the docs name
  `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` exactly. [Reviewer tension
  noted: one DX voice wanted the env var in the error itself; this
  middle ground is the recorded resolution.]
- Known (audit A2, refined rev 2): MCP clients default to a ~60 s
  request timeout and the sandbox's default wall-clock cap is also
  60 s. A near-budget execution can race the client's timeout — and
  if the client gives up, **the response carrying `executionId` is
  never delivered**, so the handle is orphaned (the execution still
  settles and persists; only the id is lost to the agent). Documented
  as the known dead-end; troubleshooting row: "call timed out but may
  have finished — `check_execution` retrieves it if you have the id."
  Phase-1 remedy: progress notifications (and, if needed, a
  list-executions-shaped recovery surface).
- *(rev 2)* startup/stdout: the bin is a plain Node entrypoint that
  redirects `console.*` to stderr (defense-in-depth for the
  stdout-purity invariant).

### M9 — Testing (three rings) + invariants

1. **Unit**: handlers over `InMemoryTransport.createLinkedPair()` —
   list/call shapes, pause payload, every `check_execution` state
   (running / paused / read-only-expired / completed / completed-null
   / failed / not_found), argument-validation → `InvalidParams`,
   unknown tool. *(rev 2)* Correlation key: persisted before the
   sandbox runs (a crashing execution is still resolvable by key),
   `check_execution` resolves by key, duplicate `requestKey` →
   structured conflict-shaped error, not a second execution.
2. **Integration (conformance)**: spawn the compiled bin; drive it
   with the SDK's `Client` + `StdioClientTransport` against a
   loopback upstream MCP server (the smoke test's fixture pattern):
   §6 4-step workflow end-to-end; pause → approve **from a separate
   child process** → poll sees the persisted result; **stdout purity**
   (with logging active, every stdout byte parses as a JSON-RPC
   frame); a slow call under an explicit client timeout — the server
   survives and later polling observes the settled row; parallel
   `tools/call`s on one connection.
3. **Manual acceptance (the §17 gate's first half)**: Claude Desktop /
   Cursor config documented; a real client drives a real call. The
   converged edge-case pass (gate two) happens on the running
   skeleton after steps 3–4 per spec. *(rev 2)* Two named gate-two
   rows added: "agent actually follows the poll instruction in each
   named client" and "near-budget execution vs. client timeout".

*(rev 2)* SDK-side tests added by the review: outcome persistence on
every terminal path with the first `put` faulted (M4 fallbacks);
concurrent-open migration race on a pre-M4 database (M5); WAL +
busy_timeout active after open; legacy-DB open + `check_execution`
on a pre-M4 completed row (NULL result accepted); near-cap (§16)
result survives persist + re-read; the credential-echo upstream +
post-completion raw-table scan (M4 posture); e2e smoke §9.2 raw-dump
assertion re-run with the new columns present.

INVARIANTS.md gains rows pinned by package tests: the human-only
approval seam (no resume tool on the MCP surface — M1), stdout
protocol purity (M8/M9 ring 2), the `check_execution` token pin
(M1), and outcome persistence at settle on every terminal path (M4).

## Spec/doc obligations (same PR)

- §18 decision entries: the two-tool surface wording ("one tool + a
  status check"), outcome persistence (M4) **including the explicit
  retention deferral**, `packages/mcp` in the §20 monorepo list, the
  `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` opt-in (M7), and *(rev 2)*
  "poll is the skeleton mechanism; MCP-native completion signaling is
  the Phase-1 successor".
- §14 onboarding: the stdio config snippet (honest pre-publish
  command), the master-key generation one-liner + encoding, seed and
  interim-approve script invocations, the env-var reference table
  **with units**, the restart caveat, and a troubleshooting block
  (tools don't appear → restart + client MCP log path; egress
  blocked; wrong key fails at call time; timeout race →
  `check_execution` / `requestKey`; *(rev 2)* "the database is one
  file — copy it before upgrading"; upstream compatibility note:
  v1 calls MCP-over-HTTP upstreams only, per the §18 upstream-scope
  decision).
- *(rev 2)* `packages/mcp` README pointing at all of the above.

## Out of scope

Streamable-HTTP transport (Phase 1) · the `conduit` CLI (step 3) ·
the §4.2 token demo (step 4) · FTS5, web console, Trace viewer ·
`listChanged` notifications · progress notifications /
protocol-native completion signaling (Phase 1; recorded successor to
the poll design) · **retention/GC of settled execution outcomes**
(deferred by recorded §18 decision, alongside trace retention) ·
**npm publishing of `@conduithq/mcp`** (the skeleton runs from the
repo; the publish pipeline is a launch-phase deliverable) ·
`check_execution` read-authorization (single-user local MVP; the
authz seam is the server library — an additive owner column mounts
there in Phase 4) · multi-client hardening beyond M5 · Connection
labels beyond the namespace fallback · crash recovery of `running`
rows (manager design §7 deferral; surfaced honestly in the
`check_execution` description) · *(rev 2)* a migration
ledger/checksum system (the project's one-time-by-construction
migration pattern is the recorded posture; revisit if migrations
multiply) · *(rev 2)* declared `outputSchema`/`structuredContent`
(Phase 1, with the error envelope as the stable v1 contract) ·
*(rev 2)* `add-mcp`-grade source onboarding (step 3; this slice is a
development checkpoint by §17 definition, and its docs say so).
