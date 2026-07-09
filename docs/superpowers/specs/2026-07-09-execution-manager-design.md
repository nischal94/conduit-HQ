# §5.5 Execution Manager — Design

**Date:** 2026-07-09
**Status:** Design — adversarially reviewed & converged (Codex ×3 + grilling) → awaiting user sign-off → implementation plan
**Spec anchors:** §5.5 (pause/resume — deterministic replay), §6 (`execute` workflow),
§10.2 (policy → approval), §11 (Trace), §16 (resource limits), §18 (locked decisions).
**Invariant it flips:** `INVARIANT §5.5 — pause/resume via deterministic replay`
(currently ⏳ in INVARIANTS.md).

---

## 1. Purpose

The execution manager is the piece of Phase 0 that turns a `require_approval` policy
verdict into a **paused execution** that a human can approve or deny, and resumes it
correctly by **deterministic replay** — the mechanism §5.5 mandates (no VM snapshots;
a paused execution is pure data: `code + seeds + journal`).

It is the first and only writer to `ExecutionRepository`. Everything below it —
sandbox, invoker, policy, store, credentials — already exists and is proven by
`e2e.smoke.test.ts`. This work adds the layer *above* the sandbox and makes a bounded set
of changes below it, each shaped to be inert by default:

- **Sandbox** (D2): a performed call can resolve to *pause* (new `status:"paused"` arm).
- **Invoker** (D6): an optional, request-bound `ApprovalDecisions` seam checked before
  policy — absent = today's behavior byte-for-byte.
- **Store** (F1/F4/F7): a **replay-journal** projection distinct from the audit Trace; an
  **atomic paused→running claim** on `ExecutionRepository`.
- **Credential scrubbing** (F6): a scrub applied to every persisted/replayed call result,
  separate from §11 semantic redaction.

The design keeps the §9.2 boundary and the policy-in-invoker separation intact throughout.

> **Adversarial-pass correction (2026-07-09).** An earlier draft of this design tried to
> pause *without* any sandbox change — let the guest catch the `require_approval` error,
> then have the manager inspect the journal and truncate it at the denial. That design is
> **unsound**: the sandbox's replay cursor is strictly positional (`quickjs.ts`), so a
> journal can only replay cleanly as a **prefix**. Stripping an entry mid-journal shifts
> every later entry and triggers the divergence guard; letting the guest run past a
> catchable approval and make further side-effecting calls creates journals that either
> fail to resume or double-execute on resume. The spec's own words settle it: *"the
> execution proceeds live from the first un-journaled call"* — the approval call **is**
> that first un-journaled call, which is only true if it was never journaled, which is only
> true if it **suspended the execution** rather than returning an error to the guest. Hence
> the corrected model below.

> **Cross-model review corrections (2026-07-09, Codex `codex exec` high-reasoning).** A real
> cross-model adversarial pass on the corrected model found seven further defects, all
> verified against the code. They reshape several decisions; each is credited inline (F1–F7)
> where it lands. The load-bearing three: **(F1)** the invoker appends a Trace row for a
> non-`allow` verdict *before* throwing (`invoker.ts:116`), so if the replay journal *is*
> `listByExecution` (D4), the "clean prefix" is polluted by the approval refusal — the
> replay journal and the audit Trace must be **two distinct projections**. **(F2)** a grant
> keyed only by `(executionId, cursor)` force-allows *whatever call lands at that cursor* on
> resume, which — because the first un-journaled call has no journal entry to diverge
> against — can authorize a *different, more destructive* tool than the human approved (a
> confused-deputy/privilege-escalation hole, made reachable by an existing determinism gap:
> `new Date()` is not pinned, only `Date.now`). **(F4)** two concurrent `resume(approve)`
> calls both double-execute the approved side effect, because `ExecutionRepository` has no
> atomic claim. The design below folds in all seven plus a wall-clock-budget scoping
> decision found during grilling.

## 2. Where it sits

```
  MCP `execute` tool call
        │
        ▼
  ExecutionManager.start(code)                       ← NEW
        │  persist Execution{status:running}; generate+persist seeds
        ▼
  Sandbox.execute({ code, seeds, journal, tools })   ← exists; ONE honest change (D2)
        │  suspends at each tool-call boundary; host performs it via ToolHost → invoker
        ▼
  invoker: policy.evaluate                                        ← exists
        │  · require_approval → signals PAUSE (call is NOT journaled)   ← NEW behavior
        │  · block           → throws ConduitPolicyBlocked (catchable)  ← exists
        ▼
  Sandbox returns status:"paused" with the pending call           ← NEW (D2)
        │  journal is a clean PREFIX ending before the approval call
        ▼
  ExecutionManager: write PendingApproval, status=paused          ← NEW
        ▼
  ExecutionManager.resume(execId, decision)                       ← NEW
        │  atomic claim paused→running (F4); reload the prefix replay
        │  journal (D4, NOT the audit Trace); stage the request-bound
        │  approve/deny decision (D6); re-drive → the approval call is
        │  the first un-journaled call → runs live → allow (or block on deny)
        ▼
  completed | failed | expired | conflict
```

## 3. Module layout

- `packages/sdk/src/execution/manager.ts` — the state machine and public API; the atomic
  paused→running claim (F4) is enforced here via the store's compare-and-swap.
- `packages/sdk/src/execution/journal.ts` — reconstruct the **prefix replay journal** from
  the dedicated replay-journal store (D4/F7), and the `pausedOn`-identity check (F2). Pure
  functions, unit-tested in isolation (no store, no sandbox).
- `packages/sdk/src/execution/decisions.ts` — the request-bound one-shot `ApprovalDecisions`
  seam carrying `approve | deny` (D6/F2/F3).
