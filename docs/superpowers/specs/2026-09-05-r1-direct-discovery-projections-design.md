# R1 — direct + discovery projections with capability profiles — design

Status: revision 3 — codex interim findings + fable code-verifying
audit folded (§12); codex re-run and in-session eng review pending
Date: 2026-09-05
Scope: spec §17 R1 (re-sequenced 2026-08-30, §18 repositioning entry)
Builds on: `2026-08-15-daemon-ownership-design.md` (capability rows, UDS
transport), `2026-08-22-daemon-control-hot-reload-design.md` (shared
runtime catalog, `refreshNamespace`), `2026-07-09-execution-manager-design.md`
(pause/resume, decisions seam)
Inputs: the R1 design brief, invariant inventory, and threat-model delta
(private artifacts, 2026-08-30; titles only per the public-safe rule);
founder decisions D1–D6 (2026-08-30) and A1–A5 (2026-09-05, §2).

## 1. What R1 ships

R1 exposes the tools the daemon already governs as two new MCP
projections over the one authority pipeline, scoped per client by a
profile, without weakening any §9.2 / §9.3 / §10 guarantee the two-tool
surface enforces today.

- **Direct projection.** Each callable tool in the client's effective
  scope is advertised individually on `tools/list` with its own input
  schema. A call runs the per-call enforcement pipeline exactly as an
  in-sandbox `tools[path](input)` call does.
- **Discovery projection.** `search`, `describe`, and `call` as MCP
  tools. `search` and `describe` are the shipped `serve` RPC kinds
  answered from the shared catalog; `call` is a governed execute-one.
- **Capability profiles.** A per-client profile (projection flags plus
  an allowlist) bound at handshake by an operator-chosen client id and
  revalidated on every call. A profile only narrows.
- **Direct execution record.** The execution row gains a `kind`
  discriminator (`code` | `direct`). A paused direct call is a stored
  canonical call, resumed by performing exactly that call.
- **Admin row.** A new `admin` capability row carrying profile
  administration and the re-homed source-removal verb, reached by
  `conduit profiles` and `conduit remove-mcp`.
- **Code Mode unchanged.** `execute` / `check_execution` stay
  byte-identical for a client with the default profile.

Not in R1: any HTTP surface (the §16 gate stands); input-aware
predicates (R2); revision or policy-version columns (R2); profile
administration UX beyond the CLI verbs here; connector work; push
notification of approval outcomes (polling only).

## 2. Decisions

Settled 2026-08-30 (eng review, founder-decided), carried verbatim:

- **D1** — one `executions` table, a `kind` variant; the status enum is
  SHARED, with per-kind meaning documented (§4.1).
- **D2** — profile administration is a NEW capability row plus a
  `conduit profiles` CLI; no administrative verb touches `serve`.
- **D3** — until revision fields exist: any successful provision /
  refresh / removal of a namespace invalidates every paused direct call
  on that namespace's tools; resume fails closed with a re-approve
  outcome.
- **D4** — mid-connection narrowing bites on the SAME connection; no
  re-handshake can re-widen.
- **D5** — equivalence-class invariants are written ONCE in a
  projection-parameterized harness; per-projection copies are
  disallowed.
- **D6** — the profile is the advertisement budget; the default profile
  does not enable direct advertisement.

Settled 2026-09-05 (this brainstorm, founder-decided):

- **A1 — widen `serve`, do not add a `direct` row.** The agent-facing
  client stays one capability row. `serve` gains one kind, `tool.call`.
  Handshake gains an optional `clientId`; the profile carries the
  authority scope. Rationale: a row per projection would put the
  projection flag in two places (row and profile), which is the T2/T3
  shape; D-B1's own comment records that the no-widening prohibition
  guards ADMINISTRATIVE verbs, and `tool.call` is not one.
- **A2 — allowlist granularity: namespaces and exact qualified tool
  names, no patterns.** A namespace entry grants every tool the
  namespace currently has; a tool entry grants one tool.
- **A3 — client identity is an explicit flag, `conduit serve --client
  <id>`.** Operator-chosen, visible in the MCP client config the
  operator already writes. Absent → default profile. Unknown id → the
  handshake is refused (fail closed; a typo never widens).
- **A4 — `requestKey` lives on the discovery `call` tool only.** Direct
  tools take the upstream input as-is; no reserved argument, no
  `_meta` dependency. A direct tool call without a key that loses its
  response is reported outcome-unknown and never retried (§7).
- **A5 — one `admin` row; CLI `conduit profiles list|set|remove` and
  `conduit remove-mcp <namespace>`.**
