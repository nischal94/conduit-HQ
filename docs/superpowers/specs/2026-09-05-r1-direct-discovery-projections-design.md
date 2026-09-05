# R1 — direct + discovery projections with capability profiles — design

Status: revision 8 — eng review (D1–D8) and outside voice (D9–D15)
folded, §12; codex convergence pass #3 still owed (three attempts lost
to the provider's usage limit today). Not converged until pass #3 says
so.
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

**Accepted Grade-B limit (rev 8, eng-review D10):** provisioning,
revalidation, and removal are OPERATOR actions through the `add-mcp`
and `admin` rows. An operator who re-provisions or retargets a
namespace in the window between a resume's generation check and the
upstream dispatch causes that approved call to run against the new
source, by the operator's own hand. R1 does NOT serialize direct
drives against namespace writes to close that window (an earlier
revision did; the lock defended a boundary this model does not claim
and cost every provision a wait behind in-flight calls). The sweep and
the post-claim generation check (§5.4) remain: they close every
catalog-change case that is not the operator racing their own
approval.

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
ALTER TABLE executions ADD COLUMN projection TEXT NOT NULL DEFAULT 'code'
ALTER TABLE executions ADD COLUMN direct_call TEXT
ALTER TABLE executions ADD COLUMN client_id TEXT
ALTER TABLE executions ADD COLUMN program TEXT
```

Fresh DDL adds `CHECK (kind IN ('code','direct'))` and
`CHECK (projection IN ('code','direct','discovery'))`. The ALTER shape
has precedent through `tolerateSchemaRace` (`sqlite.ts:129-138`, the
`redact_fields` retrofit).

`client_id` and `projection` are written for BOTH kinds at
`start`/`startDirect` (`client_id` NULL for the default profile). They
are what let `resume` rebuild the scope for a Code Mode row as well as
a direct one (§5.4), and what let the projection FLAG — not only the
tool grant — be re-checked on every call and resume (§5.2): turning
`direct` off must make a paused direct call unresumable, and turning
`code` off must stop a running program at its next call. `projection`
is also what Trace and the approvals list report after a restart
(`check_execution` does not expose it — §5.1).

**`code` holds a sentinel for EVERY new row; the program moves to
`program`.** `code` and `seeds` stay `NOT NULL` (SQLite cannot drop a
NOT NULL through ALTER; a table rebuild races across processes, M5).
Every row written by this build stores, as `code`, the sentinel
program `throw new Error("conduit: row written by a newer build")`;
a code row stores its real program in `program`; a direct row stores
`program = NULL` and `seeds = '{}'`. Hydration reads `program` for
code rows and discards `code`. This is downgrade protection for BOTH
kinds: an OLDER build ignores unknown columns, reads `code`, and would
otherwise (a) resume a direct row as an empty program and record a
landed approval that performed no call, or (b) resume a narrowed Code
Mode row with the unscoped invoker, recreating the A7 bypass. With the
sentinel in `code`, an old build fails every new row closed. Rows
written by older builds (`program` NULL, `kind` defaulted to `code`)
hydrate from `code` as today. The lifecycle lock does not prevent a
daemon downgrade; this does. Read-side guard: `kind = 'direct'` iff `direct_call` is
present and non-null; `kind = 'code'` iff `direct_call` is null. A row
violating either is corrupt and is refused on read with a named error,
never silently coerced.

`direct_call` is JSON `{ "toolName": string, "namespace": string,
"request": string }`. **`PendingApproval` gains `namespace` and
`sourceGeneration` for BOTH kinds (rev 8, D13):** a paused Code Mode
row binds exactly one call too (`pausedOn.toolName`), and on resume the
invoker re-resolves that tool from the store (`invoker.ts:111`) — so
the D3 catalog-change rule is kind-neutral. The sweep becomes
`invalidatePaused(namespace)` over `pausedOn.namespace`, and the
post-claim generation check (§5.4) runs on every resume. `namespace` is
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
  clientId: string | null;                // null = default profile
  projection: "code" | "direct" | "discovery";
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
| completed | program returned | upstream returned. **At rest (rev 8, D12):** a SYNCHRONOUS direct completion returns the upstream result on the wire and persists NO `result` (`executions.result` is not on the §11 redaction path; an upstream that returns tokens or PII must not land in SQLite in the clear); a completion reached through RESUME persists `result` passed through `redactSensitiveFields` with the tool's policy `redactFields`, because `check_execution` must deliver it later. The credential-echo tripwire still REFUSES a result rather than redacting it. |
| failed | program threw / infra / divergence | policy block, credential/upstream/infra failure, D3 invalidation, or outcome-unknown |
| expired | pause TTL elapsed | pause TTL elapsed |

A direct execution writes NO `replay_journal` rows.

**Request keys are per client, legacy-compatible (rev 8 restores
rev 6; eng-review D11 reversed D3 after the outside voice showed the
composite index recreates on every open — `sqlite.ts:195` — so a
downgrade after cross-client key reuse fails at STORE OPEN, and the
shipped conflict detection matches the single-column constraint
message, `manager.ts:628`):** for a NAMED client the manager persists
`request_key` as `${clientId}<NUL>${key}` (U+0000 between); for the
DEFAULT profile it persists the RAW key, exactly as every pre-R1 row
was written — so no migration exists and a legacy
`check_execution({requestKey})` or reissue from a default-profile
client still finds its row. The decoder refuses a `requestKey`
containing U+0000, and the `clientId` grammar (§4.2) already excludes
it, so a named key can never be spelled as a raw key or vice versa; a
key is encoded exactly once, at persist, and decoded nowhere (lookups
encode the query the same way). No index change; the shipped
single-column unique index and its conflict-detection string keep
working. The encoding is ONE function with its own round-trip pin
(row #25). **Ownership before disclosure:** a `conflict` carries the
existing execution id ONLY when that row's `client_id` equals the
caller's; otherwise the outcome is `conflict` with no id (pinned, row
#18).

`ExecutionRepository` gains `invalidatePaused(namespace: string):
Promise<number>` — flips every `paused` row of EITHER kind whose
`pausedOn.namespace` EQUALS `namespace` to `failed` with error
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

```
CREATE TABLE IF NOT EXISTS source_generations (
  gen INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  at INTEGER NOT NULL
)
```

`provisionSource` inserts one `source_generations` row inside its
existing single transaction (`sqlite.ts` `client.batch`; both provision
and revalidate reach it through `fetchAndProvision`, `provision.ts:837`,
so one insert covers both) and writes the returned `gen` into
`sources.generation`. `AUTOINCREMENT` allocates from `sqlite_sequence`,
a durable high-water mark that row deletion never lowers — the
property a per-row counter (restarts at 0 on re-add) and a table-wide
`MAX(generation)` (reusable once the highest row is deleted; codex
reproduced `1 → absent → 1` with one source) both lack. `source.remove`
deletes the `sources` row, so a later lookup finds no generation at
all. Pinned: "remove then re-add does not revive a paused direct row",
including deletion of the current maximum and deletion of every
source. The `source_generations` table is append-only and tiny (one
row per provision); no GC in R1. `Source` gains `generation:
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
ALTER TABLE trace_events ADD COLUMN client_id TEXT
```

Fresh DDL adds `CHECK (projection IN ('code','direct','discovery'))`.
`TraceEvent.projection` and `TraceEvent.clientId` are set by the
invoker from its options (rev 7, eng review D4: audit rows are
write-once, so attribution must land at append time — R5's evidence
UX cannot backfill it). No other trace change; #10 is testable from
stored rows.

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

**Handshake state machine (rev 6):** the profile lookup is an await,
and frames on one connection dispatch concurrently
(`connection.ts:298`), so the shipped synchronous handshake-once guard
(`:472` check, `:504` assign) would let a second handshake observe an
unbound connection and overwrite the first binding. The connection
therefore carries an explicit state, `unbound → validating → bound |
closed`: the handler sets `validating` SYNCHRONOUSLY before its first
await; while `validating`, a further handshake and any ordinary request
are refused `invalid` ("handshake in progress"); a failed lookup moves
to `closed` and closes the socket; success moves to `bound` with the
capability and `clientId` assigned together. A default-profile
handshake (no `clientId`) has no await and binds as today. Pinned with
two handshakes in one tick.

`serve` gains:

```ts
| { kind: "tool.call"; toolName: string; input: unknown;
    requestKey?: string; projection: "direct" | "discovery" }