- `packages/sdk/src/execution/scrub.ts` — credential scrubbing of call results before
  persist/replay (F6), distinct from §11 display redaction.
- Tests colocated: `manager.test.ts`, `journal.test.ts`, `decisions.test.ts`,
  `scrub.test.ts`; the end-to-end pause/resume assertion extends `e2e.smoke.test.ts`.

Boundaries follow the existing discipline: the manager depends on the `ConduitStore`,
`Sandbox`, and `ToolHost` **interfaces**, never concrete engines.

## 4. Public API (tweakable — lead decisions)

```ts
interface ExecutionManager {
  /** Begin a new execution. Persists it, drives the sandbox, returns the settled state. */
  start(code: string, opts?: { limits?: Partial<SandboxLimits> }): Promise<ExecutionOutcome>;

  /** Resume a paused execution after a human decision. */
  resume(executionId: string, decision: ApprovalDecision): Promise<ExecutionOutcome>;

  /** Inspect a paused execution's pending approval (for the CLI / API surface). */
  get(executionId: string): Promise<Execution | undefined>;
}

type ApprovalDecision = { kind: "approve" } | { kind: "deny"; reason?: string };

type ExecutionOutcome =
  | { status: "completed"; value: unknown }
  | { status: "failed"; error: SandboxError }
  | { status: "paused"; pending: PendingApproval }
  | { status: "expired"; pending: PendingApproval }
  | { status: "conflict" };            // lost the atomic resume claim (F4); no-op
```

`ExecutionOutcome` mirrors `Execution.status` but carries the payload the caller needs.
`Execution` (persisted) and `ExecutionOutcome` (returned) are kept distinct so the wire
shape can evolve without a storage migration.

`resume` is **idempotent under races** (F4): its first act is an atomic
`paused → running` claim (D6/state machine). A second concurrent or duplicate `resume` on
the same paused execution loses the claim and returns a distinct
`{ status: "conflict" }` outcome without re-driving anything — never a second execution of
the approved call.

**Agent-facing pause contract (spec-pinned, §10.2 verbatim).** The spec fixes how a pause
surfaces to the calling agent: *"a paused Execution returns its `exec_id` plus a
human-readable reason to the calling agent, so the agent can tell the user exactly what it
is waiting on."* Therefore the `execute` tool call (over the synchronous MCP `tools/call`)
**does not block** for the approval window — on pause it returns `{ status: "paused",
executionId, pending: { toolName, reason } }` immediately, and the human approves
out-of-band. The spec also fixes the CLI surface: **`conduit approvals list | approve |
deny`** (approve/deny take an `exec_id`), which maps directly onto
`ExecutionManager.resume(execId, { kind: "approve" | "deny" })`. `resume` is the engine
verb; `conduit approvals approve/deny` is its CLI spelling. (The web pending-approvals view
and push notifications are deferred out of the MVP — §17/§18.)

## 5. Design decisions (with rationale)

### D1 — Two policy refusals, two fates: `require_approval` suspends, `block` throws

The policy engine emits three actions; only two are refusals, and they must behave
differently at the tool-call boundary:

- **`require_approval` → SUSPEND the execution.** A human might still say yes, so the
  execution parks at this call. The call is **not** delivered to the guest and **not**
  journaled. The guest never runs past this boundary.
- **`block` → throw `ConduitPolicyBlocked` (catchable).** An operator already said no; no
  human will approve it. The guest is told and may adapt (its `catch` runs), exactly as
  today. This is a terminal denial for that call, not a pause.

This split is the core §10.2 semantics — *"agents auto-run the safe stuff and ask before
the rest"* — made real. Crucially, **who controls the approval flow** moves from the
untrusted agent code to the human: today `require_approval` is handed to the guest as a
catchable error, which means model-authored code decides what happens on an approval —
a design inversion for a security product. The corrected model puts the human in control.

`policy.ts` already declares this is the manager's responsibility: *"A `require_approval`
verdict is data; suspending the Execution it belongs to is the §5.5 execution manager's
job."* Policy stays entirely in the invoker; see D2 for how the suspension is wired
without teaching the sandbox about policy.

> **What the split actually keys on (M2/M3 reconciliation).** The pause-vs-terminate
> decision is made **host-side, on the policy verdict**, not on a guest-facing error name.
> When policy returns `require_approval`, the invoker's `policyError("require_approval", …)`
> throw is the **internal pause signal** that `perform` recognizes and converts to
> suspension (D2) — it is *never delivered to the guest as an error and never journaled*, so
> there is no "pausable guest error." When policy returns `block`, the guest **does** receive
> `ConduitPolicyBlocked` and may catch it — terminal for that call. So the guest-facing
> distinction is really: `block` → catchable `ConduitPolicyBlocked`; `require_approval` →
> (no guest error) suspension.
> - **`NON_MEMOIZABLE_ERROR_NAMES` (errors.ts) still lists `policyDenied`**, but under the
>   corrected model a `require_approval` can never be journaled at all (it suspends first), so
>   that entry is now **defensive/dead for the pause path** — kept as belt-and-suspenders, not
>   relied upon. One sentence in the impl should note this so a reader doesn't infer the old
>   "journal the denial, strip on resume" flow from its presence.
> - **Deny reuses `ConduitPolicyBlocked` deliberately (M3).** A human "no" on a pending
>   approval resolves the call as `ConduitPolicyBlocked` on the resume re-run — the same name
>   `block` uses. This is intentional, not the name-collapse the pre-correction draft warned
>   against: from the guest's and audit's perspective a denied-by-human call and an
>   operator-`block`ed call are the *same terminal outcome* (this call will not proceed);
>   collapsing them is correct. What must stay distinct is the **verdict/source** in the audit
>   Trace (a human deny vs. an operator block are different *reasons*), not the guest error
>   name. If the audit needs to tell them apart, carry it in the trace reason/source, not the
>   error name.