- **A6 — direct execution lives in the execution manager** as a
  sibling entry point (`startDirect`), sharing persist-before-run,
  `claimForResume`, the decisions seam, TTL expiry, the settle guards,
  and `decisionApplied`. A separate executor (rejected) would duplicate
  the resume machinery — threat T3 in code form. Synthesizing a Code
  Mode program per direct call (rejected) pays a sandbox drive and a
  queue slot per call and makes the projections indistinguishable in
  Trace (#10).
- **A7 — the allowlist applies to EVERY projection the profile enables,
  Code Mode included.** A named profile with Code Mode on and
  `allow:["github"]` gives the sandbox a GitHub-only catalog; an
  in-sandbox call outside it fails closed at the invoker. Only the
  unnamed default profile carries the full catalog. Without A7 a
  narrowed direct profile is bypassed by one `execute`.

## 3. Threat model (delta, per the 2026-08-30 threat-model artifact)

Grade B holds: the host is trusted; model output, guest code, project
content, and upstreams are untrusted. Client identity is client-declared
(A3) — the same posture as capability rows: "the capability set scopes
an HONEST client — it is not a privilege boundary against a hostile
same-UID process" (`rpc.ts`, verbatim). Real peer authentication is
Grade A work.

New surfaces and their answers:

- **T1 authority drift between approval and execution** → the stored
  canonical call (§4.1), per-field drift rules (§6), D3 fail-closed
  catalog change.
- **T2 stale advertisement as authority** → scope is recomputed on
  every call from current profile + current catalog (§5.2); the
  advertised list is never consulted for authority; `listChanged`
  stays `false` — politeness, not enforcement.
- **T3 projection asymmetry** → the D5 harness (§9.2) runs the §9.2
  hygiene, trace-comparability, and request-key tests over both kinds.
- **T4 direct-execution ambiguity windows** → §7.

## 4. Data model

All changes are additive and travel through the store's existing
PRAGMA-then-ALTER ladder with `tolerateSchemaRace` (M5). Fresh DDL
carries CHECK vocabularies; legacy databases are guarded read-side, the
pattern `sqlite.ts` already documents.

### 4.1 Execution record (D1)

```
ALTER TABLE executions ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'
ALTER TABLE executions ADD COLUMN direct_call TEXT
ALTER TABLE executions ADD COLUMN client_id TEXT
```

Fresh DDL adds `CHECK (kind IN ('code','direct'))`. The ALTER shape
has precedent through `tolerateSchemaRace` (`sqlite.ts:129-138`, the
`redact_fields` retrofit).

`client_id` is written for BOTH kinds at `start`/`startDirect` (null
for the default profile) — it is what lets `resume` rebuild the scope
thunk for a Code Mode row as well as a direct one (§5.4). Without it a
program under a narrowed profile that pauses on an allowed tool would
resume with the full catalog (audit P0).

`code` and `seeds` stay `NOT NULL`: SQLite cannot drop a NOT NULL
through ALTER, and a table rebuild races across processes (M5). A
direct row stores `seeds = '{}'` and, as `code`, the sentinel program
`throw new Error("direct execution row: not a program")`. The sentinel
— not `''` — is deliberate downgrade protection: an OLDER daemon build
that does not know `kind` would otherwise resume a direct row as the
empty program, complete it with `null`, and record a landed approval
that performed no call. With the sentinel an old build fails the row.
The lifecycle lock does not prevent a daemon downgrade. Hydration
discards both fields by `kind`. Read-side guard: `kind = 'direct'` iff `direct_call` is
present and non-null; `kind = 'code'` iff `direct_call` is null. A row
violating either is corrupt and is refused on read with a named error,
never silently coerced.

`direct_call` is JSON `{ "toolName": string, "namespace": string,
"request": string, "sourceGeneration": number }`. `namespace` is
stored as its own field so the sweep matches by equality — never by
`LIKE`, whose `_` wildcard is a legal namespace character.
`sourceGeneration` is the namespace's `sources.generation` (§4.1a) as
read immediately before the row is persisted (two statements; the
read-then-provision-then-put TOCTOU is caught by the resume check,
§5.4 step 3, so a single-transaction `putDirect` is not required).
`request` is the SAME canonical serialization the decisions seam binds
on: `JSON.stringify(input)` as computed by the invoker
(`invoker.ts:282`). Round-trip property, pinned by test: for any
JSON-serializable input, `JSON.stringify(JSON.parse(request)) ===
request` — `JSON.parse` preserves key order and `JSON.stringify` emits
insertion order, so a resumed direct call rebuilds the byte-identical
identity the approval was bound to.

TypeScript:

```ts
interface ExecutionBase {
  id: string; status: ExecutionStatus; pausedOn?: PendingApproval;
  startedAt: number; endedAt?: number; requestKey?: string;
  clientId: string | null;
  result?: unknown; error?: ExecutionError;
}
type Execution =
  | (ExecutionBase & { kind: "code"; code: string; seeds: { now: number; random: number } })
  | (ExecutionBase & { kind: "direct";
      call: { toolName: string; namespace: string; request: string; sourceGeneration: number } });
```

The direct arm's failure payload is the SDK's `ExecutionError`
(`types.ts`), not the sandbox package's structurally identical
`SandboxError`: the manager's direct arm must not import from
`sandbox/`.

```
```

Status enum shared (D1), per-kind meaning:

| status | code | direct |
| --- | --- | --- |
| running | sandbox driving the program | performing the one governed upstream call |
| paused | suspended on a pending call; replay on resume | approved-or-not canonical call stored; perform on resume |
| completed | program returned | upstream returned; `result` is the redacted upstream result |
| failed | program threw / infra / divergence | policy block, credential/upstream/infra failure, D3 invalidation, or outcome-unknown |
| expired | pause TTL elapsed | pause TTL elapsed |

A direct execution writes NO `replay_journal` rows.

`ExecutionRepository` gains `invalidatePausedDirect(namespace: string):
Promise<number>` — flips every `paused` `direct` row whose
`direct_call.namespace` EQUALS `namespace` to `failed` with error
`{ name: "ConduitCatalogChanged", message: "catalog changed — re-approve" }`,
`endedAt` set, `pausedOn` cleared, in one statement. Returns the count.
This sweep is HOUSEKEEPING for the approvals list; it is not the
authority for D3. The authority is the generation check on resume
(§4.1a, §5.4), which closes the race the sweep alone leaves open: a
resume that has already won `claimForResume` (row now `running`) is
invisible to a `WHERE status='paused'` sweep and would otherwise perform
the approved call against the changed catalog.

### 4.1a Source generation (the minimal provenance field)

```
ALTER TABLE sources ADD COLUMN generation INTEGER NOT NULL DEFAULT 0
```

`provisionSource` bumps `generation` inside its existing single
transaction (`sqlite.ts` `client.batch`; both provision and revalidate
reach it through `fetchAndProvision`, `provision.ts:837`, so one bump
covers both). The new value is TABLE-WIDE monotonic, not per-row:
`COALESCE((SELECT MAX(generation) FROM sources), 0) + 1`, applied on
insert AND on `ON CONFLICT(id) DO UPDATE`. A per-row counter would
restart at 0 after `source.remove` + re-add, and a direct row claimed
across that pair would compare equal to the new incarnation (audit
P1). SQLite serializes the write transaction, so the table-wide read
is race-free. `source.remove` deletes the row, so a later lookup finds
no generation at all. Pinned: "remove then re-add does not revive a
paused direct row". `Source` gains `generation:
number`. This is the R1 provenance field the brief anticipated; R2 adds
tool-level revision on top of it.

### 4.2 Profiles (D2)

```
CREATE TABLE IF NOT EXISTS profiles (
  client_id TEXT PRIMARY KEY,
  projections TEXT NOT NULL,
  allow TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)
```

```ts
interface Profile {
  clientId: string;                       // /^[a-z0-9][a-z0-9_-]{0,63}$/
  projections: { code: boolean; direct: boolean; discovery: boolean };
  allow: string[];                        // namespaces or qualified tool names
  updatedAt: number;
}
interface ProfileRepository {
  get(clientId: string): Promise<Profile | undefined>;
  list(): Promise<Profile[]>;
  put(profile: Profile): Promise<void>;   // whole-row replace
  remove(clientId: string): Promise<void>;
}
```

The default profile is NOT a row. It is a constant:
`{ projections: { code: true, direct: false, discovery: false }, allow: ALL }`
where `ALL` is a sentinel meaning the full current catalog. A wiped or
missing table therefore cannot widen anything: no row → no named
profile → handshake refused for any `clientId`.

### 4.3 Trace

```
ALTER TABLE trace_events ADD COLUMN projection TEXT NOT NULL DEFAULT 'code'
```

Fresh DDL adds `CHECK (projection IN ('code','direct','discovery'))`.
`TraceEvent.projection` is set by the invoker from its options. No other
trace change; #10 is testable from stored rows.

### 4.4 Not added

No tool-level revision; no policy version. `sources.generation` (§4.1a)
is the only provenance field in R1; R2 builds tool revision and policy
version on it.

## 5. Daemon

### 5.1 RPC vocabulary

`handshake` gains `clientId?: string`, accepted ONLY when `capability`
is `serve`; any other row carrying it is refused (`invalid`). The daemon
refuses a `serve` handshake whose `clientId` fails the grammar or names
no profile row:
`code: "invalid", message: 'unknown client id "<id>"'`. The connection
context stores `clientId` (or `null` for the default profile) — never
the resolved scope.

`serve` gains:

```ts
| { kind: "tool.call"; toolName: string; input: unknown;
    requestKey?: string; projection: "direct" | "discovery" }
```

`toolName` is the qualified name. `projection` is recorded in Trace
only; it grants nothing (both values route identically). Decoded
field-by-field like every other kind; `input` is REQUIRED and must be
a JSON value — the decoder refuses a frame without it, because
`JSON.stringify(undefined)` is not a string and would break the §4.1
round-trip. Normalization of an absent MCP `arguments` happens in the
server (§8.5), never here.

`describe` gains `includeSchemas?: boolean` (Lane B wire change). The
shipped handler calls `catalog.describe(name)` with no options, and
the catalog attaches `inputSchema` only on request (`catalog.ts:112`),
so the discovery `describe` tool (§8.4) sends `includeSchemas: true`;
in-sandbox `describe` is unchanged.

**Input-schema validation: none, on either projection (parity).** No
shipped path validates a tool's input against its `inputSchema`
(`jsonschema.ts` is not on the call path; the invoker forwards `input`
as-is and the upstream rejects what it rejects). R1 keeps that parity:
the advertised `inputSchema` is advertisement, not enforcement, on the
direct projection exactly as it is inside Code Mode today. Adding
validation is a behaviour change on both projections and is deferred
(R2 candidate, alongside input-aware policy which needs the same
schema machinery).

New row:

```ts
admin: new Set(["handshake", "profile.list", "profile.set", "profile.remove", "source.remove"])
```

```ts
| { kind: "profile.list" }
| { kind: "profile.set"; profile: { clientId; projections; allow } }
| { kind: "profile.remove"; clientId: string }
| { kind: "source.remove"; namespace: string }
```

`source.remove` carries ONLY a namespace (the §3.3.1 anti-oracle shape:
identity, never a url). No response on any row carries a credential.

The no-widening pins extend: `serve` still holds no administrative verb
(`profile.*`, `source.*`, `daemon.*`, `approvals.*` all absent);
`admin` holds no agent-facing verb (`execute`, `tool.call`, `search`,
`describe` absent) and no approval verb.

### 5.2 Effective scope

```ts
interface EffectiveScope {
  projections: { code: boolean; direct: boolean; discovery: boolean };
  callable: (qualifiedName: string) => boolean;
  listing: () => Promise<Tool[]>;         // store.tools.list() ∩ allow
}
function effectiveScope(profile: Profile | DEFAULT, catalog: Catalog, store: ConduitStore): EffectiveScope
```

Which catalog answers what: `callable` and `listing` read the STORE
(`store.tools`), because the invoker resolves tools from the store
(`invoker.ts:111`) and the store is the catalog-of-record;
`search`/`describe` filter the in-memory catalog by `callable`. The
in-memory `Catalog` interface gains no `list()`. The
`EffectiveScope` TYPE is declared in the SDK (Lane A) because
`startDirect`/`makeInvoker` signatures need it; the daemon function
that builds one is Lane B.

Pure over (profile row as read NOW, catalog as it is NOW). Computed on
every `execute`, `tool.call`, `search`, `describe`, and
`catalog.listing` — never cached on the connection, and NEVER captured
at drive start: what the daemon hands the manager and the invoker is a
thunk (`() => EffectiveScope`) evaluated on every in-sandbox call and
on every direct call, so a profile narrowed while a long Code Mode
drive is running bites on that drive's next call. `callable(name)` is
true iff the tool exists in the catalog AND (`allow` is `ALL`, or
contains `name`, or contains `name`'s namespace).

Consequences, each pinned (§9):

- a removed tool is uncallable on the next call (#4);
- a cached advertisement grants nothing (#5, T2);
- every call checks current authority (#6);
- upstream growth cannot widen a tool-level entry; a namespace entry
  grows with its namespace BY DEFINITION and the spec says so (#8);
- a profile can only narrow: the intersection is bounded by `allow`
  whatever the client requests (#9);
- narrowing the profile row bites on the SAME open connection, and a
  second handshake claiming a wider role is refused as today (#13, D4).

### 5.3 Dispatch

- `execute` (Code Mode): refused with `code: "invalid"` when
  `projections.code` is false. Otherwise as today, except the manager
  is given a per-drive `scope` (§5.4) so A7 holds.
- `tool.call`: refused when the requested projection flag is false or
  `callable(toolName)` is false — refusal reason names the tool, never
  the profile's other entries (no oracle over the allowlist). Otherwise
  `manager.startDirect(toolName, input, { requestKey, projection })`.
  Runs OUTSIDE the sandbox queue (D-B1's reasoning: it touches no
  sandbox) but under its own DAEMON-WIDE admission cap,
  `DIRECT_ADMISSION_MAX` (a daemon constant, not client-chosen, not
  per-connection), so the daemon as a whole cannot hold unbounded
  concurrent upstream calls. Over cap → `code: "busy"` (the same code
  `execute` uses) with its own text: "daemon busy: N direct calls in
  flight (cap M)".
- **Client budget for `tool.call`:** the server's `deadlineForRequest`
  gains a `tool.call` arm, `DIRECT_CLIENT_DEADLINE_MS =
  DIRECT_ADMISSION_DEADLINE_MS + DEFAULT_UPSTREAM_TIMEOUT_MS + 30_000`,
  so the client budget exceeds the daemon's worst legal answer time
  (the `server.ts` ordering invariant, ledger L126). Without the arm
  the 30 s read default would produce false outcome-unknowns on slow
  but legal calls.
- `search` / `describe`: answered from the shared catalog FILTERED by
  `callable`. A `describe` of an out-of-scope tool returns `null`,
  indistinguishable from a nonexistent tool.
- `catalog.listing`: returns the scope's projection flags plus the
  scoped listing; the server builds `tools/list` from it (§6).
- `approvals.resume`: unchanged wire shape. The daemon reads the row's
  `kind` BEFORE admission: a `code` row is admitted through the sandbox
  queue as today; a `direct` row is admitted under `DIRECT_ADMISSION_MAX`
  — a direct resume must not consume a sandbox slot. The manager then
  branches on `kind` (§5.4).
- `profile.set` / `profile.remove`: validate, write, respond. No reload
  step exists because scope is read live.
- `source.remove`: in one transaction delete the namespace's tools,
  policies, connection, integration, source, and the connection's
  sealed secret if any; then `catalog.removeNamespace`; then
  `executions.invalidatePausedDirect(namespace)`; respond with counts.
  A missing namespace is a named error, not a silent no-op.

**D3 sweep placement (pinned):** the sweep is anchored to the STORE
commit, not the in-memory catalog mutation — the invoker resolves
tools from the store, and `refreshNamespace` only mutates memory and
never throws. In both provisioning paths (`fetchAndProvision` →
`provisionSource`) and in `source.remove`, `invalidatePausedDirect`
runs AFTER `provisionSource` / the removal transaction has committed,
inside the same per-namespace source lock, and BEFORE the source
request is answered. A sweep that throws is logged and the request
still succeeds: the sweep is housekeeping; the generation check (§5.4)
is the authority.

### 5.4 Execution manager

```ts
startDirect(toolName: string, input: unknown,
  opts?: { requestKey?: string; projection: "direct" | "discovery"; scope?: EffectiveScope }
): Promise<ExecutionOutcome>;
```

Sequence:

1. `requestKey` present → persist-before-run as `start` does; an
   existing row with that key → `conflict` (unchanged semantics, #11).
2. Persist `{ kind: "direct", status: "running", clientId, call: {
   toolName, namespace, request: JSON.stringify(input),
   sourceGeneration } }` BEFORE any upstream contact;
   `sourceGeneration` is read from `sources` for the tool's namespace
   immediately before the put (§4.1).
3. Build the invoker exactly as `start` does (`makeInvoker` with
   executionId, deadline, upstream session scope) and call
   `invoke(toolName, input)` once. The drive deadline is the default
   wall-clock budget (`DEFAULT_SANDBOX_LIMITS.wallClockMs`, 60 s) —
   named here because `deadlineFor` is sandbox-shaped and the direct
   arm computes its own.
4. Settle through the SAME guarded persistence path (`completed` with
   the result; `failed` with the classified error). The prep window
   (session scope, invoker construction) terminalizes `failed` on any
   throw, as `start` does today (§18-C4 / §6 rows).
5. On the invoker's `require_approval` error (`ConduitCallError` kind
   `policy`, name `ConduitPolicyDenied`, `errors.ts:71-78`, which the
   manager already recognizes by name): write `paused` with
   `pausedOn = { callId, toolName, input, reason, expiresAt }` —
   the manager writes it directly, since no sandbox suspension exists.
   The outcome is `{ status: "paused", executionId, pending }`, the
   same shape `start` returns.

`resume(executionId, decision)` on a `direct` row:

1. `claimForResume` (unchanged CAS; lose → `conflict`; TTL lazily
   expires as today). The claim IS the sweep check: a row the sweep
   already failed is no longer `paused`, so the claim loses.
2. **Generation check (D3 authority):** read the namespace's current
   `sources.generation`; missing (source removed) or not equal to
   `call.sourceGeneration` → terminalize `failed` with
   `ConduitCatalogChanged` (`failClaimedResume`), `decisionApplied:
   false`. This runs AFTER the claim, so a provision that commits
   between the sweep and the claim is still caught.
3. Revalidate the grant: the manager evaluates the CURRENT scope thunk
   for the row's `clientId` (`scope().callable(call.toolName)`); false →
   terminalize `failed` with `ConduitScopeRevoked`, `decisionApplied:
   false`.
4. Stage the decision bound to `{ op: "call", toolName: call.toolName,
   request: call.request }`, build the invoker with `decisions`, and
   invoke with `(call.toolName, JSON.parse(call.request))`. The
   invoker's existing identity check consumes the decision only on an
   exact match, so the call performed is byte-identical to the one
   approved; policy is re-evaluated by the invoker path as today only
   when no decision is staged — with a staged decision, the D6 branch
   applies, exactly as for Code Mode. `decisionApplied` is reported
   host-side as today.
5. Settle as in `startDirect`.

**Scope on resume, both kinds:** `resume(executionId, decision,
scopeFor)` takes a `scopeFor: (clientId: string | null) => () =>
EffectiveScope` factory from the daemon, rebuilds the thunk from the
ROW's `clientId`, and threads it into `makeInvoker` and the tool host
exactly as `start` does. A code row that paused under a narrowed
profile therefore resumes under that profile, not the full catalog
(audit P0). Pinned: narrow profile → pause on an allowed tool →
approve → an out-of-scope call after resume is blocked.

Code Mode (`start`) gains an optional `scope` THUNK: the manager passes
it to `makeInvoker`, and the tool host it builds is a live filtered
catalog view (`createCatalogToolHost(scopedCatalog, invoke)` where
`scopedCatalog` consults `scope()` on every `search`/`describe`), so
in-sandbox discovery cannot see out-of-scope tools and an out-of-scope
`tools[path]()` is blocked by the invoker at call time.

### 5.5 Invoker

`CreateToolInvokerOptions` gains `projection: "code" | "direct" |
"discovery"` (recorded on every Trace row) and `scope?: () =>
EffectiveScope` (a thunk, evaluated per call — §5.2). Step 1 of
`runCall` becomes: look up the tool; if `scope` is present and
`scope().callable(path)` is false, treat exactly as an unknown tool —
`block` with reason `Tool "<path>" is outside this client's scope.`,
audited, guest-safe name `ConduitPolicyBlocked`. No other change to the
pipeline. The §9.2 boundary is untouched: the credential is resolved at
step 4 as today and never enters any projection's response.

## 6. Approval binding and drift (R1 position)

The approved action binds: principal · client · projection · qualified
tool identity · canonical arguments · decision. Bound in R1 by the
stored row (`direct_call`, `pausedOn`, and `client_id`, written at
start for both kinds).

| element | R1 rule | mechanism |
| --- | --- | --- |
| principal, client id, projection | immutable | stored on the row; a resume comes only via the `approvals` row (human), never via a client |
| qualified tool identity, canonical arguments | immutable | decisions seam exact-match; byte-identical rebuild (§4.1) |
| decision | immutable, one-shot | decisions seam `take` |
| effective capability grant | revalidate on resume | §5.4 step 3 |
| policy version | R1 INHERITS D6: a staged approval applies to exactly one byte-identical call and skips the policy engine, for Code Mode today and for direct now. The brief's "a stricter policy is never bypassed by an old approval" rule needs a policy version to compare against and is R2 work; stated here so it is not read as shipped. | invoker (unchanged) |
| credential secret version | resolve live if connection unchanged | invoker step 4 (unchanged) |
| tool/source revision | **fail closed on any namespace write (D3)** | `sources.generation` compared after the resume claim (authority) + `invalidatePausedDirect` sweep (housekeeping) |
| upstream destination | immutable identity; egress pinning reruns live | §9.3 (unchanged) |
| runtime version | informational | `AGENT_VERSION` in Trace context (unchanged) |

R2 replaces the D3 proxy with revision + policy-version binding.

## 7. Errors and the three ambiguity invariants (T4)

Error format follows `[Module] Operation failed: reason. Context: {…}`.

- **Upstream completed, crash before persist.** The row stays `running`
  with no settle. The existing crash-terminal sweep
  (`sweepOrphanedExecutions`, `WHERE status='running'` with no kind
  filter) terminalizes it `failed` at the next daemon start with error
  name `ConduitOutcomeAmbiguous` and the sweep's reason text
  (`sweep.ts:35-38`); `check_execution` consumers key on that name;
  the message says the upstream effect MAY have landed. Conduit never
  re-performs it.
- **Keyless upstreams (documented accepted ambiguity).** A direct tool
  call (A4) has no `requestKey`. If the client loses the response, it
  cannot ask "did it run?" by key — only by execution id, which it also
  lacks if the response never arrived. Accepted for R1 and stated in
  the direct projection's tool descriptions: reissue-safe writes go
  through `call` with `requestKey` or through Code Mode.
- **Timeout-unknown.** The upstream caller's `timeout` classification
  does NOT record whether the request body was sent (`upstream.ts`,
  `McpClientError("timeout", …)`), so R1 cannot tell a pre-send from a
  post-send timeout. Conservative rule: EVERY direct-call timeout
  settles `failed` with the timeout error and a message that names the
  outcome as unknown ("the upstream may have performed the call"). Never
  retried by Conduit. Adding a sent marker to the wire layer is a
  deferred precision improvement, not an R1 requirement.
- **Outcome-unknown on the IPC hop** (daemon connection lost after
  send): the server's existing wording, verbatim, pointing at
  `check_execution`.

Concurrent double-resume needs no new mechanism: `claimForResume` is
the exactly-one-winner CAS (ledger gap G2 closes with its row, §9.3).

## 8. MCP surface

### 8.1 Serve

`conduit serve [--client <id>] [--state-dir …]`. `--client` parses in
`bin.ts` next to `--state-dir` and threads `ServeOptions →
RunStdioServerOptions → DaemonRequestOptions` onto the handshake frame;
absent → default profile (today's surface, byte-for-byte, #12). The
bare `conduit-mcp` bin (`runStdioServer()` with no argv parsing) stays
default-profile-only in R1; profiles are reached through `conduit
serve`.

### 8.2 `tools/list`

Built per request from `catalog.listing` (never cached — T2). The
`CatalogListing` payload gains `projections` and `tools` (scoped
qualified names + descriptions + schemas); the client guard already
tolerates extra fields, and a listing from an OLDER daemon that omits
them is read as code-only with no direct tools (fail closed, never
widen).

| projection flag | tools advertised |
| --- | --- |
| code | `execute`, `check_execution` (as today) |
| discovery | `search`, `describe`, `call`, `check_execution` |
| direct | one tool per `listing()` entry, `check_execution` |

`check_execution` appears exactly once whatever the flags. Any
projection with no callable tools still advertises its verbs
(`search` over an empty scope returns no hits).

The direct projection's list size for the dogfood profile is recorded
as acceptance EVIDENCE (a measurement), not a cap (D6).

### 8.3 Tool-name mapping (open decision #3, closed here)

Qualified names are `namespace.local` with namespace `[a-z0-9_-]+` and
local rewritten to `[A-Za-z0-9_.]+` at normalize time; the only
character MCP-side clients (`^[a-zA-Z0-9_-]{1,64}$`) forbid is the dot.

`advertisedName(qualified)`:
1. replace every `.` with `_`;
2. if the result exceeds 64 characters: first 55 characters + `_` +
   the first 8 hex characters of SHA-256 over the qualified name;
3. collisions are computed over the FULL catalog (never the scope), so
   a profile change never renames a tool; every member of a colliding
   set takes the step-2 hash suffix;
4. the five reserved verb names — `execute`, `check_execution`,
   `search`, `describe`, `call` — are members of EVERY collision set:
   a catalog tool whose step-1 name equals a verb (namespace `check`,
   tool `execution` → `check_execution`) takes the hash suffix, so a
   verb is never shadowed and `tools/call` dispatch, which matches verb
   names first, cannot be hijacked by a catalog entry.

The daemon builds `advertised → qualified` from the catalog and
resolves a `tools/call` name by exact match against that map — never by
parsing. Accepted limit, documented: adding a tool that collides with
an existing advertised name renames the existing one on the next
listing; `listChanged` stays `false` and the cached list was never
authority.

### 8.4 Discovery tools

- `search { query: string }` → hits `{ path, description?, riskClass }`
  (schema-free, §8), scoped.
- `describe { tool: string }` → description + input schema (the RPC is
  sent with `includeSchemas: true`, §5.1), or "not found" for
  out-of-scope, indistinguishable from nonexistent.
- `call { tool: string; input: unknown; requestKey?: string }` →
  `tool.call` with `projection: "discovery"`.

### 8.5 Direct tools

Name per §8.3; `description` = the tool's description prefixed by its
risk class (`[review] …`), so a client sees the approval likelihood;
`inputSchema` = the tool's own. Arguments pass to `tool.call` as
`input` with `projection: "direct"`, with ONE normalization: an absent
MCP `arguments` becomes `{}` (MCP parity; the server already does
`args ?? {}` for `execute`), so `input` is always a JSON value and the
§4.1 round-trip holds. Inside Code Mode a missing argument normalizes
to `null` (`quickjs.ts`); the two projections differ here by design
and the spec says so.

### 8.6 Responses

Same envelope family as `execute`: completed → the redacted result as
content; paused → the pending shape with `executionId` and the human
step spelled out; failed → the guest-safe error; outcome-unknown → the
existing wording. The client polls `check_execution` after a pause; no
push channel in R1.

M1 restated per projection: no projection advertises or accepts an
approval verb; `approvals.resume` remains reachable only through the
`approvals` row.

## 9. Testing and ledger

### 9.1 Acceptance rows (enter INVARIANTS.md as ⏳ in the spec commit)

| # | claim | pinning test (planned) |
| --- | --- | --- |
| 1 | a direct call cannot bypass governance — same policy/credential/approval path as Code Mode | `execution/manager.test.ts` (direct: block, require_approval, allow) |
| 2 | direct and Code Mode cross the same §9.2 boundary | D5 harness only (`projection-harness.test.ts`); the existing `credentials.test.ts:83` INVARIANT stays as the Code Mode anchor |
| 3 | approval works without assuming `execute` | `manager.test.ts` (direct pause → resume approve/deny, `decisionApplied`) |
| 4 | a removed tool becomes uncallable immediately | `daemon/conduitd.test.ts` real processes: remove → next `tool.call` refused |
| 5 | stale discovery cannot preserve revoked authority (G3) | same file, at the RPC level (Lane B): list → revoke → `tool.call` by the cached qualified name refused; the advertised-name variant is Lane C in `server.test.ts` |
| 6 | current authority checked on every call | `effectiveScope` unit + connection test (profile edit mid-connection) |
| 7 | tool names deterministic and MCP-compatible | `server.test.ts` (grammar, length, collision set, stability under scope change) |
| 8 | upstream growth cannot silently expand a tool-level grant | `effectiveScope` unit |
| 9 | profiles only narrow | `effectiveScope` unit (allow ∩ catalog ⊆ allow; default vs named) |
| 10 | trace semantics comparable across projections | D5 harness over stored `trace_events` rows |
| 11 | request-conflict and retry defined for direct calls | D5 harness (`requestKey` conflict over both kinds) |
| 12 | two-tool clients byte-for-byte compatible | `server.test.ts` (default profile `tools/list` snapshot equals today's) |
| 13 | mid-session narrowing bites on the same connection; no re-handshake re-widens (D4) | `daemon/conduitd.test.ts` / `client.test.ts` real processes (the PR #53 pattern) |
| 14 | namespace write invalidates paused direct calls; resume fails closed re-approve (D3) — including a provision that commits AFTER the sweep but BEFORE the claim (generation check), and remove-then-re-add | `manager.test.ts` (generation mismatch after claim → `ConduitCatalogChanged`, `decisionApplied:false`; re-add does not revive) + `daemon/provision.test.ts` (sweep runs after `provisionSource` commit, inside the lock) + `source.remove` test |
| 15 | a Code Mode row that paused under a narrowed profile resumes under that profile (audit P0) | `manager.test.ts` (narrow → pause on allowed tool → approve → out-of-scope call blocked) |

Three ambiguity invariants (§7): crash-before-persist (sweep test over a
`running` direct row, Lane A); keyless-upstream documented limit (Lane
A: no retry occurs; Lane C: the direct tool description carries the
statement); timeout-unknown (any timeout settles `failed` with the
unknown-outcome wording, never re-invoked).

Two pins for the data model: the `request` round-trip property (§4.1)
and the read-side kind guard (corrupt row refused).

### 9.2 D5 harness

`packages/sdk/src/execution/projection-harness.test.ts` runs #2, #10,
#11 once each over `["code", "direct"]` using one fixture set. A
per-projection copy of any of these is a review REJECT.

### 9.3 Ledger gap fixes (G1–G3; land with the spec commit)

- G1: `server.test.ts:185` gains the `INVARIANT §4.2:` prefix and a
  ledger row "the Code Mode projection advertises exactly two tools";
  rows L23/L36 are reworded to "Code Mode projection" citing the §18
  entry.
- G2: `sqlite.test.ts:188/:204` gain `INVARIANT §5.5:` and a row
  "`claimForResume` is an exactly-one-winner CAS".
- G3: row #5 above.
- G4 (optional spec absorption of §3.3/§3.3.1) is NOT in this PR.

### 9.4 Real-process tests

#4, #5, #13, #14 follow the PR #53 pattern: a real daemon, real
clients, the assertion on the SAME connection.

## 10. Build shape (input to the plan)

Three lanes, each its own PR, each load-bearing (full gauntlet,
explainer + quiz, human-named merge):

1. **Lane A — store + manager.** §4 (all columns incl. `client_id`,
   `sources.generation`), §5.4, §5.5, the `EffectiveScope` type, D5
   harness, ambiguity invariants (manager side), rows #1–#3, #9 (unit),
   #15, G1–G3. No wire change; `serve` behaviour unchanged.
2. **Lane B — daemon + profiles + admin.** §5.1–5.3 (`tool.call`,
   `clientId` on handshake, `describe.includeSchemas`, `admin` row,
   direct admission cap, resume routing by kind, D3 sweep placement),
   `conduit profiles`, `conduit remove-mcp`, real-process tests
   #4/#5 (RPC level)/#6/#13/#14.
3. **Lane C — MCP surface.** §8, `--client`, `DIRECT_CLIENT_DEADLINE_MS`,
   rows #7, #12, the advertised-name variant of #5, the description
   statement for the keyless limit.

Buildable in that order: no lane depends on a later one (audit
confirmed after the Lane assignments above).

Constraints carried: zero new dependencies · no HTTP surface · capability
row changes are §18-recorded (this spec's landing adds the R1 entry) ·
every invariant lands with its test in the same commit · spec pair
regenerated per commit · agent never installs.

## 11. Open items handed to the plan

- `DIRECT_ADMISSION_MAX` value (daemon-wide; recommend 4, same order as
  the sandbox queue cap) and `DIRECT_ADMISSION_DEADLINE_MS`.
- Whether `profile.set` validates that every `allow` entry currently
  exists in the catalog (recommend: warn, do not refuse — a profile may
  be written before its source is added).
- (closed in rev 2) `pausedBy` lives inside `direct_call` as `clientId`.

## 12. Decision + review trail

- 2026-09-05 — brainstorm: A1–A5 founder-decided; A6–A7 agent-decided
  and disclosed; Approach 1 (manager arm) founder-confirmed.
- 2026-09-05 — spec self-review: `code`/`seeds` stay NOT NULL (ALTER
  ladder cannot drop a constraint); `request` round-trip reason
  corrected to parse/stringify order preservation; D6 policy-skip
  stated honestly (§6); `clientId` accepted on `serve` handshakes only.
- 2026-09-05 — **codex cross-model pass, interim** (the run hit the
  provider's usage limit before its final report; four findings
  recovered from its reasoning trace, each verified against code and
  folded): (1) invalidation-vs-resume race → `sources.generation`
  checked after the claim (§4.1a, §5.4); (2) scope captured per drive
  → live thunk (§5.2, §5.4, §5.5); (3) "invoker validates input
  schemas" was false → parity statement (§5.1); (4) "timeout records
  whether sent" was false → every timeout is outcome-unknown (§7).
  A full codex re-run is owed once the limit lifts.
- 2026-09-05 — **fable code-verifying audit** (48 tool uses, every
  claim checked against file:line; 1 P0 / 5 P1 / 14 P2, all folded):
  P0 — Code Mode resume ignored the profile → `client_id` column for
  both kinds + `scopeFor` on resume + row #15. P1 — per-row generation
  restarts on re-add → table-wide monotonic (§4.1a); verb names
  shadowable by catalog tools → reserved names in every collision set
  (§8.3); shipped `describe` returns no schemas → `includeSchemas`
  (§5.1, Lane B); no client budget for `tool.call` → deadline arm
  (§5.3); absent MCP `arguments` undefined → `{}` normalization +
  decoder refuses missing `input` (§5.1, §8.5). P2 — direct resume
  routed by kind before admission; busy text; cap is daemon-wide;
  sentinel program against downgrade; equality not `LIKE` on
  namespace; sweep anchored to the store commit inside the lock and
  never fails the request; `listing()` reads the store; resume step 2
  deleted; two-statement generation read accepted; sweep error name
  `ConduitOutcomeAmbiguous`; test-file names corrected; lane
  assignments fixed (`EffectiveScope` type → Lane A, description test
  → Lane C); bare `conduit-mcp` bin is default-profile-only;
  direct arm uses `ExecutionError`, never `SandboxError`.
  Confirmed by the audit: identity round-trip; reusable resume
  machinery; `ConduitPolicyDenied` catchable; ALTER precedent;
  commit-then-refresh order; sweep has no kind filter; no MCP name
  constraint enforced anywhere; `--client` threading path; listing
  payload tolerates extras; G1/G2 targets are the named tests.
