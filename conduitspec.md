# Conduit — Technical Specification (v0.1)

**Product:** Conduit — the open-source integration layer for AI agents.
**Domain:** useconduithq.com · **npm scope:** `@conduithq/*` · **CLI binary:** `conduit`
**License:** Apache-2.0 (decided 2026-08-03, §18; open-core — hosted Cloud is the commercial layer)
**Status:** For review.

---

## 1. Overview

### 1.1 One-line definition

Conduit is the governed execution authority for AI agents: controlled access to real
tools — with credentials, policy, approvals, network controls, and execution evidence held
outside model-controlled execution — shared across every agent you use. Configure each
integration once (MCP servers today; OpenAPI is normalized but not yet callable; GraphQL on
the roadmap) with
authentication and per-tool policies; agents reach the same governed catalog through
Conduit's sandboxed Code Mode today — direct tool calls and discovery projections ship with
R1 (roadmap).

### 1.2 Thesis

> Your agent should be able to reach your company's resources in a way that isn't scary.
> Most setups force a choice between **locked-down-and-useless** or **wide-open-and-risky**.
> Conduit dissolves that dichotomy: once a tool is in **one shape** (a name + two schemas)
> and every call flows through **one gateway**, the **same guardrails apply everywhere**.
> **The whole idea: make the safe path the easy path.**

### 1.3 What Conduit adds beyond the prior art

1. **Observability / Trace shipped as first-class** (not "coming soon"): every run and tool
call is recorded, inspectable, and auditable after the fact, on day one.
2. **Input-aware policy engine**: beyond Allow / Require-approval / Block per tool, policies
can branch on the *actual argument values* of a call (e.g., auto-approve `refund` under
$50, require approval at or above; allow `sendEmail` only to internal domains).

Everything else builds on the same authority pipeline: one place where a call's
principal, capability scope, policy, credential, approval, and trace are decided — whatever
surface the call arrives through.

---

## 2. Goals & Non-Goals

### 2.1 Goals

- A single MCP endpoint in front of all integrations; connect once, every agent gets the
same catalog with shared auth and policies.
- Normalize **MCP / OpenAPI / GraphQL / custom JS** tools into one uniform shape.
- **Progressive disclosure**: show the model a single `execute` tool; load a tool's schema
only when code actually calls it, so the prompt never balloons.
- **Code-mode execution**: the model writes TypeScript that runs in an isolated sandbox.
- **Credentials never reach the agent or model.**
- **Per-tool policies** with spec-derived defaults; auto-run safe, pull a human in for the rest.
- **Projections over one authority pipeline**: Conduit Code Mode today; direct governed
tools and discovery ship with R1 (roadmap). Every projection crosses the same principal →
capability scope → policy → credential → approval-when-required → invocation → redaction +
trace pipeline.
- **Demand-pulled, deliberately not building now**: desktop app, hosted Cloud, self-host
bundles, broad console — each returns when customer demand pulls it (§18).
- "**Same code paths, different deployment.**" No behavioral fork between local and cloud.

### 2.2 Non-Goals (v1)