### D2 — How the suspension is wired (the one honest sandbox change)

The pause must be a genuine suspension so the journal is a **clean prefix by
construction** (the prefix invariant — see the adversarial-pass note in §1). Mechanism,
tracing the existing `execute` loop (`quickjs.ts:65-77`):

- The loop already is: `runOnce` suspends at a tool call → `perform` runs the call
  host-side (through the ToolHost → invoker → policy) → pushes the result to the journal →
  re-runs.
- **Change:** when the invoker's policy step yields `require_approval`, `perform` resolves
  the call to a **pause signal** instead of a journaled result. The `execute` loop returns
  `status:"paused"` carrying the pending call — **without pushing anything to the
  journal.** The journal remains the prefix of calls that completed *before* the approval
  boundary.

This is the minimum the sandbox must learn: *a performed call can resolve to "pause"
instead of "result."* That is a host-side classification of a host-side call outcome — the
guest vocabulary is untouched, and the sandbox still knows nothing of policies,
credentials, or connections. Policy lives in the invoker; the invoker's existing
`policyError("require_approval", …)` throw is what `perform` recognizes as the pause
signal (the branch already exists at `invoker.ts:117`).

`SandboxResult` gains a `paused` arm. But the sandbox's own `PendingToolCall` carries only
`{ op, request }` (`quickjs.ts:81-84`) — it has **no** `toolName`/`input`/`reason`/`callId`,
and it must not, because the sandbox knows nothing of policies. So the paused arm the
**sandbox core** returns is minimal:
`{ status: "paused"; pending: { op: "call"; request: string }; seeds; journal }`.

**Where `reason`/`callId`/`toolName`/`input` come from (C3 — the plumbing).** These are
invoker/host concepts, not sandbox concepts. The pause is *detected* in the journaling
ToolHost wrapper (D8): that wrapper calls the invoker, sees the `require_approval` verdict
(the `policyError` throw), and it is the wrapper — host-side, outside the sandbox — that
**assembles the full `PendingApproval`** `{ callId, toolName, input, reason, expiresAt }`
from the invoker's verdict (reason), the pending call (toolName/input), and the derived
callId. The sandbox core only signals "this call paused"; the manager pairs the sandbox's
minimal `pending` with the wrapper-captured `PendingApproval` to build the
`ExecutionOutcome`. This keeps the sandbox policy-oblivious while the human-facing pause
payload is fully populated. **Degree of freedom for the implementer:** the exact carrier
(a side-channel from the wrapper vs. threading through the sandbox result) is an
implementation choice, but the constraint is hard — `reason`/`callId` MUST originate
host-side, never in the sandbox.

The `block` path is unchanged: it throws `ConduitPolicyBlocked`, `perform` journals it as a
failed outcome, and the guest sees it — exactly today's behavior.

**Behavior change this forces (intended — a latent-bug fix).** `e2e.smoke.test.ts`
Phase 6 (lines 262–292, verified) currently asserts that a `require_approval` call
(`delete_repo`) is **caught by the guest, which returns the error** (`return { name,
message }`) — so the execution *completes* (with the denial as its value) rather than
pausing, and a single journal entry records the denial under its non-memoizable name. Under
the correct §5.5 model that call **pauses the execution** instead. Phase 6 is updated to
assert the pause, and the denial no longer lands in the replay projection (D4). Rationale:
the old behavior made `require_approval` indistinguishable from a hard denial and put the
agent in charge of the approval flow — the agent's `catch` decides what happens, when
§5.5/§10.2 intend a *human* to. (The current test does not itself show the guest making
further side-effecting calls after the denial; the defect is that the approval is delivered
to the agent as a catchable error at all, not that the smoke-test guest exploits it.) Caught
now, before the CLI/MCP server build on it, it costs one test rewrite; caught later it is a
behavior migration. Documented in the PR and LEARNINGS as an intended fix, and the new
INVARIANT §5.5 test pins the correct behavior. (Decision made 2026-07-09 at the user's
delegation; recorded in spec §18.)

### D3 — One approval at a time (forced by replay determinism)

A later call's very existence and arguments may depend on an earlier call's *real*
(approved, live) result — e.g. `const pr = await create_pr(...); await merge_pr({id: pr.id})`.
You cannot know call #2 exists, let alone that it needs approval, until call #1 has a real
result. Collecting approvals up front is therefore **impossible in the general case**, not
merely risky. The manager surfaces approvals sequentially: approve #1 → re-run → hit #2 →
pause again. Each pause is a single, clear human decision. This is a consequence of the
model, documented so no future reader mistakes it for a missing feature.

### D4 — Two projections: the replay journal is NOT the audit Trace (F1, F7)

The earlier draft equated the replay journal with `TraceRepository.listByExecution`. **That
is unsound (F1):** the invoker appends a Trace row for *every* non-`allow` verdict *before*
throwing (`invoker.ts:116`), so the audit Trace of a paused execution already contains the
`require_approval` refusal row. If that Trace *were* the replay journal, the "clean prefix"
would be polluted by the refusal and resume would replay a stale denial — the exact bug the
suspension model exists to avoid. And the current `TraceEvent` has **no `op` field** (F7),
so it cannot even represent the `search`/`describe` entries the journal needs (D5).

**Resolution — split them.** Introduce a dedicated **replay-journal projection**, separate
from the audit Trace:

- **Replay journal** — ordered `JournalEntry` rows `{ ordinal, op, canonicalRequest,
  outcome, executionId }` for **finalized** calls only (`search`, `describe`, and `allow`ed
  `call`s that produced a real outcome). A `require_approval` pause writes **nothing** here;
  it is recorded on `Execution.pausedOn`. This projection is what resume reads, and it is a
  clean prefix by construction.
- **Audit Trace** — `TraceRepository` unchanged: it still records refusals, allowed calls,
  and upstream failures for the §11 audit trail (its existing decision-A3 semantics).

On resume the manager reads the replay-journal prefix, maps to `JournalEntry[]`, and feeds
it + the recorded seeds into `sandbox.execute`. Every prefix call returns memoized; the
approval call is the **first un-journaled call** (spec §5.5 verbatim) → executes live →
now `allow` via the decision capability (D6). No stripping: a prefix has nothing to strip.
`NON_MEMOIZABLE_ERROR_NAMES` still governs `block` denials the guest caught and continued
past — those are audit-Trace rows, never replay-journal entries.

> **Storage note — a separate `replay_journal` table (decided after deep analysis, F7 +
> New-5).** The replay journal is a new store repository (`ReplayJournalRepository`) with its
> OWN table `{ execution_id, ordinal, op, request, outcome }`, added to `ConduitStore` beside
> `TraceRepository`. The considered alternative — a filtered *projection* over the existing
> `trace_events` table — was rejected: `trace_events` has no `op` column and NOT-NULL
> columns (`policy_verdict`, `connection_prefix`, `input`) that don't apply to
> `search`/`describe`, so a projection would force sentinel/nullable columns onto the audit
> table and need a computed replay-ordinal that skips refusal rows. Three factors favor a
> separate table: (1) each table's schema stays honest to its purpose; (2) in a security
> product the **audit Trace is evidence** and should not share a schema with replay
> bookkeeping (ordinals, memoization, read-ops); (3) it leaves the *proven* `appendTrace`
> path and `trace_events` schema — which the smoke-test leak sweeps depend on — **untouched**,
> the lower-risk move for a security-sensitive change. Both tables share the SQLite backing;
> the replay journal's own `ordinal` (0,1,2… in replay order) is what the sandbox cursor
> consumes.
>
> **Atomic claim method (F4 + New-3).** `ExecutionRepository` today is `put`/`get` only —
> insufficient for the paused→running claim, which a read-then-write races. Add an explicit
> compare-and-swap method:
> ```ts
> interface ExecutionRepository {
>   put(execution: Execution): Promise<void>;
>   get(id: string): Promise<Execution | undefined>;
>   /** Atomic claim: paused → running for a single resume. Returns true iff THIS caller won. */
>   claimForResume(id: string, resumeAttemptId: string): Promise<boolean>;
> }
> ```
> The `resumeAttemptId` is **generated by the manager per `resume` call** (`crypto.randomUUID()`)
> — `ExecutionManager.resume(executionId, decision)` takes no attempt id from its caller; it
> mints one internally, so each `resume` invocation races with a distinct token and the
> winner is unambiguous. On SQLite/libSQL this is a single guarded update —
> `UPDATE executions SET status='running', resume_attempt=? WHERE id=? AND status='paused'` —
> using the affected-row count to decide the winner. The loser gets `false` → `resume`
> returns `{ status: "conflict" }` (§4) and does nothing. This is the exactly-one-resume
> guarantee; it does not depend on multi-worker infrastructure (a single process racing two
> CLI/API calls is enough to need it).

### D5 — Search/describe journaling is IN (a determinism precondition)

Spec §18 defers search/describe journaling *specifically to this work*. `search`/`describe`
read a **mutable catalog** that a source refresh (§7 `replaceNamespace`) can change during
the approval window (TTL default 72h). If those reads re-run live on resume they can return
different results, the guest picks a different path, and the divergence guard
(`quickjs.ts`: *"replay diverged at call #N"*) **fails the execution** — a paused-then-
approved run dies because a read wasn't pinned. Journaling them closes the hole. They live
in the **replay-journal projection** (D4) with `op: "search" | "describe"`, canonical
request, and outcome — replay-visible, absent from the audit Trace (they are not
audit-worthy tool calls, but they are replay-worthy).

### D6 — Request-bound one-shot approval DECISION (approve OR deny), fail-closed on mismatch (F2, F3)

Approving a paused call must NOT `upsert` an `allow` override (that would allow *all future*
calls to the tool — a security regression). Nor may the capability carry approve alone: a
deny must be a first-class outcome (F3). And it must be **bound to the exact pending call**,
not to a cursor position (F2). The seam:

```ts
interface ApprovalDecisions {
  /**
   * The decision for the pending call of an execution, if one is staged.
   * Bound to the pending call's identity — NOT to a cursor index.
   */
  take(executionId: string, call: PendingCallIdentity): ApprovalDecision | undefined;
}

interface PendingCallIdentity {
  op: "call";
  toolName: string;
  /**
   * The EXACT request string the sandbox bridge produced for this call —
   * the same serialization the replay journal stores and the divergence
   * guard compares (`quickjs.ts`: guest does `JSON.stringify(payload)`;
   * guard does a byte-for-byte `entry.request !== payload`). NOT a new
   * canonical form — see below.
   */
  request: string;
}
```

> **Reuse the sandbox's serialization; do NOT invent a canonical hash (Q3).** The identity
> check is a security boundary (it prevents approve-A → authorize-B), so its equality must
> be *identical* to what replay already trusts. The existing replay mechanism already
> depends on `JSON.stringify` being deterministic across replays — same code + same seeds →
> same objects in the same property order → byte-identical `request` strings. The `pausedOn`
> identity therefore records the same `{ op, request }` string the journal would store, and
> the resume check compares the first live call's `{ op, request }` with the **same equality
> the divergence guard uses**. Introducing a *separate* canonicalizer (key-sorting, unicode
> normalization, hashing) would create a second serialization that could disagree with the
> first — reintroducing exactly the fragility this avoids. Store the request string, not a
> hash; it is already bounded by the journal's response-cap discipline.