```

`toolName` is the qualified name. `projection` names which profile
FLAG this call requires (`permits(projection, toolName)`, §5.2), is
persisted on the execution row (§4.1), and labels the Trace row; both
values route through the same handler. It is NOT exposed on the
`check_execution` payload — the default-profile wire shape stays
byte-identical (#12); `conduit trace` and the approvals row are where
an operator sees it. Decoded
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
type Projection = "code" | "direct" | "discovery";
/** An IMMUTABLE snapshot: one profile row + one tool-name set, read together. */
interface EffectiveScope {
  projections: { code: boolean; direct: boolean; discovery: boolean };
  /** True iff the projection flag is on AND the tool is in catalog ∩ allow. */
  permits: (projection: Projection, qualifiedName: string) => boolean;
  listing: Tool[];                         // store.tools.list() ∩ allow, at snapshot time
}
/** The resolver the daemon hands the manager and the invoker. Async: profile
 * and tool reads are store reads. Rejects → the call fails as infra (fail
 * closed); a missing profile row for a named client → a scope with every
 * flag false and an empty listing (fail closed, never the default). */
type ScopeResolver = (clientId: string | null) => Promise<EffectiveScope>;
```

**Versioned snapshot (rev 7, eng review D7):** the daemon holds one
in-memory `scopeVersion` counter, bumped in the SAME code path as every
profile write (`profile.set`/`profile.remove`) and every namespace
write (`provisionSource` commit, `source.remove`). The resolver caches
one snapshot per client id tagged with the version it was built at and
returns it while the version is unchanged; a mismatch re-reads the
store. "Every call checks current authority" stays literally true — the
version changes in the same tick as the write, and there is no other
writer — while the hot path becomes a counter compare and a set lookup
instead of a profile read plus a full `tools.list` per in-sandbox call.
The counter starts at 0 on daemon start, which means "no snapshot", so
restart fails closed into a fresh read. Pinned: a write path that does
not bump the version is impossible (each write helper takes the bump
as a required callback), and a snapshot built before a write is never
returned after it.

`permits` checks BOTH the projection flag and the tool grant: turning
a flag off revokes exactly as removing a tool does. Every check in
this spec is `permits(row.projection, toolName)` — never the grant
alone. The resolver is async because `ProfileRepository.get` and
`store.tools.list` are; the invoker's `runCall` is already async, so
it awaits one snapshot per call. A snapshot is consistent (profile and
tools read in one store round-trip, both from the catalog-of-record —
the invoker resolves tools from the store, `invoker.ts:111`, not from
the in-memory catalog). `search`/`describe` filter the in-memory
catalog by the same snapshot's `permits`. The in-memory `Catalog`
interface gains no `list()`. The `EffectiveScope`/`ScopeResolver`
TYPES are declared in the SDK (Lane A) because `startDirect`,
`resume`, and `makeInvoker` signatures need them; the daemon function
that implements the resolver is Lane B.

Resolved fresh on every `execute`, `tool.call`, `search`, `describe`,
`catalog.listing`, `execution.get`, and `execution.getByRequestKey` —
never cached on the connection, and NEVER captured at drive start:
what the daemon hands the manager and the invoker is the RESOLVER,
awaited on every in-sandbox call and on every direct call, so a
profile narrowed (or a flag turned off) while a long Code Mode drive
is running bites on that drive's next call. `permits(p, name)` is true
iff `projections[p]` is true AND the tool exists in the catalog AND
(`allow` is `ALL`, or contains `name`, or contains `name`'s namespace).

**Result-access authority:** `execution.get` and
`execution.getByRequestKey` return a row only when `row.client_id`
equals the connection's client id (null equals null for the default
profile); a foreign row answers exactly as a nonexistent one. With
client-namespaced request keys (§4.1) a foreign key cannot even be
looked up. `check_execution` on every projection therefore reads only
the caller's own executions; the operator-facing `approvals` row is
unchanged and sees all.

Consequences, each pinned (§9):

