# §11 Trace redaction — design (2026-07-10)

Flips the last ⏳ INVARIANTS row and completes Phase 0. Redacts
policy-configured sensitive fields in the audit Trace at write time,
without touching the §5.5 replay payload (execution-manager design D7).

## Context and constraints

- Spec §11 pins the behavior only: "input (redacted per policy)",
  "sensitive inputs masked per policy". The mechanism is this design's
  to choose.
- **D7 (verbatim constraint from the merged §5.5 design):** "semantic
  redaction touches display paths only; the replay payload is
  credential-scrubbed (best-effort) but semantically-unredacted."
  Redaction must never alter `replay_journal` rows or replay behavior.
- **Post-D4 fact (verified 2026-07-10):** replay reads only the
  `replay_journal` table. `TraceEvent.output` has zero non-storage
  readers; its "for §5.5 replay" doc comment is stale. The audit
  Trace is currently write-only (`trace.listByExecution` has no
  non-test callers), so at-rest redaction breaks no consumer.
- The credential boundary stays structural (§9.2 request-scoped,
  never-persisted credentials). This work is *semantic* redaction of
  ordinary sensitive fields — display hygiene, **not a boundary**.

## Decisions

### R1 — Config shape: builtin key denylist + per-tool additions

A builtin list of sensitive key names applies everywhere with zero
configuration (Conduit's safe-by-default posture). Operators add
per-tool key names on the `Policy` row (`redactFields: string[]`,
default `[]`). Rejected: per-tool-only (no out-of-box protection),
global-env-only (no per-tool tuning; "per policy" becomes a stretch).

### R2 — Field syntax: simple key names, normalized matching

Entries are key names, not paths. Matching normalizes keys (lowercase;
strip `-`, `_`, `.`, spaces) and compares **exactly** — `apiKey`,
`api_key`, `API-KEY` all match `apikey`; `author` does not match
`auth`. One matching engine for builtins and additions. Dotted paths
can layer on later without breaking these entries. No substring
heuristics — the claim stays bounded and convergent
(`adversarial-convergence.md`): we mask exactly the fields named, not
"all sensitive data".

### R3 — `TraceEvent.output` is dropped (redact-by-not-storing)

Spec §11 names only an "output summary" per tool call. The full-result
field existed for replay; after the D4 split replay never reads it.
The field leaves the interface, the write path, and the read path. The
full result still exists exactly where it is needed: the replay
journal (credential-scrubbed, D7-protected). A future full-fidelity
audit view can join the replay journal; the Trace keeps the redacted
summary. Existing rows are purged (R6).

### R4 — Wiring: redact at the append choke point; config rides the verdict

`appendTrace` in `pipeline/invoker.ts` is the only TraceEvent producer
(all five call sites, refusals included, already pass the verdict).
`PolicyVerdict` gains `readonly redactFields: readonly string[]` —
the engine already fetches the policy row per call, so per-tool
additions ride back at zero extra store reads. `row?.redactFields ??
[]` for known tools regardless of `manualOverride` (redaction tuning
is independent of action overrides); `[]` for unknown tools. Builtins
are owned by the redactor and always apply. Rejected: a separate
`fieldsFor(toolName)` seam (second read of the same row, interface
sprawl); read-time projection (raw data at rest; fail-open by shape —
every future reader must remember to redact).

### R5 — Redaction engine: pure module, fail-closed guards

`pipeline/redact.ts` exports `redactSensitiveFields(value, extraKeys)`:
pure, synchronous, no config reads. Recurses objects and arrays; a
matched key's entire value (scalar or subtree) becomes the existing
`"[redacted]"` marker (same marker as `upstream.ts`). Non-object roots
pass through. **Strictly non-mutating — this is load-bearing, not
style:** `appendTrace` runs BEFORE the manager scrubs and journals the
same `value` reference (`manager.ts` journal barrier) and before
`pausedOn.input` is journaled on the approval path; an in-place
mutation would put the semantically-redacted result into the replay
journal — replay divergence, the exact D7 violation this design must
not commit. Pinned by its own test (argument deep-equals its
pre-call snapshot). **Guards fail closed:** past the depth cap, or on a
cycle, the subtree is replaced with the marker — never passed through
unredacted (a fail-open guard would be a redaction bypass via deep
nesting). Builtin list (normalized; finalized in the plan, pinned by
the invariant test): `password`, `passwd`, `secret`, `token`,
`apikey`, `xapikey`, `accesskey`, `secretkey`, `privatekey`,
`clientsecret`, `authorization`, `auth`, `bearer`, `credential`,
`credentials`, `cookie`, `setcookie`, `ssn`.

### R6 — Storage: retrofit + purge migrations

- `policies` gains `redact_fields TEXT NOT NULL DEFAULT '[]'`, with the
  same PRAGMA-guarded retrofit pattern as the old `trace_events.output`
  retrofit.
- `trace_events.output` leaves CREATE TABLE and both I/O paths. The old
  add-column retrofit is replaced by a one-time purge —
  `UPDATE trace_events SET output = NULL` when the column exists —
  because existing dev DBs hold full unredacted payloads with zero
  readers, and §11's claim is about what the Trace *stores*. The dead
  column itself stays (harmless in SQLite).

### R7 — outputSummary built from redacted output

Redact the full output object first, then `JSON.stringify(...).slice(0,
160)`. Today's summary slices the raw result, so the head of a
sensitive value can leak into the summary; redact-then-slice closes
that.

### R8 — Explicit non-goals / out of scope

- **Replay journal** (`replay_journal`, `journal.ts`) and
  `scrubCredential`: untouched (D7 of the §5.5 design).
- **`PendingApproval.input` stays unredacted deliberately** — the
  human approver needs real values to decide (the spec's own
  `amount >= 5000` example). Executions store, not Trace.
- **Not retroactive:** write-time redaction masks future rows only;
  adding a key to a tool's policy does not rewrite audit history.
- Scalar payloads (a bare string result containing something
  sensitive) are not scanned — the bounded claim covers named fields
  only.

## Invariant (pinned by `INVARIANT §11:` test, row flips in same commit)

1. Builtin-listed keys are masked in stored `input` (every verdict
   path, refusals included).
2. Per-tool `redactFields` are masked in stored `input` and
   `outputSummary`.
3. The replay-journal outcome for the same call is **unredacted**
   (replay fidelity — the D7 guard, asserted positively).
4. Trace writes carry no full `output`.

## Testing

- `redact.ts` unit: normalization variants, nesting, arrays, scalar
  roots, matched-subtree replacement, depth/cycle fail-closed,
  **non-mutation of the argument** (deep-equals pre-call snapshot).
- Policy engine: `redactFields` present on every verdict shape
  (default/override/unknown/block), independent of `manualOverride`.
- Invoker integration: refusal + success paths produce redacted
  `input`/`outputSummary`, no `output`.
- Sqlite: round-trip with `redact_fields`; both migrations (fresh DB;
  legacy DB with populated `output` column → purged).
- E2E (manager pause/resume suite): replay still sees semantically
  unredacted results after a paused/resumed execution.

## Deferred (documented, not built)

Dotted-path field addressing; value-pattern redaction; retroactive
re-redaction tooling; Trace viewer/export surfaces (post-MVP per spec
§17/§18).
