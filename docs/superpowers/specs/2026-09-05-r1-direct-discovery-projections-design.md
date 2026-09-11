# R1 — direct + discovery projections with capability profiles — design

Status: revision 16 — codex loop closed by adjudication at rev 13
(§12); rev 14 was the read pass; rev 15 folded the PR #57 bot reviews
(CodeRabbit ×10, Greptile ×5); codex pass #8 on rev 15 found 1 P0 /
3 P1 in those folds, all folded here: the discard decision moves to
settle time (`RESULT_BYTES_MAX`, one write), abandoned continuations
are QUARANTINED against the cap rather than released, the aggregated
`tools/list` walk carries one absolute deadline, and the IPC-loss
recovery wording is per projection (keyless direct has no handle).
Codex pass #9 (confirming) follows on this revision, then the merge. Rev 11 folded the instance-binding threat-model pass
(`/blindspot` eight cards; codex #5, 3 P0 / 1 P1 / 1 P2; two findings
SHIPPED on main as PR #58 `4c75b05` and PR #59 `cce91ae`, one out of
scope by decision, §3.1). Rev 12 folded codex #6 (2 P0 / 2 P1 / 1 P2).
Codex #7 on rev 12: 0 new findings, 1 residual precision P1, folded
here (§4.1 `pausedOn: StoredPendingApproval`; §5.4 step 2 legacy
branch). Next: founder read, then writing-plans (§10, Lane A first).
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
- **Code Mode wire shape unchanged.** `execute` / `check_execution`
  stay byte-identical on the wire for a client with the default
  profile (#12). Two BEHAVIOURS change for Code Mode too, by design,
  and are one-way doors (§10 Lane A): the governed-call 404 retry is
  removed (§7, row #21) and every new row carries the `code` sentinel
  (§4.1, row #19). (Rev 15, CodeRabbit: the old "unchanged" wording
  could have been read as preserving the duplicate-side-effect retry.)

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
- **T5 instance binding across time and across writers** (rev 11) →
  §3.1.

### 3.1 Instance binding (threat-model pass, 2026-09-11)

Rev 10's two P0s were one class: an approval or a provenance stamp
binding to an INSTANCE that can be replaced across TIME (a later pause
of the same execution) or across WRITERS (an older daemon build). Per
the adversarial-convergence rule the loop paused and the class was
mapped before more code: `/blindspot` (codebase mode, eight cards)
then codex pass #5 (§12). What the map says, and what R1 does about
each part:

- **The binding has two halves.** The CLAIM-TIME half is
  `claimForResume`'s CAS plus the post-claim checks (§5.4 steps 1–2):
  they decide WHICH pending call, and whether the stored pause is one
  an operator could have named. The LIVE-RESOLUTION half is everything
  the invoker reads AFTER the claim — tool, connection, credential,
  source (`invoker.ts:111, 178, 190`) — and it is deliberately unbound
  (D10, the accepted limit above): an operator who rewrites a namespace
  under an approved call does so by their own hand. R1 hardens the
  first half and documents the second.
- **Three writer versions can open one database:** the shipped pre-R1
  daemon, the R1 daemon, and any later build. Version skew is a stderr
  warning today (`packages/cli/src/skew.ts`); the schema carries no
  version gate. R1's defences against an OLDER writer are the `code`
  sentinel (§4.1: an old build fails every new row closed) and the
  generation triggers (§4.1a: an old build's provisioning still bumps).
  What R1 does NOT defend: a pre-R1 daemon that opens an R1 database
  while the R1 daemon is stopped and RESUMES a pre-R1-shaped pause
  under pre-R1 rules (codex #5 P0-1). **Adjudicated OUT OF SCOPE,
  2026-09-11, on one fact: nothing is published.** No Conduit version
  exists on npm (the package name answers 404), so no installed pre-R1
  daemon exists outside this repository's own checkouts, and the only
  downgrade path is a developer checking out an older commit against
  their own state directory. **Standing rule, from the first published
  version onward:** any schema-semantic change on the pause path — the
  shape of `paused_on`, the claim predicate, the provenance fields —
  ships with a DB-ENFORCED writer floor (a check the database itself
  applies to an older writer, in the pattern of §4.1a's triggers and
  §4.1's sentinel), never a stderr warning. R3, the first published
  version, records the store-interface changes PR #58 and #59 made and
  carries this rule into its release checklist.
- **Namespace agreement rests on the name grammar.** `pausedOn.namespace`
  is stored as its own field (§4.1) so the sweep matches by equality;
  but the generation check (§5.4 step 3) reads `sources.generation` FOR
  THAT FIELD, while the invoker dispatches BY `pausedOn.toolName` and
  takes the namespace from the tool row it resolves (`tool.namespace`).
  If the two disagree — a corrupt row, or a defect in either pause
  path — provenance is validated against one source and the call runs
  against another. Rev 11 closes it with a read-side guard (codex #5
  P0-2; §5.4 step 2, row #50): the namespace of `pausedOn.toolName`
  under the §8.3 grammar must equal `pausedOn.namespace`, and on a
  direct row `direct_call` must equal `pausedOn` on `{ toolName,
  namespace }`.
- **The trigger floor covers only the statements it names.** Rev 10's
  triggers fire on `UPDATE sources` and `INSERT tools`; a fresh `INSERT
  INTO sources` fired nothing, so remove-then-standalone-re-add (the
  `sources.upsert` seed path — no production caller today) produced a
  row at generation 0 (codex #5 P0-3). Rev 11 adds the INSERT trigger
  and three pins (§4.1a, row #47).
- **The operator binds to what was PAUSED, not to what was SHOWN.** The
  approval names a call id; the list is a projection of the same row
  and can lag, or show a recovery row. §5.3 states the consequence: the
  operator passes the id, and the CLI selects nothing.
- **A call id is not a capability.** Whoever learns one — a `serve`
  client polling its own execution, a log line — cannot decide it: only
  the `approvals` row carries `approvals.resume` (§5.1 no-widening
  pins). Replayed discovery output is D4 by design: authority is
  recomputed on every call, never read from what was advertised.
- **Accepted (codex #5 P2):** a daemon DOWNGRADE terminalizes a pending
  approval — an older build that resumes an R1 row runs the `code`
  sentinel and fails it closed, so a pause taken under R1 is lost
  across a downgrade, never resumed under the wrong rules. Recorded
  here; pinned only as far as row #19 already does.
- **Shipped-code findings are fix PRs against main, not spec text**
  (precedent: rev 10's P0 → PR #58). Codex #5's P1 — a stored `callId`
  that is present but not text, or blank, fell through the claim's
  equality arm and stranded the row `paused` forever — shipped as PR
  #59 (`cce91ae`, 2026-09-11), the liveness half of §5.5's binding rule
  (row #49). Both PRs changed the SDK store interface (`claimForResume`
  gained `callId`; `claimCallId` and `isPendingApproval` were added);
  the first published version records them.

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
ALTER TABLE executions ADD COLUMN result_state TEXT
```

`result_state` (rev 10, codex #4 P2; third value rev 15, CodeRabbit):
NULL for code rows and for any non-terminal row; on a `completed`
DIRECT row exactly one of `'delivered'` (result returned on the wire,
not stored — `result` IS NULL), `'retained'` (resumed path; `result`
holds the redacted value), or `'discarded'` (the result was too large
to deliver: the effect landed, the payload was dropped, `result` IS
NULL, and the wire answer was `completed` + `resultTooLarge: true` —
§4.1 status table). **The discard decision is made AT SETTLE TIME by
the manager, never after (rev 16, codex #8 P0):** the daemon discovers
frame oversize only after encoding a response (`connection.ts:538-599`,
`frames.ts:63-70`), which is after the settle write, and every settle
write is fenced `status = 'running'` — so a post-settle refinement
from `delivered` to `discarded` has no path. Instead the manager
measures `JSON.stringify(result)` when the upstream returns and, if it
exceeds `RESULT_BYTES_MAX` (256 KiB — a quarter of the IPC frame cap,
leaving the envelope, `executionId`, and framing far inside 1 MiB),
settles `completed` with `result_state: 'discarded'` in ONE write and
hands the daemon a payload that carries no result. The daemon's frame
check therefore never fires on a completed direct envelope; if it
still did (a defect), the shipped `invalid` error would be the answer
and the row would already be a consistent `delivered`/`retained` —
never a lie about the effect. Applies to the resumed path too: a
result over the cap is neither retained nor redacted; it is
discarded. Fresh DDL adds
`CHECK (result_state IN ('delivered','retained','discarded'))`; the
read-side guard refuses a completed direct row whose `result_state` is
NULL or whose `result`/`result_state` combination is inconsistent.
`check_execution` on a `discarded` row answers `completed`,
`resultAvailable: false`, `resultTooLarge: true`. An UPSTREAM response
that exceeds the upstream cap is a different case: it is a post-dispatch
failure (§7, `ConduitOutcomeAmbiguous`), never `completed`.

Fresh DDL adds `CHECK (kind IN ('code','direct'))` and
`CHECK (projection IN ('code','direct','discovery'))`. The ALTER shape
has precedent through `tolerateSchemaRace` (`sqlite.ts:198-205`, the
`redact_fields` retrofit; line numbers as of `fe20139`).

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
"request": string }` — provenance does NOT live here.

**Provenance lives on `PendingApproval`, for BOTH kinds, in ONE shape
(rev 9 — codex #3 found rev 8 stating it in three inconsistent
places):** `PendingApproval` gains two REQUIRED fields, `namespace:
string` and `sourceGeneration: number`, captured at pause time by BOTH
pause paths — the sandbox-suspension path (`start`, the manager's
`onApprovalPause` capture) and the direct path (`startDirect` step 5) —
from `sources.generation` for `pausedOn.toolName`'s namespace, read
immediately before the `paused` row is written. The persisted JSON is
`{ callId, toolName, namespace, sourceGeneration, input, reason,
expiresAt }`. **One validator (rev 11):** `isPendingApproval` (sdk
`types.ts`, shipped in `cce91ae`) is the ONE definition of a well-formed
stored pause, applied by every reader that acts on one — the manager
after the claim and the `approvals.list` projection — and R1 extends it
with the two provenance fields: present together (`namespace` text,
`sourceGeneration` a finite number) or absent together (a legacy
pause); any other combination is corrupt (§5.4 step 2). **The
predicate narrows to a UNION, not to `PendingApproval` (rev 12, codex
#6 P1):** `StoredPendingApproval = PendingApproval |
LegacyPendingApproval`, where the legacy arm has NEITHER provenance
field, so no reader can use an `undefined` namespace or generation
without the compiler objecting; §5.4 step 2 branches the legacy arm
explicitly to step 3, which fails it closed. On resume,
after `claimForResume`, the manager compares
`pausedOn.sourceGeneration` with the namespace's CURRENT
`sources.generation`; missing source or mismatch → `ConduitCatalogChanged`.
**Legacy pauses (rows written before R1) lack both fields:** hydration
returns them with `sourceGeneration` absent, and resume treats absence
as a mismatch — fail closed with the re-approve outcome, NEVER
substitute the current generation. The read-then-provision-then-put
TOCTOU on capture is caught by that resume check, so no single
transaction is required. `namespace` is stored as its own field so the
sweep (`invalidatePaused`, below) matches by equality — never by
`LIKE`, whose `_` wildcard is a legal namespace character. The sweep
covers every `paused` row of either kind whose `pausedOn.namespace`
equals the written namespace.
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
  id: string; status: ExecutionStatus;
  pausedOn?: StoredPendingApproval;   // rev 13: the UNION, never bare PendingApproval —
                                      // the hydrator casts parsed JSON without validating;
                                      // readers narrow through isPendingApproval, then
                                      // "sourceGeneration" in pausedOn for the legacy arm
  startedAt: number; endedAt?: number; requestKey?: string;
  clientId: string | null;                // null = default profile
  projection: "code" | "direct" | "discovery";
  result?: unknown; error?: ExecutionError;
}
type Execution =
  | (ExecutionBase & { kind: "code"; code: string; seeds: { now: number; random: number } })
  | (ExecutionBase & { kind: "direct";
      call: { toolName: string; namespace: string; request: string };
      resultState?: "delivered" | "retained" | "discarded" });   // set iff completed (rev 16)

interface PendingApproval {                 // both kinds, written by R1
  callId: string; toolName: string; namespace: string; sourceGeneration: number;
  input: unknown; reason: string; expiresAt: number;
}
type LegacyPendingApproval =                 // pre-R1 rows: NO provenance
  Omit<PendingApproval, "namespace" | "sourceGeneration">;
type StoredPendingApproval = PendingApproval | LegacyPendingApproval;
// isPendingApproval(value): value is StoredPendingApproval  (rev 12)
```

The direct arm's failure payload is the SDK's `ExecutionError`
(`types.ts`), not the sandbox package's structurally identical
`SandboxError`: the manager's direct arm must not import from
`sandbox/`.

Status enum shared (D1), per-kind meaning:

| status | code | direct |
| --- | --- | --- |
| running | sandbox driving the program | performing the one governed upstream call |
| paused | suspended on a pending call; replay on resume | approved-or-not canonical call stored; perform on resume |
| completed | program returned | upstream returned. **At rest (rev 8, D12):** a SYNCHRONOUS direct completion returns the upstream result on the wire and persists NO `result` (`executions.result` is not on the §11 redaction path; an upstream that returns tokens or PII must not land in SQLite in the clear); a completion reached through RESUME persists `result` passed through `redactSensitiveFields` with the tool's policy `redactFields`, because `check_execution` must deliver it later. **Polling a direct row (rev 9, codex #3):** the shipped projection turns an absent result into `null` (`payloads.ts:408`), which would INVENT a value for a discarded synchronous result. A direct row therefore persists `result_state: 'delivered' \| 'retained'`; `check_execution` on a `delivered` direct row answers `completed` with `resultAvailable: false` and no `result` key, and a `retained` one answers with the redacted result. Code rows keep today's shape exactly. **Oversized result:** if the upstream result exceeds `RESULT_BYTES_MAX` the manager settles `completed` with `result_state: 'discarded'` (one write, at settle — §4.1 above, rev 16) and the daemon answers `completed` with `executionId` and `resultTooLarge: true` (the effect landed; the payload is discarded — today `connection.ts:575` emits an `invalid` error after completion, which read as failure). The credential-echo tripwire still REFUSES a result rather than redacting it. **Delivery is not acknowledged (rev 15, Greptile — the D12 consequence, accepted):** a `delivered` result exists only in the one RPC response; if the daemon connection is lost after the row is settled and before the response lands, the value is gone — the effect happened. R1 does NOT retain a redacted copy until acknowledgement (that reintroduces the at-rest exposure D12 removed, for every call, to cover an IPC failure window). **The recovery handle differs by projection (rev 16, codex #8 P1):** a KEYLESS direct call has NO handle — the lost response was the only carrier of the execution id (§7, keyless-upstream limit), so the server's wording for a direct call is "the call may have completed; there is no way to look it up — re-issue only if the operation is safe to repeat"; a discovery `call` with `requestKey` recovers by re-issuing with the SAME key: the `conflict` answer carries the execution id (§4.1), and `check_execution` on it reports the outcome (with `resultAvailable: false` for a delivered result). §7 and §8.6 carry this wording; the shipped generic "check `check_execution`" text is replaced for both direct arms (Lane C, row #39). |
| failed | program threw / infra / divergence | policy block, credential/upstream/infra failure, D3 invalidation, or outcome-unknown |
| expired | pause TTL elapsed | pause TTL elapsed |

A direct execution writes NO `replay_journal` rows.

**Request keys are per client via a mapping table (rev 9 — codex #3
showed the rev 6 encoding collides with LEGACY rows: the shipped decoder
accepts any string, `rpc.ts:277`, so a pre-R1 default-profile row may
already hold `acme<NUL>k`, and rejecting future NULs cannot remove it):**

```
CREATE TABLE IF NOT EXISTS request_keys (
  client_id TEXT NOT NULL,
  key TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  PRIMARY KEY (client_id, key)
)
```

A NAMED client's key is written to `request_keys` in the same batch as
the execution row, whose legacy `request_key` column stays NULL; the
DEFAULT profile keeps using the legacy column, raw, exactly as every
pre-R1 row was written. Uniqueness for named clients is the table's
primary key; for the default profile it is the shipped single-column
unique index and its shipped conflict-detection string
(`manager.ts:653`), both untouched. There is ONE representation per
key — no logical/stored split, nothing encoded, nothing to double-encode
on hydrate-then-settle (`sqlite.ts:1064` returns the column unchanged
and that is correct for default rows; named rows have no column value).
Lookups: named → `request_keys` by `(client_id, key)`; default → legacy
column. A `conflict` therefore can only ever find a row of the SAME
client, so it always carries the existing execution id and the ID-less
wire variant of rev 8 is withdrawn — the shipped payload guard that
requires an id for every status (`payloads.ts:453`) stands. Pinned:
a legacy row holding a NUL-bearing key is untouched and unreachable
from a named client; a named client's key never collides with any
default-profile key (row #25). **Ownership** (row #18) is structural:
the lookup is keyed by the caller's client id.

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

**Generation advancement is enforced INSIDE SQLite, not by the R1
writer (rev 10, codex #4 P0):** an OLDER daemon run temporarily after
R1 has persisted a pause at generation 42 would provision or revalidate
through the shipped statements (`sqlite.ts:800` upserts source fields
and leaves unknown columns untouched; `:838-840` replaces tools) without
touching `generation`, and the R1 daemon would then accept the obsolete
provenance on resume. Triggers close this for every writer version:

```
CREATE TRIGGER IF NOT EXISTS sources_gen_on_update AFTER UPDATE ON sources
WHEN NEW.generation = OLD.generation
BEGIN
  INSERT INTO source_generations (namespace, at) VALUES (NEW.namespace, strftime('%s','now')*1000);
  UPDATE sources SET generation = last_insert_rowid() WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS sources_gen_on_insert AFTER INSERT ON sources
BEGIN
  INSERT INTO source_generations (namespace, at) VALUES (NEW.namespace, strftime('%s','now')*1000);
  UPDATE sources SET generation = last_insert_rowid() WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS sources_gen_on_tools AFTER INSERT ON tools
BEGIN
  INSERT INTO source_generations (namespace, at) VALUES (NEW.namespace, strftime('%s','now')*1000);
  UPDATE sources SET generation = last_insert_rowid() WHERE namespace = NEW.namespace;
END;
```

(`sources_gen_on_update` is guarded `WHEN NEW.generation = OLD.generation`
so the trigger's own write does not recurse; the same guard keeps the
generation writes of the other two triggers from firing it a second
time.) **`sources_gen_on_insert` (rev 11, codex #5 P0-3):** rev 10's
floor covered `UPDATE sources` and `INSERT tools` only. A source row
CREATED without tools fired nothing: remove, then re-add through the
standalone `sources.upsert` (`sqlite.ts:269` — a test seed with no
production caller today, but a statement any writer can run) left the
row at the column DEFAULT, generation 0, with no ledger row. The upsert
shape `provisionSource` uses (`INSERT … ON CONFLICT DO UPDATE`,
`sqlite.ts:800`) fires the INSERT trigger on a fresh row and the UPDATE
trigger on a conflict, so every statement that creates or changes a
source row now allocates a fresh sequence value. Any provision, replace,
or revalidate — by any daemon build that opens the database after R1's
schema has run once — bumps the namespace's generation because the
database does it, not the code. Pinned: R1 pause → provision through
the SHIPPED pre-R1 SQL against the same database → R1 resume →
`ConduitCatalogChanged` (row #47). **Three more pins (rev 11, row #47):**
(1) *zero-tool revalidate* — a revalidate that yields no tools fires
`sources_gen_on_tools` zero times, so the source-row trigger must bump
alone; (2) *retarget* — a provision that changes `location` /
`base_url` under the same source id takes the `DO UPDATE` path and
bumps; (3) *trigger survival* — the triggers live in the database file
(`CREATE … IF NOT EXISTS` in the schema ladder), and a pre-R1 build's
ladder knows no triggers and drops none, so the pin runs the R1 ladder,
then the SHIPPED pre-R1 provisioning SQL, then reads a bumped
generation through R1. R1's own `provisionSource` inserts NO ledger row
of its own (rev 11 — rev 10's explicit insert became a second bump of
the same provision once the INSERT trigger existed): the triggers fire
inside `provisionSource`'s single `client.batch` transaction, so the
bump is visible in the transaction it belongs to, and `provisionSource`
reads `sources.generation` back after the batch to populate
`Source.generation`.

Both provision and revalidate reach `provisionSource` through
`fetchAndProvision` (`provision.ts:837`), so the triggers cover both.
`AUTOINCREMENT` allocates from `sqlite_sequence`,
a durable high-water mark that row deletion never lowers — the
property a per-row counter (restarts at 0 on re-add) and a table-wide
`MAX(generation)` (reusable once the highest row is deleted; codex
reproduced `1 → absent → 1` with one source) both lack. `source.remove`
deletes the `sources` row, so a later lookup finds no generation at
all. Pinned: "remove then re-add does not revive a paused direct row",
including deletion of the current maximum and deletion of every
source. The `source_generations` table is append-only; no GC in R1. **Its growth
(rev 11, spec correction):** a provision writes N+1 ledger rows, not
one — one from the source-row trigger (INSERT or UPDATE) and one per
tool inserted, because `provisionSource` deletes and re-inserts the
namespace's tools and `sources_gen_on_tools` fires per row. Only the
LAST allocation is the namespace's generation; the intermediate rows
are the price of a floor the database enforces. Exact growth is
Σ(Nᵢ + 1) over provisions (rev 12, codex #6: the `WHEN` guard is in the
DDL above, not only in prose — without it a fresh insert wrote two
source rows, and with `recursive_triggers` on it recursed), still
small, and monotonic is the only property anything reads.
`Source` gains `generation: number`. This is the R1 provenance field the brief anticipated; R2 adds
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
    projection: "direct" }                                  // NO requestKey (A4)
| { kind: "tool.call"; toolName: string; input: unknown;
    projection: "discovery"; requestKey?: string }
```

**`requestKey` exists on the discovery arm only (rev 15, CodeRabbit —
A4):** the decoder refuses a `direct` frame carrying `requestKey`
(`invalid`), so the keyless-outcome contract of §7 is enforced at the
wire, not merely described; `startDirect` receives `requestKey` only
from the discovery path (row #30). `toolName` is the qualified name. `projection` names which profile
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
  concurrent upstream calls. **Lifecycle accounting (rev 9, codex #3):**
  admitted direct drives are tracked DAEMON-WIDE, independently of the
  connection that admitted them — the shipped drain exits when the
  sandbox queue is idle and no READY connection remains
  (`conduitd.ts:795`), and disconnect drops the connection's in-flight
  set (`connection.ts:305`), so a direct caller that disconnects mid-call
  would otherwise let an orderly stop exit under a running upstream
  call. Direct drives count in the drain-idle check, the drain
  deadline's abandonment path, shutdown cleanup, and the in-flight
  diagnostics (`daemon.status` `executionsInFlight` includes them).
  Pinned: disconnect → `daemon stop` while a direct call runs waits the
  drain grace, then reports the abandonment (row #44). Over cap → `code: "busy"` (the same code
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
  admission slot, so resources are held until the work has actually
  stopped — but not forever: **bounded slot retention (rev 15,
  Greptile P1):** a continuation blocked on an un-cancellable read
  (`invoker.ts:111` awaits with no deadline) would otherwise hold its
  slot until daemon restart, and `DIRECT_ADMISSION_MAX` such drives
  make every later direct call `busy`. The cleanup promise therefore
  waits at most `DIRECT_SLOT_RETENTION_MS` (30 s, half the drive
  budget) after the row is settled; on expiry it moves the continuation
  to a bounded QUARANTINE and logs it ABANDONED (the same vocabulary as
  the drain deadline's abandonment path). **Quarantine, not release
  (rev 16, codex #8 P1):** an abandoned continuation is still live work
  — it may hold a store read, and the attempt fence protects only the
  execution row, not a Trace append or session teardown — so releasing
  its slot outright would turn the cap into a replenishing counter.
  Admission is therefore refused `busy` while `live + quarantined ≥
  DIRECT_ADMISSION_MAX`; a quarantined continuation leaves the count
  only when its promise actually settles. What a quarantined
  continuation can still DO is bounded by the deadline gate it already
  carries: its `deadline()` expired at settle, the invoker checks it
  before writing the governed frame (§5.3 above) and before resolving
  credentials, so it can never dispatch upstream or touch a secret; it
  may append at most one refusal Trace row; session disposal runs under
  the same expired deadline and does not wait on initialization. Net
  effect: a stuck store read costs one slot until it returns — the
  cap stays a BOUND on live work; a read that never returns is a
  store defect the cap correctly surfaces as `busy`, not one it hides
  by admitting more. Pinned: `DIRECT_ADMISSION_MAX`
  drives stuck on a never-returning store read stay `busy` (the cap
  is a bound, not a counter), a returning read frees its slot without
  dispatching, and a late completion never changes the row (row #22). **Two promises (rev 9, codex #3):** the client-visible
  OUTCOME promise resolves as soon as the timer has settled the row —
  it never waits on the continuation — while a separate CLEANUP promise
  awaits the continuation and releases the slot; only the outcome
  promise feeds the RPC response, so the client deadline holds even
  when the continuation is blocked on an un-cancellable store read
  (`invoker.ts:111` awaits with no deadline). The timer starts before
  any asynchronous preparation (§5.4 `startDirect` step 2), and preparation that
  completes after expiry never dispatches: the invoker checks
  `deadline()` before writing the governed frame. Pinned: delayed
  success and delayed refusal after timeout both leave the row
  `failed`, AND a store read that never returns still yields the
  timeout outcome on the wire within budget. **Bounded persistence
  (rev 10, codex #4):** the outcome promise must not wait on a SETTLE
  WRITE either — the store write has no deadline (`sqlite.ts:437`) and
  the persistence guard awaits the write and its fallback
  (`manager.ts:442`). Whichever side wins the latch, its settle write
  runs under `SETTLE_WRITE_BUDGET_MS` (5 s); if that expires the outcome
  promise resolves with `{ status: "unknown", executionId,
  reason: "persist-timeout" }` — a new outcome variant meaning "the
  effect may have landed and the row may not yet say so" — WITHOUT
  claiming durable terminalization, while the write stays tracked in
  the cleanup promise and remains fenced. `check_execution` on that id
  later shows whatever the write eventually persisted. Pinned: a
  stalled timer write, and a stalled completion write after the
  continuation won the latch (row #45).
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
  `code` for in-sandbox use). **Filter BEFORE rank and limit (rev 9,
  codex #3):** the shipped search ranks the whole catalog and returns
  the top ten (`catalog.ts:79`); filtering those ten would hide an
  allowed tool that ranks below ten disallowed ones. Eligibility is
  applied to the candidate set first, then ranking, then the limit —
  for discovery AND in-sandbox search. Pinned: ten higher-ranked
  disallowed tools plus one matching allowed tool → the allowed tool is
  returned (row #43). A `describe` of an out-of-scope tool returns
  `null`, indistinguishable from a nonexistent tool.
- `catalog.listing { cursor?: string }`: returns the snapshot's
  projection flags, a BOUNDED connections listing — capped at
  `LISTING_CONNECTIONS_MAX` (200) entries with a `connectionsTruncated`
  flag, since the shipped listing reads every connection unbounded
  (`payloads.ts:553`) and 20,000 short entries alone encode past 1 MiB
  (codex #4), and the page packer counts the connections block in the
  budget before any tool. **The connections block is byte-bounded too
  (rev 15, CodeRabbit):** `prefix` and `label` have no length limit, so
  200 entries can still exceed the page; the block is packed by the
  same encoded-size rule as tools under its own cap,
  `LISTING_CONNECTIONS_BYTES` (128 KiB, a quarter of the page budget),
  in deterministic (prefix) order, and `connectionsTruncated` is true
  when EITHER the count or the byte cap cut it. Pinned with oversized
  entries (row #48) — and — ONLY when
  `projections.direct` is true — a PAGE of the scoped direct listing:
  `{ qualifiedName, advertisedName, description, riskClass,
  inputSchema }` per tool, with `nextCursor` (an opaque qualified-name
  watermark). Schemas never travel when direct is off, so a default or
  Code-Mode-only profile's listing stays as small as today and the
  IPC frame cap (1 MiB, `frames.ts:23`) cannot be exceeded by catalog
  growth by TOOL entries; the connections block is bounded separately
  (above), so a page can never be over budget before its first tool.
  **Pages are packed by COMPLETE encoded size (rev 6):** the
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
- `approvals.resume { executionId, decision, callId }` (rev 10, codex
  #4 P0 — the wire shape is NO LONGER unchanged): the request names the
  PENDING CALL being approved, not only the execution. Before PR #58
  the request carried no call identifier, admission preceded
  `manager.resume`, the claim checked only `id` and `status='paused'`,
  and the manager then staged whatever `pausedOn` it read — so two
  queued approvals for pause A let the second one approve a LATER
  pause B of the same program. Codex reproduced it; it is a defect in
  shipped Code Mode, not only R1 — **SHIPPED as PR #58 (`4c75b05`,
  2026-09-05)**: the wire shape, the CAS predicate, and the CLI below
  are the ones R1 inherits. **The operator passes the call id (rev 11,
  §3.1):** `conduit approvals approve|deny <execution-id> <call-id>` —
  the CLI sends the argument verbatim and selects nothing on the
  operator's behalf, so the decision binds to what was PAUSED, never to
  what a list happened to show. **Display contract:** `approvals list`
  renders `EXEC ID · CALL ID · TOOL · WAITING SINCE · EXPIRY` per row;
  `reason` travels on the wire but the CLI does not render it; a
  corrupt pause renders as a RECOVERY row whose CALL ID is the id the
  claim accepts, or `-` when none is nameable (PR #59 `cce91ae`; §5.4
  step 2). R1 adds the projection to the row (row #39).
  The daemon reads the row's
  `kind` BEFORE admission: a `code` row is admitted through the sandbox
  queue as today; a `direct` row is admitted under `DIRECT_ADMISSION_MAX`
  — a direct resume must not consume a sandbox slot. The manager then
  branches on `kind` (§5.4).
- `profile.set` / `profile.remove`: validate, write, respond. No reload
  step exists because scope is read live.
- `source.remove`: in one transaction delete the namespace's tools,
  policies, connection, integration, source, and the connection's
  sealed secret if any; then `catalog.removeNamespace`; then
  `executions.invalidatePaused(namespace)`; respond with counts.
  A missing namespace is a named error, not a silent no-op.

**D3 sweep placement (pinned):** the sweep is anchored to the STORE
commit, not the in-memory catalog mutation — the invoker resolves
tools from the store, and `refreshNamespace` only mutates memory and
never throws. In both provisioning paths (`fetchAndProvision` →
`provisionSource`) and in `source.remove`, `invalidatePaused`
runs AFTER `provisionSource` / the removal transaction has committed,
inside provisioning's own per-namespace anti-oracle chain, and BEFORE the source
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
resume(executionId: string, decision: ApprovalDecision, callId: string,
  scope: ScopeResolver): Promise<ResumeOutcome>;   // callId: shipped, 4c75b05
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
   call: { toolName, namespace, request: JSON.stringify(input) } }`
   BEFORE any upstream contact. The budget timer (§5.3) starts HERE,
   before any asynchronous preparation, not at invocation (codex #3).
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
   `pausedOn = { callId, toolName, namespace, sourceGeneration, input,
   reason, expiresAt }` (§4.1, one shape for both kinds; the generation
   read immediately before the write) — the manager writes it directly,
   since no sandbox suspension exists.
   The outcome is `{ status: "paused", executionId, pending }`, the
   same shape `start` returns.

`resume(executionId, decision, callId)` — steps 1–4 run for BOTH kinds
(rev 9, rev 11); steps 5–6 are the direct arm, and a code row continues
into the shipped replay drive after step 4:

1. `claimForResume(id, attempt, callId)` — the CAS predicate names the
   pending call (rev 10; **shipped, `4c75b05`**): `WHERE id = ? AND
   status = 'paused' AND json_extract(paused_on, '$.callId') = ?`. A
   stale approval for an earlier pause CONFLICTS even when the
   execution is paused again on a different call; lose → `conflict`;
   TTL lazily expires as today. The claim IS the sweep check: a row the
   sweep already failed is no longer `paused`, so the claim loses.
   Pinned with two queued approvals against a program with two approval
   gates (row #46; G2's ledger row is reworded to "exactly one winner
   PER PENDING CALL"). **The claim ADMITS a pause no operator could
   name (rev 11; shipped, `cce91ae`, row #49):** `paused_on` NULL or not
   JSON, or `callId` absent, not text, or ASCII-blank — the ONE set
   `NOT_NAMEABLE_CALL_ID` (sdk `types.ts`), mirrored by the CLI
   argument check, the wire decoder, the manager's entry check, and
   the SQL `trim` arm — wins the claim for ANY operator argument (a
   `CASE`, so `json_extract` never runs on invalid JSON) and is handed
   to step 2 for terminalization, so no row is ever `paused` and
   undecidable. The manager refuses a non-string or blank `callId`
   BEFORE the claim: the SDK entrypoint is public, and a bound number
   could equal a stored numeric id inside SQL.
2. **Post-claim read-side guard (rev 11; the shipped half is
   `cce91ae`, the R1 half is row #50):** before any source read and
   before any decision is staged, in this order. Every failure
   terminalizes `failed` through `failClaimedResume` with
   `decisionApplied: false` and the host-side `corruptPause` flag (the
   daemon log keys on the flag, never on an error name), and the call
   never runs:
   - `claimCallId(id)` — the text-only value THE CLAIM COMPARED
     (`json_extract`; SQLite keeps the FIRST of duplicate JSON keys,
     `JSON.parse` the LAST) — must equal the operator's argument;
   - `isPendingApproval(pausedOn)` (§4.1, the one validator) must hold,
     and `pausedOn.callId` must equal the argument;
   - **legacy branch (rev 13, codex #7):** if the narrowed value is the
     `LegacyPendingApproval` arm (no provenance pair), SKIP the two
     provenance-dependent checks below and go straight to step 3, which
     terminalizes `ConduitCatalogChanged` — the checks below read
     `pausedOn.namespace`, which the legacy arm does not have, and the
     compiler enforces the branch because `pausedOn` is typed as the
     union (§4.1). Pinned: a compile-time narrowing test and a runtime
     legacy-row test (row #50);
   - **namespace agreement (codex #5 P0-2; tightened rev 12, codex
     #6):** `pausedOn.namespace` must equal the namespace of
     `pausedOn.toolName` under the §8.3 grammar (`namespace.local`; the
     namespace alphabet has no dot, so it is the text before the first
     `.`) — AND must equal the `namespace` column of the tool row
     `pausedOn.toolName` resolves to in the store, because `tools.name`
     and `tools.namespace` are stored and hydrated independently
     (`sqlite.ts:369` and `:840`) and the invoker dispatches connection and
     source through the COLUMN (`tool.namespace`, `invoker.ts:178,
     190`), not the name. A row `{ name: "a.x", namespace: "b" }` must
     not validate generation A and dispatch through B. The tool read
     happens here, once, before any source read; a tool that no longer
     resolves is not corruption but catalog change → step 3's
     `ConduitCatalogChanged`;
   - **direct rows:** `direct_call.toolName` and `direct_call.namespace`
     must equal `pausedOn.toolName` and `pausedOn.namespace`, AND
     `direct_call.request` must equal `JSON.stringify(pausedOn.input)`
     (rev 12, codex #6 P0: step 5 stages and invokes `call.request`,
     and the decisions seam consumes exactly what was staged —
     `pausedOn.input = { amount: 1 }` beside `request =
     '{"amount":1000}'` would run 1000 under the approval of 1) — a
     direct execution performs exactly one call, so the call it was
     started for and the call it paused on are the same, in name,
     namespace, and canonical arguments, or the row is corrupt.

   Disposition per stored field (the claim decides on `callId` only;
   this step decides the rest):

   | field | absent | present but malformed | disposition |
   | --- | --- | --- | --- |
   | `callId` | claimed by the corrupt arm | not text, or ASCII-blank: claimed by the corrupt arm | terminalize corrupt (shipped) |
   | `toolName`, `reason` | claimed | not text | terminalize corrupt |
   | `input` | claimed | — (any JSON value is legal) | terminalize corrupt when absent |
   | `expiresAt` | claimed | not a finite number | terminalize corrupt |
   | `namespace` + `sourceGeneration` | BOTH absent → a legacy (pre-R1) pause: step 3 terminalizes `ConduitCatalogChanged` (re-approve), before any source read | one absent, `namespace` not text, or `sourceGeneration` not a finite number | terminalize corrupt |
   | `namespace` vs `toolName` | — | disagree under the grammar, or with the resolved tool row's `namespace` column | terminalize corrupt |
   | `toolName` vs the catalog | tool row missing | — | step 3: `ConduitCatalogChanged` (not corruption) |
   | `direct_call` vs `pausedOn` | — | disagree on `{ toolName, namespace }`, or `direct_call.request !== JSON.stringify(pausedOn.input)` | terminalize corrupt |

   "Terminalize corrupt" is `failed` with error name
   `ConduitInternalError`, the shipped corrupt-state message, and
   `corruptPause: true`. A pause whose JSON does not PARSE terminalizes
   through the prep-window catch with the parse error as its reason
   and no flag — the accepted I-3 exception (INVARIANTS §5.5). Pinned
   one test per row of the table (row #50; the `callId` row is #49).
3. **Generation check (D3 authority, both kinds):** read the namespace's
   current `sources.generation`; missing (source removed), not equal to
   `pausedOn.sourceGeneration`, or the provenance pair ABSENT (legacy
   pause, step 2) → terminalize `failed` with
   `ConduitCatalogChanged` (`failClaimedResume`), `decisionApplied:
   false`. This runs AFTER the claim, so a provision that commits
   between the sweep and the claim is still caught.
4. Revalidate the grant AND the flag: `(await scope(row.clientId))
   .permits(row.projection, call.toolName)`; false → terminalize
   `failed` with `ConduitScopeRevoked`, `decisionApplied: false`. A
   profile turned off, narrowed, or removed since the pause all land
   here.
5. Stage the decision bound to `{ op: "call", toolName: call.toolName,
   request: call.request }`, build the invoker with `decisions`, and
   invoke with `(call.toolName, JSON.parse(call.request))`. The
   invoker's existing identity check consumes the decision only on an
   exact match, so the call performed is byte-identical to the one
   approved; policy is re-evaluated by the invoker path as today only
   when no decision is staged — with a staged decision, the D6 branch
   applies, exactly as for Code Mode. `decisionApplied` is reported
   host-side as today.
6. Settle as in `startDirect`.

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
field (rev 6; generalized to BOTH kinds in rev 9, codex #3):** every
governed call — not only a direct drive — owns a host-side, monotonic
`DispatchState = "none" | "initializing" | "dispatched"` cell, created
by the invoker per call and passed to the upstream caller. The caller
advances it to `initializing` when session/handshake traffic starts
(`upstream.ts:129` — initialize precedes the governed call and must not
count as dispatch) and to `dispatched` IMMEDIATELY BEFORE the write
call that submits the governed `tools/call` body (`req.end(payload)`
in `mcp-client.ts`'s `openPost`) — before, not after, because a
transport failure during that call may have transmitted part or all
of the body (rev 15, CodeRabbit): once the write is attempted the
effect is unknowable, so any failure from that point is post-dispatch.
A zero-byte failure is indistinguishable from a partial one at this
layer and is classified the same way. Nothing ever lowers the cell.
Pinned: connection loss injected inside the write settles
`ConduitOutcomeAmbiguous` and the call is never re-sent (row #24).
For a DIRECT drive the `DirectDrive` object (§5.3) holds a reference to
its one call's cell and the manager classifies at settle time by
READING THE CELL — not an error field — so it survives every wrapping
and replacement error (today a post-dispatch upstream error whose
refusal Trace-append also fails is REPLACED by the audit error,
`invoker.ts:222-235`, and a field on the original would be lost), and
the drive timer consults the same cell when it fires. For a CODE MODE
drive, a call whose cell reads `dispatched` at failure time raises a
HOST-SIDE, GUEST-UNCATCHABLE terminal signal through the journaling
wrapper — exactly the path `ConduitReplayDivergence` takes today
(`invoker.ts:89-95`, `manager.ts`): the guest never sees it, the
manager terminalizes the execution `failed` with
`ConduitOutcomeAmbiguous`, and a guest `try/catch` around the call
cannot turn an ambiguous upstream effect into a `completed` execution.
Without this, the shipped mapper turns a post-dispatch 404 into an
ordinary guest-catchable `ConduitUpstreamError` (`upstream.ts:294`,
journaled at `manager.ts:325`) and §7's ambiguity promise had no
execution path on the Code Mode side. Today the timeout is flattened
into a plain `ConduitUpstreamError` (`upstream.ts:284`) and the error
vocabulary has no timeout member (`errors.ts:8`); the cell is how
effect uncertainty is classified WITHOUT parsing messages. Never
guest-visible; guest-safe names unchanged. Pinned for both kinds with
a side-effect-then-404 fixture and, for Code Mode, a guest `try/catch`
around the call (row #21, #24).
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
| qualified tool identity, canonical arguments | immutable | decisions seam exact-match; byte-identical rebuild (§4.1); post-claim read-side guard on the stored row — namespace agreement, `direct_call` ↔ `pausedOn` (§5.4 step 2, rev 11) |
| pending-call identity | immutable, one call per approval | `claimForResume` CAS keyed by (execution, `callId`) — shipped `4c75b05`; a pause no operator can name is claimed and terminalized, never stranded — shipped `cce91ae` (§5.4 steps 1–2) |
| decision | immutable, one-shot | decisions seam `take` |
| effective capability grant | revalidate on resume | §5.4 step 4 |
| policy version | R1 INHERITS D6: a staged approval applies to exactly one byte-identical call and skips the policy engine, for Code Mode today and for direct now. The brief's "a stricter policy is never bypassed by an old approval" rule needs a policy version to compare against and is R2 work; stated here so it is not read as shipped. | invoker (unchanged) |
| credential secret version | resolve live if connection unchanged | invoker step 4 (unchanged) |
| tool/source revision | **fail closed on any namespace write (D3)** | `sources.generation` compared after the resume claim (authority, both kinds) + `invalidatePaused` sweep (housekeeping); triggers make the bump writer-independent |
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
  send): for `execute` the server's existing wording, verbatim,
  pointing at `check_execution`; for the direct arms the
  projection-specific wording of the §4.1 status table (rev 16) —
  keyless direct: no lookup handle exists, re-issue only if safe;
  discovery `call` with `requestKey`: re-issue with the same key and
  read the execution id off the `conflict` answer.

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
post-dispatch (dispatch state `dispatched`, §5.5) and settles
`ConduitOutcomeAmbiguous`. Session
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
name into the qualified name (`_u`→`_`, `_h`→`-`, `_d`→`.`; any other
`_` pair is invalid) and puts
the qualified name on `tool.call`; the daemon re-checks `permits` on
it. No server-side map, no refetch, no stale-name path: an undecodable
or unpermitted name gets the same refusal. **Pages:** the server walks
EVERY daemon page (`nextCursor`) and returns ONE `tools/list` to the
MCP client — stdio has no frame cap, and client support for
`tools/list` pagination is uneven, so the client never sees a cursor.
**Advertisement budget (rev 15, Greptile P1):** the walk is bounded by
`ADVERTISE_TOOLS_MAX` (500 tools) and `ADVERTISE_BYTES_MAX` (4 MiB of
encoded `tools/list`), whichever is hit first; the server stops
walking at the budget, logs once per listing (the count dropped), and
the remaining tools stay reachable through discovery `call` and Code
Mode. The cut is deterministic because pages are in qualified-name
order (§5.3), so the same catalog always advertises the same prefix.
**The walk is time-bounded as well as size-bounded (rev 16, codex #8
P1):** each daemon page carries its own 30 s read deadline
(`runtime-stdio.ts:96-102`, `server.ts:110-122`), so a count budget
alone still permits hundreds of sequential deadlines. The server holds
ONE absolute `ADVERTISE_WALK_DEADLINE_MS` (30 s) for the whole
`tools/list`, passes the REMAINING budget to every page request, and
on expiry FAILS the listing with the server's existing timeout wording
— never a latency-dependent partial prefix, which would make the
advertised set depend on daemon speed. A multi-source catalog can
therefore never make `tools/list` exceed memory or the walk deadline
(rows #36, #37).

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

`advertisedName(qualified)` (rev 9 — codex #3 showed the run-length
scheme was NOT injective: namespaces may end in `-` and local names may
hold consecutive dots, so `a-.b` and `a...b` both became `a---b`):
character-wise, prefix-free escapes with `_` as the escape character —
`_` → `_u`, `-` → `_h`, `.` → `_d`, every other character literal.
Decoding is unambiguous because every `_` in an advertised name begins
exactly one two-character escape and no other character does, so two
qualified names never share an advertised name and a name can never be
reassigned — the same qualified name always has the same advertised
name, and a different qualified name always has a different one.
Reserved verbs are unreachable by construction: every advertised name
is a valid escape string containing `_d` (a qualified name always has a
dot); `execute`, `search`, `describe`, `call` contain no `_`, and
`check_execution` contains `_e`, which is not a valid escape, so none
of the five decodes to any tool. If the encoded form exceeds 64
characters the tool is EXCLUDED from direct advertisement
(deterministic, logged once; still reachable via discovery `call` and
Code Mode) — no truncation, no hash, no reassignment surface. Pinned
with codex's collision pair, leading and consecutive local dots, and a
trailing-hyphen namespace (row #7). The daemon computes the name; the server
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
projection-specific wording of §7 (rev 16: keyless direct has no
handle; discovery recovers by `requestKey`). The client polls `check_execution` after a pause; no
push channel in R1.

M1 restated per projection: no projection advertises or accepts an
approval verb; `approvals.resume` remains reachable only through the
`approvals` row.

## 9. Testing and ledger

### 9.1 Acceptance rows (enter INVARIANTS.md as ⏳ with the Lane A PR)

(Rev 15, Greptile: the spec PR is prose-only and cannot carry ledger
rows that no test yet pins; the rows below enter `INVARIANTS.md` as ⏳
in the FIRST code PR — Lane A — and flip per commit from there. Until
then this table is the ledger's staging area.)

| # | claim | pinning test (planned) |
| --- | --- | --- |
| 1 | a direct call cannot bypass governance — same policy/credential/approval path as Code Mode | `execution/manager.test.ts` (direct: block, require_approval, allow) |
| 2 | direct and Code Mode cross the same §9.2 boundary | D5 harness only (`projection-harness.test.ts`); the existing `credentials.test.ts:83` INVARIANT stays as the Code Mode anchor |
| 3 | approval works without assuming `execute` | `manager.test.ts` (direct pause → resume approve/deny, `decisionApplied`) |
| 4 | a removed tool becomes uncallable immediately | `daemon/conduitd.test.ts` real processes: remove → next `tool.call` refused |
| 5 | stale discovery cannot preserve revoked authority (G3) | same file, at the RPC level (Lane B): list → revoke → `tool.call` by the cached qualified name refused; the advertised-name variant is Lane C in `server.test.ts` |
| 6 | current authority checked on every call | `effectiveScope` unit + connection test (profile edit mid-connection) |
| 7 | tool names deterministic, injective, MCP-compatible, never reassignable | `server.test.ts` (grammar; the `_u`/`_h`/`_d` escape encoding round-trips; `a-.b` vs `a...b` and codex's earlier triple resolve to distinct names; verbs undecodable; >64 excluded; stability under scope AND catalog change) |
| 8 | upstream growth cannot silently expand a tool-level grant | `effectiveScope` unit |
| 9 | profiles only narrow | `effectiveScope` unit (allow ∩ catalog ⊆ allow; default vs named) |
| 10 | trace semantics comparable across projections | D5 harness over stored `trace_events` rows |
| 11 | request-conflict and retry defined for direct calls | D5 harness (`requestKey` conflict over both kinds) |
| 12 | two-tool clients byte-for-byte compatible | `server.test.ts` (default profile `tools/list` snapshot equals today's) |
| 13 | mid-session narrowing bites on the same connection; no re-handshake re-widens (D4) | `daemon/conduitd.test.ts` / `client.test.ts` real processes (the PR #53 pattern) |
| 14 | namespace write invalidates paused rows of BOTH kinds; resume fails closed re-approve (D3) — including a provision that commits AFTER the sweep but BEFORE the claim (generation check), remove-then-re-add, and a LEGACY pause with no provenance | `manager.test.ts` (generation mismatch / absent → `ConduitCatalogChanged`, `decisionApplied:false`; re-add does not revive) + `daemon/provision.test.ts` (sweep runs after `provisionSource` commit) + `source.remove` test |
| 15 | a Code Mode row that paused under a narrowed profile resumes under that profile (audit P0) | `manager.test.ts` (narrow → pause on allowed tool → approve → out-of-scope call blocked) |
| 16 | a projection FLAG turned off revokes like a removed tool: a running program's next call and a paused direct call's resume both fail closed with the allowlist unchanged (codex P0) | `manager.test.ts` + `daemon/conduitd.test.ts` |
| 17 | a generation bump after remove+re-add (incl. deleting the current maximum / every source) never revives a paused row of either kind; the operator-race window is DOCUMENTED as an accepted limit, not pinned (codex P0 ×2; rev 8 D10/D13) | `sqlite.test.ts` (sequence never reused) + `manager.test.ts` (both kinds) |
| 18 | result access is per client: `execution.get`/`getByRequestKey` answer not-found for a foreign row; request keys conflict only within one client (codex P1) | `daemon/conduitd.test.ts` + `manager.test.ts` |
| 19 | every new row fails closed on an OLDER build: `code` holds the sentinel, the program lives in `program` (codex P0) | `sqlite.test.ts` (hydrate: program present → used; sentinel in `code`) + a legacy-hydrator simulation |
| 21 | a governed `tools/call` is dispatched at most once per approval: a 404 after dispatch settles outcome-ambiguous and is never re-sent (codex P0, rev 5) | `pipeline/mcp-client.test.ts` + `upstream.test.ts` (side-effect-then-404 fixture), both projections via the D5 harness |
| 20 | the direct listing pages by COMPLETE encoded size under the IPC frame cap and always progresses; schemas never travel when direct is off; malformed MCP envelopes and over-length names are excluded from advertisement, deterministically (codex P1 ×3, rev 6) | `daemon/conduitd.test.ts` (packing vs the 1,626,191-byte reproduction; oversized entry skipped) + `server.test.ts` (SDK `ToolSchema` gate) |
| 22 | a direct drive settles exactly once: a late continuation after the timer cannot overwrite `failed`; the admission slot is released only after the work stops — or after `DIRECT_SLOT_RETENTION_MS`, whichever is first — and an abandoned continuation is QUARANTINED, still counted against the cap until it settles: `DIRECT_ADMISSION_MAX` drives stuck on a never-returning store read keep the daemon `busy` (a bound, not a counter), a returning read frees its slot without dispatching (the expired deadline gate), and a late completion never changes the row (codex P1, rev 6; lock halves removed rev 8; retention rev 15; quarantine rev 16) | `manager.test.ts` (delayed success / delayed refusal after timeout; stuck-continuation quarantine; no dispatch after abandonment) + `sqlite.test.ts` (attempt-fenced settle) |
| 23 | two handshakes in one tick on a named-client connection bind exactly once; requests during `validating` are refused (codex P1, rev 6) | `daemon/conduitd.test.ts` real processes |
| 24 | post-dispatch classification survives error replacement: a dispatched call whose refusal audit also fails still settles `ConduitOutcomeAmbiguous`; initialize traffic never counts as dispatch; the cell flips BEFORE the body write, so connection loss injected inside `req.end(payload)` (partial or zero-byte) settles ambiguous and is never re-sent (codex P1, rev 6; write boundary rev 15) | `manager.test.ts` + `pipeline/upstream.test.ts` + `pipeline/mcp-client.test.ts` (loss-inside-write fixture) |
| 25 | request keys: a named client's key lives in `request_keys` and never collides with any default-profile key, including a legacy key containing U+0000; a legacy raw key and a default-profile key are the same row; a `conflict` always carries the same-client execution id (codex #3, rev 9) | `sqlite.test.ts` + `manager.test.ts` (Lane A) |
| 26 | two direct drives on one namespace run concurrently up to `DIRECT_ADMISSION_MAX`; a provision never waits on a drive and a drive never waits on a provision (D10) | `daemon/conduitd.test.ts` (Lane B) |
| 27 | every trace row carries `projection` and `client_id` (NULL = default profile), on both kinds (D4) | D5 harness (Lane A) |
| 28 | `DirectDrive` transitions: dispatch monotonic; `settled` taken exactly once; attempt id fences the settle write (D5) | `manager.test.ts` (Lane A) |
| 29 | versioned scope snapshot: a write without a version bump is impossible; a snapshot built before a write is never served after it; restart starts unversioned (D7) | `daemon/conduitd.test.ts` (Lane B) |
| 40 | profile and tool writes exist ONLY under `packages/mcp/src/daemon/` — no CLI or SDK path writes them out of process, so the in-memory scope version cannot be bypassed (D15) | a source-scan test in `packages/mcp/src/daemon/` (Lane B) |
| 41 | a synchronous direct completion persists no `result` and polls back as `completed, resultAvailable:false` (never `result:null`); a resumed completion persists it redacted per policy `redactFields`; a result over `RESULT_BYTES_MAX` is settled `completed` + `result_state:'discarded'` in ONE write by the manager (both the synchronous and the resumed path), answers `completed` + `resultTooLarge`, and polls back as `completed, resultAvailable:false, resultTooLarge:true`; the daemon's frame check never fires on a completed direct envelope; the read-side guard refuses a completed direct row with no `result_state` or an inconsistent `result`/`result_state` pair (D12; codex #3, rev 9; `'discarded'` rev 15; settle-time decision rev 16) | `manager.test.ts` + `payloads.test.ts` + `sqlite.test.ts` + D5 harness (Lanes A, B) |
| 42 | a paused Code Mode row whose namespace is re-provisioned resumes to `ConduitCatalogChanged`, same as a direct row (D13) | D5 harness (Lane A) |
| 43 | scoped search filters BEFORE ranking and the limit: an allowed tool ranked below ten disallowed ones is still returned, for discovery and in-sandbox search (codex #3, rev 9) | `catalog.test.ts` + `daemon/conduitd.test.ts` (Lanes A, B) |
| 44 | direct drives are in the daemon's lifecycle accounting: disconnect then `daemon stop` while a direct call runs waits the drain grace and reports abandonment; `executionsInFlight` counts them (codex #3, rev 9) | `daemon/conduitd.test.ts` (Lane B) |
| 45 | the client-visible timeout outcome resolves within budget even when the continuation OR the settle write is blocked; a stalled write yields `status:"unknown"` with the id, never a claimed terminalization; late preparation never dispatches after expiry (codex #3/#4) | `manager.test.ts` (Lane A) |
| 46 | an approval binds to ONE pending call: two queued approvals for pause A against a program with two gates → the second `conflict`s, never approves pause B; `claimForResume` predicate includes `callId` (codex #4 P0, rev 10; shipped-code defect) — **SHIPPED: PR #58 `4c75b05`, 2026-09-05; INVARIANTS §5.5 row ✅** | `sqlite.test.ts` + `manager.test.ts` + `packages/cli/src/approvals.test.ts` (on main) |
| 47 | a provision or revalidate through the SHIPPED pre-R1 SQL against an R1 database still bumps the namespace generation (triggers), so a pause taken before a daemon downgrade fails closed on resume after the upgrade (codex #4 P0, rev 10); a source row CREATED without tools (remove, then standalone re-add), a zero-tool revalidate, and a retarget under the same source id all bump, and the triggers survive a pre-R1 build opening the database (codex #5 P0-3, rev 11); a provision with N tools writes exactly N+1 ledger rows and the namespace's generation is the last (cardinality pin, rev 15) | `sqlite.test.ts` (Lane A) |
| 48 | the connections block of a listing is bounded at `LISTING_CONNECTIONS_MAX` entries AND `LISTING_CONNECTIONS_BYTES` encoded bytes with one truncation flag, packed deterministically, and counted in the page budget; an empty-tool page and a direct-disabled listing both fit the frame cap with 20,000 connections, and with 200 entries whose `prefix`/`label` are each 16 KiB (codex #4, rev 10; byte cap rev 15) | `daemon/conduitd.test.ts` (Lane B) |
| 49 | the liveness half of #46: a pause whose stored `callId` no operator can name — row not an object, `callId` absent, not text, or ASCII-blank — is claimed and terminalized `failed` with `corruptPause`, never stranded `paused`; ONE validator `isPendingApproval` decides "corrupt" for the manager and `approvals.list`; every corrupt pause lists as a recovery row carrying the SQL-extracted id, or none; the manager requires `claimCallId` to equal the operator's argument (codex #5 P1, threat-model pass) — **SHIPPED: PR #59 `cce91ae`, 2026-09-11; INVARIANTS §5.5 row ✅** | `sqlite.test.ts` + `manager.test.ts` + `payloads.test.ts` + `packages/cli/src/approvals.test.ts` (on main) |
| 50 | post-claim read-side guard, R1 half: `pausedOn.namespace` equals the grammar-derived namespace of `pausedOn.toolName` AND the resolved tool row's `namespace` column (a `{ name:"a.x", namespace:"b" }` row terminalizes, never dispatches through B); a direct row's `direct_call` equals its `pausedOn` on `{ toolName, namespace }` and `request === JSON.stringify(input)` (a corrupt `request` never runs under the pause's approval); the provenance pair is present together (typed) or absent together (legacy → `ConduitCatalogChanged`; the validator narrows to the `StoredPendingApproval` union); every other combination terminalizes corrupt with `corruptPause`, `decisionApplied:false`, and the call never runs — one pin per row of the §5.4 disposition table, both kinds (codex #5 P0-2, rev 11; codex #6 P0/P1, rev 12) | `manager.test.ts` + a `types.test.ts` case per validator branch (Lane A) |
| 30 | decoder: `clientId` on a non-`serve` handshake → `invalid`; `tool.call` without `input` → `invalid`; `tool.call` with `projection: "direct"` AND `requestKey` → `invalid` (A4 at the wire, rev 15); `describe.includeSchemas` decoded, absent = false; `catalog.listing.cursor` decoded | `daemon/rpc.test.ts` (Lane B) |
| 31 | admin row no-widening: `serve` holds no `profile.*`/`source.*`/`daemon.*`/`approvals.*`; `admin` holds no `execute`/`tool.call`/`search`/`describe` and no approval verb (extends the existing capability pins) | `daemon/rpc.test.ts` (Lane B) |
| 32 | `conduit remove-mcp` is atomic: tools, policies, connection, integration, source, AND the sealed secret all gone or none; paused direct calls on it invalidated; unknown namespace is a named error | `daemon/provision.test.ts` + `packages/cli/src/remove-mcp.test.ts` (Lane B) |
| 33 | `conduit profiles set\|list\|remove`: argv parsing, `clientId` grammar rejection, `allow`/`projections` JSON round-trip, exit codes, and no credential-bearing output | `packages/cli/src/profiles.test.ts` (Lane B) |
| 34 | `conduit serve --client <unknown>` exits non-zero naming the id and never serves the default profile | `packages/cli/src/integration.test.ts` (Lane C) |
| 35 | direct-cap refusal is `code: "busy"` with the direct-specific text, and the slot is released only after the drive settles | `daemon/conduitd.test.ts` (Lane B) |
| 36 | daemon listing cursor is stable across pages; the server's full walk returns every allowed tool exactly once up to the advertisement budget (`ADVERTISE_TOOLS_MAX` / `ADVERTISE_BYTES_MAX`), stops deterministically at the budget with one log line, fails the whole listing when `ADVERTISE_WALK_DEADLINE_MS` expires (never a partial prefix), and a catalog change mid-walk can only drop a name, never bind it to a different tool (budget rev 15; walk deadline rev 16) | `daemon/conduitd.test.ts` (Lane B) + `server.test.ts` (Lane C; a catalog past both budgets; slow pages past the walk deadline) |
| 37 | a listing carries no schemas when `projections.direct` is false; a listing from an OLDER daemon (no `projections`/`tools`) is read as code-only with no direct tools; the server's page walk terminates and never repeats an entry | `daemon/conduitd.test.ts` + `server.test.ts` (Lanes B, C) |
| 38 | server name resolution is a pure decode: `decode(encode(q)) === q` for every legal qualified name and an invalid escape (`_e`, trailing `_`) is undecodable; an undecodable or unpermitted name → MCP "unknown tool"; the qualified name goes on the wire and the daemon re-checks `permits` | `server.test.ts` (Lane C) |
| 39 | `approvals list` renders direct rows with their projection, call id, and tool name, and does not render `reason` (§5.3 display contract); `check_execution` payload shape is unchanged for code rows | `packages/cli/src/approvals.test.ts` + `payloads.test.ts` (Lanes B, C) |

Three ambiguity invariants (§7): crash-before-persist (sweep test over a
`running` direct row, Lane A); keyless-upstream documented limit (Lane
A: no retry occurs; Lane C: the direct tool description carries the
statement); timeout-unknown (a timeout while dispatch state is
`dispatched` settles `failed` with the unknown-outcome wording, never
re-invoked; a pre-dispatch timeout settles under its own name — §7).

Two pins for the data model: the `request` round-trip property (§4.1)
and the read-side kind guard (corrupt row refused).

### 9.2 D5 harness

`packages/sdk/src/execution/projection-harness.test.ts` runs rows #2,
#10, and #11 once each over the valid `(kind, projection)` pairs —
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

Rows #4, #5, #13, and #14 follow the PR #53 pattern: a real daemon, real
clients, the assertion on the SAME connection.

## 10. Build shape (input to the plan)

Three lanes, each its own PR, each load-bearing (full gauntlet,
explainer + quiz, human-named merge):

1. **Lane A — store + manager.** §4 (all columns incl. `client_id`,
   `projection`, `program`, `source_generations`), §5.4, §5.5 (incl.
   the per-call dispatch cell), the `EffectiveScope`/`ScopeResolver` types,
   client-namespaced request keys, D5 harness, ambiguity invariants
   (manager side), rows #1–#3, #9 (unit), #15, #16 (manager half),
   #17, #18 (manager half), #19, #21, #25, #41, #42, #47, #50, G1–G3
   (#46 and #49 are already on main). No wire
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
  `RESUME_ADMISSION_DEADLINE_MS`, pinned), `LISTING_PAGE_BYTES`
  (512 KiB, half the frame cap; measured on encoded bytes),
  `LISTING_CONNECTIONS_BYTES` (128 KiB), `DIRECT_SLOT_RETENTION_MS`
  (30 s), `ADVERTISE_TOOLS_MAX` / `ADVERTISE_BYTES_MAX` (500 tools /
  4 MiB), `ADVERTISE_WALK_DEADLINE_MS` (30 s, absolute across pages),
  and `RESULT_BYTES_MAX` (256 KiB, measured on `JSON.stringify(result)`
  at settle) — added rev 15–16; values are recommendations, the bounds
  themselves are pinned.
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
- 2026-09-05 (23:42) — **codex pass #3 on rev 8: 0 P0 / 8 P1 / 1 P2,
  NOT CONVERGED; all nine folded in rev 9** (none reopens a settled
  decision): run-length name encoding not injective (`a-.b` vs
  `a...b`) → prefix-free `_u`/`_h`/`_d` escapes (§8.2, §8.3, rows
  #7/#38); rev 6 key encoding collides with LEGACY NUL-bearing keys →
  `request_keys` mapping table, legacy column untouched, ID-less
  conflict variant withdrawn (§4.1, row #25); provenance stated
  inconsistently → one `PendingApproval` shape for both kinds, legacy
  pause = fail closed (§4.1, §5.4, row #14); Code Mode 404 ambiguity had
  no execution path → per-call dispatch cell + guest-uncatchable
  terminal signal via the journaling wrapper (§5.5, rows #21/#24);
  discarded sync result polled as `null` → `result_state` +
  `resultAvailable:false` + `resultTooLarge` (§4.1, row #41); scoped
  search order → filter before rank/limit (§5.3, row #43); direct
  drives absent from drain accounting → daemon-wide tracking (§5.3,
  row #44); timer awaited its continuation → outcome promise split
  from cleanup promise, timer starts before prep (§5.3, §5.4, row
  #45); stale lock/`invalidatePausedDirect`/`afterDispatch` wording
  swept. Confirming pass #4 follows.
- 2026-09-06 (00:10) — **codex pass #4 on rev 9: 2 P0 / 3 P1 / 1 P2,
  NOT CONVERGED.** Both P0s are a NEW class — an approval or a
  provenance stamp binding to an INSTANCE that can be replaced across
  TIME (a later pause of the same execution) or across WRITERS (an
  older daemon build): (1) `approvals.resume` names only the execution
  and the claim checks only `paused`, so a queued duplicate approval
  can approve a later pause — a shipped Code Mode defect, reproduced
  → `callId` on the wire and in the CAS predicate (§5.3, §5.4, row
  #46, T9); (2) an older daemon's provisioning leaves `generation`
  untouched → SQLite triggers bump it for any writer (§4.1a, row #47,
  T10). P1: settle-write stall still blocks the outcome → bounded
  persistence + `status:"unknown"` variant (§5.3, row #45); the
  connections block alone can exceed the frame cap → bounded +
  counted (§5.3, row #48); T2 still mandated the rejected encoding and
  two stale terms survived → fixed (report, §6, §10). P2: `result_state`
  missing from the model → column, vocabulary, type, guard (§4.1). All
  folded in rev 10. **Per the adversarial-convergence rule (CLAUDE.md,
  "Adversarial review has a stop line": new-class breaks repeatedly →
  pause for a dedicated threat-model pass before more code), the loop
  STOPS here: the next step is a
  threat-model pass on instance binding (approval ↔ pending call ↔
  provenance ↔ writer version), then pass #5 — not a fifth
  fold-and-rerun.**
- 2026-09-11 (00:45 → 12:00) — **instance-binding threat-model pass, the
  step rev 10 named.** (1) `/blindspot` codebase mode → eight cards
  (artifact "Instance Binding Blindspots", 2026-09-11; §3.1 carries
  them). (2) **codex pass #5** (`gpt-5.6-sol`, effort `high`; trigger:
  authorization boundary; 3 P0 / 1 P1 / 1 P2, NOT CONVERGED),
  founder-adjudicated: **P0-1** a pre-R1 daemon resuming against an R1
  database → OUT OF SCOPE on the fact that nothing is published (npm
  404), plus the standing writer-floor rule from the first published
  version onward (§3.1); **P0-2** tool-name ↔ namespace agreement
  rests on the grammar → post-claim read-side guard with
  `direct_call` ↔ `pausedOn` equality (§5.4 step 2, row #50); **P0-3**
  no `AFTER INSERT ON sources` trigger, so remove + standalone re-add
  resurrects generation 0 → INSERT trigger + three pins (§4.1a, row
  #47); **P1** a present-but-malformed `callId` strands the row —
  SHIPPED code, so a fix PR against main (precedent rev 10 → #58):
  **PR #59 `cce91ae`** (row #49). Its own gauntlet: five codex runs,
  all `gpt-5.6-sol` `high` (trigger: authorization boundary +
  persistence invariant) — 0 P0/2 P1/2 P2 on `1aef6aa` → 0/2/1 on
  `0997d76`, same class → shape fix, ONE validator → 0/2/2 on
  `677ddd5` → 0/1/1 on `fbda698` (duplicate-key parser disagreement →
  `claimCallId`) → **CONVERGED on `9cf3e6e`**, 0/0/0; accepted (class
  a): the CLI option parser intercepting a corrupt `--` id,
  unparseable JSON terminalizing via the I-3 catch without the flag,
  the redundant `IS NULL` arm; pr-review-toolkit ×5, `/security-review`
  clean, Aikido clean, `/code-review` five agents folded, Greptile one
  finding folded in `aed9825`; explainer "The Un-nameable Call Id",
  quiz passed, founder-named merge. **P2** a daemon downgrade
  terminalizes a pending approval → accepted, recorded (§3.1).
  Corrections the pass surfaced: the CLI list does not render `reason`
  (§5.3 display contract); a provision writes N+1 ledger rows, not one
  (§4.1a); `provisionSource`'s explicit ledger insert removed as a
  duplicate bump (§4.1a). Task state: T9 SHIPPED via #58 (`4c75b05`);
  T2 (`request_keys`) is NOT on main — only its rev-10 text fix is
  done.
- 2026-09-11 — **rev 11 folds the above:** §3.1 (new), §4.1 (one
  validator, provenance pair), §4.1a (INSERT trigger, three pins, N+1,
  no explicit insert), §5.3 (operator passes the id; display
  contract; #58 shipped), §5.4 (claim admits the un-nameable; step 2
  guard + disposition table; steps renumbered), §6 (pending-call row),
  §9.1 (#46 shipped, #47 extended, #49 shipped, #50 new, #39
  reworded), §10 (Lane A rows), tasks (T9 done, T9b done, T10
  extended, T11 new, T2 status). **Codex pass #6 (confirming;
  `gpt-5.6-sol` `high`, trigger: authorization boundary) follows, then
  the founder's read, then writing-plans.**
- 2026-09-11 (12:47 → 13:03) — **codex pass #6 on rev 11: 2 P0 / 2 P1 /
  1 P2, NOT CONVERGED, all class (c)** (`gpt-5.6-sol`, effort `high`;
  trigger: authorization boundary + convergence verdict; 932 s; it
  verified the shipped #58/#59 code on main and the npm 404s). P0-2
  residual: the rev-11 guard compared the grammar prefix while dispatch
  uses the independently stored `tools.namespace` column →
  resolve-the-tool check added (§5.4 step 2). New P0: `direct_call.request`
  was never cross-bound to `pausedOn.input` while step 5 stages
  `call.request` → request equality added. P1: the update trigger's DDL
  omitted the `WHEN` guard the prose claimed (reproduced: N+2, or
  recursion) → guard in the DDL; growth restated as Σ(Nᵢ+1). P1: the
  extended validator's TS predicate would lie about legacy rows →
  `StoredPendingApproval` union. P2: §5.3 described pre-#58 behaviour
  as "today" → reworded. Confirmed converged from pass #5: P0-1 (a),
  P0-3, P1 (#59), P2 (a). **Rev 12 folds all five; codex pass #7
  (confirming) follows.**
- 2026-09-11 (15:22 → 15:33) — **codex pass #7 on rev 12: 0 new
  findings; 9 of 10 adjudicated items CONVERGED; 1 residual P1 (c)**
  (`gpt-5.6-sol`, effort `high`; trigger: authorization boundary +
  convergence verdict; the first attempt at 13:06 died on the
  provider's usage limit, re-run as queued). It executed the §4.1a DDL
  in SQLite 3.51.0 (fresh INSERT, conflict-upsert UPDATE, tool INSERT,
  `recursive_triggers` off and on): exactly one allocation each — the
  trigger design is confirmed. Residual: rev 12 introduced the
  `StoredPendingApproval` union but left `ExecutionBase.pausedOn`
  typed as `PendingApproval`, so the union reached no reader, and
  step 2 did not state that the legacy arm skips the
  provenance-dependent checks. **Rev 13 folds it** (§4.1 type block,
  §5.4 step 2 legacy branch). **Adjudication (LEARNINGS #16):** the
  residual is a precision defect in the previous fold, not a new class;
  pass #7 found nothing else across time, writers, or the guard, and
  named the only remaining window as D10 (class a). The loop STOPS
  here: next is the founder's read of rev 13, then writing-plans. An
  eighth pass is the founder's call, not the rule's.
- 2026-09-11 (15:50) — **rev 14, the read pass (agent, on the founder's
  instruction; no semantic change):** §4.1 cross-reference fixed (the
  legacy branch is step 2 → step 3, not "step 3 narrows"); a stray
  empty code fence removed; line citations in current sections
  refreshed to the branch tip `fe20139` (`sqlite.ts` 689→800, 727→838,
  129-138→198-205, `manager.ts` 628→653; trail entries keep their
  historical numbers); §5.3's timer-start reference disambiguated to
  `startDirect` step 2; T1 marked MOOT (the lock it would remove was
  never implemented); the eng-review report row updated. Codex pass
  #8 NOT run: no boundary, type, or DDL changed in this revision.
- 2026-09-11 (17:25 → 17:45) — **rev 15: PR #57 marked ready on the
  founder's merge instruction; CodeRabbit (10) and Greptile (5)
  reviewed; every finding adjudicated.** FOLDED (design): A4 leaked —
  `requestKey` was on both `tool.call` arms → discriminated union,
  decoder refuses it on `direct` (§5.1, row #30); an oversized
  synchronous completion matched neither `result_state` →
  `'discarded'` (§4.1, row #41, T3); timed-out drives could hold
  admission slots until restart → `DIRECT_SLOT_RETENTION_MS` with
  logged abandonment, safe under the attempt fence (§5.3, row #22);
  the aggregated `tools/list` had no global bound →
  `ADVERTISE_TOOLS_MAX` / `ADVERTISE_BYTES_MAX`, deterministic cut
  (§8.2, rows #36/#37); the connections block had an entry cap but no
  byte cap → `LISTING_CONNECTIONS_BYTES` (§5.3, row #48);
  `DispatchState` "at the moment the frame is written" was ambiguous
  under a partial write → flips BEFORE `req.end`, loss inside the
  write is ambiguous (§5.5, row #24); D12's discarded synchronous
  result is unrecoverable after IPC loss → stated as the accepted
  consequence, recovery wording corrected (§4.1 status table).
  FOLDED (editorial): "Code Mode unchanged" scoped to wire shape with
  the two behaviour changes named (§1); per-tool ledger cardinality
  pinned (row #47); ⏳ rows enter INVARIANTS with the Lane A PR, not
  the prose PR (§9.1 — the honest reading of the ledger rule);
  `~/.claude/...` path → public-safe title (§12); markdown pipes,
  heading-like line starts, and a blank line (rows #33, §9.2, §9.4,
  tasks). STALE (reviewed an earlier snapshot): the `WHEN` guard (in
  the DDL since rev 12) and `callId` threading (shipped in #58; in the
  §5.4 signature since rev 11). NOT A SPEC DEFECT: the shipped decoder
  not yet accepting `clientId` / `includeSchemas` / `cursor` — that is
  Lane B's work and row #30 pins it. New task T12 carries the rev-15
  bounds. **Codex pass #8 (confirming, `gpt-5.6-sol` `high`; trigger:
  the rev-15 changes touch resource limits and the dispatch boundary)
  runs on this revision before the merge.**
- 2026-09-11 (17:35 → 17:47) — **codex pass #8 on rev 15: 1 P0 / 3 P1
  class (c), 1 P1 class (a), 1 P2 class (b); NOT CONVERGED** — every
  (c) a seam of a rev-15 fold (`gpt-5.6-sol`, effort `high`; trigger:
  resource limits + dispatch boundary). **P0** `'discarded'` had no
  persistence path: the manager settles before the daemon can see
  frame oversize, and the running-only fence forbids refinement → the
  manager decides at settle time against `RESULT_BYTES_MAX`, one
  write, both paths; TS union fixed (§4.1, row #41). **P1** releasing
  an abandoned slot made the cap a replenishing counter and the
  attempt fence covers only the row, not Trace or teardown →
  QUARANTINE: abandoned work stays counted until it settles; the
  expired deadline gate means it can never dispatch (§5.3, row #22).
  **P1** the walk budget bounded count and bytes but not time (500
  pages × 30 s) → `ADVERTISE_WALK_DEADLINE_MS`, expiry fails the
  listing (§8.2, row #36). **P1** the IPC-loss wording assumed an
  execution id a keyless direct caller cannot have → per-projection
  wording; discovery recovers via `requestKey` → `conflict` (§4.1
  status table, §7, §8.6, row #39). **(a)** an older build conflates
  `discarded`/`delivered` as `result: null` — under §3.1's
  nothing-published decision. **(b)** a provably zero-byte `req.end`
  failure is classified ambiguous — conservative by §7's design, fails
  safe, no duplicate dispatch. **Rev 16 folds the four; codex pass #9
  (confirming) runs before the merge.** Two passes in a row have found
  seams in the previous fold and nothing else (LEARNINGS #21); if #9
  returns another fold-seam only, it is folded and the loop stops
  there by the rev-13 adjudication — a tenth pass is not the rule's.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 (direct `codex exec` passes on revs 3/4/8/9 and the 2026-09-11 threat-model pass #5; three early runs lost to the provider limit) | issues_found | rev 3: 4 P0/8 P1/2 P2; rev 4: 1 P0/8 P1/2 P2; rev 8: 0 P0/8 P1/1 P2 → rev 9; rev 9: 2 P0/3 P1/1 P2 → rev 10; pass #5 (threat model, on rev 10): 3 P0/1 P1/1 P2 → rev 11 + PRs #58/#59 on main; pass #6 (rev 11): 2 P0/2 P1/1 P2 → rev 12; pass #7 (rev 12): 0 new, 1 residual P1 → rev 13; loop closed by adjudication |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_folded (codex loop closed at rev 13) | 15 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** the direct passes (not `/codex review`) drove revs 2–13 (passes #1–#7); every finding is folded, shipped, or out of scope by a recorded decision; pass #7 returned no new finding and the loop is closed (§12 adjudication).
- **CROSS-MODEL:** outside voice (Claude subagent, fresh context) vs the eng review: 9 findings, 7 tensions put to the founder — 6 accepted (D10–D15), 1 rejected (D9); it independently confirmed D4 and D7.
- **VERDICT:** ENG REVIEW COMPLETE, CODEX LOOP CLOSED (rev 13) — ready for the founder's read, then writing-plans.

### Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above.

- [x] **T1 — MOOT (rev 14):** "remove drive linearization" was a spec-level reversal (rev 8 deleted the lock before any code existed); nothing to remove. The surviving obligations — sweep + post-claim generation check on BOTH kinds, rows #17, #42 — are carried by T10, T11, and T8.
- [ ] **T2 (P1, human: ~4h / CC: ~15min)** — sdk/store — Request keys: the `request_keys` mapping table for named clients, written atomically with the execution row; legacy column untouched for the default profile — Surfaced by: D11 → codex #3 (rev 9) — Verify: row #25 — **Status (rev 11): OPEN.** Its spec text was fixed in rev 10; no code is on main.
- [x] **T9 (P1, human: ~1d / CC: ~20min)** — sdk/store + mcp/daemon + cli — Approval instance binding: `callId` on `approvals.resume` and in the `claimForResume` predicate; the operator passes the call id — Surfaced by: codex #4 P0 (rev 10) — Verify: row #46 — **SHIPPED: PR #58 `4c75b05` (2026-09-05)**
- [x] **T9b (P1, shipped)** — sdk/store + sdk/execution + mcp/daemon + cli — Liveness half of T9: the claim admits a `callId` no operator can name; the manager terminalizes it (`claimCallId`, `isPendingApproval`, `corruptPause`); `approvals.list` ships recovery rows — Surfaced by: codex #5 P1 (threat-model pass, rev 11) — Verify: row #49 — **SHIPPED: PR #59 `cce91ae` (2026-09-11)**
- [ ] **T10 (P1, human: ~2h / CC: ~10min)** — sdk/store — SQLite triggers that bump `sources.generation` on any source INSERT or UPDATE and any tool insert, writer-independent; `provisionSource` writes no ledger row of its own — Surfaced by: codex #4 P0 (rev 10), codex #5 P0-3 (rev 11) — Verify: row #47 (incl. zero-tool revalidate, retarget, trigger survival)
- [ ] **T11 (P1, human: ~4h / CC: ~15min)** — sdk/execution + sdk types — Post-claim read-side guard, R1 half: `isPendingApproval` narrows to `StoredPendingApproval` (provenance pair together, or the legacy arm without both); namespace agreement under the §8.3 grammar AND against the resolved tool row's `namespace` column; `direct_call` ↔ `pausedOn` equality on name, namespace, and `request === JSON.stringify(input)`; one test per row of the §5.4 disposition table — Surfaced by: codex #5 P0-2 (rev 11), codex #6 P0 + P1 ×2 (rev 12) — Verify: row #50
- [ ] **T3 (P1, human: ~4h / CC: ~15min)** — sdk/execution — Persist a direct result only on the resume path, redacted; synchronous completion not persisted; `result_state` ∈ {delivered, retained, discarded} with the read-side guard — Surfaced by: D12, CodeRabbit (rev 15) — Verify: row #41
- [ ] **T12 (P1, human: ~4h / CC: ~15min)** — sdk/execution + mcp/daemon + mcp/server — Rev-15/16 bounds: `DIRECT_SLOT_RETENTION_MS` quarantine (counted, not released; expired-deadline gate blocks dispatch); `RESULT_BYTES_MAX` settle-time discard; `LISTING_CONNECTIONS_BYTES` packing; `ADVERTISE_TOOLS_MAX` / `ADVERTISE_BYTES_MAX` + `ADVERTISE_WALK_DEADLINE_MS`; `DispatchState` flips before `req.end`; decoder refuses `requestKey` on the direct arm; projection-specific outcome-unknown wording — Surfaced by: Greptile P1 ×2, CodeRabbit ×3 (rev 15), codex #8 P0 + P1 ×3 (rev 16) — Verify: rows #22, #24, #30, #36, #39, #41, #48
- [ ] **T4 (P1, human: ~4h / CC: ~15min)** — mcp/server — Decode advertised names; walk all daemon pages into one tools/list — Surfaced by: D14 — Verify: rows #36, #38
- [ ] **T5 (P2, human: ~30min / CC: ~3min)** — sdk/store — `client_id` on trace_events; invoker writes projection + client_id — Surfaced by: D4 — Verify: row #27
- [ ] **T6 (P2, human: ~1h / CC: ~5min)** — sdk/execution — One `DirectDrive` object — Surfaced by: D5 — Verify: row #28
- [ ] **T7 (P2, human: ~1d / CC: ~15min)** — mcp/daemon — Versioned scope snapshot + writer-location test — Surfaced by: D7, D15 — Verify: rows #29, #40
- [ ] **T8 (P2, human: ~3d / CC: ~1h)** — tests — Ledger rows #25–#42 with their tests, per lane — Surfaced by: D6, D12–D15 — Verify: INVARIANTS.md flips per commit

NO UNRESOLVED DECISIONS

