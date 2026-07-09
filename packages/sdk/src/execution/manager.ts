import type { ToolInvoker } from "../execute.js";
import { GUEST_ERROR_NAMES, REPLAY_DIVERGENCE_ERROR_NAME } from "../pipeline/errors.js";
import type {
  JournalEntry,
  Sandbox,
  SandboxError,
  SandboxLimits,
  SandboxResult,
  ToolHost,
} from "../sandbox/sandbox.js";
import { generateSeeds } from "../sandbox/sandbox.js";
import type { ConduitStore } from "../store/store.js";
import type { Execution, PendingApproval } from "../types.js";
import type { ApprovalDecision, ApprovalDecisions } from "./decisions.js";
import { createInMemoryApprovalDecisions } from "./decisions.js";
import { toSandboxJournal } from "./journal.js";
import { scrubCredential } from "./scrub.js";

/**
 * §5.5 execution manager (design 2026-07-09). Turns a `require_approval`
 * policy verdict into a paused execution a human can approve or deny, and
 * resumes it by DETERMINISTIC REPLAY — a paused execution is pure data
 * (`code + seeds + journal`), never a VM snapshot.
 *
 * It is the first and only writer to `ExecutionRepository` and the
 * `replay_journal`. Everything below it — sandbox, invoker, policy, store,
 * credentials — already exists (proven by `e2e.smoke.test.ts`); this layer
 * sits above the sandbox and composes them.
 *
 * The load-bearing mechanism is the JOURNALING TOOLHOST WRAPPER (design D8):
 * the manager wraps the real ToolHost so every upstream call durably appends
 * its (credential-scrubbed) result to the replay journal BEFORE the guest
 * proceeds — the barrier that makes "did the side effect happen?" a recorded
 * state instead of a silent replay hazard. On a `require_approval` verdict
 * the wrapper suspends the run (throws `ConduitApprovalPause`) and assembles
 * the human-facing `PendingApproval` HOST-SIDE — the sandbox stays
 * policy-oblivious (design C3/D2).
 */
export interface ExecutionManager {
  /** Begin a new execution. Persists it, drives the sandbox, returns the settled state. */
  start(code: string, opts?: { limits?: Partial<SandboxLimits> }): Promise<ExecutionOutcome>;
  /** Resume a paused execution after a human decision. */
  resume(executionId: string, decision: ApprovalDecision): Promise<ExecutionOutcome>;
  /** Inspect the persisted execution (CLI / API surface). */
  get(executionId: string): Promise<Execution | undefined>;
}

/**
 * What the caller of `start`/`resume` gets back. Mirrors `Execution.status`
 * but carries the payload the caller needs; kept distinct from the persisted
 * `Execution` so the wire shape can evolve without a storage migration.
 *
 * Every arm carries `executionId` so the caller can act on the result — the
 * §4.1 agent-facing pause contract returns `exec_id` to the agent, and the
 * CLI's `conduit approvals approve|deny <exec_id>` maps onto
 * `resume(executionId, …)`. A `conflict` still carries the id it raced on.
 */
export type ExecutionOutcome =
  | { status: "completed"; executionId: string; value: unknown }
  | { status: "failed"; executionId: string; error: SandboxError }
  | { status: "paused"; executionId: string; pending: PendingApproval }
  | { status: "expired"; executionId: string; pending: PendingApproval }
  | { status: "conflict"; executionId: string };

/**
 * The wiring the manager composes. The manager depends on the `ConduitStore`,
 * `Sandbox`, and a per-execution invoker FACTORY — never concrete engines.
 *
 * `makeInvoker` is a factory rather than a single invoker because the invoker
 * is bound per execution (its `executionId` scopes Trace rows and the
 * decisions seam) — and on resume it must be built with the staged
 * `ApprovalDecisions` dep so the approved/denied call resolves through the
 * decision seam (design D6). The manager owns the `catalog`-backed ToolHost
 * construction indirectly through `makeToolHost(invoke)`, which the caller
 * supplies so the catalog stays the caller's concern (same shape as
 * `createCatalogToolHost(catalog, invoke)`).
 */