The invoker gains an **optional** `decisions?: ApprovalDecisions` dep, checked *before*
policy. On the first un-journaled call the invoker computes its `PendingCallIdentity` and
asks `take`:

- **No staged decision** → policy runs exactly as today (absent dep = byte-for-byte current
  behavior; `e2e.smoke.test.ts`'s non-paused paths are untouched).
- **`approve`, identity matches `Execution.pausedOn`** → verdict forced to `allow`, traced
  as an operator approval; the decision is consumed (one-shot).
- **`deny`** → verdict forced to a terminal `ConduitPolicyBlocked` for exactly this call;
  consumed. The human's "no" is delivered like an operator `block` (D3 deny path).
- **Identity does NOT match `pausedOn`** → **fail closed as nondeterministic** (a
  `ConduitPolicyBlocked`/replay-divergence error), never a silent allow.

**Why fail-closed-on-mismatch is the security crux (F2).** The first un-journaled call has
no journal entry to diverge against, so the sandbox's own cursor guard cannot catch a guest
that (via unpinned non-determinism) reaches a *different* call than the one the human
approved. Binding the decision to `pausedOn`'s `(op, toolName, request)` and rejecting
any mismatch turns that gap into a checked boundary: an approval for `create_issue` can
never authorize `delete_repo`.

> **Determinism-hole prerequisite (F2, existing bug).** The sandbox pins `Date.now` and
> `Math.random` but **not `new Date()`** (`quickjs.ts:346`, and its own comment admits it).
> A guest using `new Date()` (e.g. `new Date().getSeconds()`) reads real wall-clock time and
> is non-deterministic — it *can* reach a different first-un-journaled call on resume. The
> fail-closed identity check above contains the security impact regardless. Separately, this
> work SHOULD pin `new Date()` (route the `Date` constructor's no-arg/now path through the
> same seeded epoch + tick as `Date.now`) so honest guests don't spuriously fail resume.
> **`performance.now` is NOT a concern (C4, verified):** the QuickJS bootstrap
> (`quickjs.ts:338-401`) never defines `performance`, and the bare engine provides no host
> `performance` global, so it does not exist in the guest — there is nothing to pin. Pinning
> breadth (which clock surfaces beyond `new Date()`) is a plan-time decision; the identity
> check is non-negotiable.

### D7 — Credential scrubbing (best-effort) vs. semantic redaction, and the real structural guarantee (F6 + New-2)

Two different operations were conflated. The replay journal must preserve the call result so
replay is faithful — but a **hostile-but-reachable upstream can echo the credential back in
a `200` body** (the card-09 case the smoke test guards for *live* calls). The pass-2 review
correctly flagged that an earlier draft **overclaimed** a credential-string scrub as a hard
boundary. It is not: scanning an upstream result for the request's own secret is a
**denylist over unbounded input** — split, encoded, transformed, or partial echoes bypass
it. Per the project's convergence rule (`adversarial-convergence.md`), a denylist over
unbounded input is **best-effort defense-in-depth, never a boundary**, and the real
guarantee must be named structurally.

**The real structural guarantee (§9.2), unchanged by this work:** credentials are
**request-scoped** — resolved host-side, fresh per call, attached to the outbound request,
and **never persisted** anywhere (not the store, not the journal, not the Trace). The
secret's only lifetime is the single outbound `call`. That is what actually prevents a
credential from living in the replay journal: the journal stores the *upstream result*, and
the credential was never part of the result-producing path except as an echo the upstream
chose to include. So the structural rule is: **the replay journal and Trace store only ever
hold data the host classified as an upstream result; credential material is out-of-band and
un-persisted by construction.**

**The two layers (both explicitly bounded):**
- **Credential scrubbing — BEST-EFFORT (defense-in-depth, not a boundary).** As a tripwire,
  every persisted/replayed result is scrubbed of the request's own credential string before
  it is stored or handed back to the guest. This catches the *naive* verbatim echo (the
  common case) but is known-incomplete against encodings. It is labeled best-effort exactly
  like the sibling scan in `pipeline/upstream.ts` (which this design should reuse, not
  re-invent). A finding against this layer is a category-(b) convergence item, not a break.
- **Semantic redaction (§11, display-only, MVP step 2):** policy-driven redaction of ordinary
  sensitive fields touches the **display projection only** (`outputSummary` / audit views);
  it MUST NOT alter the replay payload, or replay diverges.

**Invariant this imposes on the §11 work:** semantic redaction touches display paths only;
the replay payload is credential-scrubbed (best-effort) but semantically-unredacted. Neither
scrub nor redaction is the credential boundary — request-scoped, never-persisted credentials
(§9.2) are. This is the honest labeling the convergence rule requires.

### D8 — TTL/expiry, and side-effect-vs-audit ambiguity (F5)

`PendingApproval.expiresAt = now + CONDUIT_APPROVAL_TTL` (env, default 72h per §5.5). A
`resume` past `expiresAt` transitions the execution to `expired` (terminal) and records a
policy-timeout in the audit Trace (§5.5). MVP checks expiry lazily on resume (and via
`get`); a background sweep is deferred (single-process MVP; lazy expiry is correct for the
CLI flow).

**Replay-journal append is the authoritative barrier for EVERY upstream call (F5 + New-1).**
The pass-2 review found that splitting the replay journal from the audit Trace (D4) creates
a cross-store consistency obligation on *every* live `call`, not only approved ones: if a
side-effecting call is traced (or reaches upstream) but its result is **not durably in the
replay journal** before the guest proceeds, a *later* pause + resume would find that call
un-journaled and **re-execute it**. The single-projection model didn't have this hazard;
the split inherits it. **Resolution — the append barrier, for all upstream `call`s:**

1. Perform the call. On success, the result MUST be **durably appended to the replay
   journal before the value is handed back to the guest** — the replay journal is the
   barrier; guest progress past a call implies that call is replay-durable.
2. If the result cannot be persisted *after the side effect occurred* (the append itself
   throws) → terminal **`failed: outcome-ambiguous`** (audited), **not resumable**. This is
   handled **within the live drive** by the journaling wrapper's `captured.ambiguous` signal
   — no cross-drive bookkeeping is involved, because the throw happens in the same process
   that fired the side effect.

This makes "was this completed call's result recorded?" a checked state within the drive,
never a silent replay hazard. Where an upstream supports idempotency keys, the caller passes
a per-`(executionId, callId)` key so a transport-layer retry is safe; absent that,
fail-closed-terminal is the default.

> **Removed — the durable `call_attempts` marker (Codex pass-4 P1, 2026-07-10).** An earlier
> revision of this design wrote a durable "attempt marker" for each live `call` BEFORE it
> reached upstream, and had `resume` scan for un-cleared markers to detect a
> "fired-but-unjournaled" side effect left by a **process crash** between the upstream call
> and its append. **That machinery was removed** because it delivered no reachable in-scope
> guarantee. A marker was only ever read on the PAUSED-recovery path of `resume`. But a
> genuine process crash mid-call leaves the execution row `running` — `start` persists
> `running` then drives; the resume claim flips `paused`→`running` then drives — **never
> `paused`**. Since `resume` only ever claims a `paused` row, the marker for a real crashed
> side effect was **never reached**. The append-throw case above (a live `appendBarrier`
> THROW after the side effect, *within one process*) is the only F5 guarantee actually
> promised, and `captured.ambiguous` delivers it without any marker. Keeping the marker made
> the code *look* like it handled process-crash recovery when it structurally could not — an
> over-claim, removed per the honesty the convergence rule requires.

> **Process-crash recovery is DEFERRED (out of MVP scope).** Safely terminalizing a stranded
> `running` row requires distinguishing "crashed mid-call" from "legitimately running right
> now" — undecidable in a single-process MVP without a heartbeat/lease, which is exactly the
> **multi-worker infrastructure this design defers** (§7, "Multi-worker execution pickup").
> The MVP guarantee is therefore **NO DOUBLE-EXECUTION** (a stranded `running` row is never
> re-run, because `resume` only claims `paused`), **NOT recovery** (a host crash mid-call
> leaves a zombie `running` row until an operator intervenes — visible, and never silently
> re-executed). Idempotency keys + a worker lease are the principled way to add real recovery
> later.

**Where the barrier physically lives — a journaling ToolHost wrapper, NOT the sandbox
(Q5).** The sandbox loop (`quickjs.ts`: `perform` → `journal.push` in-memory → re-run from
top) must stay oblivious to persistence — the same boundary the rest of this design
protects. Two journals are in play at different scopes: the sandbox's **in-memory** `journal[]`
(drives re-run-from-top *within one* `sandbox.execute`) and the durable **`replay_journal`
table** (drives replay *across* a pause/resume, i.e. across `sandbox.execute` calls). The
durable append is added by having the **manager wrap the `ToolHost`** it passes in: each
`search`/`describe`/`call` durably appends its outcome to `replay_journal` *before returning*
to the sandbox, then the sandbox's in-memory loop proceeds unchanged. On resume, the durable
prefix is loaded as the new `sandbox.execute`'s starting in-memory journal, so those calls'
host path never re-runs (they're memoized) — each call is durably journaled **exactly once,
ever**. The durable append is **idempotent on `(executionId, ordinal)`** (a no-op if the
ordinal already exists), so even a spurious re-`perform` within a segment cannot double-write.
The sandbox core is not modified for durability; only the new `status:"paused"` arm (D2) is.

**The asymmetry that governs the fail-closed choice (F5).** Between the two failure modes at
an upstream side effect, the harms are asymmetric: a **double-executed** side effect (a
second `delete_repo`) is silent and irreversible, whereas a **stranded** execution is visible
and recoverable. For a security product the silent-irreversible failure is the one to design
out. This is why the append-throw case above terminalizes `failed:outcome-ambiguous` rather
than retrying, and why the deferred process-crash case (removed-marker note above) is left as
a visible zombie `running` row rather than a speculative auto-recovery that could re-run a
side effect. The risk-class-aware alternative (fail-open for safe/read calls, fail-closed for
review/destructive) was rejected for the MVP: it makes riskClass a *safety* trust surface,
not just a policy default. Idempotency keys + a worker lease are the principled way to relax
this later, per-upstream.

### D9 — Wall-clock budget is per-resume-segment for the MVP (grilling finding)

The §16 wall-clock deadline is computed fresh per `sandbox.execute` (`quickjs.ts:63`), so
each resume gets a fresh budget — human think-time during an approval does NOT burn the
sandbox CPU budget (correct: you don't want a 72h approval wait to trip a 60s cap). The
implication: an execution that pauses N times gets up to N×`wallClockMs` of *compute*. This
is bounded by the **human-gated approval count** (approvals are not attacker-controllable —
each requires a person), so it is acceptable for the MVP. A true cumulative per-execution
compute cap (persist elapsed compute on the Execution, carry it across resumes) is noted as
a Phase-2 hardening. `interrupted`/`failed` are terminal and never persist a pause, so a
wall-clock interrupt can never leave a non-prefix journal awaiting resume.

## 6. State machine

```
                 start()
                   │
                   ▼
              [running] ──sandbox completes──────────────▶ [completed]
                   │   ──sandbox fails/interrupted───────▶ [failed]
                   │   ──sandbox returns status:paused────▶ [paused]  (writes pausedOn)
                   ▼
              [paused] ──resume: ATOMIC claim paused→running (F4)──┐
                   │        │ lost claim ─────────▶ [conflict] (no-op, someone else is resuming)
                   │        ▼ won claim
                   │     [running] ── approved call runs live ──▶ call fires
                   │        │   ── result persisted ──▶ continue ─▶ completed | failed | paused(next)
                   │        │   ── result append FAILS after side effect ──▶ [failed: outcome-ambiguous]
                   │   ──resume(deny)──▶ [running] ─▶ … (pending call resolves as ConduitPolicyBlocked)
                   │   ──resume after expiresAt──▶ [expired]
```

`running → paused → running` may cycle N times (one cycle per required approval, D3).
`completed`, `failed`, `expired` are terminal; `conflict` is a no-op result (the execution
stays whatever it already is). The atomic claim (F4) guarantees exactly one resume drives
each pause; the append barrier (F5, D8) guarantees an approved side effect whose result
cannot be journaled terminalizes `failed:outcome-ambiguous` rather than re-running. A host
crash mid-call leaves the row `running` (never re-driven, since resume claims only `paused`)
— NO double-execution, but recovery of that zombie row is deferred (D8, §7).

## 7. Scope

**In:** `start`/`resume`/`get`; the sandbox `paused` arm (D2); the dedicated
**replay-journal projection** distinct from the audit Trace (D4/F1/F7); prefix-journal
reconstruction (D4); the request-bound one-shot `ApprovalDecisions` seam with
fail-closed-on-mismatch (D6/F2/F3); the **atomic paused→running claim** on
`ExecutionRepository` (F4); the **append-barrier outcome-ambiguous terminal state**
(D8/F5, delivered within the live drive by `captured.ambiguous`);
**credential scrubbing** of persisted/replayed results (D7/F6);
**search/describe journaling** (D5); pinning the remaining clock surfaces so honest guests
replay cleanly (D6/F2); TTL/expiry (D8); the invariant test; the Phase-6 smoke-test
behavior fix (D2); extension of the smoke test's leak sweep across a pause/resume boundary.

**Deferred out (noted, not built):**
- Multi-worker execution pickup. §5.5 says a *different worker can* resume a paused
  execution (because it is pure data) — true and preserved by this design, but the MVP is
  single-process; no worker-claim/lease is built.
- **Process-crash recovery of a `running` execution** (D8, Codex pass-4 P1). A host crash
  mid-call leaves a zombie `running` row; the MVP never re-runs it (resume claims only
  `paused` → NO double-execution) but also never auto-recovers it. Safely terminalizing a
  stranded `running` row needs to tell "crashed" from "legitimately running", which requires
  the deferred multi-worker lease/heartbeat above. Until then a zombie row is a visible
  operator concern, not a silent hazard.
- Web pending-approvals view. MVP surfaces approvals via the CLI/API (`get` + `resume`);
  the console is deferred out of the MVP per §17.
- Input-aware policy rules (§10.3, Phase 2) — unaffected; the seam already carries `input`.

## 8. Error handling

- Sandbox `failed`/`interrupted` (wall-clock/memory/output) → `Execution.status=failed`,
  the reason recorded; not resumable. Never persists a pause (D9), so no non-prefix journal
  can await resume.
- Store failures during `start`/`resume` are infra faults — the execution is not silently
  left half-transitioned; a failed status write aborts the transition and surfaces an error
  (an unpersisted pause that "looks running" must not be resumable into double-execution).
- **Lost resume claim (F4):** returns `{ status: "conflict" }`, a pure no-op — no replay,
  no call. Exactly one resume drives each pause.
- **Approved side effect + result-append failure (F5):** if a completed live call's result
  cannot be appended to the replay journal (the append throws *after* the side effect
  occurred), the drive's `captured.ambiguous` signal moves the execution to terminal `failed`
  with an outcome-ambiguous reason (audited), not resumable — handled within the live drive,
  no marker. (A *process crash* mid-call — a different failure — leaves the row `running`;
  recovery of that is deferred, D8/§7. It is never re-run: resume claims only `paused`.)
- Deny → the pending call resolves as a terminal `ConduitPolicyBlocked` on the re-run: if
  the guest catches it, its handler runs and the execution may still complete; if uncaught,
  the execution `failed` with the policy reason — an honest terminal state either way.
- **Approval-identity mismatch (F2):** the first live call on resume ≠ `pausedOn` → fail
  closed as a replay-divergence/`ConduitPolicyBlocked` error; never a silent allow.
- Expiry is terminal and traced.

## 9. Testing (invariant + behaviors)

- `INVARIANT §5.5: pause/resume via deterministic replay` — approve → resume re-runs the
  approved call live and completes; flips the ⏳ ledger row in the same commit.
- deny → resume: pending call resolves as `ConduitPolicyBlocked`; guest `catch` path and
  no-catch (fail) path both covered (F3).
- two sequential approvals (D3) — approve #1, resume, pause on #2, approve #2, complete.
- catalog changes between pause and resume — with D5 journaling, replay is stable (the
  regression this design exists to prevent); asserted directly.
- **prefix purity (F1):** a paused execution's replay journal contains NO refusal row even
  though the audit Trace records the `require_approval` (assert both projections directly).
- **approval-identity binding (F2):** a resume where the first live call ≠ `pausedOn` fails
  closed; an approval for tool A can never authorize tool B (the confused-deputy test).
- **concurrent resume (F4):** two `resume(approve)` in flight → exactly one drives, the
  other returns `conflict`; the approved side effect executes exactly once.
- **outcome-ambiguity (F5):** simulate a result-append failure after a successful upstream
  call → terminal `failed` (outcome-ambiguous), not resumable; no double-execution on retry.
- **credential scrub across replay (F6):** a hostile upstream echoing the credential in a
  200 body → the secret appears in neither the persisted replay journal nor the replayed
  sandbox value (extends the existing card-09 assertion to the journal + resume path).
- TTL expiry → `expired`, traced as policy-timeout.
- §9.2 leak sweep extended across the resumed run: no secret in any guest-visible value,
  replay journal, or Trace display projection after resume.

## 10. Deviations log

(Implementation-time deviations recorded in the scratchpad and summarized in the PR.)

## 11. Spec §18 migration required (New-5)

This design **changes a locked spec §18 decision** and must not ship without updating the
spec, or a future implementer will follow the stale invariant. The protocol (CLAUDE.md:
"product decisions → spec §18") makes this a spec edit, not a design-doc-only change.

- **Locked text today (§18, verbatim):** *"Trace as replay log: ✅ `TraceEvent.output`
  carries the full (response-capped) call result — the Trace store **doubles as** the durable
  replay journal for `call` ops … Persisting `search`/`describe` journal entries is deferred
  to the §5.5 execution-manager work."*
- **What changes:** the replay journal becomes a **separate `replay_journal` table**, not the
  Trace store (D4 + storage note). §18's *rationale* is preserved — durable-data replay,
  reusing the SQLite store, no VM snapshots — only the "same table" implementation detail
  changes, because the review proved (F1) that the audit Trace records refusal rows that
  pollute the replay prefix and (F7) that `TraceEvent` cannot represent read-ops.
- **The `search`/`describe` deferral named in §18 is discharged here** (D5): they are
  journaled, in the new replay-journal table.
- **BOTH spec locations must change (C5).** The "doubles as" claim appears TWICE in the
  spec: the §18 locked-decision line *and* §5.5's prose (`conduitspec.md:180`: "the Trace
  store (§11) doubles as the replay log"). The implementation PR's spec edit must update
  **both** — editing only §18 would leave §5.5 asserting the stale model. Edit the HTML
  source, regenerate `conduitspec.md` via `html2md.py`, and grep the regenerated file for
  "doubles as" to confirm neither location survives.

**When:** the §18 edit lands **in the implementation PR** (regenerate `conduitspec.md` via
`html2md.py` in the same commit, so the spec-drift CI check stays green and spec + code +
the flipped INVARIANTS §5.5 row move atomically). Rationale: a *locked* decision should
change only when approved design + working code + green CI stand behind it — not on the
strength of a design doc alone. The intent-to-migrate is recorded here (durable now); the
spec text changes atomically with the code that honors it.

## 12. Adversarial review provenance

- **Author adversarial pass (Claude):** found the prefix-invariant unsoundness of the
  original "inspect-and-truncate" model → the suspension-based correction.
- **Cross-model pass 1 (`codex exec`, high reasoning):** 7 findings (F1–F7), 3 the author
  missed (trace-before-pause, cursor-only-grant confused-deputy, concurrent-resume
  double-exec). All verified against code and folded in.
- **Cross-model pass 2 (`codex exec`):** F1/F3/F7 fully resolved; F2/F4/F5/F6 refined; 5 new
  findings — New-1 (dual-write barrier for all calls, High), New-2 (scrub overclaimed →
  relabel best-effort, High), New-3 (CAS store method), New-4 (canonicalization — already
  fixed pre-review), New-5 (spec §18 migration). All folded into this revision.
- **Cross-model pass 3 (`codex exec`) — CONVERGED.** All 5 pass-2 findings RESOLVED; **zero
  new in-scope findings.** The one remaining caveat (credential-scrub incompleteness against
  encoded echoes) is explicitly a category-(b) best-effort defense-in-depth layer, not a
  boundary break — exactly the stop-line `adversarial-convergence.md` defines. Pass 3 also
  independently confirmed: the durable-append barrier does not conflict with QuickJS replay;
  the separate replay_journal vs Trace is crash-consistent (no silent double-exec window);
  the F5 fail-closed decision is the correct security default for the MVP. **The adversarial
  review has converged — the design is sound to implement.**

- **Convergence trajectory:** pass 1 → 7 findings (3 structural) · pass 2 → 5 (2 structural,
  3 specification) · pass 3 → 0. Monotonic decrease in count and severity, residual is a
  labeled best-effort layer — healthy convergence, not a denylist treadmill.

- **Editorial/consistency review (`code-reviewer` agent, on PR #25).** Verified every
  claim-vs-code assertion in the doc against the source (all correct). Found 3 must-fix
  documentation-accuracy defects (none architectural), all folded in: **M1** — D2 overstated
  the current smoke-test behavior ("guest keeps running" → actually "guest catches and
  returns; execution completes"); **M2** — D1's "pausable guest error" framing was stale
  (under the corrected model `require_approval` never reaches the guest); **M3** — deny
  reusing `ConduitPolicyBlocked` needed explicit reconciliation with D1's
  don't-collapse-names rule. Plus material consider-items folded: **C3** — the plumbing of
  invoker-side `reason`/`callId` through the sandbox's minimal paused arm (now specified as
  the ToolHost wrapper's job); **C1** — `resumeAttemptId` origin (manager-generated per
  resume); **C4** — `performance.now` is not a guest global (verified, no pinning needed);
  **C5** — the "doubles as" claim lives in BOTH §18 and §5.5, so the spec migration must fix
  both. This review closed the doc-accuracy and implementability gaps before the plan.