- Not a general agent framework / orchestrator (it's the integration layer beneath one).
- Not a model provider or prompt framework.
- Not a replacement for the upstream services — it proxies them.
- No multi-tenant SaaS beyond what Cloud requires (self-host is single-tenant).

---

## 3. Terminology & Data Model

The whole product rests on a small, exact vocabulary.

- **Source** — a description of available tools: an MCP server URL, an OpenAPI spec, or a
GraphQL endpoint (+ custom JS plugin). The raw input to ingestion.
- **Integration** — something Conduit connects to, *defined by* a Source. It describes the
**catalog of tools**. On its own it is **not** live or authenticated.
- **Connection** — a **configured instance** of an Integration. One Integration may have
**many** Connections (e.g., the same API authenticated for two accounts). A Connection
**does not have to be authenticated** (public APIs / public MCP servers need no creds).
- **Tool** — one callable operation in the catalog, normalized to **{ name, inputSchema,
outputSchema, riskClass, source-semantics }**. Addressed via a **namespace** (e.g.
`github.issues.create`).
- **Policy** — per-tool control: **Allow / Require approval / Block**, seeded from a
spec-derived default, tunable anytime, extended with **input-aware rules** (§10).
- **Execution** — one invocation of the `execute` tool: model-written code running in the
sandbox, producing tool calls. Executions can **pause** (for auth or approval) and
**resume** by id (`exec_...`).
- **Connection prefix** — addressing scheme `service.<org-slug>.<env>`, where
`<org-slug>` is the org slug (single org per instance; `CONDUIT_ORG_SLUG`, §13) and
`<env>` selects the account/environment. Examples below use `org` as an illustrative slug
(e.g. `github.org.main` = Production GitHub).

**Relational shape:**

```
Source ──defines──> Integration ──has many──> Connection(s)
                         │
                         └──contains──> Tool(s) ──governed by──> Policy
Execution ──makes──> Tool calls ──recorded as──> Trace events
```

---

## 4. Core Concepts (the two pillars)

### 4.1 One tool shape

Wiring tools to agents is fiddly, per-client, and easy to get wrong. Conduit makes every
tool, from any protocol, look the **same**: **one name, one input schema, one output
schema**, so any agent can call any of them the same way. MCP, OpenAPI, GraphQL, or a
custom integration all become `{ name, inputSchema, outputSchema }` under the hood.

**Consequence:** because tools share one shape, the **calling surface is interchangeable** —
MCP clients, the CLI, and a drop-in SDK client are all clients of the same core; adding a
new entry point requires **zero** changes to tools, schemas, or policies.

### 4.2 Progressive disclosure

Connect everything and the Code Mode projection still shows the model a **single tool**
(`execute`). It **searches the catalog** and loads a tool's schema **only when the code
actually calls it**, so the prompt never balloons.

**Benchmark:** a representative catalog of ~1,600 tools across GitHub/Stripe/Jira/Sentry
costs ~278,800 tokens if injected directly, vs. ~1,044 tokens through the Code Mode surface.
Context reduction is a measured benefit of this projection, not the product's identity.

---

## 5. Architecture

### 5.1 Topology — MCP Proxy

Conduit is **one MCP endpoint in front of all integrations.** Agents connect *in* (speak
MCP to Conduit); Conduit connects *out* to integrations and **re-exposes them as one
catalog.** Every tool call passes through the proxy, **which is where auth and policy live.**

```
   Claude Code ┐                          ┌─ Sentry  (OpenAPI)
   Cursor      ┤                          ├─ GitHub  (GraphQL)
   Codex       ┤──MCP──> [ CONDUIT ] ──out─┼─ Linear  (MCP)
   ChatGPT     ┤        one endpoint       ├─ Stripe  (OpenAPI)
   your SDK    ┘        one catalog        └─ custom JS plugins
```

### 5.2 Components (single process, single binary)

- **Ingestion / normalizer** — turns a Source into an Integration + normalized Tools.
- **Catalog** — searchable index of all Tools (powers progressive disclosure).
- **Sandbox** — **QuickJS** runtime that executes model-written TS/JS. Small, embeddable,
isolatable; portable across container *and* Cloudflare Worker.
- **Credential resolver** — host-side; binds `connectionRef → secret` and attaches it to the
outbound request **outside** the sandbox.
- **Policy engine** — evaluates riskClass + input-aware rules per call; allow / pause / block.
- **Execution manager** — runs executions; handles pause/resume (`exec_...`).
- **Trace store** — records every run + tool call for audit (§11).
- **Auth** — pluggable: built-in session auth (better-auth) *or* delegated (Cloudflare Access / JWT).
- **Storage** — pluggable: **libSQL/SQLite** single file (single-node) or **D1** (Worker).
- **Web console** — Integrations workspace, connections, policies, Connect card, Trace viewer.
- **Surfaces** — MCP server (`/mcp`), CLI, desktop shell, programmatic SDK; thin shells over the core.

### 5.3 Per-call pipeline (server-side, the heart)

For each tool call emitted by sandboxed code:

1. **Resolve** the target Integration/Connection (by namespace + connection prefix).
2. **Enforce policy** (riskClass + input-aware rules) → allow / pause-for-approval / block.
3. **Attach credentials** to the upstream request, **host-side, outside the sandbox.**
4. **Call upstream**, capture result + latency.
5. **Record** a Trace event.
6. **Return** the result to the sandbox.

The agent only ever talks to Conduit; **credentials never reach it.**

### 5.4 Unifying code-mode and MCP-proxy views

Both framings are simultaneously true: the **single MCP tool** the client sees is `execute`;
the model's TypeScript runs in the sandbox, and **that code's tool calls** are what traverse
the §5.3 pipeline. "Code-mode MCP" = (one MCP tool) + (a sandbox that runs code that calls
the catalog). Spec consumers should hold both views at once.

### 5.5 Pause/resume — deterministic replay (decided)

Executions pause only at **tool-call boundaries** (a policy approval or an auth prompt).
The mechanism is **deterministic replay**, not VM snapshotting: every finalized tool call's
result is **journaled** — into a dedicated **replay-journal projection**, distinct from
the audit Trace (§11). On resume, the execution's
code re-runs from the top; journaled calls return their **memoized results** without
re-hitting upstream; the execution proceeds live from the first un-journaled call. A
`require_approval` pause writes nothing to the replay journal (it is recorded on the
Execution's pending approval), so the journal is a clean prefix by construction; the audit Trace still
records the refusal. **The same durable-data model powers both the audit differentiator and
pause/resume correctness.**

- **Survives restarts:** a paused Execution is pure data (code + journal); the daemon can
restart — or a different worker can pick it up — and resume it.
- **Determinism contract:** sandbox code must be deterministic between tool calls. Conduit
enforces the boundary cases: `Date.now()` and `Math.random()` values are recorded on
first run and replayed verbatim on resume.
- **Approval TTL:** a pending approval expires after a configurable window
(`CONDUIT_APPROVAL_TTL`, default 72h); the Execution then fails with a policy-timeout
error, recorded in Trace.
- **One decision per pending call (2026-09-06):** a pending approval is identified by
the paused call's `callId`. A resume names that call, and the paused→running claim
succeeds only while the Execution is paused on it — a decision naming a call the Execution is no
longer paused on (already decided, or paused again on a later call) is refused as a conflict,
never applied to another call.

---

## 6. The `execute` tool & code-mode workflow

**The only tool the client sees:** `execute` —

> "Execute TypeScript in a sandboxed runtime with access to configured API tools."

**The 4-step workflow the model uses:**

```ts
// 1. discover by intent
const { items } = await tools.search({ query });
// 2. pick a path
const path = items[0]?.path;
// 3. load just that tool's schema (lazy)
const details = await tools.describe.tool({ path, includeSchemas: true });
// 4. call it, type-safely
const result = await tools[path](input);
```

Plus typed direct calls once a path is known, e.g. `await tools.github.issues.list({ owner, repo })`.

**Available connection prefixes** are surfaced to the model in the `execute` description, e.g.:

```
- github.org.main : Production GitHub
- stripe.org.main : Live Stripe account
- jira.org.main   : Team Jira
```

The sandbox can `import` from the npm ecosystem (e.g. an AI SDK) from a **vetted allowlist**,
with all network egress **gated by SSRF/policy controls** (§9.3) — decided: allowlist +
egress-gated (not full-npm). This is what makes code-mode strictly more expressive than JSON
tool-calling or a fixed CLI (the model authors new behavior, not just invokes pre-built
verbs), while keeping the import attack surface bounded. The allowlist is operator-configurable.

---

## 7. Ingestion & normalization

**Supported Source types:** OpenAPI spec · GraphQL endpoint · MCP server · custom JS plugin.

**Add a Source** (web "Add Source" auto-detects type, indexes tools, handles auth) or via API:

```
conduit call conduit openapi addSource '{
  "spec": "https://petstore3.swagger.io/api/v3/openapi.json",
  "namespace": "petstore",
  "baseUrl": "https://petstore3.swagger.io/api/v3"
}'
```

- **`namespace`** groups/addresses the tools (`conduit call petstore ...`).
- **`baseUrl`** is required when the OpenAPI document has relative `servers` entries.
- **Conduit's own management API is itself an Integration** (the `conduit` namespace) —
self-managing / dogfooded.

**Normalization output per tool:** `{ name, namespace, inputSchema, outputSchema, riskClass, sourceSemantics }`. riskClass is derived in §10.1.

**Missing output schemas:** when a source declares no output schema (common for MCP
servers), `outputSchema` defaults to a permissive `unknown`/passthrough schema — the
"one tool shape" stays uniform without over-claiming validation.

**Source refresh & policy persistence:** re-ingesting a Source diffs the catalog. Policies
are keyed by tool name and **persist across refreshes**; manual overrides and input-aware
rules are **never silently reverted** to spec-derived defaults. New tools get defaults;
removed tools' policies are archived (restored if the tool reappears); tools whose schemas
changed are **flagged for review** in the console.

---

## 8. Catalog & progressive disclosure

- **`tools.search({ query, limit })`** — intent search over the full catalog; returns ranked
paths with minimal metadata (no full schemas).
- **`tools.describe.tool({ path, includeSchemas })`** — lazily loads the full input/output
schema for one tool.
- **`tools[path](input)`** — invoke.
- The model's prompt only ever contains the `execute` tool + connection prefixes; schemas are
pulled on demand. This is the mechanism behind "thousands of tools, no bloat."

**Search ranking roadmap (decided — staged, evidence-gated):** the primary search
caller is the *model*, which writes tool-shaped queries and retries cheaply — so ranking
sophistication is bought only when data demands it.

- **v0 (shipped):** lexical ranking in `InMemoryCatalog` — name-segment >
name-substring > description token match; deterministic; the `execute` description
tells the model to search with concrete nouns/verbs and retry on empty results.
- **Phase 1 (with the storage layer):** `tools.search` moves to **SQLite FTS5 +
BM25** behind the same `Catalog` interface — stemming and real ranking for zero new
dependencies. Verify D1's FTS5 support for Worker parity then; if lacking, the Worker
keeps the in-memory implementation (a config detail, not a fork).
- **Phase 2 (instrument, then decide):** Trace records zero-hit searches, giving a real
miss-rate metric. Embedding/semantic search is added **only if that data demands it**,
and then only as **operator opt-in** — catalog metadata never leaves the machine by
default (§9.3 spirit).

---

## 9. Connections, credentials & the security boundary

### 9.1 Connection model

- A Connection is a configured instance of an Integration; **many per integration** (e.g.
two accounts of the same API). **Auth optional** (public sources need none).
- Per-user credentials **and** shared credentials. "Set up once, whole team has it" — no
onboarding ritual, no toggling integrations on/off mid-task.

### 9.2 Credential-boundary invariant (load-bearing)

- Tool calls run in an **isolated sandbox (QuickJS).**
- Credentials are **resolved host-side, at call time**, and **injected into the outbound
request only.**
- A secret **never** enters any of these four zones: **(1) the sandbox heap, (2) the
agent-written code, (3) the agent, (4) the model.**
- The sandbox calls a tool **by reference (name/handle)**; Conduit binds reference→secret
**outside** the sandbox and constructs the authenticated request. The credential and the
sandbox address space **never coexist.**
- **Stored secrets are encrypted at rest** with a master key (operator-manageable).

### 9.3 Network / SSRF control

- Sandboxed code's egress to **loopback / private addresses is OFF by default** (an opt-in
flag enables it only when the code is trusted).

---

## 10. Policy engine

### 10.1 riskClass (derived from imported semantics)

Every tool gets a normalized `riskClass`, populated by a per-protocol classifier:

| Source | Signal | Default mapping |
| --- | --- | --- |
| OpenAPI | HTTP verb | GET/HEAD/OPTIONS → **safe**; POST/PUT/PATCH → **review**; DELETE → **destructive** |
| MCP | `destructiveHint` (+ `readOnlyHint`) | hint → **destructive**; read-only → **safe** |
| GraphQL | operation type | query → **safe**; mutation → **destructive** |
| custom JS | plugin-declared | author-declared, defaults to **review** |

Heuristics are imperfect (POST can be safe or destructive), so **manual overrides** are
always allowed.

### 10.2 Three policy states (per tool)

- **Allow** — runs uninterrupted.
- **Require approval** — the call **pauses** until a human approves (the Execution suspends;
resume by id).
- **Block** — cannot be called.

Defaults: safe → Allow; review → Require approval; destructive → Require approval; tunable for any tool anytime.
"Agents auto-run the safe stuff and ask before the rest."

**Where approvals surface:** a pending-approvals view (+ badge) in the web console;
`conduit approvals list|approve|deny` in the CLI; and a paused Execution returns its
`exec_id` plus a human-readable reason to the calling agent, so the agent can tell the
user exactly what it is waiting on. Push notifications (webhook/Slack) are deferred (§18).

### 10.3 Input-aware rules (CONDUIT DIFFERENTIATOR)

Policies may branch on the **actual argument values** of a call. **Two authoring modes**
(decided — support both): **(a) declarative YAML** for simple value rules (easy/safe to
author, approachable for non-devs), and **(b) typed TS predicates** — rules as TypeScript
functions over the tool's typed input, for complex logic with compile-time checking against
the known input schema. YAML rules compile down to the same evaluation as TS predicates.

YAML form (illustrative):

```yaml
- tool: stripe.*.refund
  when: { input.amount: { gte: 5000 } }   # cents
  then: require_approval
  else: allow
- tool: "*.sendEmail"
  when: { input.to: { matches: "*@ourcompany.com" } }
  then: allow
  else: require_approval
- tool: "*.delete*"
  then: require_approval
```

Typed TS predicate form (for complex logic):

```ts
definePolicy("stripe.*.refund", (input: RefundInput, ctx) =>
  input.amount >= 5000 || !ctx.user.isAdmin ? "require_approval" : "allow"
);
```

Evaluation: input-aware rules layer **on top of** riskClass defaults; most-specific match wins;
explicit Block always wins. Because tools are strongly typed, both forms validate against the
known input schema at policy-author time.

---

## 11. Observability / Trace (CONDUIT DIFFERENTIATOR — shipped, not "coming soon")

- **One place to see every run and tool call.** Audit any decision after the fact.
- **Per execution:** id, total wall time, the code that ran, policy decisions, pause/resume
events, final result/error.
- **Per tool call:** namespace.tool, latency, input (redacted per policy), output summary,
upstream status, policy verdict. Example row set:
```
run_7421            1.42s
sentry.getIssue     184ms
github.searchCode   391ms
linear.createIssue  612ms
```
- **Secret redaction:** Trace never stores raw credentials (consistent with §9.2); sensitive
inputs masked per policy.
- **Surfaces:** Trace viewer in the web console; `conduit trace ...` in the CLI; queryable via SDK.
- **Retention:** configurable locally (SQLite); export (JSON) for external audit/SIEM.
Cloud-scale retention tiers are deferred (§18).

---

## 12. Surfaces (all over one core)

| Surface | What it is |
| --- | --- |
| **MCP server** | streamable-HTTP endpoint at `/mcp` (+ stdio). The default agent connection. |
| **CLI** (`conduit`) | drive the local service from the terminal; headless/server friendly. |
| **Desktop app** | native window + graphical console; a **companion** to the CLI driving the **same** local background service (not a second runtime). Mac/Windows/Linux. |
| **Programmatic SDK** | `@conduithq/sdk` — drop-in native client; the foundation all other surfaces are built on. |
| **gen-UI dashboard** | generated UI bound to proxy objects (actionable components). |
| **Reusable workflows** | saved code-mode snippets; can receive webhooks / schedule crons. |

"Today it is a code-mode MCP. It could just as well be the CLI, a one-off script, a gen-UI
dashboard, or a reusable workflow. **Same tools, every surface.**"

---

## 13. Deployment modes (full parity)

All modes are the **same core, different packaging** ("same code paths, different deployment").

### 13.1 CLI / local

- Requires **Node.js 20+**. `npm install -g @conduithq/cli` (pnpm/bun/yarn supported).
- `conduit install` — install/start the **durable background service** (survives restarts).
- `conduit web` — open web UI (default `http://127.0.0.1:<PORT>`).
- `conduit web --foreground` — throwaway foreground runtime.
- Integrations, credentials, policies stay **local**.
- **Local trust boundary:** the local daemon binds **127.0.0.1** and its `/mcp` +
API are **unauthenticated** (loopback-only trust). Any deployment that binds beyond
loopback — Docker's default `0.0.0.0`, Cloud, Worker — **runs with auth enabled**;
the unauthenticated convenience exists only in loopback mode.

### 13.2 Desktop app

- Native shell over the same local service. Integrations workspace; manage connections &
policies; Connect card for agents. Data stays on the machine.

### 13.3 Cloud (hosted, commercial)

- Same catalog/auth/policies, run for us. Free tier. Sign in → add integration → create
connection → point agents at the hosted `/mcp`. Works with **cloud agents (ChatGPT)**.

### 13.4 Self-host — Docker

- **Whole server in one container** over a **libSQL (SQLite) file**: typed API + MCP server +
auth + QuickJS execution + web console, **one process, no external DB/worker/proxy**.
- `docker run -d -p <PORT>:<PORT> -v conduit-data:/data ghcr.io/<org>/conduit-selfhost:latest`
(or `docker compose up -d --build` from `apps/host-selfhost`).
- **Ownership:** first account = **owner**; thereafter **invite-only** (single-use links from
Admin); open signup closed. Headless bootstrap via env (below).
- **Persistence:** SQLite DB + generated encryption keys live in `/data` (back up the volume;
primarily `data.db`).

**Environment variables** (all optional; bare run boots a working instance — `CONDUIT_` prefix):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | 7878 | HTTP port |
| `CONDUIT_HOST` | 0.0.0.0 | Bind address |
| `CONDUIT_DATA_DIR` | /data | DB + generated keys |
| `CONDUIT_DB_PATH` | `<data>/data.db` | SQLite file |
| `CONDUIT_WEB_BASE_URL` | auto | Public browser URL; **required behind a domain/TLS** (else invalid-origin) |
| `CONDUIT_AUTH_SECRET` | generated, persisted | Session secret (32+ chars); rotating signs everyone out |
| `CONDUIT_SECRET_KEY` | generated, persisted | **Master key encrypting stored secrets** |
| `CONDUIT_BOOTSTRAP_ADMIN_EMAIL` | unset | Pre-create admin headlessly |
| `CONDUIT_BOOTSTRAP_ADMIN_PASSWORD` | unset | Bootstrap admin password |
| `CONDUIT_BOOTSTRAP_ADMIN_NAME` | Admin | Bootstrap admin display name |
| `CONDUIT_ORG_NAME` | Default | Single org every user joins |
| `CONDUIT_ORG_SLUG` | default | Org URL slug |
| `CONDUIT_ALLOW_LOCAL_NETWORK` | false | Allow sandbox egress to loopback/private (SSRF-sensitive) |

### 13.5 Self-host — Cloudflare Worker

- **Single Worker** in your account. **Auth via Cloudflare Access** (no separate app login;
JWT validated on every request). **Storage = D1.** **QuickJS** execution inside the Worker.
Web console + API + MCP all from one Worker. **Single-tenant** (one org; manage members in
Access).
- Deploy from `apps/host-cloudflare`: `wrangler login` → `deploy:setup` (idempotent: create/
reuse D1, write id to `wrangler.jsonc`, generate+upload `CONDUIT_SECRET_KEY`, deploy).
- Put behind Access (else API/MCP routes 401): add self-hosted Access app → set domain →
policy → copy **AUD** → redeploy with `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN`.

---

## 14. Onboarding

- **Agent-run setup prompt** (copy-paste into Claude/Cursor/any MCP agent): helps pick the run
mode, install, connect over MCP, and get the first integration working end-to-end.
- **`add-mcp` helper** (`npx add-mcp <url> --transport http --name conduit`) auto-detects the
client and writes its config. The Connect card shows the exact command prefilled.
- **MCP startup-reload caveat (must surface in UX):** most MCP clients only load servers at
startup; after adding Conduit, the user may need to **restart the client / open a new chat**
before Conduit's tools appear.

**`/mcp` stdio server onboarding (§17 build-order step 2 — see
`packages/mcp/README.md` for the full walkthrough):**

1. **Generate a master key:** `conduit key generate` mints
`~/.conduit/master-key` (0600) — the default, file-based path. Refuses if a key file
already exists, `CONDUIT_MASTER_KEY` is set, or the default db already holds sealed
secrets under some other key. The raw base64-of-32-random-bytes one-liner —
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`
— remains the env-var alternative for containers/custom-path installs that manage the key via
`CONDUIT_MASTER_KEY` instead of the key file.
2. **Config snippet, honest pre-publish command:** nothing is on npm yet, so the client
config's `command`/`args` point at the built file directly — `node
<abs path>/packages/mcp/dist/bin.js`. For a default-path key generated via
`conduit key generate`, the `env` block needs no
`CONDUIT_MASTER_KEY` entry at all — the server resolves the key from
`~/.conduit/master-key` automatically (env, when set, still overrides the file). Leave
`CONDUIT_DB` out of the snippet: the built-in default already resolves to an absolute
path via `homedir()`, and Node never expands `~`, so a literal
`~/.conduit/conduit.db` in `env` would be read as relative to the client's
own working directory and fail to start.
3. **Onboard an upstream source** so there's something to call:
`conduit add-mcp --url <upstream-mcp-url> --namespace <ns> --prefix <prefix>`
(fail-closed §10.2 policy defaults, so the walking skeleton can't strand on an unapproved pause
for a safe-classified tool). See `packages/cli/README.md` for the full flag reference,
`CONDUIT_ADD_SECRET` credential onboarding, and the retarget refusal.
4. **Approve/resume a paused call:** `conduit approvals list` /
`conduit approvals approve <execId>` (or `deny`), run from a separate
process while the agent is waiting.
5. **Restart the client** after editing its config — the startup-reload caveat above
applies here too.

**`/mcp` env vars (with units):**

| Var | Meaning | Default |
| --- | --- | --- |
| `CONDUIT_DB` | SQLite database path. Node does not expand `~` — if set, use an absolute path. | `~/.conduit/conduit.db`, resolved via `homedir()` (created on first run) |
| `CONDUIT_MASTER_KEY` | SecretBox key, base64 encoding of exactly 32 bytes. | optional when `~/.conduit/master-key` exists (env overrides file) |
| `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` | Allow loopback/private-network upstreams. Dev/demo only. | off (fail-closed) |
| `CONDUIT_APPROVAL_TTL` | How long a paused execution stays approvable, in **milliseconds**. | `259200000` (72h) |

- **`/mcp` troubleshooting:** tools don't appear → restart the client (macOS
Claude Desktop server logs: `~/Library/Logs/Claude/mcp-server-*.log`); egress blocked → set
`CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1` for a loopback/demo upstream (the agent-visible
error deliberately doesn't name this var); a wrong master key fails at STARTUP (the key canary
verified during store open), not at first secret decrypt; a call that timed out may have finished — pass a `requestKey` to
`execute` and recover the outcome via `check_execution`; back up the single
SQLite database file before upgrading; v1 calls MCP-over-HTTP upstreams only.

---

## 15. Public API / CLI surface (initial)

```
conduit install                         # durable background service
conduit web [--foreground]              # web UI
conduit tools search "<intent>"         # find tools by intent
conduit tools sources                   # list integrations + tool counts
conduit call <path...> --help           # browse a namespace
conduit call <path...> '<json>'     # invoke (path = namespace + segments, e.g. github issues create)
conduit call conduit openapi addSource '<json>'   # add an integration (self-managing ns)
conduit resume --execution-id <exec_id> # resume a paused (auth/approval) execution
conduit approvals [list|approve <id>|deny <id>]  # pending approval queue
conduit trace [list|show <run_id>]      # observability (Conduit addition)
```

- `call`, `resume`, `tools …` auto-start the local daemon if needed.
- MCP endpoint: streamable-HTTP at `/mcp` (+ stdio transport).

---

## 16. Security model (consolidated)

1. **Sandboxed execution** (QuickJS) for all tool code.
2. **Credential-boundary invariant** (§9.2): host-side resolution, outbound-only injection,
four exclusion zones, reference-not-secret in the sandbox.
3. **Secrets encrypted at rest** (master key, operator-manageable). Key lifecycle
(§16.3): the master key lives at `~/.conduit/master-key` (0600) with an env-var
override; a startup canary fails loud on a wrong key before any tool call runs; `conduit key
generate`/`rotate` mint and re-seal it; rotation is stop-first (stop all conduit
processes and MCP clients before running) and re-seals every stored secret in one transaction;
crash recovery is a manual procedure over `master-key.bak`/`master-key.next`;
and the db file and key file are always backed up together — a db backup only pairs with the key
that was live when it was taken.
4. **Per-tool + input-aware policy** gating every call (allow/approval/block).
5. **SSRF control**: private-network egress off by default.
6. **Sandbox resource limits**: per-execution wall-clock timeout, memory ceiling, and
output-size cap (defaults 60s / 128 MB / 1 MB; operator-tunable). A runaway
`while(true)` is interrupted, not babysat.
7. **Pluggable auth**: built-in session auth or delegated identity (Access/JWT).
8. **Local browser control-plane integrity (request authenticity)**: the web console
is a browser client of an unauthenticated loopback API that can fire real credentialed calls, so it
needs a request-authenticity floor SEPARATE from login/identity auth (a malicious web page is a remote
attacker that can reach `127.0.0.1` — CSRF-to-localhost / DNS-rebinding). On every
STATE-CHANGING request: validate `Host` against the exact local listener (blocks rebinding);
require the exact console `Origin` == `CONDUIT_WEB_BASE_URL` (reject `null`
/ foreign); mutations only via non-simple JSON (never GET/form); no permissive CORS; a same-origin CSRF
nonce / short-lived local capability; equivalent checks on any WS/SSE upgrade. This WIDENS the old
"origin pinning for browser logins" rule to all mutating requests — it is NOT the login/identity auth
library (that stays deferred, §18). Bind literally to loopback and FAIL CLOSED if bound beyond loopback
while login-auth is unavailable.
9. **Audit**: every call traced and exportable; secrets redacted in Trace. Any trace UI
renders `trace_events` only (never the unredacted `replay_journal`, §18) and
escapes content under a restrictive CSP — upstream/trace fields are attacker-controlled data.

---

## 17. Phased build plan (parity, sequenced)

**Phase 0 — Core SDK (`@conduithq/sdk`)**

- Data model (Source/Integration/Connection/Tool/Policy/Execution).
- Normalizers: OpenAPI + MCP first (GraphQL + custom JS next).
- Catalog + `tools.search` / `tools.describe.tool` / typed call.
- QuickJS sandbox + the `execute` tool + 4-step workflow.
- Credential resolver + boundary invariant. SQLite storage. Secrets-at-rest.

**⭑ MVP Prototype Checkpoint (the "walking skeleton") — STOP, test, find edge cases before building further**

The thinnest slice that is testable *as a product*, not a library: the point where a
real MCP agent drives a real tool call through the real boundary. Spans the end of Phase 0 plus a
minimal runnable slice of Phase 1; deliberately excludes the web console, FTS5, and everything in
Phases 2–5. Rationale: find breakages on a small surface before the full product is built on top of
them, when they are cheap to fix.

- **In scope (must build):** finish Phase 0 (§5.5 execution manager — pause/resume
replay + approval queue; §11 Trace redaction — flips the last ⏳ invariant); the `/mcp`
server (**stdio transport first**, the form Claude Desktop / Cursor use); a minimal
`conduit` CLI (`serve`, `add-mcp`, add a source + connection); and
the §4.2 before/after token demo (the spec's designated QA artifact).
- **Explicitly deferred out:** web console, FTS5/BM25 search (the in-memory catalog
suffices at demo scale), Trace viewer/export, and all of Phases 2–5. A UI is not needed to test the
engine — the CLI + a real MCP client are.
- **Definition of done — TWO gates, both required:** *(1) Built* — a real MCP
client connects, sees one `execute` tool, and drives a real tool call against a real
upstream MCP source through the §9.2/§9.3 boundary, with the token savings observable. *(2)
Verified* — a deliberate edge-case / adversarial pass on the *running* skeleton has
converged: malformed schemas, hostile upstream echoes, credential 401s, tool-call timeouts,
resume-after-pause, redaction paths, and the §14 startup-reload UX caveat are each handled or
documented out-of-scope. The happy path is the entry ticket to the test phase, not the finish
line.

Only after both gates pass does the build resume: the rest of Phase 1 (web console, FTS5), then
Phases 2+. (Decided 2026-07-08.)

**⭑ v1 Surface Product — the first thing a real end user can adopt (milestone, decided
2026-07-14)**

The MVP is a walking skeleton (done). Phase 1 as written groups capabilities, not the shortest path
to a usable product; the v1 surface product is a NARROW cherry-pick from Phases 1–2 that turns the
CLI-and-config developer preview into something a non-CLI user can adopt. Explicitly scoped
**local, loopback, single-user, no login-auth** (§13.1) — every deferral below follows from
that scope. Reviewed cross-model (2026-07-14): the naive "loopback + unauthenticated + web console" cut
is CSRF-to-localhost / DNS-rebinding exploitable, so the request-authenticity floor (§16) is IN the
milestone, not deferred with the auth library.

**In v1 (build):**

- **Durable background service. ✅ BUILT** (2026-08-16 design, build sequence step 2 —
daemon ownership). Owns the DB, execution manager, caches, and the control API. The process-ownership
model is **decided and shipped**: `conduitd` is the sole writer of
`~/.conduit/conduit.db`, and every other surface is a thin local client of it over a Unix
socket — the stdio `/mcp` server (`conduit serve`), `conduit approvals`,
`conduit add-mcp`, and the default `--doctor`. The shared-store alternative was
rejected on **simplicity and single-authority** grounds, not impossibility: a shared store
is technically viable — the same kernel locks work for N processes as for one — but it buys N caches
that can individually go stale, write serialization as an emergent property rather than a program
invariant, and N independent lifetimes to reason about. And keeping approvals resumable across agent
sessions requires some process to be durable, which is the daemon again. Clients auto-start a daemon
when none is running (spawn budget of one, environment constructed rather than inherited); stopping is
SIGTERM. Exclusion with `conduit key rotate` is the kernel maintenance lock rather than a
liveness probe (rotate stays a direct-db operation, outside the daemon — the one deliberate exception
to sole-writer ownership, since rotation must re-seal the database no daemon may be holding). The §17 startup-reload caveat closes here — a source added through
one client is visible to another with no restart. Pinned by the §17 rows in
`INVARIANTS.md`.
- **Typed control-plane API + hot-reload. ✅ DAEMON-SIDE BUILT** (2026-08-22 design, build
sequence step 3) — **the HTTP half ships WITH step 4**, so this line stays PARTIAL. Built:
the daemon holds ONE long-lived runtime whose catalog every `search`/`describe`
reads, and the provisioning tail hot-reloads that catalog after the commit — so a source added or
revalidated through any client is visible to a still-connected `serve` session with no
restart, at both the `catalog.listing` and the `search`/`describe`
surface. Per-tool name/description bytes are bounded before the commit, so a hostile upstream cannot
land unbounded text in the shared catalog. A `control` capability carries
`daemon.status` and `daemon.stop` (the stop ack is flushed before the daemon
begins its drain), surfaced as `conduit daemon status|stop` — `status` exits 3
when no daemon is running. Every daemon-handshaking client warns once on version skew, and the daemon
owns a bounded rotating log. NOT yet built: the console's own local HTTP API (distinct from the
`/mcp` transport), which ships in the SAME increment as the §16 request-authenticity floor
below — a local HTTP surface may not exist ahead of the floor that makes it safe. That API will accept
an abstract actor/principal (anonymous-local) so Cloud/self-host auth does not later require rewriting
every handler. Pinned by the §17 rows in `INVARIANTS.md`.
- **Request-authenticity floor (§16)** — ships IN THE SAME INCREMENT as the console, not
after: Host/Origin validation, CSRF nonce, non-simple-JSON mutations, no permissive CORS, restrictive
CSP + escaped trace/upstream content, loopback-only bind (fail closed beyond loopback). This is
request integrity, NOT login/identity auth.
- **Web console** — Add Source (**MCP-only** per the v1 upstream-scope
decision, §18), connections, a policy editor over the EXISTING per-tool allow/approval/block model
(no schema-aware/input-aware authoring), the **pending-approvals view** (§10.2 — mandatory:
the first destructive call pauses, and the console is the human-usable resume path), and the Connect
card.
- **Read-only trace viewer** — projection of `trace_events` with cursor
pagination and basic indexed filters (time/execution/tool/verdict; no FTS). NEVER joins or exposes the
unredacted `replay_journal` (§18). Escaped rendering + CSP. NO export and NO
retention/GC (both stay deferred, below); a durable local store SHOULD offer a confirmed manual purge
that preserves pending executions + replay data.
- **Prerequisite — verify credential key lifecycle. ✅ BUILT** (2026-07-19 design,
`docs/superpowers/specs/2026-07-19-credential-key-lifecycle-design.md`). Master-key
generation, file permissions, and the recovery/rotation story are now product behavior, pinned by
the §16.3 rows in `INVARIANTS.md`.

**Deferred OUT of v1** (each follows from the local/loopback/single-user scope):
`/mcp` streamable-HTTP transport (stdio already serves local Claude Desktop/Cursor; HTTP is a
hosted/remote-agent need — keep its route stack independent so building the console never implements
`/mcp`-over-HTTP); FTS5/BM25 (in-memory catalog suffices at v1 scale, §8); the login/identity
**auth library** (§18 — moves to Phase 4/Cloud); input-aware policy rules (Phase 2, §10.3);
trace export + retention/GC (Phase 2/4); desktop (Phase 3, cut); Cloud (4); self-host (5).

**Build sequence:** (1) verify credential key lifecycle ✅ → (2) decide daemon ownership ✅ →
(3) typed control API + hot-reload ✅ daemon-side (HTTP with step 4) → (4) request-authenticity floor →
(5) console onboarding / connections / policy / approvals / Connect → (6) read-only trace viewer →
(7) service install / restart / upgrade / recovery. Each piece is load-bearing.
**Re-sequenced from step 4 onward (§18 repositioning decision, 2026-08-30):** the
remaining work proceeds as **R1–R5** — R1 direct + discovery projections with minimal
capability scoping; R2 input-aware policy v1 (real GitHub schemas); R3 zero-friction CLI
distribution; R4 embedding contract (Grade B first); R5 focused approval + evidence UX. The
step-4 §16 floor becomes the hard gate on any HTTP-facing surface; steps 5–7 map into R5,
R5, and R3/R4 respectively (full continuity map in the §18 entry). **Next: R1.**

**Phase 1 — Local runtime + CLI + MCP**

- Durable background service; `/mcp` streamable-HTTP + stdio; `conduit` CLI; `add-mcp`.
- Web console: Add Source, connections, policies, Connect card.
- Policy engine v1 (riskClass + three states + overrides).
- `tools.search` upgraded to SQLite FTS5/BM25 behind the same Catalog interface (§8 roadmap).

**Phase 2 — Differentiators**

- **Trace** end-to-end (store, web viewer, `conduit trace`, export, redaction).
- **Input-aware policy rules** (value-based branching) + schema-aware authoring.

**Phase 3 — Desktop app**

- Native shell over the same local service (Mac/Win/Linux).

**Phase 4 — Hosted Cloud**

- Multi-user org, hosted `/mcp`, free tier, billing, per-user + shared credentials.

**Phase 5 — Self-host parity**

- Docker single-container image (libSQL) + env/bootstrap/ownership/invites.
- Cloudflare Worker (D1 + Access-delegated auth + QuickJS).

**Cross-cutting:** the token-savings **before/after demo** as a marketing/QA artifact.

---

## 18. Open questions / decisions to lock

**Resolved (locked):**

- **Repositioning — governed execution authority; projection model; roadmap re-sequence (decided 2026-08-30):** ✅
Conduit's identity is the *governed execution authority for AI agents*: controlled access
to real tools with credentials, policy, approvals, network controls, and execution evidence
held outside model-controlled execution. The Code Mode surface (§4.2 plus the two-tool
decision of 2026-07-11: `execute` + `check_execution`) becomes one of
**three projections** over the one authority pipeline (principal → capability scope →
input-aware policy → credential resolution → approval when required → governed invocation
with network enforcement → redaction + trace): *direct governed tools* (for clients with
native orchestration), *discovery* (search / describe / execute-one), and *Conduit
Code Mode* (permanent, no longer the whole product). Effective capabilities =
client-requested ∩ principal-authorized ∩ current catalog visibility ∩ policy constraints; a
client can narrow, never widen; a cached schema is advertisement, not authority; every call
revalidates live; revocation beats stale discovery.
Deployment guarantees are stated per trust grade: **Grade A** (separately administered
authority service; agent host untrusted; future, demand-pulled), **Grade B**
(trusted-host sidecar — today's architecture; §9.2 holds under the declared trusted-host
model; a malicious same-UID host is outside the grade's protection, stated plainly),
**Grade C** (in-process library; cannot claim §9.2 as written; specified separately
with explicit downgrades).
The §17 build sequence is re-sequenced from step 4 onward into **R1–R5**: R1 direct +
discovery projections with minimal per-client capability scoping and a direct
execution-record variant (a deliberate store-schema change — the first since the per-step
freezes); R2 input-aware policy v1 grounded in the real stored schemas of the dogfooded
catalog; R3 zero-friction CLI distribution; R4 embedding contract (Grade B proven against
one real client before any SDK stabilization; Grade C specified separately); R5 focused
approval + evidence UX. **Gate:** no HTTP-facing surface ships without the §16
request-authenticity floor; no unused HTTP infrastructure is built ahead of need. Approved
actions bind a defined tuple (principal, client, projection, qualified tool, canonical
arguments, revision, policy version, connection identity, destination, decision) with
per-field drift rules settled in the R1/R2 design specs. OpenAPI is normalized but not yet
callable; GraphQL, CLI, and browser adapters remain future, customer-pulled roadmap items —
none is described publicly as shipped until executable through the governed pipeline.
*Continuity (nothing silently vanishes):* old step 4 (§16 floor) → the HTTP gate, its
transport-agnostic control handlers and branded Principal already banked by step 3; step 5
(console) → R5's approval slice, remainder deferred; step 6 (trace viewer) → R5 evidence
UX; step 7 (service lifecycle) → R3/R4; deferred "execution-level source/tool revision
pinning" → required by R2 approval integrity; deferred "source-removal verb" → R1
profile management.
- **Sandbox engine:** ✅ **QuickJS** (faithful) — portability across container + Worker; npm
compat handled via the allowlist (below) rather than a heavier isolate.
- **Policy rule language:** ✅ **Both** — declarative YAML + typed TS predicates (§10.3).
- **In-sandbox npm imports:** ✅ **Allowlist + egress-gated** (§6, §9.3) — vetted packages
only; all egress through proxy/policy.
- **Default local port:** ✅ **7878** — distinct, dedicated default; used throughout §13 and the env table.
- **Connection-prefix grammar:** ✅ `service.<org-slug>.<env>` (§3, §6) — env/account map onto the `<env>` segment.
- **Pause/resume model:** ✅ **Deterministic replay** (§5.5) — tool-call results journaled
in Trace; resume re-runs code against memoized results; no VM snapshots.
- **Tech stack:** ✅ locked for Phase 0 (§20) — TypeScript/ESM, pnpm workspaces,
quickjs-emscripten, Ajv + Zod, Vitest, libSQL.
- **Connection addressing (v1):** ✅ **Single connection per namespace** (§5.3) — a
namespace resolves to its one configured connection; multiple connections for an integration fail
closed until per-call addressing ships. The pipeline's resolver seam accepts a `prefix`
parameter from day one (unused in v1) so real addressing arrives without an interface change.
- **Replay journal as a dedicated projection (revised 2026-07-09, §5.5 execution-manager work):**
✅ the durable replay journal is a **separate `replay_journal` table**, distinct from the
audit Trace, holding `{ execution_id, ordinal, op, request, outcome }` for finalized
`search`/`describe`/`call` ops. This supersedes the earlier "the Trace store
doubles as the replay journal" decision: a cross-model review proved the audit Trace records the
`require_approval` refusal row (polluting the replay prefix) and that `TraceEvent`
cannot represent read-ops — so the two projections are split. The §18 rationale is preserved (durable-data
replay over the SQLite store, no VM snapshots); only the "same table" detail changes. `TraceEvent.output`
still carries the full (response-capped) call result for the §11 audit trail, with `outputSummary`
as its display projection. Persisting `search`/`describe` journal entries — deferred here
in the original decision — is discharged: they live in the new replay-journal table.
**Audit semantics:** refusals (policy-denied, blocked) and allowed calls that reached the
upstream caller and failed are traced (the latter with the allow verdict and no output); pre-flight
refusals (no connection, unsupported source type, exhausted budget) and infra faults are not traced —
infra faults live host-side under a correlation id. A failed trace append fails the call: an
unauditable call must not silently succeed.
- **Upstream scope (v1):** ✅ **MCP-only, behind a per-source-type seam** (§5.3) —
JSON-RPC 2.0 `tools/call` with the namespace prefix stripped to recover the upstream tool
name. Known limitation: MCP names the normalizer transformed don't round-trip until the original
name is stored in `sourceSemantics`. Other source types fail closed ("not yet callable").
- **Upstream-client transport compatibility (C4, promoted from tracked SDK design item):** ✅ the fix is the **first post-MVP PR, ahead of the §17 v1 surface sequence** (decided 2026-07-16). The MVP's upstream caller and `add-mcp` onboarding fetch speak bare JSON-RPC POST only; a 0-of-3 dogfood result against real public MCP servers (GitHub 401 — onboarding sends no Authorization though `CONDUIT_ADD_SECRET` is stored; Context7 400 — no initialize/session; Vercel 401 — OAuth) makes this the adoption blocker: v1's console ships "Add Source (MCP-only)", which is pointless while no real MCP source can be added. Fix scope, verified live 2026-07-16 (the standard handshake onboards Context7, 2 tools, and GitHub, 44 tools with PAT auth): (1) streamable-HTTP handshake — initialize → `Mcp-Session-Id` → notifications/initialized, protocolVersion negotiation; (2) `Accept: application/json, text/event-stream` + SSE frame parsing on both the onboarding fetch and the serve-time upstream caller; (3) credentials sent at onboarding; (4) `tools/list` pagination (`nextCursor`). **OAuth-flow upstreams (Vercel-class) stay out of scope** — the static-secret model is the v1 credential story; OAuth onboarding is its own later decision. Distinct from the deferred §17 item "`/mcp` streamable-HTTP transport", which is Conduit's own *server-side* transport; this decision covers Conduit as *client* of upstreams.
- **Desktop app — OUT of launch/MVP scope:** ✅ the Phase-3 desktop shell
(§13.2) is explicitly NOT part of the initial launch. The launch surfaces are the CLI and web
console (§12); the desktop app is a thin native shell over the *same* local service (§13.2,
"a companion to the CLI … not a second runtime"), so deferring it removes a UI surface, not a
capability, and strands no downstream work — Phases 4–5 (Cloud, self-host) do not depend on it. It
remains a post-launch option enabled by the surface-agnostic core; picking it up later needs no
rework. (Decided 2026-07-08.)
- **Per-connect egress pinning** (§9.3): ✅ **SHIPPED** 2026-07-08
(Issue #21 / PR #22, merged early — was slated Phase 1). `createPinnedLookup` resolves
once and forces the connection to the vetted resolved IP (canonicalize-then-check), closing both the
address-encoding bypass and the DNS-rebinding TOCTOU. Pinned by `pipeline/egress.test.ts`
(INVARIANTS.md §9.3). The classifier is symmetric across all three embedded-IPv4 IPv6 forms —
v4-mapped (`::ffff:0:0/96`), v4-compatible (`::/96`, deprecated per RFC 4291
§2.5.5.1; special-use, "should not appear on the public Internet" per RFC 5156), and NAT64
(`64:ff9b::/96`) — each decoded by its embedded v4 (fix 2026-07-11, codex re-pass:
`::127.0.0.1` had read as public while its v4-mapped twin was blocked).
**Custom-prefix NAT64 (RFC 6052 network-specific prefixes) is out of scope:** a custom
prefix carries no globally-fixed NAT64 meaning, so an address under it is ordinary global-unicast
IPv6 that reaches a private target *only* if the operator's own network runs a translator for
that prefix — an environmental precondition Conduit cannot observe. This is a documented scope
boundary, **not** the `allowPrivate` opt-in (that is an explicit call-site
authorization); blanket-blocking every global IPv6 whose low bits spell a private v4 would be a
denylist over unbounded input and false-positive-block the legitimate IPv6 internet. Only the
globally-reserved `64:ff9b::/96` prefix belongs in the canonical classifier.
(Custom-NAT64 classification confirmed out-of-scope by codex adversarial pass 2026-07-11.)
- **UpstreamCaller as a trusted dependency** (§5.3, §9.2): ✅ the pipeline treats an
injected `UpstreamCaller` as trusted infrastructure — the same posture it holds toward the
store and policy engine — not as an adversary. So the invoker does NOT re-validate a custom caller's
error name against its kind, nor re-scan a custom caller's success result for the credential; those
defenses live in the built-in MCP caller. Rationale: a custom caller is host-side code the operator
installs, and a hostile one already holds the secret in its own `call()` scope, so
smuggling it back through the invoker buys an attacker nothing. If Conduit ever runs
operator-untrusted caller plugins, this decision reopens and the invoker gains its own output/name
validation. (Decided 2026-07-08 after a codex adversarial re-pass raised both as findings.)
- **§11 Trace redaction mechanism (2026-07-10):** ✅ **write-time redaction at
the Trace append choke point** — a builtin sensitive-key list (normalized exact matching) plus
per-tool `redactFields` on the Policy row, riding the `PolicyVerdict`. The full
`TraceEvent.output` is dropped from the Trace (redact-by-not-storing). A pre-§11 database
is migrated once on open: its trace rows' `input` is masked with the then-current builtin +
per-tool keys, legacy summaries (truncated raw serializations) are replaced wholesale with a marker,
and the legacy `output` column is dropped — the column's absence marks the migration done.
The full result lives only in the §5.5 replay journal, which stays semantically unredacted (D7). Not
retroactive for policy changes: editing `redactFields` later masks future rows only. `PendingApproval.input` stays
unredacted — the approver decides on real values. Display hygiene, not a boundary: the credential
boundary remains §9.2's request-scoped, never-persisted credentials.
- **/mcp stdio surface — two-tool shape (2026-07-11):** ✅ the client sees exactly two
tools: **`execute`** (the existing `execute` definition, plus an
optional `requestKey` correlation input) and **`check_execution`**
(resolves by `executionId` or by `requestKey`). The §4.2 "one tool" story becomes
"one tool + a status check": the execute definition's ≤1,044-token invariant holds by capping the
connection listing (first N connections plus "…and K more — search the catalog"), and
`check_execution` gets its own ≤256-token pin. `resume`/approve is deliberately
NOT an MCP tool — the §10.2 approval seam stays human-only; an agent must never approve its own paused
call.
- **/mcp execution-outcome persistence (2026-07-11):** ✅ `Execution` gains
persisted settle-state (`result`/`error` columns, plus the nullable unique
`request_key` column) so `check_execution` is a pure store read, correct
regardless of which process resumed. Every terminal transition is outcome-aware: a stored
`failed` row always explains itself (a synthetic `ConduitPersistError` covers a
faulted settle-write fallback), a `completed` row always carries a result (`null`
is legitimate and distinct from absent), and `expired` carries neither. Retention/GC of
these settled outcomes is **explicitly deferred**, alongside the existing trace-retention
deferral (below) — the accumulation is a visible decision, not silence.
- **`packages/mcp` joins the monorepo (2026-07-11):** ✅ a new workspace
package, `@conduithq/mcp` — the stdio MCP server (§17 build-order step 2). §20's monorepo
list gains it.
- **`CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` opt-in (2026-07-11):** ✅ an
env var read by `packages/mcp`, default **off** (§9.3 fail-closed stands); set
to `1` to allow the loopback-upstream dev/demo case, which otherwise cannot run at all.
Enabling it prints a loud stderr warning at startup. Dev/demo-only framing in the docs; the Phase-1
shape is per-connection egress policy.
- **/mcp completion signaling — poll is the skeleton mechanism (2026-07-11):** ✅ the
poll design (`check_execution`) is skeleton-scoped: MCP-native completion signaling
(progress notifications / task semantics) is the recorded Phase-1 successor — deferred, not
forgotten.
- **Open-sourcing the repo (2026-08-03):** ✅ three decisions, made explicitly by the
product owner: (1) **conduit-HQ goes public AS-IS with full git history**, gated on a
privacy audit of that history — secrets are already proven absent by CI's full-history gitleaks
scan; the audit targets personal-operational material (machine paths, incident narratives, private
artifact URLs), categorized with exact locations, so the final flip is an evidence-based human
decision, never an agent action. (2) **HANDOFF.md and LEARNINGS.md remain in the public
repo** — the working-in-the-open record is part of the product's story — under a codified
public-safe writing rule (project CLAUDE.md) from the flip onward: no machine-specific paths, no
personal URLs. (3) License is **Apache-2.0** (patent grant matters for a security
product; permissive adoption over copyleft).

**Deferred (future phases — none block v0.1 / Phase 0):**

1. **Auth library — SPLIT (revised 2026-07-14):** the login/identity system
(better-auth-equivalent session auth + the delegated-auth contract) moves to **Phase 4/Cloud**
— a local single-user product on loopback needs no login (§13.1). What must NOT be deferred is the
**request-authenticity floor** (Host/Origin/CSRF/CSP/loopback-bind, §16) — that ships IN the
v1 surface product because a browser console over an unauthenticated loopback API is otherwise
CSRF-to-localhost / DNS-rebinding exploitable. "Defer auth" means defer login/identity, NOT request
integrity. (Cross-model reviewed 2026-07-14.)
2. **Trace storage scale** (SQLite fine locally; Cloud needs a real store + retention tiers) — Phase 4.
3. **npm allowlist contents**: which packages ship vetted by default (AI SDK, validation, etc.) — Phase 0/1.
4. **Pricing shape** for Cloud (out of scope per editorial standard, but flag for product) — Phase 4.
5. **Approval push notifications** (webhook/Slack) beyond console/CLI/agent surfacing — Phase 2.
6. **Settled execution-outcome retention/GC** (`/mcp` M4) — persisted
`result`/`error` columns accumulate with no GC yet; same shape as the trace-retention
deferral above — Phase 4.

---

## 19. Branding / naming

- **Product:** Conduit · **Domain:** useconduithq.com
- **npm:** `@conduithq/sdk`, `@conduithq/cli` (bare `conduit` is taken; scope is free)
- **CLI binary:** `conduit`
- **Container image:** `ghcr.io/<org>/conduit-selfhost`
- Verify `useconduithq.com` (and `.dev`/`.sh` alternates) at a registrar before lock; npm
scope `@conduithq` confirmed available.

---

## 20. Tech stack (locked for Phase 0)

- **Language:** TypeScript everywhere (strict mode, ESM-only). **Node.js ≥ 20.**
- **Monorepo:** pnpm workspaces — `packages/sdk`, `packages/cli`,
`packages/mcp` (the stdio MCP server, §17 build-order step 2),
`apps/host-selfhost`, `apps/host-cloudflare` (later: `apps/desktop`, web console).
- **QuickJS binding:** `quickjs-emscripten` — the same WASM build runs in Node and in
Cloudflare Workers, which is what makes §13 deployment parity real rather than aspirational.
- **Schemas & validation:** tools carry **JSON Schema** natively (OpenAPI and MCP already
speak it); runtime validation via **Ajv**. Internal configs validated with **Zod**.
- **Storage:** `@libsql/client` (file URL locally; D1 adapter on Workers) behind one
storage interface.
- **Tests:** Vitest. **Build:** tsup (per-package ESM bundles). **Lint/format:** deferred
to Phase 1 (keep Phase 0 friction low).
