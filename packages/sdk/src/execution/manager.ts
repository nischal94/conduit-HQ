import type { ToolInvoker } from "../execute.js";
import { GUEST_ERROR_NAMES } from "../pipeline/errors.js";
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
 * The same class also carries the outcome-ambiguous escape (design D8/F5):
 * when a completed call's result cannot be journaled, the barrier throws this
 * with `ambiguous: true`. It shares the `ConduitApprovalPause` name so the
 * sandbox's `perform` still treats it as a non-result (never journaling the
 * call); the manager reads `captured.ambiguous` to finalize a terminal failed
 * state rather than a pause.
 */
class ConduitApprovalPause extends Error {
  readonly ambiguous: boolean;
  constructor(ambiguous = false) {
    super(ambiguous ? "execution outcome-ambiguous" : "execution paused awaiting approval");
    this.name = "ConduitApprovalPause";
    this.ambiguous = ambiguous;
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
    captured: { pending?: PendingApproval; ambiguous?: SandboxError },
  ): ToolHost {
    let ordinal = prefixLength;

    async function journal(
      op: "search" | "describe" | "call",
      request: string,
      run: () => Promise<unknown>,
      onApprovalPause: () => PendingApproval,
    ): Promise<unknown> {
      let value: unknown;
      try {
        value = await run();
      } catch (error) {
        if (isRequireApproval(error)) {
          // Pause: assemble the host-side PendingApproval and suspend WITHOUT
          // journaling (design D2/D4). Only a `call` can gate.
          captured.pending = onApprovalPause();
          throw new ConduitApprovalPause();
        }
        // Any other error (a `block`, a real upstream failure, a denied
        // resume resolving as ConduitPolicyBlocked) is a journaled failed
        // outcome — catchable in the guest, exactly as today.
        const outcome = { ok: false as const, error: toSandboxError(error) };
        await appendBarrier(op, request, outcome);
        // Re-throw so the guest sees the (guest-safe) error.
        throw error;
      }
      const scrubbed = scrubCredential(value, ctx.secret);
      const normalized = scrubbed === undefined ? null : scrubbed;
      await appendBarrier(op, request, { ok: true as const, value: normalized });
      return normalized;
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
          JSON.stringify({ path, includeSchemas: options?.includeSchemas === true }),
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

  function assemblePending(path: string, input: unknown): PendingApproval {
    // reason/callId originate HOST-SIDE here (design C3) — never in the
    // sandbox. The reason is the policy verdict's message, surfaced from the
    // invoker's `ConduitPolicyDenied` throw and captured by the wrapper.
    return {
      callId: newId(),
      toolName: path,
      input,
      reason: lastApprovalReason ?? `${path} requires approval before it can run.`,
      expiresAt: now() + resolveApprovalTtlMs(),
    };
  }

  // The reason text of the most recent require_approval. Set when the wrapper
  // recognizes the invoker's ConduitPolicyDenied so assemblePending can carry
  // it. Single-pending-call model (design D3) → at most one is live per drive.
  let lastApprovalReason: string | undefined;

  function isRequireApproval(error: unknown): boolean {
    if (!(error instanceof Error) || error.name !== GUEST_ERROR_NAMES.policyDenied) {
      return false;
    }
    lastApprovalReason = error.message;
    return true;
  }

  async function drive(
    execution: Execution,
    invoke: ToolInvoker,
    prefix: readonly JournalEntry[],
    secret: string | undefined,
    limits: Partial<SandboxLimits> | undefined,
  ): Promise<ExecutionOutcome> {
    const captured: { pending?: PendingApproval; ambiguous?: SandboxError } = {};
    const host = makeJournalingHost(
      deps.makeToolHost(invoke),
      { executionId: execution.id, secret },
      prefix.length,
      captured,
    );

    const result: SandboxResult = await deps.sandbox.execute({
      code: execution.code,
      tools: host,
      seeds: execution.seeds,
      journal: prefix,
      ...(limits !== undefined ? { limits } : {}),
    });

    // Outcome-ambiguous barrier failure (design D8/F5): the wrapper threw a
    // `ConduitApprovalPause(true)` after a side effect completed but its
    // result could not be journaled. The sandbox treats that as a pause
    // (name-match) and returns `status:"paused"`, but this is a terminal,
    // NON-resumable failure — never a real approval pause. Check it first.
    if (captured.ambiguous !== undefined) {
      return finish(execution, { status: "failed", error: captured.ambiguous });
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
        await deps.store.executions.put({
          ...execution,
          status: "paused",
          pausedOn: pending,
        });
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
    await deps.store.executions.put(persisted);
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

      const execution = await deps.store.executions.get(executionId);
      if (execution === undefined || execution.pausedOn === undefined) {
        // The claim flipped status to running but there is no pending call to
        // resume against — a corrupt state; fail closed.
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
        await deps.store.executions.put({
          ...execution,
          status: "expired",
          endedAt: now(),
        });
        return { status: "expired", executionId, pending: pausedOn };
      }

      // Load the durable prefix and stage the decision bound to the pending
      // call's identity (design D6). Serialization MUST match the invoker's:
      // request = JSON.stringify(pausedOn.input) via the shared identity from
      // journal.ts — so it cannot drift and fail every approved resume closed.
      const prefixRows = await deps.store.replayJournal.listByExecution(executionId);
      const prefix = toSandboxJournal(prefixRows);
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
      // next pause.
      const running: Execution = { ...execution, status: "running" };
      delete running.pausedOn;
      const invoke = deps.makeInvoker({ executionId, decisions });
      return drive(running, invoke, prefix, undefined, undefined);
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
