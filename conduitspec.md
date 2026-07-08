# Conduit — Technical Specification (v0.1)

**Product:** Conduit — the open-source integration layer for AI agents.
**Domain:** useconduithq.com · **npm scope:** `@conduithq/*` · **CLI binary:** `conduit`
**License:** MIT (open-core; hosted Cloud is the commercial layer)
**Status:** For review.

---

## 1. Overview

### 1.1 One-line definition

Conduit is the open-source integration layer for AI agents: **one catalog for every
tool, shared across every agent you use.** Configure each integration once (MCP servers,
OpenAPI specs, GraphQL endpoints) with authentication and per-tool policies, then use that
same catalog from any MCP-compatible agent.

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

Everything else is a faithful re-implementation of the proven core.

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
- **Full surface parity**: MCP server, CLI, desktop app, programmatic SDK; same core.
- **Full deployment parity**: CLI/local, desktop, hosted Cloud, self-host (Docker + Cloudflare).
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

### 4.2 Progressive disclosure ("thousands of tools, no bloat")

Connect everything and Conduit still shows the model a **single tool** (`execute`). It
**searches the catalog** and loads a tool's schema **only when the code actually calls it**,
so the prompt never balloons.

**Target metric (the demo):** a representative catalog of ~1,600 tools across GitHub/Stripe/
Jira/Sentry costs ~278,800 tokens if injected directly, vs. **1 tool / ~1,044 tokens** with
Conduit. The interactive before/after token comparison is a first-class marketing artifact.

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
The mechanism is **deterministic replay**, not VM snapshotting: every tool call's result is
**journaled** — the Trace store (§11) doubles as the replay log. On resume, the execution's
code re-runs from the top; journaled calls return their **memoized results** without
re-hitting upstream; the execution proceeds live from the first un-journaled call. **One
mechanism powers both the audit differentiator and pause/resume correctness.**

- **Survives restarts:** a paused Execution is pure data (code + journal); the daemon can
restart — or a different worker can pick it up — and resume it.
- **Determinism contract:** sandbox code must be deterministic between tool calls. Conduit
enforces the boundary cases: `Date.now()` and `Math.random()` values are recorded on
first run and replayed verbatim on resume.
- **Approval TTL:** a pending approval expires after a configurable window
(`CONDUIT_APPROVAL_TTL`, default 72h); the Execution then fails with a policy-timeout
error, recorded in Trace.

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
3. **Secrets encrypted at rest** (master key, operator-manageable).
4. **Per-tool + input-aware policy** gating every call (allow/approval/block).
5. **SSRF control**: private-network egress off by default.
6. **Sandbox resource limits**: per-execution wall-clock timeout, memory ceiling, and
output-size cap (defaults 60s / 128 MB / 1 MB; operator-tunable). A runaway
`while(true)` is interrupted, not babysat.
7. **Pluggable auth**: built-in session auth or delegated identity (Access/JWT).
8. **Origin pinning**: `CONDUIT_WEB_BASE_URL` must match for browser logins.
9. **Audit**: every call traced and exportable; secrets redacted in Trace.

---

## 17. Phased build plan (parity, sequenced)

**Phase 0 — Core SDK (`@conduithq/sdk`)**

- Data model (Source/Integration/Connection/Tool/Policy/Execution).
- Normalizers: OpenAPI + MCP first (GraphQL + custom JS next).
- Catalog + `tools.search` / `tools.describe.tool` / typed call.
- QuickJS sandbox + the `execute` tool + 4-step workflow.
- Credential resolver + boundary invariant. SQLite storage. Secrets-at-rest.

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
- **Trace as replay log:** ✅ **`TraceEvent.output` carries the full
(response-capped) call result** (§5.5, §11) — the Trace store doubles as the durable replay
journal for `call` ops; `outputSummary` is a display projection. Persisting
`search`/`describe` journal entries is deferred to the §5.5 execution-manager work.
**Audit semantics:** refusals (policy-denied, blocked) and allowed calls that reached the
upstream caller and failed are traced (the latter with the allow verdict and no output); pre-flight
refusals (no connection, unsupported source type, exhausted budget) and infra faults are not traced —
infra faults live host-side under a correlation id. A failed trace append fails the call: an
unauditable call must not silently succeed.
- **Upstream scope (v1):** ✅ **MCP-only, behind a per-source-type seam** (§5.3) —
JSON-RPC 2.0 `tools/call` with the namespace prefix stripped to recover the upstream tool
name. Known limitation: MCP names the normalizer transformed don't round-trip until the original
name is stored in `sourceSemantics`. Other source types fail closed ("not yet callable").

**Deferred (future phases — none block v0.1 / Phase 0):**

1. **Auth library** for built-in mode (better-auth-equivalent) and the delegated-auth contract — Phase 1.
2. **Trace storage scale** (SQLite fine locally; Cloud needs a real store + retention tiers) — Phase 4.
3. **npm allowlist contents**: which packages ship vetted by default (AI SDK, validation, etc.) — Phase 0/1.
4. **Pricing shape** for Cloud (out of scope per editorial standard, but flag for product) — Phase 4.
5. **Approval push notifications** (webhook/Slack) beyond console/CLI/agent surfacing — Phase 2.
6. **Per-connect egress pinning** (§9.3): the v1 guard resolves DNS and checks every
address, then `fetch` re-resolves independently — a DNS-rebinding TOCTOU window. Closing it
means resolving once and forcing the connection to the vetted IP — Phase 1.
7. **UpstreamCaller as a trusted dependency** (§5.3, §9.2): the pipeline treats an
injected `UpstreamCaller` as trusted infrastructure — the same posture it holds toward the
store and policy engine — not as an adversary. So the invoker does NOT re-validate a custom caller's
error name against its kind, nor re-scan a custom caller's success result for the credential; those
defenses live in the built-in MCP caller. Rationale: a custom caller is host-side code the operator
installs, and a hostile one already holds the secret in its own `call()` scope, so
smuggling it back through the invoker buys an attacker nothing. If Conduit ever runs
operator-untrusted caller plugins, this decision reopens and the invoker gains its own output/name
validation. (Decided 2026-07-08 after a codex adversarial re-pass raised both as findings.)

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
`apps/host-selfhost`, `apps/host-cloudflare` (later: `apps/desktop`, web console).
- **QuickJS binding:** `quickjs-emscripten` — the same WASM build runs in Node and in
Cloudflare Workers, which is what makes §13 deployment parity real rather than aspirational.
- **Schemas & validation:** tools carry **JSON Schema** natively (OpenAPI and MCP already
speak it); runtime validation via **Ajv**. Internal configs validated with **Zod**.
- **Storage:** `@libsql/client` (file URL locally; D1 adapter on Workers) behind one
storage interface.
- **Tests:** Vitest. **Build:** tsup (per-package ESM bundles). **Lint/format:** deferred
to Phase 1 (keep Phase 0 friction low).
