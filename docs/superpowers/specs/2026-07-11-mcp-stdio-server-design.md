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

- **`execute`** — the existing `buildExecuteTool` definition,
  verbatim. Results are returned as JSON text content. A pause
  returns `{ status: "paused", executionId, pending: { toolName,
  reason, expiresAt }, message }` — `message` tells the agent a human
  must approve out-of-band and to poll `check_execution`.
- **`check_execution`** — input `{ executionId }`; returns
  `{ status }` plus `pending` while paused, `result` when completed,
  `error` when failed. An `expired` execution reports status only
  (its settle carries neither result nor error — M4).

**`resume`/approve is deliberately NOT an MCP tool.** The §10.2
approval seam is human-only; an agent must never approve its own
paused call. Pinned by test (M9). Rejected: execute-only surface
(agent can never retrieve a post-approval result — dead-end UX);
blocking `tools/call` until approval (fights every client timeout;
72h TTL makes it unreal).

The §4.2 "one tool" story becomes "one tool + a status check": the
execute definition's ≤1,044-token invariant is untouched;
`check_execution` gets its own pin (≤256 tokens).

### M2 — Protocol: official `@modelcontextprotocol/sdk`, pinned ^1.x

Conformance against the real clients is the acceptance test, and the
official SDK is what those clients are tested against. **Pin the
stable v1 line** (`^1.29.0` at design time): the v2 packages
(`@modelcontextprotocol/server` et al.) are `2.0.0-alpha` —
not production material, and `minimumReleaseAge` applies regardless.
Supply-chain rule: the user runs the install in their own terminal.