- a removed tool is uncallable on the next call (#4);
- a cached advertisement grants nothing (#5, T2);
- every call checks current authority — flag AND grant (#6, #16);
- upstream growth cannot widen a tool-level entry; a namespace entry
  grows with its namespace BY DEFINITION and the spec says so (#8);
- a profile can only narrow: the intersection is bounded by `allow`
  whatever the client requests (#9);
- narrowing the profile row bites on the SAME open connection, and a
  second handshake claiming a wider role is refused as today (#13, D4).

### 5.3 Dispatch

- `execute` (Code Mode): refused with `code: "invalid"` when the
  snapshot's `projections.code` is false. Otherwise as today, with the
  manager given `{ clientId, projection: "code", scope: resolver }`
  (§5.4) so A7 holds.
- `tool.call`: refused when `permits(projection, toolName)` is false —
  refusal reason names the tool, never the profile's other entries (no
  oracle over the allowlist). Otherwise
  `manager.startDirect(toolName, input, { clientId, projection,
  requestKey, scope: resolver })`, under no namespace lock
  (§5.4, rev 8).
  Runs OUTSIDE the sandbox queue (D-B1's reasoning: it touches no
  sandbox) but under its own DAEMON-WIDE admission cap,
  `DIRECT_ADMISSION_MAX` (a daemon constant, not client-chosen, not
  per-connection), so the daemon as a whole cannot hold unbounded
  concurrent upstream calls. Over cap → `code: "busy"` (the same code
  `execute` uses) with its own text: "daemon busy: N direct calls in
  flight (cap M)". The slot is held until the drive SETTLES — a
  timed-out drive still unwinding keeps its slot; it is released in
  the same `finally` that disposes the upstream session scope.
- **Direct drive deadline and client budget.** The manager enforces a
  WHOLE-OPERATION deadline on a direct drive, `DIRECT_DRIVE_BUDGET_MS`
  (60 s, the same figure as the sandbox wall clock), by its own timer:
  the invoker's `deadline()` reports the remaining budget, so the
  upstream call is bounded by `min(ceiling, remaining)`, and a drive
  whose budget expires while awaiting anything else is settled
  `failed` with the classification §7 gives it — the direct arm has
  no sandbox interrupt, so this timer is its interrupt.
  **Exactly-once settlement (rev 6):** the timer and the drive
  continuation race to settle, and the shipped settle guards handle
  persistence FAILURE, not competing completions (`manager.ts:442,
  585`; execution updates are unconditional on status, `sqlite.ts:441`).
  So each direct drive owns one in-process `settled` latch — the first
  of {timer, continuation} to take it settles the row; the loser's
  result is discarded — AND persistence is fenced: every settle write
  for a direct row is `UPDATE … WHERE status = 'running' AND
  resume_attempt = ?`, the attempt id written at persist (start) or
  claim (resume), so a late continuation cannot overwrite `failed`
  with `completed`/`paused` even across a crash-restart. The timer
  does NOT abandon the continuation: it settles `failed`, then AWAITS
  the continuation (discarding its outcome) before releasing the
  admission slot and the namespace lock, so resources are held until
  the work has actually stopped. Pinned: delayed success and delayed
  refusal arriving after timeout both leave the row `failed`.
  **Admission is the slot only (rev 8, D10):** no lock is acquired for
  a direct drive, so `DIRECT_ADMISSION_DEADLINE_MS` bounds the slot
  wait alone; provisioning and removal budgets are UNCHANGED from the
  shipped values.
  The server's `deadlineForRequest` gains a `tool.call` arm,
  `DIRECT_CLIENT_DEADLINE_MS = DIRECT_ADMISSION_DEADLINE_MS +
  DIRECT_DRIVE_BUDGET_MS + 30_000` — admission (slot) + WHOLE
  drive + margin, the exact shape of the existing `execute` rule
  (`server.ts:69-107`, ledger L126). `RESUME_CLIENT_DEADLINE_MS`
  already covers admission + wall clock + margin and applies to direct
  resumes unchanged since `DIRECT_ADMISSION_DEADLINE_MS ≤
  RESUME_ADMISSION_DEADLINE_MS` (plan pins the inequality).
- `search` / `describe`: answered from the shared catalog FILTERED by
  the snapshot's `permits(projection, …)` where projection is the one
  the caller's flag enables (`discovery` for the discovery tools,
  `code` for in-sandbox use). A `describe` of an out-of-scope tool
  returns `null`, indistinguishable from a nonexistent tool.
- `catalog.listing { cursor?: string }`: returns the snapshot's
  projection flags, the connections listing as today, and — ONLY when
  `projections.direct` is true — a PAGE of the scoped direct listing:
  `{ qualifiedName, advertisedName, description, riskClass,
  inputSchema }` per tool, with `nextCursor` (an opaque qualified-name
  watermark). Schemas never travel when direct is off, so a default or
  Code-Mode-only profile's listing stays as small as today and the
  IPC frame cap (1 MiB, `frames.ts:23`) cannot be exceeded by catalog
  growth. **Pages are packed by COMPLETE encoded size (rev 6):** the
  daemon appends entries while the JSON encoding of the WHOLE response
  so far (flags, connections, entries, cursor) stays under
  `LISTING_PAGE_BYTES` (512 KiB, half the frame cap), measured on the
  encoded bytes — a count-based page does not bound the frame (50
  entries × (<16 KiB schema + 16 KiB description) encodes to
  1,626,191 bytes). An entry that ALONE exceeds the page budget is
  excluded from advertisement (logged once, deterministic; still
  reachable via discovery `call` and Code Mode) and the cursor advances
  past it, so pagination always progresses. `advertisedName` is
  computed by the DAEMON (§8.3) — the daemon is the one owner of the
  mapping; the server never computes names. Pages are consistent
  because names depend only on the qualified name (§8.3, injective), so
  a catalog change mid-pagination can only make a name unresolvable,
  which fails closed.
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
startDirect(toolName: string, input: unknown, opts: {
  clientId: string | null; projection: "direct" | "discovery";
  requestKey?: string; scope: ScopeResolver;
}): Promise<ExecutionOutcome>;
start(code: string, opts?: { limits?; requestKey?;
  clientId?: string | null; scope?: ScopeResolver }): Promise<ExecutionOutcome>;
resume(executionId: string, decision: ApprovalDecision,
  scope: ScopeResolver): Promise<ResumeOutcome>;
```

`start` without `clientId`/`scope` (legacy callers, tests) behaves as
today with the default profile. `resume` ALWAYS takes the resolver:
the daemon is the only production caller.

**No drive linearization (rev 8, D10 — reverses rev 4's lock and rev
7's readers-writer variant):** the invoker awaits the tool, connection,
credential, and source reads separately (`invoker.ts:111, 178, 190`),
so a namespace write committing between the post-claim generation
check and the upstream dispatch would run the approved call against
the new source. Every such write is an OPERATOR action (§3 accepted
limit): R1 does not lock against it. Direct drives run under no
namespace lock; provisioning keeps its own 5 s onboarding budget
(`mcp-fetch.ts:23`) and its anti-oracle per-namespace chain
(`source-lock.ts`) exactly as shipped. The sweep + generation check
close every non-operator case.

Sequence:

1. `requestKey` present → persist-before-run as `start` does; an
   existing row with that key → `conflict` (unchanged semantics, #11).
2. Persist `{ kind: "direct", status: "running", clientId, projection,
   call: { toolName, namespace, request: JSON.stringify(input),
   sourceGeneration } }` BEFORE any upstream contact;
   `sourceGeneration` is read from `sources` for the tool's namespace
   immediately before the put (§4.1).
3. Build the invoker exactly as `start` does (`makeInvoker` with
   executionId, deadline, upstream session scope, `projection`, and
   `scope`) and call `invoke(toolName, input)` once under the
   `DIRECT_DRIVE_BUDGET_MS` timer (§5.3) — named here because
   `deadlineFor` is sandbox-shaped and the direct arm computes its own.
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
3. Revalidate the grant AND the flag: `(await scope(row.clientId))
   .permits(row.projection, call.toolName)`; false → terminalize
   `failed` with `ConduitScopeRevoked`, `decisionApplied: false`. A
   profile turned off, narrowed, or removed since the pause all land
   here.
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

**Scope on resume, both kinds:** `resume` binds the resolver to the
ROW's `clientId` and `projection` and threads it into `makeInvoker`
and the tool host exactly as `start` does. A code row that paused
under a narrowed profile therefore resumes under that profile, not
the full catalog (audit P0); a code row whose profile has `code` off
fails at its first call after resume. Pinned: narrow profile → pause
on an allowed tool → approve → an out-of-scope call after resume is
blocked; and flag-only revocation with an unchanged allowlist.

Code Mode (`start`) gains the optional resolver: the manager passes it
to `makeInvoker`, and the tool host it builds is a live filtered
catalog view (`createCatalogToolHost(scopedCatalog, invoke)` where
`scopedCatalog` awaits one snapshot per `search`/`describe`), so
in-sandbox discovery cannot see out-of-scope tools and an out-of-scope
`tools[path]()` is blocked by the invoker at call time.

### 5.5 Invoker

`CreateToolInvokerOptions` gains `projection: Projection` (recorded on
every Trace row) and `scope?: () => Promise<EffectiveScope>` (the
resolver already bound to the drive's client id, awaited per call —
§5.2). Step 1 of `runCall` becomes: look up the tool; if `scope` is
present and `(await scope()).permits(projection, path)` is false,
treat exactly as an unknown tool —
`block` with reason `Tool "<path>" is outside this client's scope.`,
audited, guest-safe name `ConduitPolicyBlocked`.

**One further host-side change, for §7 — dispatch STATE, not an error
field (rev 6):** each direct drive owns a host-side, monotonic
`DispatchState = "none" | "initializing" | "dispatched"` — the
`dispatch` field of the drive's `DirectDrive` object (§5.3, rev 7) —
created by the manager and passed through `CreateToolInvokerOptions`
to the upstream caller. The caller advances it to `initializing` when
session/handshake traffic starts (`upstream.ts:129` — initialize
precedes the governed call and must not count as dispatch) and to
`dispatched` at the moment the governed `tools/call` frame is written
to the socket. Nothing ever lowers it. The manager classifies at
settle time by READING THE CELL — not an error field — so it survives
every wrapping and replacement error (today a post-dispatch upstream
error whose refusal Trace-append also fails is REPLACED by the audit
error, `invoker.ts:222-235`, and a field on the original would be
lost), and the drive timer consults the same cell when it fires. Today
the timeout is flattened into a plain `ConduitUpstreamError`
(`upstream.ts:284`) and the error vocabulary has no timeout member
(`errors.ts:8`); the cell is how effect uncertainty is classified
WITHOUT parsing messages. Never guest-visible; guest-safe names
unchanged.
The §9.2 boundary is untouched: the credential is resolved at step 4
as today and never enters any projection's response.

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
- **Post-dispatch failures (timeout, connection loss, malformed or
  capped response, Trace-append failure after return, drive-budget
  expiry after dispatch, IPC loss).** Any failure settled while the
  drive's `DispatchState` (§5.5) reads `dispatched` — whatever error
  object reaches the manager — settles the row `failed` with error
  name `ConduitOutcomeAmbiguous` — the SAME name the crash sweep uses
  — and a message that names the effect as unknown ("the upstream may
  have performed the call"). A failure while the state is `none` or
  `initializing` settles `failed` under its own classification (the
  governed call was not sent). Never
  retried by Conduit. A settle-write failure after an upstream return
  takes the existing M4 path (synthetic `ConduitPersistError`
  fallback); the drive-budget timer firing while an upstream call is
  in flight is post-dispatch by definition. IPC loss between daemon
  and server keeps the server's existing outcome-unknown wording,
  pointing at `check_execution`.
- **Outcome-unknown on the IPC hop** (daemon connection lost after
  send): the server's existing wording, verbatim, pointing at
  `check_execution`.

Concurrent double-resume needs no new mechanism: `claimForResume` is
the exactly-one-winner CAS (ledger gap G2 closes with its row, §9.3).

**No post-dispatch retry, on any projection (rev 5, codex P0).** The
shared MCP client retries a session-bearing `tools/call` ONCE after an
HTTP 404 (`mcp-client.ts:711-727`, wrapping `callToolOnce` at `:929`).
An untrusted upstream can perform the call, answer 404, and receive the
identical call again after re-initialization: one consumed approval,
two dispatches — an inherited defect that contradicts the one-call
guarantee R1 states. Decision: for a governed `tools/call` the 404
retry is DISABLED; a session-bearing 404 after dispatch is
`afterDispatch: true` and settles `ConduitOutcomeAmbiguous`. Session
renewal may prepare a LATER, separately authorized call; it never
re-sends this one. The `tools/list` and initialize retries are
unaffected (no side effects). Applies to Code Mode too — the class is
projection-neutral (T3). Pinned with an upstream fixture that records
a side effect before returning 404 (row #21). Ledger rows that
describe the scoped 404 retry (§18-C4 family) are reworded to "for
side-effect-free operations only".

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

Built per request from `catalog.listing` (never cached as AUTHORITY —
T2), following `nextCursor` across EVERY daemon page and returning ONE
`tools/list` to the MCP client (no client-side cursor — rev 8, D14). The `CatalogListing` payload gains `projections` and the
paged `tools` (§5.3); the client guard already tolerates extra fields,
and a listing from an OLDER daemon that omits them is read as
code-only with no direct tools (fail closed, never widen).

**Name resolution on `tools/call` (Lane C, rev 8 — D14):** the
encoding (§8.3) is injective, so the server DECODES the advertised
name into the qualified name (`--`→`-`, then a lone `-`→`.`) and puts
the qualified name on `tool.call`; the daemon re-checks `permits` on
it. No server-side map, no refetch, no stale-name path: an undecodable
or unpermitted name gets the same refusal. **Pages:** the server walks
EVERY daemon page (`nextCursor`) and returns ONE `tools/list` to the
MCP client — stdio has no frame cap, and client support for
`tools/list` pagination is uneven, so the client never sees a cursor.

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

**Injective encoding, no hashing (rev 6).** Any scheme that resolves
collisions by rewriting names lets a later catalog change REASSIGN an
advertised name to a different tool (codex: remove `a.b_c` + `a.b.c`,
add `a.b_c_5b8f934a` — its base name equals the removed tool's hashed
name, and an agent holding the old advertisement invokes a different
tool under a namespace grant). So the advertised name is a function of
the qualified name ALONE, injective over the legal character sets, and
never depends on what else is in the catalog:

`advertisedName(qualified)`: replace every `-` with `--`, then every
`.` with `-`. Decoding is unambiguous (a run of `-` of length n encodes
⌊n/2⌋ literal hyphens plus one dot iff n is odd), so two qualified
names never share an advertised name, and a name can never be
reassigned — the same qualified name always has the same advertised
name, and a different qualified name always has a different one.
Reserved verbs are unreachable by construction: a qualified name always
contains a `.`, so its advertised form always contains `-`, and none of
`execute`, `check_execution`, `search`, `describe`, `call` does. If the
encoded form exceeds 64 characters the tool is EXCLUDED from direct
advertisement (deterministic, logged once; still reachable via
discovery `call` and Code Mode) — no truncation, no hash, no
reassignment surface. The daemon computes the name; the server
decodes it (§8.2); decoding is sound by construction.

Consequence for the accepted-limit sentence of rev 3: there is no
longer a case where adding a tool renames an existing one.
`listChanged` stays `false`; the cached list was never authority.

**Advertisement eligibility (schema envelope):** the normalizer stores
whatever schema record the upstream declared (`normalize/mcp.ts:24`),
including `{}` or non-object schemas, while the MCP tool contract
requires an object `inputSchema` (`server.ts:246`). Checking `type`
alone is insufficient (`{"type":"object","required":42,"properties":[]}`
passes it and one such entry invalidates the client's whole `tools/list`
response), so the FULL MCP tool-definition envelope is validated:
the daemon applies a structural predicate (object `inputSchema` whose
`properties`, `required`, and every optional envelope field have the
types the MCP schema demands) at listing time, and the server
additionally runs each advertised entry through the MCP SDK's own
`ToolSchema` parse (already a dependency of `packages/mcp`) before
returning it — belt and braces at the two layers that each own a
format. A tool failing either check is NOT advertised on the direct
projection (logged once per listing, deterministic) and stays
reachable through discovery `call` and Code Mode, whose argument
handling is unchanged. This is envelope validation of the
ADVERTISEMENT, not argument validation (§5.1 parity stands).

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

Same envelope family as `execute`: completed → the upstream result as
the invoker returned it, on the wire only (a synchronous direct result
is never persisted; a resumed one is persisted redacted — §4.1 status
table, D12) as content; paused → the pending shape with `executionId` and the human
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
| 7 | tool names deterministic, injective, MCP-compatible, never reassignable | `server.test.ts` (grammar; the `-`/`--` encoding round-trips; codex's reassignment triple resolves to three distinct names; verbs unreachable; >64 excluded; stability under scope AND catalog change) |
| 8 | upstream growth cannot silently expand a tool-level grant | `effectiveScope` unit |
| 9 | profiles only narrow | `effectiveScope` unit (allow ∩ catalog ⊆ allow; default vs named) |
| 10 | trace semantics comparable across projections | D5 harness over stored `trace_events` rows |
| 11 | request-conflict and retry defined for direct calls | D5 harness (`requestKey` conflict over both kinds) |
| 12 | two-tool clients byte-for-byte compatible | `server.test.ts` (default profile `tools/list` snapshot equals today's) |
| 13 | mid-session narrowing bites on the same connection; no re-handshake re-widens (D4) | `daemon/conduitd.test.ts` / `client.test.ts` real processes (the PR #53 pattern) |
| 14 | namespace write invalidates paused direct calls; resume fails closed re-approve (D3) — including a provision that commits AFTER the sweep but BEFORE the claim (generation check), and remove-then-re-add | `manager.test.ts` (generation mismatch after claim → `ConduitCatalogChanged`, `decisionApplied:false`; re-add does not revive) + `daemon/provision.test.ts` (sweep runs after `provisionSource` commit, inside the lock) + `source.remove` test |
| 15 | a Code Mode row that paused under a narrowed profile resumes under that profile (audit P0) | `manager.test.ts` (narrow → pause on allowed tool → approve → out-of-scope call blocked) |
| 16 | a projection FLAG turned off revokes like a removed tool: a running program's next call and a paused direct call's resume both fail closed with the allowlist unchanged (codex P0) | `manager.test.ts` + `daemon/conduitd.test.ts` |
| 17 | a generation bump after remove+re-add (incl. deleting the current maximum / every source) never revives a paused row of either kind; the operator-race window is DOCUMENTED as an accepted limit, not pinned (codex P0 ×2; rev 8 D10/D13) | `sqlite.test.ts` (sequence never reused) + `manager.test.ts` (both kinds) |
| 18 | result access is per client: `execution.get`/`getByRequestKey` answer not-found for a foreign row; request keys conflict only within one client (codex P1) | `daemon/conduitd.test.ts` + `manager.test.ts` |
| 19 | every new row fails closed on an OLDER build: `code` holds the sentinel, the program lives in `program` (codex P0) | `sqlite.test.ts` (hydrate: program present → used; sentinel in `code`) + a legacy-hydrator simulation |
| 21 | a governed `tools/call` is dispatched at most once per approval: a 404 after dispatch settles outcome-ambiguous and is never re-sent (codex P0, rev 5) | `pipeline/mcp-client.test.ts` + `upstream.test.ts` (side-effect-then-404 fixture), both projections via the D5 harness |
| 20 | the direct listing pages by COMPLETE encoded size under the IPC frame cap and always progresses; schemas never travel when direct is off; malformed MCP envelopes and over-length names are excluded from advertisement, deterministically (codex P1 ×3, rev 6) | `daemon/conduitd.test.ts` (packing vs the 1,626,191-byte reproduction; oversized entry skipped) + `server.test.ts` (SDK `ToolSchema` gate) |
| 22 | a direct drive settles exactly once: a late continuation after the timer cannot overwrite `failed`; the admission slot is released only after the work stops (codex P1, rev 6; lock halves removed rev 8) | `manager.test.ts` (delayed success / delayed refusal after timeout) + `sqlite.test.ts` (attempt-fenced settle) |
| 23 | two handshakes in one tick on a named-client connection bind exactly once; requests during `validating` are refused (codex P1, rev 6) | `daemon/conduitd.test.ts` real processes |
| 24 | post-dispatch classification survives error replacement: a dispatched call whose refusal audit also fails still settles `ConduitOutcomeAmbiguous`; initialize traffic never counts as dispatch (codex P1, rev 6) | `manager.test.ts` + `pipeline/upstream.test.ts` |
| 25 | request-key encoding round-trip: named keys encode once and never decode; a legacy raw key and a default-profile key are the same row; a named client's key never collides with a raw key; a `requestKey` containing U+0000 is refused (D11) | `manager.test.ts` + `daemon/rpc.test.ts` (Lane A/B) |
| 26 | two direct drives on one namespace run concurrently up to `DIRECT_ADMISSION_MAX`; a provision never waits on a drive and a drive never waits on a provision (D10) | `daemon/conduitd.test.ts` (Lane B) |
| 27 | every trace row carries `projection` and `client_id` (NULL = default profile), on both kinds (D4) | D5 harness (Lane A) |
| 28 | `DirectDrive` transitions: dispatch monotonic; `settled` taken exactly once; attempt id fences the settle write (D5) | `manager.test.ts` (Lane A) |
| 29 | versioned scope snapshot: a write without a version bump is impossible; a snapshot built before a write is never served after it; restart starts unversioned (D7) | `daemon/conduitd.test.ts` (Lane B) |
| 40 | profile and tool writes exist ONLY under `packages/mcp/src/daemon/` — no CLI or SDK path writes them out of process, so the in-memory scope version cannot be bypassed (D15) | a source-scan test in `packages/mcp/src/daemon/` (Lane B) |
| 41 | a synchronous direct completion persists no `result`; a resumed completion persists it redacted per policy `redactFields` (D12) | `manager.test.ts` + D5 harness (Lane A) |
| 42 | a paused Code Mode row whose namespace is re-provisioned resumes to `ConduitCatalogChanged`, same as a direct row (D13) | D5 harness (Lane A) |
| 30 | decoder: `clientId` on a non-`serve` handshake → `invalid`; `tool.call` without `input` → `invalid`; `describe.includeSchemas` decoded, absent = false | `daemon/rpc.test.ts` (Lane B) |
| 31 | admin row no-widening: `serve` holds no `profile.*`/`source.*`/`daemon.*`/`approvals.*`; `admin` holds no `execute`/`tool.call`/`search`/`describe` and no approval verb (extends the existing capability pins) | `daemon/rpc.test.ts` (Lane B) |
| 32 | `conduit remove-mcp` is atomic: tools, policies, connection, integration, source, AND the sealed secret all gone or none; paused direct calls on it invalidated; unknown namespace is a named error | `daemon/provision.test.ts` + `packages/cli/src/remove-mcp.test.ts` (Lane B) |
| 33 | `conduit profiles set|list|remove`: argv parsing, `clientId` grammar rejection, `allow`/`projections` JSON round-trip, exit codes, and no credential-bearing output | `packages/cli/src/profiles.test.ts` (Lane B) |
| 34 | `conduit serve --client <unknown>` exits non-zero naming the id and never serves the default profile | `packages/cli/src/integration.test.ts` (Lane C) |
| 35 | direct-cap refusal is `code: "busy"` with the direct-specific text, and the slot is released only after the drive settles | `daemon/conduitd.test.ts` (Lane B) |
| 36 | daemon listing cursor is stable across pages; the server's full walk returns every allowed tool exactly once; a catalog change mid-walk can only drop a name, never bind it to a different tool | `daemon/conduitd.test.ts` (Lane B) + `server.test.ts` (Lane C) |
| 37 | a listing carries no schemas when `projections.direct` is false; a listing from an OLDER daemon (no `projections`/`tools`) is read as code-only with no direct tools; the server's page walk terminates and never repeats an entry | `daemon/conduitd.test.ts` + `server.test.ts` (Lanes B, C) |
| 38 | server name resolution is a pure decode: `decode(encode(q)) === q` for every legal qualified name; an undecodable or unpermitted name → MCP "unknown tool"; the qualified name goes on the wire and the daemon re-checks `permits` | `server.test.ts` (Lane C) |
| 39 | `approvals list` renders direct rows with their projection and tool name; `check_execution` payload shape is unchanged for code rows | `packages/cli/src/approvals.test.ts` + `payloads.test.ts` (Lanes B, C) |

Three ambiguity invariants (§7): crash-before-persist (sweep test over a
`running` direct row, Lane A); keyless-upstream documented limit (Lane
A: no retry occurs; Lane C: the direct tool description carries the
statement); timeout-unknown (any timeout settles `failed` with the
unknown-outcome wording, never re-invoked).

Two pins for the data model: the `request` round-trip property (§4.1)
and the read-side kind guard (corrupt row refused).

### 9.2 D5 harness

`packages/sdk/src/execution/projection-harness.test.ts` runs #2, #10,
#11 once each over the valid `(kind, projection)` pairs —
`("code","code")`, `("direct","direct")`, `("direct","discovery")` —
using one fixture set, so discovery's distinct flag, request-key
surface, and Trace value are exercised, not only the execution kind.
A per-projection copy of any of these is a review REJECT.

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
   `projection`, `program`, `source_generations`), §5.4, §5.5 (incl.
   `afterDispatch`), the `EffectiveScope`/`ScopeResolver` types,
   client-namespaced request keys, D5 harness, ambiguity invariants
   (manager side), rows #1–#3, #9 (unit), #15, #16 (manager half),
   #17, #18 (manager half), #19, #21, #25, #41, #42, G1–G3. No wire
   change — but NOT "serve behaviour unchanged" (rev 8, D15): Lane A
   removes the governed-call 404 retry for Code Mode too (#21) and
   writes the sentinel into `code` for every new row (§4.1), so from
   the first Lane A deploy a rollback fails every new row closed by
   design. Both are one-way doors and the Lane A explainer quiz covers
   them.
2. **Lane B — daemon + profiles + admin.** §5.1–5.3 (`tool.call`,
   `clientId` on handshake, `describe.includeSchemas`, paged
   `catalog.listing` with daemon-computed `advertisedName`, `admin`
   row, direct admission cap + drive budget, resume routing by kind,
   D3 sweep placement, result-access authority, versioned scope
   snapshot), `conduit profiles`, `conduit remove-mcp`, real-process
   tests #4/#5 (RPC level)/#6/#13/#14/#16/#18/#20 (daemon half)/#23/
   #26/#29/#30–#33/#35–#37/#40.
3. **Lane C — MCP surface.** §8, `--client`, `DIRECT_CLIENT_DEADLINE_MS`
   arm, full daemon-page walk into one `tools/list`, name decode, rows
   #7, #12, #20 (SDK `ToolSchema` gate), #34, #36–#39, the
   advertised-name variant of #5, the description statement for the
   keyless limit.

Buildable in that order: no lane depends on a later one (audit
confirmed after the Lane assignments above).

Constraints carried: zero new dependencies · no HTTP surface · capability
row changes are §18-recorded (this spec's landing adds the R1 entry) ·
every invariant lands with its test in the same commit · spec pair
regenerated per commit · agent never installs.

## 11. Open items handed to the plan

- `DIRECT_ADMISSION_MAX` value (daemon-wide; recommend 4, same order as
  the sandbox queue cap), `DIRECT_ADMISSION_DEADLINE_MS` (must be ≤
  `RESUME_ADMISSION_DEADLINE_MS`, pinned) and `LISTING_PAGE_BYTES`
  (512 KiB, half the frame cap; measured on encoded bytes).
- Whether `profile.set` validates that every `allow` entry currently
  exists in the catalog (recommend: warn, do not refuse — a profile may
  be written before its source is added).
- (closed in rev 3) client identity is the `client_id` column on
  `executions`, written for both kinds (§4.1).

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
- 2026-09-05 — **codex full cross-model pass on rev 3** (4 P0 / 8 P1 /
  2 P2, NOT CONVERGED; all fourteen adjudicated IN SCOPE — none is a
  documented accepted limit — and folded): P0 generation check still a
  TOCTOU → direct drives linearized under the per-namespace source lock
  (§5.4); P0 `MAX(generation)` reusable → `source_generations`
  AUTOINCREMENT sequence (§4.1a); P0 flag revocation inert → persisted
  `projection` + `permits(projection, tool)` everywhere (§4.1, §5.2);
  P0 downgrade left narrowed code rows executable → sentinel in `code`
  for every new row, program in `program` (§4.1). P1: sync/async scope
  contract → `ScopeResolver` snapshot, compilable signatures (§5.2,
  §5.4); duplicate FINAL advertised names → iterate-and-exclude
  algorithm (§8.3); name-map owner unassigned → daemon computes,
  server resolves with one refetch (§5.3, §8.2); cross-profile result
  reads → per-client result access + client-namespaced request keys
  (§4.1, §5.2); non-object stored schemas → advertisement eligibility
  (§8.3); listing vs 1 MiB frame cap → paged listing, schemas only
  when direct is on (§5.3); timeout/post-dispatch classification →
  host-only `afterDispatch` + `ConduitOutcomeAmbiguous` (§5.5, §7);
  client deadline ≤ drive budget → whole-drive timer + admission +
  drive + margin (§5.3). P2: "redacted result" wording corrected
  (§4.1, §8.6); harness over `(kind, projection)` pairs (§9.2). Rows
  #16–#20 added. Confirming re-run follows per the
  adversarial-convergence rule.
- 2026-09-05 — **codex confirming pass on rev 4: NOT CONVERGED** (9 of
  14 closed, 5 partial; new: 1 P0 / 8 P1 / 2 P2). Folded in rev 5: the
  P0 (post-dispatch 404 retry → disabled for governed calls, §7, row
  #21) and both P2 (projection contract wording §5.1/§4.1; stale §11
  item). **OPEN — fold in rev 6 before the eng review** (codex's
  finding and fix, condensed; each a genuine in-scope P1):
  1. *Request-key namespacing breaks upgrade recovery*: legacy rows
     hold raw `k`; new default-profile rows hold `\0k`; a lookup by
     `k` misses the old row and a reissue admits a second run; a legacy
     key containing the separator can collide with an encoded named
     key. Fix: an atomic, versioned migration of legacy keys, an
     unambiguous encoding (never encoded twice), and an ownership
     check before returning a conflict id. (§4.1, §5.2, §5.4)
  2. *`afterDispatch` lost through wrapping errors*: a post-dispatch
     upstream error whose refusal Trace-append also fails is REPLACED
     by the audit error (`invoker.ts:222-235`) and reads pre-dispatch;
     the drive timer cannot inspect an error not yet produced;
     initialize traffic precedes the governed call (`upstream.ts:129`).
     Fix: a monotonic host-side per-drive DISPATCH STATE (not an error
     field) that every wrapper preserves and the timer consults, with
     initialization distinguished from the governed call. (§5.5, §7)
  3. *Source-lock waiting is unbudgeted*: the lock waits indefinitely
     (`source-lock.ts:65`); direct calls join the chain with no
     admission bound and no rule that an expired waiter never runs;
     REVERSE regression: provisioning now waits behind a 60 s direct
     drive while its client budget is 35 s (`mcp-fetch.ts:23`,
     `server.ts:182`). Fix: lock acquisition is part of bounded
     admission for every operation on the chain; expired or
     disconnected waiters never enter their callback; provisioning and
     removal budgets account for the wait. (§5.3, §5.4, §11)
  4. *Drive timer has no exactly-once settlement*: the timer
     terminalizes while the awaited call can still complete, and the
     late continuation writes `completed`/`paused` over `failed`
     (updates are unconditional on status, `sqlite.ts:441`; the settle
     guards handle persistence failure, not competing completions).
     Fix: one settlement winner per drive, losing continuations
     suppressed, persistence fenced by attempt/status; lock and
     admission slot held until the work has actually stopped; test
     delayed success and delayed refusal after timeout. (§5.3, §5.4)
  5. *Advertised names can be REASSIGNED*: remove `a.b_c`+`a.b.c`,
     add `a.b_c_5b8f934a` → its base name equals the removed tool's
     hashed name; an agent holding the old advertisement invokes a
     different tool under a namespace grant. Fix: non-reassignable
     advertised identities (injective scheme, or persisted
     assignments/tombstones); refuse ambiguous stale identities rather
     than rebind. (§5.3, §8.2, §8.3)
  6. *Schema eligibility checks `type` only*:
     `{"type":"object","required":42,"properties":[]}` passes and one
     such entry can invalidate the client's whole listing. Fix:
     validate the full MCP tool-definition envelope per advertised
     tool; exclude malformed entries deterministically. (§8.3)
  7. *Listing size bound omits descriptions and envelope*: 50 tools ×
     (<16 KiB schema + 16 KiB description) encoded to 1,626,191 bytes
     > 1 MiB. Fix: pack pages by COMPLETE encoded response size;
     define handling of an individually oversized entry; pagination
     must still progress when entries are excluded. (§5.3, §11)
  8. *Async profile lookup races the handshake-once guard*: frames
     dispatch concurrently (`connection.ts:298`); an await between
     check (`:472`) and assignment (`:504`) lets a second handshake
     overwrite the first binding. Fix: states `unbound → validating →
     bound/closed`, reserved synchronously before the first await;
     further handshakes and ordinary requests refused while
     validating. (§5.1, §5.2/D4)
  Still-partial from the prior round are subsumed by items 1, 2, 3, 6,
  7 above.
- 2026-09-05 — **rev 6 folds all eight:** (1) named keys
  `clientId<NUL>key`, default profile keeps RAW keys → no migration,
  decoder refuses U+0000, conflict id only to its owner (§4.1); (2)
  per-drive monotonic `DispatchState` cell read at settle, replacing
  the `afterDispatch` error field (§5.5, §7); (3) lock acquisition
  inside bounded admission for direct AND provisioning/removal,
  expired waiters never run, provisioning budgets grow by the drive
  budget (§5.3, §5.4); (4) one settlement latch per drive +
  attempt-fenced `UPDATE … WHERE status='running' AND resume_attempt=?`,
  timer awaits the continuation before releasing slot and lock (§5.3);
  (5) INJECTIVE name encoding (`-`→`--`, `.`→`-`), no hashing, >64
  excluded, verbs unreachable by construction — the reassignment
  surface is gone (§8.3); (6) full MCP envelope validation at both
  layers (§8.3); (7) pages packed by complete encoded size under
  `LISTING_PAGE_BYTES`, oversized entries skipped with progress (§5.3);
  (8) handshake state machine `unbound → validating → bound | closed`,
  reserved before the first await (§5.1). Rows #22–#24 added; #7 and
  #20 reworded.
- 2026-09-05 — **in-session eng review (plan-eng-review, founder
  present; codex pass #3 still blocked by the provider limit, so the
  review ran first — the passes are independent).** Scope: full spec
  accepted (D1; Lane C already lands last and alone). Architecture:
  D2 exclusive namespace chain → readers-writer lock, writer
  preference (§5.3, §5.4). Code quality: D3 NUL-joined request keys →
  composite `(client_id, request_key)` unique index + idempotent
  backfill, default profile = `''` (§4.1); D4 `client_id` on
  `trace_events` (§4.3); D5 one `DirectDrive` object (§5.3, §5.5).
  Tests: D6 fifteen unpinned paths → rows #25–#39, #25 CRITICAL
  regression (§9.1). Performance: D7 per-call store reads → versioned
  scope snapshot (§5.2). Outside voice: codex unavailable (usage
  limit) → Claude subagent (fable, fresh context), nine findings, each
  put to the founder as a cross-model tension: **D9** split direct
  advertisement into R1b → REJECTED, D1 stands (§18 defines R1; Lane C
  lands last and alone). **D10** drive linearization + the D2
  readers-writer lock defend a race only the trusted operator can
  create, and the provisioning budget it cited was wrong (onboarding
  is 5 s, `mcp-fetch.ts:23`) → ACCEPTED: lock deleted, D2 reversed,
  operator window recorded as an accepted Grade-B limit (§3, §5.3,
  §5.4; rows #17/#22/#26 reworded). **D11** D3's composite index is a
  downgrade hazard (index recreated on every open, `sqlite.ts:195`)
  and breaks the shipped conflict-detection string (`manager.ts:628`)
  and by-key lookup → ACCEPTED: rev 6 encoding restored, D3 reversed
  (§4.1, row #25). **D12** unredacted upstream `result` at rest →
  ACCEPTED: synchronous completions persist no result; resumed ones
  persist redacted (§4.1, §8.6, row #41). **D13** a paused Code Mode
  row binds one call too → ACCEPTED: `sourceGeneration` on
  `pausedOn` for both kinds, kind-neutral sweep and check (§4.1, §5.4,
  row #42). **D14** decode names instead of a map; server walks all
  daemon pages → ACCEPTED (§8.2, §8.3, rows #36/#38). **D15** Lane A is
  a one-way door and must say so; writer-location test for D7 →
  ACCEPTED (§10, row #40). Cross-model agreement: the outside voice
  independently confirmed the D7 snapshot and the D4 trace column;
  its remaining feasibility note (clients honouring `nextCursor`)
  dissolves under D14.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 (3 direct `codex exec` passes on revs 3/4/6: two completed, one lost to the provider limit) | issues_found | rev 3: 4 P0/8 P1/2 P2; rev 4: 1 P0/8 P1/2 P2; rev 6: not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open (all folded; convergence pass #3 owed) | 15 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** the direct passes (not `/codex review`) drove revs 2–6; all their findings are folded; the confirming pass on rev 6 has not run (usage limit).
- **CROSS-MODEL:** outside voice (Claude subagent, fresh context) vs the eng review: 9 findings, 7 tensions put to the founder — 6 accepted (D10–D15), 1 rejected (D9); it independently confirmed D4 and D7.
- **VERDICT:** ENG REVIEW COMPLETE, findings folded — eng review required to re-clear after codex pass #3 (convergence) runs on rev 8.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P1, human: ~1d / CC: ~15min)** — sdk/execution — Remove drive linearization; keep sweep + post-claim generation check on BOTH kinds — Surfaced by: D10, D13 — Files: `packages/sdk/src/execution/manager.ts`, `packages/mcp/src/daemon/connection.ts` — Verify: rows #17, #42
- [ ] **T2 (P1, human: ~2h / CC: ~10min)** — sdk/store — Request keys: rev 6 encoding, one function + round-trip pin — Surfaced by: D11 — Verify: row #25
- [ ] **T3 (P1, human: ~4h / CC: ~15min)** — sdk/execution — Persist a direct result only on the resume path, redacted; synchronous completion not persisted — Surfaced by: D12 — Verify: row #41
- [ ] **T4 (P1, human: ~4h / CC: ~15min)** — mcp/server — Decode advertised names; walk all daemon pages into one tools/list — Surfaced by: D14 — Verify: rows #36, #38
- [ ] **T5 (P2, human: ~30min / CC: ~3min)** — sdk/store — `client_id` on trace_events; invoker writes projection + client_id — Surfaced by: D4 — Verify: row #27
- [ ] **T6 (P2, human: ~1h / CC: ~5min)** — sdk/execution — One `DirectDrive` object — Surfaced by: D5 — Verify: row #28
- [ ] **T7 (P2, human: ~1d / CC: ~15min)** — mcp/daemon — Versioned scope snapshot + writer-location test — Surfaced by: D7, D15 — Verify: rows #29, #40
- [ ] **T8 (P2, human: ~3d / CC: ~1h)** — tests — Ledger rows #25–#42 with their tests, per lane — Surfaced by: D6, D12–D15 — Verify: INVARIANTS.md flips per commit

NO UNRESOLVED DECISIONS