export interface ExecutionManagerDeps {
  store: ConduitStore;
  sandbox: Sandbox;
  /**
   * Build the per-call invoker for one execution. On resume the manager
   * passes the staged `decisions` seam so the approved call resolves live.
   * Absent `decisions` (the `start` path) the invoker behaves exactly as it
   * does today.
   */
  makeInvoker: (args: { executionId: string; decisions?: ApprovalDecisions }) => ToolInvoker;
  /** Wrap an invoker into the catalog-backed ToolHost (e.g. createCatalogToolHost(catalog, invoke)). */
  makeToolHost: (invoke: ToolInvoker) => ToolHost;
  /** Defaults to `createInMemoryApprovalDecisions`; injectable for tests. */
  makeDecisions?: () => ApprovalDecisions;
  /** Injectable clock (ms); defaults to Date.now. */
  now?: () => number;
  /** Injectable id generator; defaults to crypto.randomUUID. */
  newId?: () => string;
}

/**
 * §5.5 TTL: a pending approval expires `CONDUIT_APPROVAL_TTL` ms after it is
 * raised (env-tunable; default 72h). Checked lazily on resume (single-process
 * MVP; a background sweep is deferred — design D8).
 */
const DEFAULT_APPROVAL_TTL_MS = 259_200_000; // 72h

function resolveApprovalTtlMs(): number {
  const raw = process.env.CONDUIT_APPROVAL_TTL;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_APPROVAL_TTL_MS;
  }
  const parsed = Number(raw);
  // Fail SAFE to the default on a malformed value rather than a 0/NaN TTL
  // that would expire every approval instantly (or never).
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_APPROVAL_TTL_MS;
}

/**
 * The internal pause signal the journaling wrapper throws so the sandbox
 * suspends WITHOUT journaling the call (design D2). The sandbox matches it
 * structurally by `name === "ConduitApprovalPause"` (quickjs.ts `perform`);
 * it never sees the policy that produced it.
 *
 * The same class also carries the two TERMINAL escapes that must suspend the
 * sandbox (so the guest cannot catch them) yet resolve to a terminal `failed`,
 * never a real pause:
 *  - **outcome-ambiguous** (design D8/F5): a completed call's result could not
 *    be journaled (`captured.ambiguous`).
 *  - **replay-divergence** (design D6/F2): the first live call on resume is not
 *    the approved call (`captured.divergence`).
 * Both share the `ConduitApprovalPause` name so the sandbox's `perform` treats
 * them as a non-result (never journaling the call, and — being a
 * suspend/interrupt — uncatchable in the guest); the manager reads the matching
 * `captured` field to finalize a terminal failed state rather than a pause.
 */
class ConduitApprovalPause extends Error {
  readonly terminal: boolean;
  constructor(terminal = false) {
    super(terminal ? "execution terminated (non-resumable)" : "execution paused awaiting approval");
    this.name = "ConduitApprovalPause";
    this.terminal = terminal;
  }
}

/**
 * The credential the request would attach, so the barrier can best-effort
 * scrub a naive echo out of the persisted/replayed result (design D7). The
 * manager does not itself resolve credentials — that stays in the pipeline —
 * so it is supplied per execution when known; when absent, scrubbing is a
 * no-op and the structural §9.2 guarantee (request-scoped, never-persisted
 * credentials) is what actually holds.
 */
interface JournalingHostContext {
  executionId: string;
  secret: string | undefined;
}

/**
 * The out-of-band signals the journaling wrapper hands back to `drive` for one
 * sandbox drive. `pending` is a real approval pause; `ambiguous` and
 * `divergence` are TERMINAL faults that the sandbox surfaces as a pause (via
 * the shared `ConduitApprovalPause` name) but the manager finalizes as
 * `failed` — never a resumable pause. At most one is set per drive.
 */
interface CapturedDriveState {
  pending?: PendingApproval;
  /** design D8/F5: a completed call's result could not be journaled. */
  ambiguous?: SandboxError;
  /** design D6/F2: the first live call on resume ≠ the approved call. */
  divergence?: SandboxError;
  /**
   * design D8/F5: writing the attempt marker itself faulted (a store blip),
   * BEFORE the side effect could reach upstream. The write is host-side
   * infrastructure — its failure must terminalize the drive `failed`, never
   * surface to the guest as a catchable tool error (which the guest could
   * treat as a phantom failure and continue past, since NO journal row was
   * appended). Fails closed: side effect never fired, execution non-resumable.
   */
  markerFault?: SandboxError;
}