Use the **low-level `Server` API** —
`setRequestHandler(ListToolsRequestSchema | CallToolRequestSchema)` —
not `McpServer.registerTool`: our tool definitions are already native
JSON Schema, and the execute description is dynamic (M6). Rejected:
hand-rolled JSON-RPC over stdio (we own conformance + every future
protocol revision; a framing bug presents as "Claude Desktop silently
ignores the server").

### M3 — Home: new `packages/mcp` (`@conduithq/mcp`)

A library — `createConduitMcpServer(deps)` — plus one bin,
`conduit-mcp` (the stdio entry). Depends on `@conduithq/sdk`
(workspace) + `@modelcontextprotocol/sdk`. The CLI (step 3) imports
the library for `conduit serve`; the Phase-1 HTTP host mounts the same
server over a different transport. Keeps the MCP dependency out of the
core SDK ("direct dependency count stays deliberately small").
Rejected: starting `packages/cli` early (a "cli" package that isn't a
CLI, exporting server logic); an sdk subpath export (drags the MCP dep
into core). §20's monorepo list gains the package — recorded in §18.

### M4 — The one SDK change: persist the execution outcome

`Execution` gains settle-state: `result?: unknown` /
`error?: SandboxError`, written by the manager's `finish()` — the
single settle choke point (verified; `expired` settles separately and
carries neither). SQLite: two nullable TEXT (JSON) columns via the
established `PRAGMA table_info` + `ALTER TABLE` pattern.
`check_execution` is then a pure store read, correct regardless of
which process resumed (`claimForResume` is an atomic CAS — the §5.5
"a different worker can pick it up" property, verified at
`store/sqlite.ts` claim site).

**Posture (audit correction C1):** the persisted result inherits
exactly the replay journal's posture — raw, credential-scrubbed only
in the best-effort sense that applies when a secret is threaded to the
manager (today it never is: both drive paths pass
`secret: undefined`; `scrub.ts` is explicit that the structural
guarantee is §9.2's request-scoped, never-persisted credentials, not
the scan). No new at-rest exposure class: the replay journal already
durably holds raw upstream results (D7). The §11 decision covered the
*audit* surface; this is the *delivery* surface. Edge: an `undefined`
completion value serializes to NULL — `check_execution` reports
completed with `result: null`.

Rejected: durable-decision-plus-resume-on-poll (side effects fire at
poll time, maybe never; splits §15's approve semantics); no delivery
(gate demo ends with the agent unable to finish its own story).

### M5 — Multi-process store hygiene: WAL + busy_timeout (audit C2)

`openSqliteStore` currently sets no pragmas. The skeleton makes
multi-process access real (stdio server + step-3 CLI on one file), so
the same SDK change adds `PRAGMA journal_mode=WAL` and
`PRAGMA busy_timeout` (5000ms) at the `openSqliteStore` choke point —
every consumer benefits; no per-surface config. (No-ops harmlessly on
`:memory:` test databases.)

### M6 — Composition and freshness

`createConduitMcpServer(deps)` wires the smoke-test recipe:
`openSqliteStore` → hydrate `InMemoryCatalog` from `store.tools` →
`createToolInvoker` factory (per-execution, decisions seam on resume)
→ `QuickJSSandbox` → `createExecutionManager`.

Freshness: the **execute description and the catalog are rebuilt from
the store on every `tools/list`, and each `execute` call hydrates a
fresh catalog snapshot at start** (trivial at demo scale) — a
connection or source added by another process appears on the client's
next list/search without a server restart. This dissolves most of the §14 reload caveat for our
static two-tool surface; what remains (the client's own caching) is
documented onboarding UX. `listChanged: false` for the skeleton.
Connection labels (audit C3): `Connection` has no label field — the
listing derives the label from the integration's namespace; real
labels are a step-3 concern, not a schema change now.

Concurrency: QuickJS creates a fresh context per `execute` (verified),
so concurrent `tools/call`s are safe; SQLite serializes writes (M5).

### M7 — Process & config model

One standalone process per client, spawned by the client, opening the
shared SQLite file directly — no daemon until Phase 1. Env surface
(set in the client's config JSON):

- `CONDUIT_DB` — database path; default `~/.conduit/conduit.db`
  (created on first run).
- `CONDUIT_MASTER_KEY` — the SecretBox key source, same contract the
  store already requires.
- `CONDUIT_ALLOW_PRIVATE_EGRESS` (audit A1) — default **off** (§9.3
  fail-closed stands); set to `1` for the loopback-upstream dev/demo
  case, which otherwise cannot run at all. A deliberate, visible,
  documented opt-in — the secure default does not move.
- `CONDUIT_APPROVAL_TTL` — already read by the manager; documented.

Demo seeding (a source + connection + secret) is a script/test
fixture; the real `add-mcp` flow is step 3.

### M8 — Errors & known considerations

- Malformed `tools/call` arguments → MCP protocol error
  (InvalidParams). Unknown tool name → protocol error.
- Sandbox/execution failures → structured `failed` payload in the
  tool *result* (agent-visible data, not a protocol fault).
- Store-open failure → exit nonzero with one stderr line (the client
  surfaces "server failed to start").
- Known (audit A2): MCP clients default to a ~60s request timeout and
  the sandbox's default wall-clock cap is also 60s — a near-budget
  execution can race the client's timeout. Documented; not a code
  change (operators can lower the sandbox cap; Phase 1 can add
  progress notifications).

### M9 — Testing (three rings) + invariants

1. **Unit**: handlers over `InMemoryTransport.createLinkedPair()` —
   list/call shapes, pause payload, check_execution states, protocol
   errors.
2. **Integration (conformance)**: spawn the real bin; drive it with
   the SDK's `Client` + `StdioClientTransport` against a loopback
   upstream MCP server (the smoke test's fixture pattern): §6
   4-step workflow end-to-end, pause → out-of-band
   `manager.resume()` (simulating the CLI in another process) → poll
   `check_execution` sees the persisted result.
3. **Manual acceptance (the §17 gate's first half)**: Claude Desktop /
   Cursor config documented; a real client drives a real call. The
   converged edge-case pass (gate two) happens on the running
   skeleton after steps 3–4 per spec.

INVARIANTS.md gains rows pinned by package tests: the human-only
approval seam (no resume tool on the MCP surface — M1), stdout
protocol purity (no non-protocol bytes on stdout — M6), the
`check_execution` token pin (M1), and outcome persistence at settle
(M4).

## Spec/doc obligations (same PR)

- §18 decision entries: the two-tool surface wording ("one tool + a
  status check"), outcome persistence (M4), `packages/mcp` in the §20
  monorepo list, the egress env opt-in (M7). HTML edited first,
  `html2md.py` rerun same turn.
- §14 onboarding: the stdio config snippet (env vars, restart
  caveat).

## Out of scope

Streamable-HTTP transport (Phase 1) · the `conduit` CLI (step 3) ·
the §4.2 token demo (step 4) · FTS5, web console, Trace viewer ·
`listChanged` notifications · multi-client hardening beyond M5 ·
Connection labels beyond the namespace fallback.