export function createExecutionManager(deps: ExecutionManagerDeps): ExecutionManager {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  // Defaults to the request-bound in-memory seam (decisions.ts). A fresh
  // instance per resume is correct: a decision lives only for the one resume
  // it is staged for, and the invoker consumes it one-shot.
  const makeDecisions = deps.makeDecisions ?? createInMemoryApprovalDecisions;

  /**
   * Build the journaling ToolHost wrapper (design D8, the barrier). For every
   * op it: runs the underlying host op, credential-scrubs the result, and
   * durably appends `{ ordinal, op, request, outcome }` to the replay journal
   * BEFORE returning — guest progress past a call implies that call is
   * replay-durable. A `require_approval` verdict (the invoker's
   * `ConduitPolicyDenied`) is intercepted on `call` and converted to a
   * suspension: NOTHING is journaled, the host-side `PendingApproval` is
   * captured, and `ConduitApprovalPause` is re-thrown so the sandbox pauses.
   *
   * `nextOrdinal` continues from the durable prefix so a resumed run appends
   * after the loaded prefix (the prefix calls are memoized and never re-hit
   * the host). The append is idempotent on `(executionId, ordinal)`.
   */
  function makeJournalingHost(
    inner: ToolHost,
    ctx: JournalingHostContext,
    prefixLength: number,
    captured: CapturedDriveState,
  ): ToolHost {
    let ordinal = prefixLength;

    // The reason text of the most recent require_approval. Scoped to THIS
    // wrapper (i.e. this drive) — not the ExecutionManager instance — so a
    // second concurrent drive on the same manager can never read a reason set
    // by another (design P2 / Fix 7). Single-pending-call model (design D3) →
    // at most one is live per drive, set when the wrapper recognizes the
    // invoker's ConduitPolicyDenied and consumed by assemblePending.
    let lastApprovalReason: string | undefined;

    function isRequireApproval(error: unknown): boolean {
      if (!(error instanceof Error) || error.name !== GUEST_ERROR_NAMES.policyDenied) {
        return false;
      }
      lastApprovalReason = error.message;
      return true;
    }

    function isReplayDivergence(error: unknown): boolean {
      return error instanceof Error && error.name === REPLAY_DIVERGENCE_ERROR_NAME;
    }

    function assemblePending(path: string, input: unknown): PendingApproval {
      // reason/callId originate HOST-SIDE here (design C3) — never in the
      // sandbox. The reason is the policy verdict's message, surfaced from the
      // invoker's `ConduitPolicyDenied` throw and captured just above.
      return {
        callId: newId(),
        toolName: path,
        input,
        reason: lastApprovalReason ?? `${path} requires approval before it can run.`,
        expiresAt: now() + resolveApprovalTtlMs(),
      };
    }

    async function journal(
      op: "search" | "describe" | "call",
      request: string,
      run: () => Promise<unknown>,
      onApprovalPause: () => PendingApproval,
    ): Promise<unknown> {
      // Attempt marker (design D8/F5) — ONLY for `call` (search/describe are
      // reads with no side effect). Written at the ordinal this call's append
      // will consume, BEFORE the side effect reaches upstream, so a process
      // crash between the upstream call and its journal append leaves a durable
      // "attempted but unrecorded" marker a later resume treats as
      // outcome-ambiguous. `ordinal` is the counter appendBarrier will read;
      // nothing runs between here and the append to shift it.
      const attemptOrdinal = ordinal;
      if (op === "call") {
        // The marker WRITE is host-side infrastructure (design D8/F5). If it
        // faults it must NOT propagate into `perform` as a normal (catchable)
        // tool error — no journal row was appended, so the guest would continue
        // on a phantom failure. Terminalize `failed` UNCATCHABLY instead: set
        // the host-side signal, then suspend via ConduitApprovalPause(true)
        // (the divergence/ambiguous path). Fails closed: side effect never
        // reached upstream, execution is non-resumable.
        try {
          await deps.store.replayJournal.markAttempt(ctx.executionId, attemptOrdinal);
        } catch (cause) {
          captured.markerFault = {
            name: "ConduitOutcomeAmbiguous",
            message:
              `[ExecutionManager] Failed to write the attempt marker before an upstream call; ` +
              `execution terminated (non-resumable) so the side effect is never issued unrecorded. ` +
              `Context: { executionId: ${ctx.executionId}, ordinal: ${attemptOrdinal}, cause: ${String(cause)} }`,
          };
          throw new ConduitApprovalPause(true);
        }
      }

      let value: unknown;
      try {
        value = await run();
      } catch (error) {
        if (isRequireApproval(error)) {
          // Pause: no upstream side effect happened (policy refuses BEFORE
          // upstream). Commit to the uncatchable suspend path FIRST (set the
          // captured signal + decide to throw ConduitApprovalPause) so a
          // clearAttempt fault can NEVER downgrade this pause into a catchable
          // guest error (H2). The marker clear is best-effort: on this
          // no-side-effect branch a stale marker is safe — its ordinal is
          // absent from the journal, so resume treats it per the recovery
          // check; but M-fix means a stale marker whose ordinal never lands a
          // row IS the true ambiguous case, so we still clear when we can.
          captured.pending = onApprovalPause();
          await clearAttemptBestEffort(op, attemptOrdinal);
          throw new ConduitApprovalPause();
        }
        if (isReplayDivergence(error)) {
          // Resume replay-divergence (design D6/F2): refused BEFORE upstream,
          // like require_approval — no side effect. Commit to the uncatchable
          // terminal path FIRST (H2), THEN best-effort clear the marker — a
          // clearAttempt fault must not bypass the divergence terminalization.
          // The manager finalizes `failed`; do NOT journal it (not real guest
          // control flow).
          captured.divergence = {
            name: REPLAY_DIVERGENCE_ERROR_NAME,
            message: `[ExecutionManager] Resume replay-divergence; execution terminated (non-resumable). Context: { executionId: ${ctx.executionId} }`,
          };
          await clearAttemptBestEffort(op, attemptOrdinal);
          throw new ConduitApprovalPause(true);
        }
        // Any other error (a `block`, a real upstream failure, a denied
        // resume resolving as ConduitPolicyBlocked) is a journaled failed
        // outcome — catchable in the guest, exactly as today. The failed
        // outcome IS durably recorded by appendBarrier, so the attempt is no
        // longer ambiguous — clear the marker after the append.
        const outcome = { ok: false as const, error: toSandboxError(error) };
        await appendBarrier(op, request, outcome);
        // The failed outcome is durably journaled at this ordinal, so a stale
        // marker is RESOLVED on resume (M-fix: ordinal present in the journal).
        // Clearing is best-effort — a clear fault must not replace the guest's
        // real (guest-safe) error with a store fault.
        await clearAttemptBestEffort(op, attemptOrdinal);
        // Re-throw so the guest sees the (guest-safe) error.
        throw error;
      }
      const scrubbed = scrubCredential(value, ctx.secret);
      const normalized = scrubbed === undefined ? null : scrubbed;
      // Append the outcome FIRST (the durable barrier); only once it is durable
      // do we clear the attempt marker. If appendBarrier throws (outcome
      // could not be journaled), it terminalizes outcome-ambiguous and the
      // marker is deliberately LEFT in place — the drive is terminal anyway.
      await appendBarrier(op, request, { ok: true as const, value: normalized });
      // The success outcome is durably journaled at this ordinal, so a stale
      // marker is RESOLVED on resume (M-fix: ordinal present in the journal).
      // Clearing is best-effort — a clear fault must not turn a durably
      // recorded success into a guest-visible store error.
      await clearAttemptBestEffort(op, attemptOrdinal);
      return normalized;
    }

    async function clearAttempt(
      op: "search" | "describe" | "call",
      attemptOrdinal: number,
    ): Promise<void> {
      if (op === "call") {
        await deps.store.replayJournal.clearAttempt(ctx.executionId, attemptOrdinal);
      }
    }

    /**
     * Clear the attempt marker on a branch that has ALREADY committed to a
     * terminal/pause outcome (require_approval, replay-divergence). A clear
     * failure here is harmless to replay — no journal row was appended, so the
     * stale marker's ordinal is absent from the journal; on resume the M-fix
     * treats an ordinal absent from the journal as the true outcome-ambiguous
     * case only if a side effect could have fired, and NEITHER of these
     * branches reaches upstream. Swallowing the clear fault is therefore safe
     * and is REQUIRED: it must never be able to bypass the captured terminal
     * signal and downgrade the outcome into a catchable guest error (H2).
     */
    async function clearAttemptBestEffort(
      op: "search" | "describe" | "call",
      attemptOrdinal: number,
    ): Promise<void> {
      try {
        await clearAttempt(op, attemptOrdinal);
      } catch {
        // Deliberately swallowed — see the doc comment. The terminal/pause
        // signal was already captured; a stale marker on a no-side-effect
        // branch cannot cause a double side effect.
      }
    }

    async function appendBarrier(
      op: "search" | "describe" | "call",
      request: string,
      outcome: JournalEntry["outcome"],
    ): Promise<void> {
      const at = ordinal;
      ordinal += 1;
      try {
        await deps.store.replayJournal.append(ctx.executionId, {
          ordinal: at,
          op,
          request,
          outcome: toRowOutcome(outcome),
        });
      } catch (cause) {
        // The side effect (if any) already happened but its result is not
        // durable — the call is outcome-ambiguous and must never be re-run
        // (design D8/F5). Record it and fail the execution terminally.
        captured.ambiguous = {
          name: "ConduitOutcomeAmbiguous",
          message:
            `[ExecutionManager] Result of a completed upstream call could not be journaled; ` +
            `the execution is outcome-ambiguous and not resumable. Context: { executionId: ${ctx.executionId}, ordinal: ${at}, cause: ${String(cause)} }`,
        };
        throw new ConduitApprovalPause(true);
      }
    }

    return {
      search: (options) =>
        journal(
          "search",
          JSON.stringify(options),
          () => inner.search(options),
          neverPauses("search"),
        ) as Promise<Awaited<ReturnType<ToolHost["search"]>>>,
      describe: (path, options) =>
        journal(
          "describe",
          // MUST match the guest bridge's own serialization of the describe
          // payload. The guest emits `JSON.stringify(options)` verbatim
          // (bootstrapSource: `bridge("describe", options)`), and the sandbox's
          // divergence guard compares the stored `request` byte-for-byte against
          // that on replay. The bridge's payload is dispatched as
          // `describe(path, includeSchemas === true ? { includeSchemas: true } :
          // {})` (quickjs.ts dispatchOp), so the guest's two canonical option
          // shapes are `{ path }` (the §6 lazy-describe pattern) and
          // `{ path, includeSchemas: true }`. Reconstruct THOSE exact bytes —
          // never inject `includeSchemas: false`, which the guest never emits
          // and which would diverge every lazy-describe resume.
          options?.includeSchemas === true
            ? JSON.stringify({ path, includeSchemas: true })
            : JSON.stringify({ path }),
          () => inner.describe(path, options),
          neverPauses("describe"),
        ) as Promise<Awaited<ReturnType<ToolHost["describe"]>>>,
      call: (path, input) =>
        journal(
          "call",
          // MUST match the sandbox bridge's own serialization of a call
          // payload (bootstrapSource: bridge("call", { path, input })), so
          // the durable prefix's `request` equals what the guest re-emits on
          // replay and the cursor guard sees a match.
          JSON.stringify({ path, input }),
          () => inner.call(path, input),
          () => assemblePending(path, input),
        ),
    };
  }

  /**
   * Guard a POST-SANDBOX persistence write (the paused/finish/expiry `put`s).
   * By the time these run the row is already `running` (`start` put it, or
   * `claimForResume` flipped it), so if the write throws — a transient
   * store/disk fault — and we let it propagate uncaught, the row is stranded
   * `running` with a stale `pausedOn`: a later resume's `claimForResume WHERE
   * status='paused'` finds 0 rows → permanently un-resumable (design §8/§6:
   * running must reach a terminal, never a silent half-transition). This is the
   * SIBLING of the drive()-catch (commit 0991204) that already covers a throw
   * OUT of `sandbox.execute`.
   *
   * On a write failure, best-effort finalize the row `failed` (endedAt set,
   * pausedOn cleared) so it is observably terminal and never a
   * resumable-but-isn't `running`, then re-throw the original fault (not
   * swallowed — the error still surfaces to the caller). If the fallback write
   * ALSO throws (the store is genuinely down, not transient), we cannot persist
   * anything; re-throw the original — there is no better recovery than
   * surfacing the fault.
   */
  async function persistOrFinalizeFailed(
    execution: Execution,
    write: () => Promise<void>,
  ): Promise<void> {
    try {
      await write();
    } catch (cause) {
      const failed: Execution = { ...execution, status: "failed", endedAt: now() };
      delete failed.pausedOn;
      try {
        await deps.store.executions.put(failed);
      } catch {
        // The store is genuinely faulting (not a transient blip): even the
        // finalize write failed. Nothing more can persist; surface the
        // original fault so the caller sees a failure, not a silent success.
      }
      throw cause;
    }
  }

  async function drive(
    execution: Execution,
    invoke: ToolInvoker,
    prefix: readonly JournalEntry[],
    secret: string | undefined,
    limits: Partial<SandboxLimits> | undefined,
  ): Promise<ExecutionOutcome> {
    const captured: CapturedDriveState = {};
    const host = makeJournalingHost(
      deps.makeToolHost(invoke),
      { executionId: execution.id, secret },
      prefix.length,
      captured,
    );

    let result: SandboxResult;
    try {
      result = await deps.sandbox.execute({
        code: execution.code,
        tools: host,
        seeds: execution.seeds,
        journal: prefix,
        ...(limits !== undefined ? { limits } : {}),
      });
    } catch (cause) {
      // An UNEXPECTED throw out of `sandbox.execute` — a bootstrap failure,
      // a getQuickJS() failure, corrupt stored seeds surfacing as a RangeError,
      // etc. — is an infra fault (design §8). Both `start` (row was just put
      // `running`) and `resume` (claimForResume flipped the row to `running`)
      // have already persisted a NON-terminal `running` row before reaching
      // here. If we let this propagate untouched, that row is left permanently
      // `running` with a stale `pausedOn`: un-settled AND un-resumable (a later
      // resume's claimForResume WHERE status='paused' finds 0 rows → conflict),
      // contradicting §6's state machine (running must reach a terminal) and §8
      // ("the execution is not silently left half-transitioned"). Finalize a
      // terminal `failed` — endedAt set, pausedOn cleared, the cause recorded —
      // and persist it BEFORE re-throwing, so the row is never stranded in
      // `running`. Not swallowed: the terminal state records the reason and the
      // original error still surfaces to the caller.
      await finish(execution, {
        status: "failed",
        error: {
          name: "ConduitExecutionError",
          message: `[ExecutionManager] Sandbox execution threw unexpectedly; execution finalized as failed. Context: { executionId: ${execution.id}, cause: ${String(cause)} }`,
        },
      });
      throw cause;
    }

    // Terminal barrier signals (design D6/F2 and D8/F5): the wrapper threw a
    // `ConduitApprovalPause(true)` — a suspend the sandbox surfaces as
    // `status:"paused"`, but which is actually a terminal, NON-resumable
    // failure, never a real approval pause. Check these BEFORE the switch.
    //
    // divergence — the first live call on resume was not the approved call.
    if (captured.divergence !== undefined) {
      return finish(execution, { status: "failed", error: captured.divergence });
    }
    // ambiguous — a side effect completed but its result could not be journaled.
    if (captured.ambiguous !== undefined) {
      return finish(execution, { status: "failed", error: captured.ambiguous });
    }
    // markerFault — the attempt marker WRITE faulted before the side effect
    // reached upstream. Host-side infra failure: terminalize `failed`, never
    // surface to the guest as a catchable tool error.
    if (captured.markerFault !== undefined) {
      return finish(execution, { status: "failed", error: captured.markerFault });
    }

    switch (result.status) {
      case "completed":
        return finish(execution, { status: "completed", value: result.value });
      case "failed":
        return finish(execution, { status: "failed", error: result.error });
      case "interrupted":
        return finish(execution, {
          status: "failed",
          error: {
            name: "ConduitExecutionInterrupted",
            message: `[ExecutionManager] Execution interrupted (${result.reason}) per §16 resource caps.`,
          },
        });
      case "paused": {
        const pending = captured.pending;
        if (pending === undefined) {
          // Defensive: the sandbox paused but the wrapper captured no
          // PendingApproval. Fail closed rather than persist a pause with no
          // identity to resume against.
          return finish(execution, {
            status: "failed",
            error: {
              name: "ConduitInternalError",
              message: "[ExecutionManager] Sandbox paused without a captured approval.",
            },
          });
        }
        await persistOrFinalizeFailed(execution, () =>
          deps.store.executions.put({
            ...execution,
            status: "paused",
            pausedOn: pending,
          }),
        );
        return { status: "paused", executionId: execution.id, pending };
      }
    }
  }

  async function finish(
    execution: Execution,
    outcome: { status: "completed"; value: unknown } | { status: "failed"; error: SandboxError },
  ): Promise<ExecutionOutcome> {
    const persisted: Execution = {
      ...execution,
      status: outcome.status,
      endedAt: now(),
    };
    // A settled execution carries no pending approval.
    delete persisted.pausedOn;
    await persistOrFinalizeFailed(execution, () => deps.store.executions.put(persisted));
    return outcome.status === "completed"
      ? { status: "completed", executionId: execution.id, value: outcome.value }
      : { status: "failed", executionId: execution.id, error: outcome.error };
  }

  return {
    async start(code, opts) {
      const execution: Execution = {
        id: `exec_${newId()}`,
        code,
        status: "running",
        seeds: generateSeeds(),
        startedAt: now(),
      };
      await deps.store.executions.put(execution);
      const invoke = deps.makeInvoker({ executionId: execution.id });
      return drive(execution, invoke, [], undefined, opts?.limits);
    },

    async resume(executionId, decision) {
      // FIRST: atomic paused→running claim (design F4). Lose → conflict no-op.
      const resumeAttemptId = newId();
      const won = await deps.store.executions.claimForResume(executionId, resumeAttemptId);
      if (!won) {
        return { status: "conflict", executionId };
      }

      // The claim just flipped the row to `running`. EVERYTHING from here until
      // `drive` takes over is a fragile preparation window (design §8/F5): a
      // throw in `get` (which can surface CORRUPT stored JSON — bad seeds or
      // pausedOn — as a parse error), the contiguity check in `toSandboxJournal`
      // (design D5), `listByExecution`, `stage`, or `makeInvoker` would strand
      // the row `running` — a later resume's `claimForResume WHERE
      // status='paused'` then finds 0 rows → permanently un-resumable. Guard the
      // WHOLE window: any throw terminalizes the row `failed` via
      // `failClaimedResume` (which needs NO parsed Execution — the fault may be
      // that there is no parseable Execution to spread) BEFORE re-throwing. Once
      // control reaches `drive`, drive's own catch owns terminalization.
      let execution: Execution | undefined;
      try {
        execution = await deps.store.executions.get(executionId);
        if (execution === undefined || execution.pausedOn === undefined) {
          // The claim flipped status to running but there is no pending call to
          // resume against — a corrupt state. Persist the terminal `failed`
          // (via the raw terminalizer, since there may be no valid Execution)
          // BEFORE returning, so the row is never a stranded `running`.
          await deps.store.executions.failClaimedResume(
            executionId,
            "resumed execution has no pending approval (corrupt state)",
          );
          return {
            status: "failed",
            executionId,
            error: {
              name: "ConduitInternalError",
              message: `[ExecutionManager] Resumed execution has no pending approval. Context: { executionId: ${executionId} }`,
            },
          };
        }
        const pausedOn = execution.pausedOn;

        // TTL (design D8): lazily expire on resume. `claimForResume` already
        // flipped status to running, so persist the terminal `expired` state.
        if (now() > pausedOn.expiresAt) {
          const expired: Execution = { ...execution, status: "expired", endedAt: now() };
          // A settled execution carries no pending approval — clear pausedOn so
          // the terminal row is not left with a stale pending call (same
          // discipline as finish()).
          delete expired.pausedOn;
          await persistOrFinalizeFailed(execution, () => deps.store.executions.put(expired));
          return { status: "expired", executionId, pending: pausedOn };
        }

        // Load the durable prefix and stage the decision bound to the pending
        // call's identity (design D6). Serialization MUST match the invoker's:
        // request = JSON.stringify(pausedOn.input) via the shared identity from
        // journal.ts — so it cannot drift and fail every approved resume closed.
        const prefixRows = await deps.store.replayJournal.listByExecution(executionId);
        const prefix = toSandboxJournal(prefixRows);

        // Outcome-ambiguity on recovery (design D8/F5): an un-cleared attempt
        // marker means a PRIOR drive MAY have crashed between an upstream side
        // effect and its journal append. But a marker is outcome-ambiguous ONLY
        // IF its ordinal is ABSENT from the durable journal prefix (H/M-fix): a
        // marker whose ordinal ALREADY has a journal row is RESOLVED — the
        // append succeeded and only the clear didn't (a crash BETWEEN
        // appendBarrier and clearAttempt). Re-running is not at stake there;
        // the outcome is durably recorded. So compare the attempt ordinals
        // against the journal ordinals and terminalize only on the genuinely
        // unrecorded ones. With no idempotency key (v1 has none), those fail
        // CLOSED: terminal `failed` (outcome-ambiguous), never re-run. The
        // terminal state records the pending call so a human can re-issue.
        const strandedAttempts = await deps.store.replayJournal.listAttempts(executionId);
        const journaledOrdinals = new Set(prefixRows.map((row) => row.ordinal));
        const unrecordedAttempts = strandedAttempts.filter(
          (ordinal) => !journaledOrdinals.has(ordinal),
        );
        if (unrecordedAttempts.length > 0) {
          const failed: Execution = { ...execution, status: "failed", endedAt: now() };
          delete failed.pausedOn;
          await persistOrFinalizeFailed(execution, () => deps.store.executions.put(failed));
          return {
            status: "failed",
            executionId,
            error: {
              name: "ConduitOutcomeAmbiguous",
              message:
                `[ExecutionManager] A prior upstream call was attempted but its result was never ` +
                `journaled (crash between side effect and append); the execution is outcome-ambiguous ` +
                `and not resumable. Context: { executionId: ${executionId}, attemptOrdinals: [${unrecordedAttempts.join(", ")}] }`,
            },
          };
        }
        // Any RESOLVED markers (ordinal already journaled — only the clear was
        // lost to a crash) are stale but harmless. Best-effort clear them so the
        // journal is tidy; a clear fault here does not block resume, because the
        // outcome is durably recorded and re-running is not at stake.
        for (const ordinal of strandedAttempts) {
          if (journaledOrdinals.has(ordinal)) {
            await deps.store.replayJournal.clearAttempt(executionId, ordinal).catch(() => {
              // Stale marker at a journaled ordinal — resume proceeds regardless.
            });
          }
        }

        const decisions = makeDecisions();
        decisions.stage(
          executionId,
          { op: "call", toolName: pausedOn.toolName, request: JSON.stringify(pausedOn.input) },
          decision,
        );

        // The execution is `running` again (the claim did that); re-drive with
        // the decisions-wired invoker. The approved call is the FIRST
        // un-journaled call → runs live via the decision seam (allow), or
        // resolves ConduitPolicyBlocked (deny). Continue to completed / failed /
        // next pause. drive() owns terminalization from here on.
        const running: Execution = { ...execution, status: "running" };
        delete running.pausedOn;
        const invoke = deps.makeInvoker({ executionId, decisions });
        return await drive(running, invoke, prefix, undefined, undefined);
      } catch (cause) {
        // A throw in the preparation window (NOT from inside drive — drive
        // finalizes its own faults and re-throws already-terminalized). Best
        // effort: terminalize the claimed row `failed` so it is never stranded
        // `running`, then re-throw the original fault. `failClaimedResume` only
        // fires on a still-`running` row, so if drive already finalized it to a
        // terminal state this is a harmless no-op.
        await deps.store.executions
          .failClaimedResume(executionId, `resume preparation failed: ${String(cause)}`)
          .catch(() => {
            // The store is genuinely faulting; nothing more can persist. Surface
            // the original fault regardless.
          });
        throw cause;
      }
    },

    get(executionId) {
      return deps.store.executions.get(executionId);
    },
  };
}

function neverPauses(op: string): () => PendingApproval {
  return () => {
    throw new Error(`[ExecutionManager] ${op} cannot pause; only a call gates on approval.`);
  };
}

function toSandboxError(error: unknown): SandboxError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function toRowOutcome(
  outcome: JournalEntry["outcome"],
): { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } } {
  return outcome.ok
    ? { ok: true, value: outcome.value }
    : { ok: false, error: { name: outcome.error.name, message: outcome.error.message } };
}
