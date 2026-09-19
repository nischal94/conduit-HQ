import type { ToolInvoker } from "../execute.js";
import type { DispatchCell } from "../pipeline/dispatch.js";
import {
  GUEST_ERROR_NAMES,
  OUTCOME_AMBIGUOUS_ERROR_NAME,
  REPLAY_DIVERGENCE_ERROR_NAME,
} from "../pipeline/errors.js";
import { redactSensitiveFields } from "../pipeline/redact.js";
import {
  createUpstreamSessionScope,
  type UpstreamSessionScope,
} from "../pipeline/upstream-session.js";
import type {
  JournalEntry,
  Sandbox,
  SandboxError,
  SandboxLimits,
  SandboxResult,
  ToolHost,
} from "../sandbox/sandbox.js";
import { DEFAULT_SANDBOX_LIMITS, generateSeeds } from "../sandbox/sandbox.js";
import {
  defaultScopeResolver,
  type EffectiveScope,
  namespaceOf,
  type ScopeResolver,
} from "../scope.js";
import type { ConduitStore, DirectSettle } from "../store/store.js";
import {
  type Execution,
  type ExecutionError,
  hasProvenance,
  isPendingApproval,
  NOT_NAMEABLE_CALL_ID,
  type PendingApproval,
  type Projection,
  type StoredPendingApproval,
} from "../types.js";
import { mapCreateConflict } from "./create-conflict.js";
import type { ApprovalDecision, ApprovalDecisions } from "./decisions.js";
import { createInMemoryApprovalDecisions } from "./decisions.js";
import {
  boundedFencedSettle,
  boundedStoreCall,
  createDirectDrive,
  DIRECT_DEFAULTS,
  type DirectBudgets,
  type DirectDriveHandle,
  type DirectOutcome,
  deliverableBytes,
  formatCause,
  type OwnedDirectDrive,
  type StoreCallResult,
} from "./direct.js";
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
  start(
    code: string,
    opts?: {
      limits?: Partial<SandboxLimits>;
      requestKey?: string;
      /** null (or absent) = the default profile (§4.1). */
      clientId?: string | null;
      /**
       * §5.2/§5.4: the authority this drive runs under. ABSENT wires NO scope
       * (D-A3 / eng review D8): the drive takes today's unscoped path — one
       * `tools.get` per call, no per-call `tools.list()`. That path is legal
       * ONLY for the default profile; a NAMED client without a resolver is
       * refused before any row is written (D11).
       */
      scope?: ScopeResolver;
    },
  ): Promise<ExecutionOutcome>;
  /**
   * Resume a paused execution after a human decision on ONE pending call.
   * `callId` is the `PendingApproval.callId` the human saw; if the execution
   * is no longer paused on that call (already decided, or paused again on a
   * later call) the resume is a `conflict`, never a decision on another call.
   */
  resume(
    executionId: string,
    decision: ApprovalDecision,
    callId: string,
    /**
     * §5.4 step 4: the authority the resumed drive runs under. ABSENT means
     * the DEFAULT profile — legal only for a default-profile row (clientId
     * null, D8). A NAMED row without a resolver has no authority to resume
     * under and is terminalized `ConduitScopeRevoked` (D11).
     */
    scope?: ScopeResolver,
  ): Promise<ResumeOutcome>;
  /**
   * §5.3/§5.4: run ONE governed tool call with no guest program. Returns a
   * HANDLE, not a promise (D-A2): the client-visible `outcome` is bounded by
   * the drive budget plus the settle-write budget, while the continuation may
   * still be running behind it — `retention` and `finished` report on that.
   *
   * `scope` is REQUIRED here (spec §5.4): a direct call whose projection flag
   * is never evaluated would be a public SDK bypass. D-A3's optional scope
   * applies to `start`/`resume` only.
   */
  startDirect(
    toolName: string,
    input: unknown,
    opts: {
      clientId: string | null;
      projection: "direct" | "discovery";
      requestKey?: string;
      scope: ScopeResolver;
    },
  ): DirectDriveHandle;
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
 * CLI's `conduit approvals approve|deny <exec_id> <call_id>` maps onto
 * `resume(executionId, decision, callId)`. A `conflict` still carries the id
 * it raced on.
 */
export type ExecutionOutcome =
  | {
      status: "completed";
      executionId: string;
      value: unknown;
      /** §4.1: the deliverable exceeded RESULT_BYTES_MAX — settled `discarded`, no value. */
      resultTooLarge?: true;
    }
  | { status: "failed"; executionId: string; error: SandboxError }
  /**
   * Narrowed back to `PendingApproval` (§4.1): every pause this build writes
   * is provenance-stamped at capture time, and a namespace with no source row
   * terminalizes `ConduitCatalogChanged` instead of pausing (D-A7) — so a
   * pause without the pair is no longer producible here.
   */
  | { status: "paused"; executionId: string; pending: PendingApproval }
  /**
   * Still the UNION: an `expired` pause is READ from a stored row, which may
   * predate R1 and carry no provenance. Readers narrow through
   * `hasProvenance` (§4.1).
   */
  | { status: "expired"; executionId: string; pending: StoredPendingApproval }
  | { status: "conflict"; executionId: string };

/**
 * What `resume` returns: the drive outcome PLUS host-side truth about whether
 * the operator's staged decision was actually CONSUMED by the pending call
 * (the decisions seam's one-shot `take` — design D6). The two are independent
 * axes: a deny can land and the guest still catch it and complete
 * (`status:"completed", decisionApplied:true`), and a drive can fail with a
 * guest-forged `ConduitPolicyBlocked` name without any decision applying
 * (`status:"failed", decisionApplied:false`). Callers reporting the operator's
 * VERB (the CLI's `approvals approve|deny`) must key on `decisionApplied`,
 * never on the outcome's error name — error names are guest-reachable and
 * therefore spoofable; consumption is recorded host-side by the invoker.
 */
export type ResumeOutcome = DirectOutcome & {
  decisionApplied: boolean;
  /**
   * Set ONLY by the manager's corrupt-state branches: the claimed row had no
   * pending call an operator could have named, so it was terminalized
   * `failed` without staging a decision. Host-side truth, like
   * `decisionApplied` — a caller that logs or reports "corrupt pause" must
   * key on this, never on `error.name`, which a guest can forge.
   */
  corruptPause?: true;
};

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
   *
   * A custom `makeInvoker` MUST forward `dispatch`, `projection`, `clientId`
   * and `scope` to the invoker it builds. They are not conveniences: dropping
   * `dispatch` leaves the manager's cell reading `none` forever, so a failure
   * AFTER the upstream call was written classifies as "did not run" instead
   * of ambiguous (§7/D-A4); dropping `scope` or `clientId` runs the call
   * without the per-call authority recheck (§5.5); dropping `projection`
   * mis-attributes the audit row (§4.3). Absent must stay absent — under
   * `exactOptionalPropertyTypes`, pass the key only when it is defined.
   */
  makeInvoker: (args: {
    executionId: string;
    decisions?: ApprovalDecisions;
    /**
     * Remaining §16 wall-clock budget, in ms, for THIS drive. The invoker
     * clamps each upstream call to `min(ceiling, deadline())` and refuses once
     * the budget is exhausted — so a call raised late in the window cannot
     * overrun the wall-clock by a full upstream ceiling (finding F1, gate two).
     */
    deadline?: () => number;
    /**
     * §18-C4: the per-drive upstream session scope, created by the manager
     * BEFORE this invoker and disposed in a `finally` around the whole drive.
     * Threading it through here (rather than each call minting an ephemeral
     * scope) is what lets repeat calls to the same (url, auth) within one
     * drive reuse a single initialized MCP session.
     */
    upstreamSession?: UpstreamSessionScope;
    /** §4.3/§5.5: attribution and authority for THIS drive. */
    projection: Projection;
    clientId: string | null;
    /** The resolver bound to the drive's client id; absent = default profile (D-A3). */
    scope?: () => Promise<EffectiveScope>;
    /** §5.5: a direct drive's one cell. */
    dispatch?: DispatchCell;
  }) => ToolInvoker;
  /**
   * Wrap an invoker into the catalog-backed ToolHost. The second argument is
   * present IFF the drive runs under a resolver: the host must then be the
   * scoped view (§5.4), so in-sandbox search/describe see the same authority
   * the per-call check enforces.
   */
  makeToolHost: (
    invoke: ToolInvoker,
    scoped?: { scope: () => Promise<EffectiveScope>; projection: "code" },
  ) => ToolHost;
  /** Defaults to `createInMemoryApprovalDecisions`; injectable for tests. */
  makeDecisions?: () => ApprovalDecisions;
  /**
   * §18-C4: builds the per-drive upstream session scope. Defaults to
   * `createUpstreamSessionScope`; injectable for tests (a recording fake
   * proves creation/disposal timing without a real MCP session).
   */
  makeUpstreamSession?: () => UpstreamSessionScope;
  /**
   * §11 direct-arm budgets, overridable per field. Injectable so tests can
   * exercise expiry without waiting out the real 60 s drive budget.
   */
  direct?: Partial<DirectBudgets>;
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
  /** §4.1: provenance-stamped at capture time — never the legacy shape. */
  pending?: PendingApproval;
  /** design D8/F5: a completed call's result could not be journaled. */
  ambiguous?: SandboxError;
  /** design D6/F2: the first live call on resume ≠ the approved call. */
  divergence?: SandboxError;
  /**
   * D-A7: the pause could not be provenance-stamped because the tool's
   * namespace has no source row. Terminal `failed`, and the call did NOT run
   * (the pause is raised BEFORE upstream).
   */
  catalogChanged?: ExecutionError;
}

/**
 * D-A7: the internal signal `assemblePending` throws when a pause cannot carry
 * both provenance fields. Module-scope so the wrapper's catch can identify it
 * by class rather than by message. Never reaches the guest: the wrapper
 * converts it to a terminal `ConduitApprovalPause(true)`.
 */
class CatalogChangedAtPause extends Error {}

export function createExecutionManager(deps: ExecutionManagerDeps): ExecutionManager {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  // Defaults to the request-bound in-memory seam (decisions.ts). A fresh
  // instance per resume is correct: a decision lives only for the one resume
  // it is staged for, and the invoker consumes it one-shot.
  const makeDecisions = deps.makeDecisions ?? createInMemoryApprovalDecisions;
  const makeUpstreamSession = deps.makeUpstreamSession ?? (() => createUpstreamSessionScope());

  /**
   * The remaining §16 wall-clock budget for a drive that is about to run, as a
   * closure the invoker polls before each upstream call (finding F1, gate two).
   * It mirrors the sandbox's OWN fresh per-drive window: the sandbox reсomputes
   * `Date.now() + wallClockMs` at the top of every `execute`, and a resume gets
   * a fresh window just like a start. Captured at makeInvoker time, a hair
   * before the sandbox's own read, so the invoker's clamp is conservatively no
   * later than the wall-clock interrupt.
   */
  function deadlineFor(limits: Partial<SandboxLimits> | undefined): () => number {
    const wallClockMs = limits?.wallClockMs ?? DEFAULT_SANDBOX_LIMITS.wallClockMs;
    const budgetEnd = now() + wallClockMs;
    return () => budgetEnd - now();
  }

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

    function isOutcomeAmbiguous(error: unknown): boolean {
      return error instanceof Error && error.name === OUTCOME_AMBIGUOUS_ERROR_NAME;
    }

    /**
     * §4.1: stamp the pause with the provenance pair a §5.4 resume checks —
     * the tool's namespace and that namespace's generation AT PAUSE TIME.
     * `getGeneration` is "current at read time", so a concurrent catalog bump
     * reads newer, never stale, and resume refuses the stale pause.
     *
     * D-A7: when either field is unavailable the pause is REFUSED rather than
     * stamped with a placeholder — a fabricated `sourceGeneration` would be
     * compared against the namespace's current generation and silently pass a
     * real authorization check.
     */
    async function assemblePending(path: string, input: unknown): Promise<PendingApproval> {
      const namespace = namespaceOf(path);
      const generation =
        namespace === undefined ? undefined : await deps.store.sources.getGeneration(namespace);
      if (namespace === undefined || generation === undefined) {
        throw new CatalogChangedAtPause(
          `[ExecutionManager] Approval pause refused: no source for the tool's namespace; re-approve after the catalog settles. Context: { executionId: ${ctx.executionId}, tool: ${path} }`,
        );
      }
      // reason/callId originate HOST-SIDE here (design C3) — never in the
      // sandbox. The reason is the policy verdict's message, surfaced from the
      // invoker's `ConduitPolicyDenied` throw and captured just above.
      return {
        callId: newId(),
        toolName: path,
        namespace,
        sourceGeneration: generation,
        input,
        reason: lastApprovalReason ?? `${path} requires approval before it can run.`,
        expiresAt: now() + resolveApprovalTtlMs(),
      };
    }

    async function journal(
      op: "search" | "describe" | "call",
      request: string,
      run: () => Promise<unknown>,
      onApprovalPause: () => Promise<PendingApproval>,
    ): Promise<unknown> {
      let value: unknown;
      try {
        value = await run();
      } catch (error) {
        if (isRequireApproval(error)) {
          // Pause: no upstream side effect happened (policy refuses BEFORE
          // upstream). Commit to the uncatchable suspend path — the captured
          // signal is set and ConduitApprovalPause is thrown, which the sandbox
          // treats as an uncatchable interrupt so the guest cannot
          // catch-and-continue past its own approval gate.
          try {
            captured.pending = await onApprovalPause();
          } catch (cause) {
            if (cause instanceof CatalogChangedAtPause) {
              // D-A7: no provenance → no pause. Terminal, and the call did not
              // run, so the operator re-approves against a settled catalog.
              captured.catalogChanged = {
                name: "ConduitCatalogChanged",
                message: cause.message,
              };
              throw new ConduitApprovalPause(true);
            }
            // Any other provenance failure (a store read threw) is a HOST
            // fault. Terminal, guest-uncatchable, and OPAQUE — the cause goes
            // to the host log, never into a guest-visible or persisted
            // message, which could carry a store path.
            const correlationId = crypto.randomUUID();
            console.error(
              `[ExecutionManager] Provenance read failed at pause ${correlationId}: ${formatCause(cause)}`,
            );
            captured.ambiguous = {
              name: "ConduitInternalError",
              message: `[ExecutionManager] Approval pause could not be recorded. Reference: ${correlationId}`,
            };
            throw new ConduitApprovalPause(true);
          }
          throw new ConduitApprovalPause();
        }
        if (isOutcomeAmbiguous(error)) {
          // §7 Code Mode side: the cell read `dispatched` when the call
          // failed, so the upstream may have performed it. Host-side,
          // guest-uncatchable, terminal — exactly the divergence path. A
          // guest `catch` must never continue past an ambiguous side effect.
          captured.ambiguous = {
            name: OUTCOME_AMBIGUOUS_ERROR_NAME,
            message: (error as Error).message,
          };
          throw new ConduitApprovalPause(true);
        }
        if (isReplayDivergence(error)) {
          // Resume replay-divergence (design D6/F2): refused BEFORE upstream,
          // like require_approval — no side effect. Terminalize uncatchably;
          // the manager finalizes `failed`; do NOT journal it (not real guest
          // control flow).
          captured.divergence = {
            name: REPLAY_DIVERGENCE_ERROR_NAME,
            message: `[ExecutionManager] Resume replay-divergence; execution terminated (non-resumable). Context: { executionId: ${ctx.executionId} }`,
          };
          throw new ConduitApprovalPause(true);
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
      // Append the outcome durably BEFORE handing the value back to the guest
      // (the barrier — design D8): guest progress past a call implies that
      // call is replay-durable. If appendBarrier throws (the completed call's
      // outcome could not be journaled), it terminalizes outcome-ambiguous
      // (captured.ambiguous) — the append-throw F5 guarantee (a live side
      // effect whose result is unrecorded is never re-run in this drive).
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
        // The stored reason is OPAQUE: a store fault's text carries the
        // database path and SQL, and this row is handed back to the agent by
        // `check_execution`. The cause goes to the host log under a fresh
        // reference; only the reference is persisted. `ordinal` stays — it is
        // host-generated, not derived from the fault.
        const ref = crypto.randomUUID();
        console.error(
          `[ExecutionManager] journal append failed after a completed call ${ref}: ${formatCause(cause)}`,
        );
        captured.ambiguous = {
          name: OUTCOME_AMBIGUOUS_ERROR_NAME,
          message:
            `[ExecutionManager] Result of a completed upstream call could not be journaled; ` +
            `the execution is outcome-ambiguous and not resumable. Context: { executionId: ${ctx.executionId}, ordinal: ${at} } Reference: ${ref}`,
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
   *
   * mcp design M4/M9: the fallback row is itself a `failed` terminal and must
   * ALWAYS carry an error payload (never a payload-less terminal row). If the
   * execution already had a real error (e.g. drive()'s own catch already set
   * one before calling in), preserve it; otherwise synthesize
   * `ConduitPersistError` naming the write fault as the reason the outcome
   * could not be durably recorded — this fires on every terminal path that
   * routes through this guard (completed/failed settle, paused, expired).
   */
  async function persistOrFinalizeFailed(
    execution: Execution,
    write: () => Promise<void>,
  ): Promise<void> {
    try {
      await write();
    } catch (cause) {
      // OPAQUE: a store fault's text carries the database path and SQL, and
      // this row is handed back to the agent by `check_execution`.
      const ref = crypto.randomUUID();
      console.error(`[ExecutionManager] settle write failed ${ref}: ${formatCause(cause)}`);
      const failed: Execution = {
        ...execution,
        status: "failed",
        endedAt: now(),
        error: execution.error ?? {
          name: "ConduitPersistError",
          message: `[ExecutionManager] Settle write failed; outcome not persisted. Context: { executionId: ${execution.id} } Reference: ${ref}`,
        },
      };
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

  /**
   * Drive one sandbox execution to a settled outcome. The MVP delivers NO
   * DOUBLE-EXECUTION, not process-crash recovery: `resume` only claims a
   * `paused` row, so a host crash mid-call — which leaves the row `running`,
   * never `paused` — is never re-driven (it strands a zombie `running` row for
   * an operator, not a silent re-run). Recovering such a row would require
   * distinguishing "crashed" from "legitimately running", undecidable in a
   * single-process MVP without the deferred multi-worker lease/heartbeat
   * (design §7). The one crash-shaped guarantee the design DOES promise —
   * an appendBarrier THROW after a live side effect → terminal
   * `failed:outcome-ambiguous` — is delivered WITHIN this drive by
   * `captured.ambiguous` (see appendBarrier), needing no cross-drive marker.
   */
  async function drive(
    // Code rows only: the direct arm is a separate drive.
    execution: Extract<Execution, { kind: "code" }>,
    invoke: ToolInvoker,
    prefix: readonly JournalEntry[],
    secret: string | undefined,
    limits: Partial<SandboxLimits> | undefined,
    /** Present iff the drive runs under a resolver: the host is then scoped (§5.4). */
    scoped?: { scope: () => Promise<EffectiveScope>; projection: "code" },
  ): Promise<ExecutionOutcome> {
    const captured: CapturedDriveState = {};
    const host = makeJournalingHost(
      deps.makeToolHost(invoke, scoped),
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
      // OPAQUE for the same reason as the settle-write fault above: a store
      // or bootstrap fault's text carries host-only detail into a row
      // `check_execution` hands back to the agent.
      const ref = crypto.randomUUID();
      console.error(`[ExecutionManager] sandbox execution threw ${ref}: ${formatCause(cause)}`);
      await finish(execution, {
        status: "failed",
        error: {
          name: "ConduitExecutionError",
          message: `[ExecutionManager] Sandbox execution threw unexpectedly; execution finalized as failed. Context: { executionId: ${execution.id} } Reference: ${ref}`,
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
    // catalogChanged (D-A7) — the pause could not be provenance-stamped, so no
    // pause was written and the gated call never ran.
    if (captured.catalogChanged !== undefined) {
      return finish(execution, { status: "failed", error: captured.catalogChanged });
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
      // mcp design M4: fold the settle-state into the persisted row. A
      // completed row carries its result (`undefined` normalized to `null` at
      // persistence — the M1 undefined→null rule); a failed row ALWAYS
      // carries its error, so a stored failed row can always explain itself.
      ...(outcome.status === "completed" ? { result: outcome.value ?? null } : {}),
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
    };
    // A settled execution carries no pending approval.
    delete persisted.pausedOn;
    await persistOrFinalizeFailed(execution, () => deps.store.executions.put(persisted));
    return outcome.status === "completed"
      ? { status: "completed", executionId: execution.id, value: outcome.value }
      : { status: "failed", executionId: execution.id, error: outcome.error };
  }

  /**
   * Bind a resolver to one client id. ABSENT stays absent (eng review D8):
   * the drive then runs today's unscoped path — no per-call tools.list().
   * The default profile is materialized only where a check is mandatory
   * (resume step 4) via `defaultScopeResolver(deps.store)`.
   */
  function bindScope(
    scope: ScopeResolver | undefined,
    clientId: string | null,
  ): (() => Promise<EffectiveScope>) | undefined {
    return scope === undefined ? undefined : () => scope(clientId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // §5.3 direct arm — the LATCH STATE MACHINE
  //
  // One direct drive has exactly TWO racing settlers and ONE shared latch
  // (`drive.settle()`), so exactly one of them ever writes the row and exactly
  // one ever publishes the client-visible outcome.
  //
  //                         ┌──────────────────────────────┐
  //                         │  drive constructed (D-A13)   │
  //                         │  timer ARMED, latch FREE     │
  //                         │  persisted = false           │
  //                         └──────────────┬───────────────┘
  //                                        │
  //              ┌─────────────────────────┴─────────────────────────┐
  //              │                                                   │
  //   (A) CONTINUATION reaches a                        (B) TIMER fires at
  //       settle point:                                     driveBudgetMs:
  //         - completion (sized)                              expireDirect()
  //         - pause (generation read first)
  //         - failure / prep-window throw
  //              │                                                   │
  //              └──────────────► drive.settle() ◄──────────────────┘
  //                                    │
  //                    ┌───────────────┴───────────────┐
  //                    │ true (WINNER, exactly one)    │ false (LOSER)
  //                    ▼                               ▼
  //          settleBounded(...)                  return immediately:
  //                    │                         write nothing, publish
  //                    │                         nothing. The winner
  //                    │                         already answered.
  //                    ▼
  //        persisted === false?  ──yes──► publish the pre-dispatch outcome
  //                    │                  directly (no row exists; nothing
  //                    │                  could have dispatched). If create()
  //                    │                  later SUCCEEDS, startDirect's
  //                    │                  post-create branch re-issues the
  //                    │                  SAME fenced timeout settle.
  //                    │ no
  //                    ▼
  //     settleDirect(id, attempt, settle)  ← the FENCE:
  //         WHERE status='running' AND resume_attempt = attempt
  //                    │
  //         ┌──────────┼──────────────┬────────────────────┐
  //         │          │              │                    │
  //     "written"  "fenced"(0 rows) "failed"(reject)   "timeout"
  //     publish     publish          publish            publish
  //     intended    unknown/         unknown/           unknown/
  //     outcome     persist-failed   persist-failed     persist-timeout
  //
  // GUARD-PHASE EXPIRY (resume): the drive is constructed right after the
  // claim identifies a direct row, so its timer covers the §5.4 read-side
  // guard too — its `onExpire` is wired AT CONSTRUCTION, and every guard read
  // races it. The SAME one latch decides here:
  //
  //        budget elapses during the guard        a guard read resolves
  //                    │                                    │
  //                    ▼                                    ▼
  //          onExpire: drive.settle() ◄───── the one latch ─────► terminalizeDirect:
  //                    │                                         drive.settle()
  //         ┌──────────┴──────────┐                     ┌──────────┴──────────┐
  //     true (WINNER)        false (LOSER)          true (WINNER)      false (LOSER)
  //     settleEarly()        return, write          settleEarly()      EXPIRY HOLDS IT:
  //     bounded fenced       nothing                bounded fenced     await guardExpiry
  //     settle; publish                             settle; publish    and return ITS
  //     via guardExpiry                             its own outcome    outcome — never a
  //                                                                    second write
  //
  // THE HANDOVER, the one exit that is neither of the two above. After
  // the LAST guard read (`policies.get`) the resume path stops guarding and
  // hands the drive to `runDirect`. `raceGuard` answers "not expired"
  // whenever the READ wins — including when the budget elapsed DURING it and
  // the expiry already holds the latch with its write in flight. Handing over
  // then is fatal: `runDirect`'s first `settle()` loses and it returns having
  // resolved nothing, so `await outcome` never resolves and `resume()` hangs
  // forever holding a daemon queue slot. So the handover re-checks the latch
  // itself and defers to `guardExpiry`, exactly as a late guard result does:
  //
  //        last guard read returns          drive.settled?
  //                    │                   ┌──── true ────► return guardExpiry
  //                    ▼                   │                (the expiry owns it)
  //        if (directDrive.settled) ───────┤
  //                                        └──── false ───► build `run`, rewire
  //                                                         onExpire → expireDirect,
  //                                                         runDirect takes over
  //
  // LIFECYCLE SPLIT (M1 / D-A2). `finishEarly()` resolves BOTH lifecycle
  // promises; `settleEarly()` resolves only `settledAt` and clears the timer,
  // leaving `finished` for the caller to resolve on the settle WRITE. Every
  // guard exit that ISSUES a write now uses `settleEarly()` plus
  // `resolveFinished(write)`, because `finished` means "the continuation and
  // any tracked settle write have actually stopped" and Lane B holds an
  // admission slot on it — resolving it over a live store write would release
  // that slot while the work is still running. `settledAt` is deliberately
  // NOT deferred: the spec measures slot retention from the moment the row is
  // SETTLED, not from the write's completion. `finishEarly()` remains for the
  // exits that write nothing.
  //
  // A late guard result deferring to `guardExpiry` is what keeps the loser
  // from issuing a SECOND `settleDirect` on the same (id, attempt) and then
  // reading its own `fenced` (0 rows) as `unknown/persist-failed` — a false
  // non-answer for a write that actually SUCCEEDED. The SQL fence protects
  // the record; only the latch protects the published outcome.
  //
  // `terminalizeDirect` is the ONE place this rule lives for every FAILED
  // terminalization; the TTL `expired` arm below repeats it inline because
  // its settle payload is `{status:"expired"}`, not a failure. Every guard
  // terminalization and the prep-window catch call it, and it owns
  // `settleEarly()` so no caller can settle the row and forget to stop the
  // drive. The expiry handler calls `settleEarly()` itself for the same
  // reason, so that exit looks like every other exit.
  //
  // CLASSIFICATION at expiry is decided by the DISPATCH CELL (D-A4), never by
  // elapsed time: cell `dispatched` → ConduitOutcomeAmbiguous ("the upstream
  // may have performed the call"); otherwise ConduitExecutionInterrupted
  // ("did not run").
  //
  // ORDERING RULE: every UNBOUNDED read a settle needs happens
  // BEFORE `settle()` is taken — the pause path's `getGeneration`, the
  // create-conflict lookup — so a stalled read cannot hold the latch and
  // deny the timer its chance to answer.
  //
  // EXIT PATHS: `runDirect`'s `finally` always disposes the drive's timer and
  // awaits the tracked settle writes; `startDirect`'s `finished` disposes
  // again (idempotent). `outcome` and `retention` resolve on every path — an
  // unresolvable `outcome` strands the caller and holds a queue slot. Only
  // `finished` may stay pending, and only for a quarantined continuation (see
  // its own doc in direct.ts).
  //
  // CODE-ROW GUARD EXPIRY (resume). A code row has no drive, so it carries
  // its OWN latch — `codeGuardLatched` — and it is a genuine race, not a
  // straight line. Two writers can reach the row: the expiry timer, and the
  // guard itself (a refusal, or the handover to the drive).
  //
  //        budget elapses during the guard        a guard read resolves
  //                    │                                     │
  //                    ▼                                     ▼
  //     timer callback: takeCodeGuardLatch() ◄── one latch ──► terminalizeCodeGuard /
  //     as its FIRST statement                                the handover:
  //         │                                                 takeCodeGuardLatch()
  //     ┌───┴─── true (WINNER) ────┐                    ┌──────────┴──────────┐
  //     │                          │                true (WINNER)      false (LOSER)
  //  terminalizeCodeRow:      false (LOSER)         refuse / hand over  EXPIRY HOLDS IT:
  //  bounded                  return, write         to the drive        await codeGuardExpiry
  //  failClaimedResume        nothing                                   and return ITS
  //     │                                                               outcome — never a
  //  ┌──┴────┬──────────┐                                               second write
  // ok       rejected   timeout
  // publish  publish    publish
  // `failed` unknown/   unknown/
  // (defin.) persist-   persist-
  //          failed     timeout
  //
  // WHY THE LATCH IS SYNCHRONOUS, and why the race alone is not enough.
  // `codeGuardExpiry` resolves only when its terminalizing WRITE finishes, so
  // between the callback firing and that write landing there is a window in
  // which the expiry promise is still pending. A guard read returning inside
  // that window WINS `Promise.race` — and if the guard then continued it
  // would refuse on its own, or hand over and START THE GUEST PROGRAM, which
  // can dispatch the approved call, while the expiry publishes "the pending
  // call did not run" for the same row. The latch is taken as the callback's
  // FIRST statement, before any await, and JS is single-threaded, so no
  // continuation scheduled after the callback began can observe it free.
  //
  // WHERE IT IS ENFORCED: inside `raceGuard`, the one function every guard
  // read already goes through — when the read wins the race, the latch is
  // consulted and a set latch converts the win into the expiry's outcome. So
  // "no guard step runs after an expiry fired" is a property of the shape,
  // not of each call site remembering to ask. `terminalizeCodeGuard` and the
  // handover re-check take the latch for the same reason, in the other
  // direction: a guard that got there first must make a later-firing timer a
  // no-op. The three overlap deliberately — each closes the paths the others
  // reach first, and the row has exactly one writer on every interleaving.
  //
  // The CLASSIFICATION here is the dispatch-cell rule, not a second rule: the
  // §5.4 read-side guard runs before any invoker is built, so nothing can have
  // dispatched while it runs. A guard exit is therefore a definite "did not
  // run" — never ambiguous — and the write's own fate decides only whether
  // that definite failure is DURABLE.
  //
  // THE LATE-CREATE RECONCILIATION (startDirect). When the timer fires while
  // `create()` is in flight and `create()` then succeeds, the latch is ALREADY
  // spent: the expiry published the outcome against a row that did not yet
  // exist. The re-issued fenced settle is therefore reconciliation only — it
  // changes no client-visible answer — but it goes through the ONE bounded
  // fenced path all the same, because a stall there left `finished` pending
  // and the new row `running` forever. `finished` tracks the WRITE, not the
  // bounded result that may give up on it, and a reconciliation that does not
  // land is logged host-side under a reference rather than swallowed.
  //
  // THE STORE-CALL SHAPE, underneath all of the above. Every store call on a
  // path a client waits on goes through `storeCall` (or the helpers built on
  // it: `failClaimedBounded`, `terminalizeCodeRow`, `boundedFencedSettle`).
  // It answers three questions once instead of at every call site: a store
  // method may THROW synchronously rather than reject, an await with no budget
  // never returns when the store stalls, and the loser of a budget race can
  // reject with nobody watching. Two awaits are deliberately outside it — the
  // two FIRST mutations, each carrying its own comment — because bounding them
  // needs attempt-fenced late-completion recovery for code rows.
  //
  // A THROW is an exit path too, and the one that kept being missed.
  // `runDirect` asserts it never throws, but an assertion is not an
  // enforcement, so both call sites treat a rejection as a real exit that must
  // settle: `startDirect`'s backstop, and the resume path's handler, which
  // logs the cause under a reference and settles through the latch —
  // classifying by the DISPATCH CELL exactly as `classifyDirectFailure` and
  // `expireDirect` do, and falling back to `unknown` if even that write
  // cannot be started. Below them, `boundedFencedSettle` catches a
  // SYNCHRONOUS throw from `settleDirect`, so no settle path anywhere can
  // turn a faulting store into an unresolved outcome.
  // ─────────────────────────────────────────────────────────────────────────

  const budgets: DirectBudgets = { ...DIRECT_DEFAULTS, ...deps.direct };

  interface DirectRun {
    execution: Extract<Execution, { kind: "direct" }>;
    drive: OwnedDirectDrive;
    scope: () => Promise<EffectiveScope>;
    decisions?: ApprovalDecisions;
    /** resumed path: redact before measuring; sync path: raw. */
    redactFields?: readonly string[];
    resolveOutcome: (o: DirectOutcome) => void;
    /** Settle writes still in flight. */
    tracked: Promise<unknown>[];
    /** True once create() (startDirect) or the claim (resume) put the row in place. */
    persisted: boolean;
  }

  /**
   * THE post-claim store call. Every store call this manager makes on a path
   * a client is waiting on — after `claimForResume` has flipped the row, and
   * everywhere in the direct arm — goes through here rather than being
   * awaited raw.
   *
   * It exists because the alternative is a judgement call at every call site
   * about whether THAT store method can throw synchronously, whether THAT
   * await needs a budget, and whether THAT loser can reject unobserved. Those
   * three questions have the same answer everywhere on these paths, so they
   * are answered once, here, and a call site that forgets to ask them is a
   * shape the code no longer has.
   *
   * `budgetMs` defaults to the settle-write budget because every caller of
   * this helper is issuing or racing a write a client is waiting on.
   */
  function storeCall<T>(
    invoke: () => Promise<T>,
    budgetMs: number = budgets.settleWriteBudgetMs,
  ): { result: Promise<StoreCallResult<T>>; call: Promise<StoreCallResult<T>> } {
    return boundedStoreCall(invoke, budgetMs);
  }

  /**
   * Best-effort terminalization of a row THIS resume claimed, bounded and
   * safe against a synchronous throw. Used where the stored kind cannot route
   * a fenced settle — a `kindOf` that did not answer, and the code-row exits.
   * Returns how the write ended so the caller can decide whether it may claim
   * a terminal outcome or must answer `unknown`.
   */
  async function failClaimedBounded(
    executionId: string,
    reason: string,
    ref: string,
    errorName?: string,
  ): Promise<StoreCallResult<void>> {
    const { result } = storeCall(() =>
      errorName === undefined
        ? deps.store.executions.failClaimedResume(executionId, reason)
        : deps.store.executions.failClaimedResume(executionId, reason, errorName),
    );
    const ended = await result;
    if (ended.kind === "rejected") {
      // The store is genuinely faulting; nothing more can persist. The cause
      // still reaches the host log, under the SAME reference the stored
      // reason carries, so an operator can join the two.
      console.error(
        `[ExecutionManager] failClaimedResume also failed ${ref}: ${formatCause(ended.cause)}`,
      );
    }
    return ended;
  }

  /**
   * A CODE row's guard-phase terminalization, classified once.
   *
   * The dispatch-cell rule (D-A4) decides this exactly as it decides every
   * other direct failure — and on this path the cell's answer is structural
   * rather than read: the §5.4 read-side guard runs BEFORE any invoker is
   * built, so nothing can have dispatched while it runs. A guard exit is
   * therefore a definite "did not run", never ambiguous.
   *
   * What the write's own fate decides is whether that definite failure is
   * DURABLE. A written row may be published as `failed`. A write that
   * rejected or timed out means the row may still read `running`, which is
   * what `unknown` exists to say — the same rule `settleBounded` applies to
   * the direct arm's fenced settle.
   */
  async function terminalizeCodeRow(
    executionId: string,
    reason: string,
    error: ExecutionError,
    errorName?: string,
    flag: { corruptPause?: true } = {},
  ): Promise<ResumeOutcome> {
    const ref = crypto.randomUUID();
    const ended = await failClaimedBounded(executionId, reason, ref, errorName);
    if (ended.kind === "ok") {
      return { status: "failed", executionId, error, decisionApplied: false, ...flag };
    }
    return {
      status: "unknown",
      executionId,
      reason: ended.kind === "timeout" ? "persist-timeout" : "persist-failed",
      decisionApplied: false,
    };
  }

  /**
   * Bounded settle (both direct paths — D-A11): the intended outcome is
   * published ONLY when the fenced write returned true. `false` means the
   * fence lost — on a persisted row the latch guarantees ONE caller per
   * drive, so a 0-row result means the row is not `running` under this
   * attempt, an inconsistency reported honestly as `unknown`. A rejected
   * write is "persist-failed"; a write still pending after the settle-write
   * budget is "persist-timeout". Both mean "the effect may have landed and
   * the row may not yet say so" — never a claimed terminal.
   */
  async function settleBounded(
    run: DirectRun,
    settle: DirectSettle,
    outcome: DirectOutcome,
  ): Promise<void> {
    if (!run.persisted) {
      // No row exists yet (the timer beat create()). There is nothing to
      // write and nothing that could have dispatched; publish the
      // pre-dispatch outcome directly.
      run.resolveOutcome(outcome);
      return;
    }
    const { result, write } = boundedFencedSettle(
      deps.store,
      run.execution.id,
      run.drive.attempt,
      settle,
      budgets.settleWriteBudgetMs,
    );
    run.tracked.push(write);
    switch (await result) {
      case "written":
        run.resolveOutcome(outcome);
        return;
      case "fenced":
      case "failed":
        run.resolveOutcome({
          status: "unknown",
          executionId: run.execution.id,
          reason: "persist-failed",
        });
        return;
      case "timeout":
        run.resolveOutcome({
          status: "unknown",
          executionId: run.execution.id,
          reason: "persist-timeout",
        });
        return;
    }
  }

  /**
   * D-A4: classify a direct failure by the CELL, not by elapsed time. Once the
   * governed body write was attempted the upstream effect is unknowable, so a
   * failure after `dispatched` is ambiguous — never "did not run".
   */
  function classifyDirectFailure(run: DirectRun, cause: unknown): ExecutionError {
    if (
      run.drive.dispatch.state === "dispatched" ||
      (cause instanceof Error && cause.name === OUTCOME_AMBIGUOUS_ERROR_NAME)
    ) {
      return {
        name: OUTCOME_AMBIGUOUS_ERROR_NAME,
        message: `[ExecutionManager] Direct call failed after dispatch; the upstream may have performed the call. Context: { executionId: ${run.execution.id} }`,
      };
    }
    return toSandboxError(cause);
  }

  /** The timer's settle handler (D-A13): installed via createDirectDrive's onExpire. */
  function expireDirect(run: DirectRun): void {
    const { execution, drive } = run;
    if (!drive.settle()) return;
    const error: ExecutionError =
      drive.dispatch.state === "dispatched"
        ? classifyDirectFailure(run, new Error("budget elapsed after dispatch"))
        : {
            name: "ConduitExecutionInterrupted",
            message: `[ExecutionManager] Direct drive budget elapsed before dispatch (${budgets.driveBudgetMs}ms). Context: { executionId: ${execution.id} }`,
          };
    void settleBounded(
      run,
      { status: "failed", error },
      { status: "failed", executionId: execution.id, error },
    );
  }

  /**
   * The ONE continuation. Never throws. The timer already runs (armed in
   * `createDirectDrive`), so every path below races it through the latch.
   */
  async function runDirect(run: DirectRun): Promise<void> {
    const { execution, drive } = run;
    // Parse ONCE, before the try. The stored `request` is only guaranteed to
    // be a STRING by hydration; a corrupt row can hold bytes that are not
    // JSON. Parsing it lazily at the two use sites put one of them INSIDE the
    // catch that handles the pause arm, where a throw escapes `runDirect`
    // entirely — and on the resume path nothing downstream could settle the
    // outcome. A corrupt row is a terminal failure of the row, decided here
    // before any drive work begins, so neither use site can throw.
    let request: unknown;
    try {
      request = JSON.parse(execution.call.request);
    } catch {
      if (!drive.settle()) return;
      // No stored bytes and no parse position in the message: the row is
      // handed back to the agent by `check_execution`.
      const error: ExecutionError = {
        name: "ConduitInternalError",
        message: `[ExecutionManager] Stored direct_call request is not valid JSON (corrupt state); the call did not run. Context: { executionId: ${execution.id} }`,
      };
      await settleBounded(
        run,
        { status: "failed", error },
        { status: "failed", executionId: execution.id, error },
      );
      return;
    }
    let upstreamSession: UpstreamSessionScope | undefined;
    try {
      // Prep-window throws: the STORED error carries the cause, the
      // CLIENT-VISIBLE outcome does not — exactly as `start()` does today.
      let invoke: ToolInvoker;
      try {
        upstreamSession = makeUpstreamSession();
        invoke = deps.makeInvoker({
          executionId: execution.id,
          deadline: drive.deadline,
          upstreamSession,
          projection: execution.projection,
          clientId: execution.clientId,
          scope: run.scope,
          dispatch: drive.dispatch,
          ...(run.decisions !== undefined ? { decisions: run.decisions } : {}),
        });
      } catch (cause) {
        if (!drive.settle()) return;
        // The STORED reason is opaque too. A prep-window fault here can
        // carry host-only detail (a database path, an upstream body) and the
        // stored row is handed back to the agent by `check_execution`. The
        // cause goes to the daemon log under a fresh reference; only the
        // reference is persisted — the same pattern the resume prep-window
        // catch uses.
        const ref = crypto.randomUUID();
        console.error(
          `[ExecutionManager] direct drive preparation failed ${ref}: ${formatCause(cause)}`,
        );
        const error: ExecutionError = {
          name: "ConduitInternalError",
          message: `[ExecutionManager] Direct drive preparation failed. Reference: ${ref}`,
        };
        await settleBounded(
          run,
          { status: "failed", error },
          { status: "failed", executionId: execution.id, error },
        );
        return;
      }

      const value = await invoke(execution.call.toolName, request);
      // §4.1: `discarded` is decided AT SETTLE against the DELIVERABLE — on
      // the resume path that is the REDACTED value, and redaction can EXPAND
      // it. Pure computation, so it may run before the latch.
      const deliverable =
        run.redactFields === undefined ? value : redactSensitiveFields(value, run.redactFields);
      // MEASURED BEFORE THE LATCH, and the number reused below. `JSON.stringify`
      // THROWS for a `BigInt`, a circular value, or a throwing `toJSON` — and a
      // custom invoker can return any of them. Measured after the latch, that
      // throw landed in the catch below, whose own `drive.settle()` then failed
      // and returned without publishing anything, so `outcome` never resolved
      // and the caller waited forever.
      //
      // `deliverable` is the value that is actually STORED — redacted on the
      // resume path, raw on the sync path — so this measures the right bytes
      // (§4.1), exactly as the post-latch call did.
      let deliverableSize: number | undefined;
      try {
        deliverableSize = deliverableBytes(deliverable);
      } catch {
        deliverableSize = undefined;
      }
      if (deliverableSize === undefined) {
        if (!drive.settle()) return;
        // The call DID run: the cell decides, exactly as `classifyDirectFailure`
        // does everywhere else. A result we cannot serialize is not "did not
        // run" — the upstream already performed the call. Nothing of the value
        // is stored, so no partial body can reach the row.
        const error: ExecutionError = classifyDirectFailure(
          run,
          new Error(
            `[ExecutionManager] Direct call result could not be serialized. Context: { executionId: ${execution.id} }`,
          ),
        );
        await settleBounded(
          run,
          { status: "failed", error },
          { status: "failed", executionId: execution.id, error },
        );
        return;
      }
      if (!drive.settle()) return;
      if (deliverableSize > budgets.resultBytesMax) {
        await settleBounded(
          run,
          { status: "completed", resultState: "discarded" },
          {
            status: "completed",
            executionId: execution.id,
            value: undefined,
            resultTooLarge: true,
          },
        );
      } else if (run.redactFields === undefined) {
        await settleBounded(
          run,
          { status: "completed", resultState: "delivered" },
          { status: "completed", executionId: execution.id, value: deliverable },
        );
      } else {
        await settleBounded(
          run,
          { status: "completed", resultState: "retained", result: deliverable },
          { status: "completed", executionId: execution.id, value: deliverable },
        );
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === GUEST_ERROR_NAMES.policyDenied) {
        if (run.decisions === undefined) {
          // §5.4 startDirect step 5: pause. The generation read is UNBOUNDED,
          // so it runs BEFORE the latch — the timer can still
          // settle the row while it stalls — and immediately before the
          // write, as the spec requires.
          const namespace = execution.call.namespace;
          let generation: number | undefined;
          try {
            generation = await deps.store.sources.getGeneration(namespace);
          } catch (readCause) {
            // A REJECTED read is a store fault, not a catalog change. Opaque
            // to the client; the cause goes to the host log only.
            if (!drive.settle()) return;
            const ref = crypto.randomUUID();
            console.error(
              `[ExecutionManager] Provenance read failed at direct pause ${ref}: ${formatCause(readCause)}`,
            );
            const error: ExecutionError = {
              name: "ConduitInternalError",
              message: `[ExecutionManager] Approval pause could not be recorded. Reference: ${ref}`,
            };
            await settleBounded(
              run,
              { status: "failed", error },
              { status: "failed", executionId: execution.id, error },
            );
            return;
          }
          if (!drive.settle()) return;
          if (generation === undefined) {
            const error: ExecutionError = {
              name: "ConduitCatalogChanged",
              message: `[ExecutionManager] Approval pause refused: no source for namespace. Context: { executionId: ${execution.id} }`,
            };
            await settleBounded(
              run,
              { status: "failed", error },
              { status: "failed", executionId: execution.id, error },
            );
            return;
          }
          const pending: PendingApproval = {
            callId: newId(),
            toolName: execution.call.toolName,
            namespace,
            sourceGeneration: generation,
            input: request,
            reason: cause.message,
            expiresAt: now() + resolveApprovalTtlMs(),
          };
          await settleBounded(
            run,
            { status: "paused", pausedOn: pending },
            { status: "paused", executionId: execution.id, pending },
          );
          return;
        }
      }
      if (!drive.settle()) return;
      const error = classifyDirectFailure(run, cause);
      await settleBounded(
        run,
        { status: "failed", error },
        { status: "failed", executionId: execution.id, error },
      );
    } finally {
      run.drive.dispose();
      if (upstreamSession !== undefined) {
        try {
          await upstreamSession.dispose();
        } catch (cause) {
          console.error(
            `[ExecutionManager] upstream session scope dispose failed after a direct drive. Context: { executionId: ${execution.id}, cause: ${formatCause(cause)} }`,
          );
        }
      }
      await Promise.allSettled(run.tracked);
    }
  }

  return {
    async start(code, opts) {
      const clientId = opts?.clientId ?? null;
      if (clientId !== null && opts?.scope === undefined) {
        // D11: a NAMED client without a resolver has no authority
        // to run under — the unscoped path is the DEFAULT profile's alone.
        // Refused BEFORE `create`, so no row is written.
        throw new Error(
          `[ExecutionManager] start refused: a named client requires a scope resolver. Context: { clientId: ${JSON.stringify(clientId)} }`,
        );
      }
      const scope = bindScope(opts?.scope, clientId);
      const execution: Extract<Execution, { kind: "code" }> = {
        id: `exec_${newId()}`,
        kind: "code",
        code,
        status: "running",
        seeds: generateSeeds(),
        startedAt: now(),
        clientId,
        projection: "code",
        ...(opts?.requestKey !== undefined ? { requestKey: opts.requestKey } : {}),
      };
      try {
        // Unbounded by decision: bounding the FIRST mutation needs
        // attempt-fenced late-completion recovery for code rows.
        await deps.store.executions.create(execution);
      } catch (cause) {
        // requestKey is persisted BEFORE the sandbox runs, so a
        // duplicate key is caught here as a UNIQUE constraint violation —
        // never a second execution. D-A12: the ONE conflict mapper, shared
        // with startDirect; no inline copy of either marker string here.
        const conflict = await mapCreateConflict(cause, opts?.requestKey, clientId, deps.store);
        if (conflict !== undefined) {
          return conflict;
        }
        throw cause;
      }
      // The row is now `running` (persisted above). EVERYTHING from here until
      // `drive` takes over must terminalize the row on a throw, or it strands
      // `running` forever (§6 state machine: running must reach a terminal).
      // `makeUpstreamSession()` — or the `randomBytes` inside the default scope
      // factory — can throw; it must be INSIDE this guard, not before it.
      let upstreamSession: UpstreamSessionScope;
      try {
        upstreamSession = makeUpstreamSession();
      } catch (cause) {
        // Sibling of drive()'s catch: finalize the just-persisted `running` row
        // to terminal `failed` BEFORE re-throwing, so it is never stranded.
        // OPAQUE: the injected scope factory's fault can carry host-only
        // detail, and the row is agent-readable through `check_execution`.
        const ref = crypto.randomUUID();
        console.error(
          `[ExecutionManager] upstream session scope creation failed at start() ${ref}: ${formatCause(cause)}`,
        );
        await finish(execution, {
          status: "failed",
          error: {
            name: "ConduitInternalError",
            message: `[ExecutionManager] Upstream session scope creation failed at start(). Context: { executionId: ${execution.id} } Reference: ${ref}`,
          },
        });
        throw cause;
      }
      try {
        // `deadlineFor()` and the injected `makeInvoker` are ALSO inside the
        // terminalize-on-throw window: a synchronous throw from either (an
        // injected invoker doing sync work, a bad limits value) must finalize
        // the just-persisted `running` row, not strand it (§6). The default
        // createToolInvoker does no sync-throwing work, so this is defensive —
        // but the module's asserted invariant must hold for any injected dep.
        let invoke: ToolInvoker;
        try {
          invoke = deps.makeInvoker({
            executionId: execution.id,
            deadline: deadlineFor(opts?.limits),
            upstreamSession,
            projection: "code",
            clientId,
            // exactOptionalPropertyTypes forbids `scope: undefined`; absent
            // must stay absent so the invoker takes the unscoped path (D-A3).
            ...(scope !== undefined ? { scope } : {}),
          });
        } catch (cause) {
          // OPAQUE, same reason as the scope-creation fault above.
          const ref = crypto.randomUUID();
          console.error(
            `[ExecutionManager] invoker creation failed at start() ${ref}: ${formatCause(cause)}`,
          );
          await finish(execution, {
            status: "failed",
            error: {
              name: "ConduitInternalError",
              message: `[ExecutionManager] Invoker creation failed at start(). Context: { executionId: ${execution.id} } Reference: ${ref}`,
            },
          });
          throw cause;
        }
        return await drive(
          execution,
          invoke,
          [],
          undefined,
          opts?.limits,
          scope !== undefined ? { scope, projection: "code" } : undefined,
        );
      } finally {
        try {
          await upstreamSession.dispose();
        } catch (cause) {
          // Best-effort: a throwing dispose never changes the drive's own
          // outcome (upstream-session.ts's own dispose never throws, but a
          // custom injected scope might). Route to the same diagnostics sink
          // the invoker uses (console.error) rather than rethrow.
          console.error(
            `[ExecutionManager] upstream session scope dispose failed after start(). Context: { executionId: ${execution.id}, cause: ${formatCause(cause)} }`,
          );
        }
      }
    },

    startDirect(toolName, input, opts) {
      const executionId = `exec_${newId()}`;
      const attempt = newId();
      let resolveOutcome!: (o: DirectOutcome) => void;
      const outcome = new Promise<DirectOutcome>((r) => {
        resolveOutcome = r;
      });
      let markSettled!: () => void;
      const settledAt = new Promise<void>((r) => {
        markSettled = r;
      });
      // `JSON.stringify` has TWO failure modes for a non-JSON input, and only
      // one of them returns `undefined`. A cyclic value, a `BigInt`, and a
      // throwing `toJSON` all THROW synchronously — before the handle's three
      // promises exist, so the caller would get no bounded outcome and no
      // execution record at all. Collapse the throw into the same `undefined`
      // the other non-JSON inputs produce, and let the one refusal branch
      // below answer through the normal handle.
      let request: string | undefined;
      try {
        request = JSON.stringify(input);
      } catch {
        request = undefined;
      }
      const execution: Extract<Execution, { kind: "direct" }> = {
        id: executionId,
        kind: "direct",
        status: "running",
        startedAt: now(),
        clientId: opts.clientId,
        projection: opts.projection,
        call: {
          toolName,
          namespace: namespaceOf(toolName) ?? "",
          request: request ?? "null",
        },
        ...(opts.requestKey !== undefined ? { requestKey: opts.requestKey } : {}),
      };
      // D-A13: the run object exists before the drive so `expireDirect` can
      // settle it; the drive arms its timer at construction — before create()
      // — so a hung first write still yields the timeout outcome in budget.
      const run: DirectRun = {
        execution,
        // Assigned on the very next statement; no await intervenes, so no
        // code can observe the placeholder.
        drive: undefined as unknown as OwnedDirectDrive,
        scope: () => opts.scope(opts.clientId),
        resolveOutcome: (o) => {
          resolveOutcome(o);
          markSettled();
        },
        tracked: [],
        persisted: false,
      };
      run.drive = createDirectDrive({
        executionId,
        attempt,
        now,
        budgetMs: budgets.driveBudgetMs,
        onExpire: () => expireDirect(run),
      });
      const finished = (async () => {
        if (request === undefined) {
          // The decoder guarantees a JSON value; defend the public SDK
          // entrypoint against a non-serializable input anyway.
          if (run.drive.settle()) {
            run.resolveOutcome({
              status: "failed",
              executionId,
              error: {
                name: "ConduitInternalError",
                message: "[ExecutionManager] startDirect refused: input is not a JSON value.",
              },
            });
          }
          return;
        }
        try {
          await deps.store.executions.create(execution, { attempt });
          run.persisted = true;
        } catch (cause) {
          // The conflict lookup is an UNBOUNDED read — do it BEFORE taking
          // the latch so the timer can still answer if it stalls; then
          // publish only if we won. `opts.clientId` is the CALLER'S OWN
          // client id, never null for a named client: that is what keeps
          // client A's key collision from returning client B's execution id.
          const conflict = await mapCreateConflict(
            cause,
            opts.requestKey,
            opts.clientId,
            deps.store,
          ).catch((c: unknown) => {
            // A failed lookup is not a conflict; the generic persist failure
            // below is the honest answer. The cause is not silently lost.
            console.error(
              `[ExecutionManager] conflict lookup failed for ${executionId}: ${formatCause(c)}`,
            );
            return undefined;
          });
          if (!run.drive.settle()) return;
          run.resolveOutcome(
            conflict ?? {
              status: "failed",
              executionId,
              error: {
                name: "ConduitInternalError",
                message: `[ExecutionManager] startDirect could not persist the row. Context: { executionId: ${executionId} }`,
              },
            },
          );
          return;
        }
        if (run.drive.settled) {
          // The timer fired while create() was in flight and its fenced
          // settle hit 0 rows. The row now exists `running`; re-issue the
          // SAME timeout settle (fenced on this attempt) so it cannot linger
          // for the crash sweep to relabel, and never run the pipeline on a
          // drive that already answered.
          const error: ExecutionError = {
            name: "ConduitExecutionInterrupted",
            message: `[ExecutionManager] Direct drive budget elapsed before dispatch (${budgets.driveBudgetMs}ms). Context: { executionId: ${executionId} }`,
          };
          // Through the ONE bounded fenced path, not a raw `settleDirect`.
          // The latch is already spent — the expiry published the outcome —
          // so this write changes no client-visible answer; what it must not
          // do is STALL, which left `finished` pending and the new row
          // `running` forever, nor swallow its own failure, which left an
          // unreconciled row with nothing in the log to find it by.
          const { result, write } = boundedFencedSettle(
            deps.store,
            executionId,
            attempt,
            { status: "failed", error },
            budgets.settleWriteBudgetMs,
          );
          // `finished` means the tracked write has actually stopped, so keep
          // tracking the WRITE, not the bounded result that may give up on it.
          run.tracked.push(write);
          const reconciled = await result;
          if (reconciled !== "written") {
            // Host-side only, under a reference: the row may still read
            // `running` and an operator needs a handle on it. The reference
            // names no stored detail and reaches no agent-readable surface.
            console.error(
              `[ExecutionManager] direct timeout reconciliation did not land ${crypto.randomUUID()}: executionId ${executionId}, result ${reconciled}`,
            );
          }
          await Promise.allSettled(run.tracked);
          return;
        }
        await runDirect(run);
      })()
        .catch(() => {})
        .finally(() => {
          run.drive.dispose();
          // DEFENCE-IN-DEPTH. Every branch above is written to settle through
          // the latch, but "no path reaches here" is an unprovable claim about
          // future code, so this converts a branch that forgets to settle from
          // an un-resolvable `outcome` (a caller awaiting forever) into an
          // honest non-answer. It carries no invariant of its own; a real path
          // that lands here needs its own settle, not this.
          // Taking the latch also stops the timer's handler from publishing a
          // second, contradictory outcome.
          if (run.drive.settle()) {
            run.resolveOutcome({
              status: "unknown",
              executionId,
              reason: "persist-failed",
            });
          }
        });
      let retentionTimer: NodeJS.Timeout | undefined;
      const retention = Promise.race<"released" | "abandoned">([
        finished.then(() => "released" as const),
        settledAt.then(
          () =>
            new Promise<"abandoned">((r) => {
              retentionTimer = setTimeout(() => r("abandoned"), budgets.slotRetentionMs);
              retentionTimer.unref?.();
            }),
        ),
      ]);
      void finished.then(() => clearTimeout(retentionTimer));
      return { executionId, outcome, retention, finished };
    },

    async resume(executionId, decision, callId, scopeResolver) {
      // The argument must be a call id an operator could have read off the
      // list: text, not ASCII-blank. The wire decoder (mcp rpc.ts) refuses
      // anything else, but this is a public SDK entrypoint — an embedder
      // passing a bound NUMBER could equal a stored numeric callId in the
      // claim's SQL and then pass the strict-equality check below, driving
      // a call no human named. Refuse BEFORE the claim, so no row is
      // touched. The blank set is `NOT_NAMEABLE_CALL_ID` (types.ts), the
      // one the store's claim and the wire decoder mirror.
      if (typeof callId !== "string" || NOT_NAMEABLE_CALL_ID.test(callId)) {
        throw new Error(
          `[ExecutionManager] Resume refused: callId must be a non-blank string. Context: { executionId: ${executionId} }`,
        );
      }
      // FIRST: atomic paused→running claim (design F4), bound to the ONE
      // pending call the decision is for. Lose → conflict no-op — including
      // when the execution is paused again on a LATER call than the one
      // this decision names.
      const resumeAttemptId = newId();
      // Unbounded by decision: bounding the FIRST mutation needs
      // attempt-fenced late-completion recovery for code rows.
      const won = await deps.store.executions.claimForResume(executionId, resumeAttemptId, callId);
      if (!won) {
        return { status: "conflict", executionId, decisionApplied: false };
      }

      // §5.3: a DIRECT row's settle write is fenced and bounded on EVERY
      // path, the guard's terminalizations included — `failClaimedResume` is
      // neither. Read the stored kind with no hydration (`kindOf`), because a
      // corrupt direct row must still route through the bounded fenced settle
      // even when `get` cannot answer for it.
      //
      // The drive is created HERE, before the guard runs, so its timer
      // (D-A13) covers the guard phase too: a guard read that never returns
      // still settles the claimed row within the drive budget rather than
      // stranding it `running`.
      // I4: BOUNDED. This read runs after the claim already flipped the row to
      // `running` and before any drive exists — so it is the one post-claim
      // read no timer covers. A store that never answers here stranded the row
      // `running` forever and hung `resume()` past every budget. Bound it by
      // the same drive budget the guard phase gets; on timeout the stored kind
      // is unknown, so the settle cannot be routed: best-effort terminalize the
      // claimed row and report the honest non-answer.
      const kindEnded = await storeCall(
        () => deps.store.executions.kindOf(executionId),
        budgets.driveBudgetMs,
      ).result;
      // A REJECTED lookup is not a timeout: the store answered, it just could
      // not say. `undefined` routes the settle the same way an absent kind
      // does — through the code-row arm, which is the conservative choice.
      const kind = kindEnded.kind === "ok" ? kindEnded.value : undefined;
      if (kindEnded.kind === "timeout") {
        // The reason is OPAQUE: a store rejection here carries host-only
        // detail (a database path) into a row `check_execution` hands back to
        // the agent. The cause goes to the daemon log under a fresh reference.
        const ref = crypto.randomUUID();
        console.error(
          `[ExecutionManager] resume kind lookup timed out ${ref}: executionId ${executionId}`,
        );
        // This branch fires precisely because the store did not answer, so
        // its own fallback write cannot be assumed to either. Best-effort:
        // the outcome below stands whatever the write did.
        await failClaimedBounded(
          executionId,
          `resume kind lookup timed out. Reference: ${ref}`,
          ref,
        );
        return {
          status: "unknown",
          executionId,
          reason: "persist-timeout",
          decisionApplied: false,
        };
      }
      /**
       * GUARD-PHASE EXPIRY. Every §5.4 guard read below — `executions.get`,
       * `claimCallId`, `tools.get`, `sources.getGeneration`, `policies.get`,
       * `checkScope()` — is UNBOUNDED. If one never returns, the claimed row
       * would stay `running` forever and `resume()` would never settle.
       *
       * So the drive's `onExpire` is wired AT CONSTRUCTION, not after the
       * guard (which was the bug: the timer fired into an unassigned handler
       * and did nothing). It takes the SAME latch the drive's own settle
       * takes, so the guard and the timer race exactly once, and issues the
       * bounded fenced settle. The resume path observes it through
       * `guardExpiry`, which every guard-phase await races against.
       */
      let resolveGuardExpiry!: (o: ResumeOutcome) => void;
      const guardExpiry = new Promise<ResumeOutcome>((r) => {
        resolveGuardExpiry = r;
      });
      const directDrive: OwnedDirectDrive | undefined =
        kind === "direct"
          ? createDirectDrive({
              executionId,
              attempt: resumeAttemptId,
              now,
              budgetMs: budgets.driveBudgetMs,
              onExpire: () => {
                // The latch: if the guard already decided, it owns the settle.
                if (!directDrive?.settle()) return;
                // Resolve the drive's lifecycle promises and clear its timer
                // on THIS path too, so the expiry exit looks like every other
                // exit rather than leaving `finished`/`settledAt` pending and
                // the drive undisposed.
                directDrive.settleEarly();
                const error: ExecutionError = {
                  name: "ConduitExecutionInterrupted",
                  message: `[ExecutionManager] Direct resume budget elapsed during the read-side guard (${budgets.driveBudgetMs}ms); the pending call did not run. Context: { executionId: ${executionId} }`,
                };
                void settleDirectBounded({ status: "failed", error }, error, directDrive).then(
                  resolveGuardExpiry,
                  () =>
                    resolveGuardExpiry({
                      status: "unknown",
                      executionId,
                      reason: "persist-failed",
                      decisionApplied: false,
                    }),
                );
              },
            })
          : undefined;

      /**
       * CODE-ROW GUARD EXPIRY. A code row has no drive and therefore no
       * timer, so every guard read below used to be unbounded for it: one
       * read that never returned stranded the claimed row `running` and hung
       * `resume()` past every budget — the same hang the direct arm's drive
       * timer closes. Bound the code row's guard phase by the SAME drive
       * budget.
       *
       * Its classification is the dispatch-cell rule, not a new one: the
       * guard runs before any invoker exists, so nothing can have dispatched
       * while it runs. The expiry is therefore a definite "did not run", and
       * `terminalizeCodeRow` decides only whether that failure is durable.
       */
      let codeGuardTimer: NodeJS.Timeout | undefined;
      /**
       * THE code row's latch. A direct row has `directDrive.settle()`; a code
       * row has no drive, so this is its equivalent — and it must be taken
       * SYNCHRONOUSLY, before any await, by whichever of the two writers gets
       * there first. The expiry promise resolves only when its write
       * FINISHES, so a flag that waited for the promise would leave the whole
       * write in flight as a window in which a returning guard read still
       * looked live.
       */
      let codeGuardLatched = false;
      /** Take it, or report that someone else holds it. Never blocks. */
      const takeCodeGuardLatch = (): boolean => {
        if (codeGuardLatched) return false;
        codeGuardLatched = true;
        return true;
      };
      const codeGuardExpiry =
        directDrive === undefined
          ? new Promise<ResumeOutcome>((resolve) => {
              codeGuardTimer = setTimeout(() => {
                // FIRST STATEMENT, before any await or write. JS is
                // single-threaded, so from here no guard continuation can be
                // scheduled that does not observe the latch as taken.
                if (!takeCodeGuardLatch()) return;
                const error: ExecutionError = {
                  name: "ConduitExecutionInterrupted",
                  message: `[ExecutionManager] Resume budget elapsed during the read-side guard (${budgets.driveBudgetMs}ms); the pending call did not run. Context: { executionId: ${executionId} }`,
                };
                void terminalizeCodeRow(
                  executionId,
                  "resume budget elapsed during the read-side guard; the pending call did not run",
                  error,
                  "ConduitExecutionInterrupted",
                ).then(resolve, () =>
                  resolve({
                    status: "unknown",
                    executionId,
                    reason: "persist-failed",
                    decisionApplied: false,
                  }),
                );
              }, budgets.driveBudgetMs);
              codeGuardTimer.unref?.();
            })
          : undefined;

      /**
       * Every guard-phase await races the expiry, so a store read that never
       * returns still yields an answer within the drive budget. The DIRECT
       * path races its drive's timer; a CODE row races `codeGuardExpiry`,
       * which is the same bound without a drive behind it.
       *
       * The result is a DISCRIMINATED UNION rather than `T | ResumeOutcome`:
       * a guard read's own value could itself be object-shaped, so "is this
       * the expiry outcome?" must never be a shape test on the value.
       */
      type Guarded<T> = { expired: false; value: T } | { expired: true; outcome: ResumeOutcome };
      /**
       * The latch, for either kind. A direct row's is the drive's; a code
       * row's is `codeGuardLatched`. Both are set SYNCHRONOUSLY by whichever
       * writer got there first.
       */
      const expiryHasFired = (): boolean =>
        directDrive === undefined ? codeGuardLatched : directDrive.settled;

      /**
       * THE latch rule for the CODE row's guard, in ONE place — the twin of
       * `terminalizeDirect`: **take the latch, or defer to whoever holds it.**
       *
       * Every guard refusal for a code row goes through here. Taking the
       * latch first means a timer that fires while this write is in flight
       * finds it taken and writes nothing, so exactly one writer ever touches
       * the row; losing it means the expiry got there first, and this
       * publishes ITS outcome rather than issuing a second write and
       * reporting a contradictory answer.
       */
      async function terminalizeCodeGuard(
        reason: string,
        error: ExecutionError,
        errorName?: string,
        flag: { corruptPause?: true } = {},
      ): Promise<ResumeOutcome> {
        if (codeGuardExpiry !== undefined && !takeCodeGuardLatch()) {
          // The expiry handler holds the latch and is writing (or has
          // written). Publish ITS outcome; never write a second time.
          return await codeGuardExpiry;
        }
        // The guard owns the outcome now, so the timer has nothing left to
        // do; stopping it here keeps the window short rather than relying on
        // the latch alone.
        clearTimeout(codeGuardTimer);
        return await terminalizeCodeRow(executionId, reason, error, errorName, flag);
      }
      async function raceGuard<T>(work: Promise<T>): Promise<Guarded<T>> {
        const wrapped = work.then((value): Guarded<T> => ({ expired: false, value }));
        const expiry = directDrive === undefined ? codeGuardExpiry : guardExpiry;
        if (expiry === undefined) return await wrapped;
        const winner = await Promise.race([
          wrapped,
          expiry.then((outcome): Guarded<T> => ({ expired: true, outcome })),
        ]);
        if (winner.expired) return winner;
        // THE READ WON THE RACE — which is not the same as "the expiry did
        // not fire". The expiry promise resolves only when its terminalizing
        // WRITE completes, so a read returning while that write is in flight
        // still wins here. Continuing then would let the guard hand over and
        // START THE DRIVE — dispatching the approved call — while the expiry
        // publishes "the pending call did not run" for the same row, and two
        // writers would touch it.
        //
        // The LATCH is the authority, never the race: it is taken
        // synchronously in the expiry callback's first statement, so once
        // that callback has begun, no guard continuation scheduled after it
        // can observe the latch free. Checking it HERE — in the one function
        // every guard read already goes through — makes "no guard step runs
        // after an expiry fired" a property of the shape rather than of each
        // call site remembering to ask.
        if (expiryHasFired()) {
          return { expired: true, outcome: await expiry };
        }
        return winner;
      }

      /**
       * The UNLATCHED write. Only two callers may use it: the expiry handler
       * (which has already taken the latch) and `terminalizeDirect` below
       * (which takes it on the caller's behalf). Everything else goes through
       * `terminalizeDirect`.
       *
       * The direct row's guard terminalizations must NOT use
       * the unbounded, unfenced `failClaimedResume`. This writes the same
       * terminal state through the ONE bounded fenced settle, and reports
       * `unknown` rather than claiming a terminal the store may not have
       * accepted.
       */
      async function settleDirectBounded(
        settle: DirectSettle,
        error: ExecutionError,
        /**
         * M1 / D-A2: the drive whose `finished` must await this write. The
         * write is NOT cancelled when `result` times out — it may still land —
         * so `finished` ("the continuation and any tracked settle write have
         * actually stopped") only resolves once it does. Lane B holds an
         * admission slot on `finished`; resolving it over a live store write
         * would release that slot while the work is still running.
         */
        trackOn?: OwnedDirectDrive,
      ): Promise<ResumeOutcome> {
        const { result, write } = boundedFencedSettle(
          deps.store,
          executionId,
          resumeAttemptId,
          settle,
          budgets.settleWriteBudgetMs,
        );
        trackOn?.resolveFinished(write.then(() => undefined));
        const winner = await result;
        if (winner === "written") {
          return { status: "failed", executionId, error, decisionApplied: false };
        }
        return {
          status: "unknown",
          executionId,
          reason: winner === "timeout" ? "persist-timeout" : "persist-failed",
          decisionApplied: false,
        };
      }

      /**
       * THE latch rule for the resume path, in ONE place: **take the latch, or
       * defer to whoever holds it.**
       *
       * Arming `onExpire` made a previously-dead race live. The
       * budget can elapse just before a slow-but-returning guard read
       * resolves: the timer callback has then already taken the latch and
       * started its write, and a guard terminalization that wrote anyway
       * would issue a SECOND `settleDirect` for the same
       * `(executionId, resumeAttemptId)`. The SQL fence keeps the RECORD
       * correct — the loser matches 0 rows — but the loser would read that as
       * `fenced` and publish `unknown/persist-failed` even though the
       * expiry's write SUCCEEDED. That is exactly the false `persist-failed`
       * the `unknown` contract exists to avoid.
       *
       * So: every guard terminalization and the prep-window catch call this.
       * It also owns `settleEarly()`, so no caller can settle the row and
       * forget to stop the drive.
       */
      async function terminalizeDirect(
        drive: OwnedDirectDrive,
        settle: DirectSettle,
        error: ExecutionError,
      ): Promise<ResumeOutcome> {
        if (!drive.settle()) {
          // The expiry handler holds the latch and is writing (or has
          // written). Publish ITS outcome; never write a second time.
          return guardExpiry;
        }
        // D-A2: `settleEarly` (not `finishEarly`) — the row is decided,
        // so `settledAt` resolves and retention starts, but `finished` waits
        // on the settle write below, which is still live work.
        drive.settleEarly();
        return settleDirectBounded(settle, error, drive);
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
        const got = await raceGuard(deps.store.executions.get(executionId));
        if (got.expired) return got.outcome;
        execution = got.value;
        if (execution === undefined || execution.pausedOn === undefined) {
          // The claim flipped status to running but there is no pending call to
          // resume against — a corrupt state. Persist the terminal `failed`
          // BEFORE returning, so the row is never a stranded `running`.
          const error: ExecutionError = {
            name: "ConduitInternalError",
            message: `[ExecutionManager] Resumed execution has no pending approval. Context: { executionId: ${executionId} }`,
          };
          const reason = "resumed execution has no pending approval (corrupt state)";
          if (directDrive !== undefined) {
            const settled = await terminalizeDirect(
              directDrive,
              { status: "failed", error },
              error,
            );
            return { ...settled, corruptPause: true };
          }
          return await terminalizeCodeGuard(reason, error, undefined, {
            corruptPause: true,
          });
        }
        // The hydrator casts `paused_on` without validating it, and the
        // claim admits any CORRUPT pause on purpose — a stored value that
        // is not an object (the JSON literal `null`, a bare string), or
        // whose callId is absent, not text, or blank — so it can be
        // terminalized HERE rather than stranded `paused` forever. Check
        // the shape before touching a property: `null.callId` would throw
        // into the generic catch below and bury the reason. A well-formed
        // pause can only have been claimed with its own callId, so a
        // mismatch is corruption, never a race.
        // Decide on the identity THE CLAIM COMPARED (the SQL-extracted call
        // id), not only the hydrated one: SQLite's extractor and JSON.parse
        // can disagree on the same bytes (duplicate keys — first vs last),
        // and a claim the corrupt arm admitted must never look well-formed
        // here just because JSON.parse produced a matching string.
        const claimed = await raceGuard(deps.store.executions.claimCallId(executionId));
        if (claimed.expired) return claimed.outcome;
        const claimCallId = claimed.value;
        const stored: unknown = execution.pausedOn;
        if (claimCallId !== callId || !isPendingApproval(stored) || stored.callId !== callId) {
          const reason =
            "resumed execution's pending approval carries no call id an operator could name (corrupt state); the execution is now failed and the pending call did not run";
          const error: ExecutionError = {
            name: "ConduitInternalError",
            message: `[ExecutionManager] Resumed execution's pending approval carries no call id an operator could name (corrupt state); the execution is now failed and the pending call did not run. Context: { executionId: ${executionId} }`,
          };
          if (directDrive !== undefined) {
            const settled = await terminalizeDirect(
              directDrive,
              { status: "failed", error },
              error,
            );
            return { ...settled, corruptPause: true };
          }
          return await terminalizeCodeGuard(reason, error, undefined, {
            corruptPause: true,
          });
        }
        const pausedOn = stored;

        // TTL (design D8): lazily expire on resume. `claimForResume` already
        // flipped status to running, so persist the terminal `expired` state.
        if (now() > pausedOn.expiresAt) {
          if (directDrive !== undefined) {
            // §5.3: a direct row's terminal write is the fenced `settleDirect`
            // — the `expired` arm — never an unfenced `put`. Latch first: if
            // the budget already elapsed, the expiry owns the outcome.
            if (!directDrive.settle()) return guardExpiry;
            // M1 / D-A2: same split as `terminalizeDirect` — the row is
            // decided, but `finished` awaits this write, which is live work.
            directDrive.settleEarly();
            const { result, write } = boundedFencedSettle(
              deps.store,
              executionId,
              resumeAttemptId,
              { status: "expired" },
              budgets.settleWriteBudgetMs,
            );
            directDrive.resolveFinished(write.then(() => undefined));
            const winner = await result;
            if (winner === "written") {
              return { status: "expired", executionId, pending: pausedOn, decisionApplied: false };
            }
            return {
              status: "unknown",
              executionId,
              reason: winner === "timeout" ? "persist-timeout" : "persist-failed",
              decisionApplied: false,
            };
          }
          // Captured so the bounded closure below keeps the narrowing the
          // guard above established.
          const current: Execution = execution;
          const expired: Execution = { ...current, status: "expired", endedAt: now() };
          // A settled execution carries no pending approval — clear pausedOn so
          // the terminal row is not left with a stale pending call (same
          // discipline as finish()).
          delete expired.pausedOn;
          // BOUNDED: post-claim and client-visible. `persistOrFinalizeFailed`
          // handles a REJECTED write, but a write that never settles has no
          // rejection to handle — unbounded, a stalled store held `resume()`
          // open past every budget here, exactly as it did on the direct arm.
          const ended = await storeCall(() =>
            persistOrFinalizeFailed(current, () => deps.store.executions.put(expired)),
          ).result;
          if (ended.kind === "timeout") {
            // The write never settled, so the row may still read `running`:
            // `unknown` is exactly what that means. Only a TIMEOUT is
            // converted — a REJECTION keeps its shipped contract below, where
            // `persistOrFinalizeFailed` has already written the
            // ConduitPersistError fallback row and the original fault is the
            // caller's answer.
            return {
              status: "unknown",
              executionId,
              reason: "persist-timeout",
              decisionApplied: false,
            };
          }
          if (ended.kind === "rejected") {
            throw ended.cause;
          }
          return { status: "expired", executionId, pending: pausedOn, decisionApplied: false };
        }

        // ── §5.4 steps 2–4: the post-claim read-side guard ──────────────────
        // An approval granted against ONE catalog state, ONE call, and ONE
        // client's authority must never be spent against another. Order is
        // part of the requirement: the claim already won (so the row can
        // never strand `paused`), and every branch below terminalizes the
        // claimed row before any upstream call or credential resolution.
        const terminalize = async (
          reason: string,
          errorName: string,
          flag: { corruptPause?: true } = {},
        ): Promise<ResumeOutcome> => {
          const error: ExecutionError = {
            name: errorName,
            message: `[ExecutionManager] ${reason}. Context: { executionId: ${executionId} }`,
          };
          // A DIRECT row's terminalization is the bounded
          // fenced settle, never the unbounded unfenced `failClaimedResume`.
          if (directDrive !== undefined) {
            const settled = await terminalizeDirect(
              directDrive,
              { status: "failed", error },
              error,
            );
            return { ...settled, ...flag };
          }
          return await terminalizeCodeGuard(reason, error, errorName, flag);
        };
        const CORRUPT = { corruptPause: true as const };

        // Legacy branch (§5.4 step 3, rev 13): a pause written before R1 has
        // no provenance pair, so nothing can verify it. Fail it closed as a
        // re-approve BEFORE any source read — the checks below read
        // `pausedOn.namespace`, which the legacy arm does not have.
        if (!hasProvenance(pausedOn)) {
          return terminalize(
            "catalog changed — re-approve (pause predates provenance)",
            "ConduitCatalogChanged",
          );
        }
        // Namespace agreement, grammar half (§8.3: `namespace.local`).
        if (namespaceOf(pausedOn.toolName) !== pausedOn.namespace) {
          return terminalize(
            "stored pause's namespace disagrees with its tool name (corrupt state); the pending call did not run",
            "ConduitInternalError",
            CORRUPT,
          );
        }
        // Namespace agreement, COLUMN half: `tools.name` and `tools.namespace`
        // are stored and hydrated independently, and the invoker dispatches
        // connection and source through the column — a `{ name: "a.x",
        // namespace: "b" }` row must not validate generation A and dispatch
        // through B. A tool that no longer resolves is catalog change, not
        // corruption.
        const gotTool = await raceGuard(deps.store.tools.get(pausedOn.toolName));
        if (gotTool.expired) return gotTool.outcome;
        const toolRow = gotTool.value;
        if (toolRow === undefined) {
          return terminalize(
            "catalog changed — re-approve (tool no longer exists)",
            "ConduitCatalogChanged",
          );
        }
        if (toolRow.namespace !== pausedOn.namespace) {
          return terminalize(
            "stored pause's namespace disagrees with the tool row's namespace column (corrupt state); the pending call did not run",
            "ConduitInternalError",
            CORRUPT,
          );
        }
        // A direct execution performs exactly ONE call: the call it was
        // started for and the call it paused on are the same, in name,
        // namespace, and canonical arguments, or the row is corrupt. Without
        // this, `pausedOn.input = { amount: 1 }` beside `request =
        // '{"amount":1000}'` would run 1000 under the approval of 1.
        if (execution.kind === "direct") {
          const { call } = execution;
          if (
            call.toolName !== pausedOn.toolName ||
            call.namespace !== pausedOn.namespace ||
            call.request !== JSON.stringify(pausedOn.input)
          ) {
            return terminalize(
              "direct_call disagrees with the stored pause (corrupt state); the pending call did not run",
              "ConduitInternalError",
              CORRUPT,
            );
          }
        }
        // Step 3 — generation check (D3 authority, both kinds). Runs AFTER
        // the claim, so a provision that commits between the sweep and the
        // claim is still caught. `getGeneration` is "current at read time": a
        // concurrent bump reads NEWER, never stale, which fails closed here.
        const gotGeneration = await raceGuard(deps.store.sources.getGeneration(pausedOn.namespace));
        if (gotGeneration.expired) return gotGeneration.outcome;
        const currentGeneration = gotGeneration.value;
        if (currentGeneration === undefined || currentGeneration !== pausedOn.sourceGeneration) {
          return terminalize("catalog changed — re-approve", "ConduitCatalogChanged");
        }
        // Step 4 — revalidate the projection FLAG and the grant under the
        // ROW's client and projection. No resolver: the default profile
        // applies ONLY to a default-profile row (clientId null — D8); a NAMED
        // row without a resolver has no authority to resume under and fails
        // closed (D11), without so much as consulting the default profile.
        // Once per resume, never per call.
        if (scopeResolver === undefined && execution.clientId !== null) {
          return terminalize(
            "no scope resolver for a named client's row — cannot revalidate its grant",
            "ConduitScopeRevoked",
          );
        }
        const boundScope = bindScope(scopeResolver, execution.clientId);
        const checkScope = boundScope ?? (() => defaultScopeResolver(deps.store)(null));
        const gotScope = await raceGuard(checkScope());
        if (gotScope.expired) return gotScope.outcome;
        if (!gotScope.value.permits(execution.projection, pausedOn.toolName)) {
          return terminalize(
            "the client's scope no longer permits this call — re-approve is not possible",
            "ConduitScopeRevoked",
          );
        }
        // ── §5.4 step 5: the DIRECT resume arm ──────────────────────────────
        if (execution.kind === "direct") {
          if (directDrive === undefined) {
            // `kindOf` disagreed with the hydrated row — the stored kind is
            // the authority for routing the settle, so refuse rather than
            // drive a direct row through an unfenced path.
            return terminalize(
              "stored kind disagrees with the hydrated row (corrupt state); the pending call did not run",
              "ConduitInternalError",
              CORRUPT,
            );
          }
          const decisions = makeDecisions();
          decisions.stage(
            executionId,
            {
              op: "call",
              toolName: execution.call.toolName,
              request: execution.call.request,
            },
            decision,
          );
          const gotPolicy = await raceGuard(deps.store.policies.get(execution.call.toolName));
          if (gotPolicy.expired) return gotPolicy.outcome;
          // `raceGuard` answers "not expired" whenever the READ wins the
          // race — including when the budget elapsed during it and the expiry
          // has already taken the latch with its write still in flight. The
          // handover below hands the drive to `runDirect`, whose first
          // `drive.settle()` then LOSES and returns having resolved nothing,
          // so `await outcome` never resolves and the resume hangs forever,
          // holding a daemon queue slot. The latch is the authority: if it is
          // gone, the expiry owns the outcome, so publish ITS answer rather
          // than driving a dead latch. Re-checked HERE, after the last guard
          // read, because this is the last point before handover.
          if (directDrive.settled) return guardExpiry;
          const policyRow = gotPolicy.value;
          let resolveOutcome!: (o: DirectOutcome) => void;
          const outcome = new Promise<DirectOutcome>((r) => {
            resolveOutcome = r;
          });
          const running: Extract<Execution, { kind: "direct" }> = {
            ...execution,
            status: "running",
          };
          delete running.pausedOn;
          let markSettled!: () => void;
          const settledAt = new Promise<void>((r) => {
            markSettled = r;
          });
          const run: DirectRun = {
            execution: running,
            drive: directDrive,
            // Step 4 above already bound the authority; the drive re-checks
            // per call through the same resolver.
            scope: checkScope,
            decisions,
            // §11: the resumed path REDACTS before measuring and before
            // storing — `retained` holds the redacted value, and redaction
            // can expand it past the cap (§4.1).
            redactFields: policyRow?.redactFields ?? [],
            resolveOutcome: (o) => {
              resolveOutcome(o);
              markSettled();
            },
            tracked: [],
            // The claim put the row `running` under resumeAttemptId.
            persisted: true,
          };
          directDrive.onExpire = () => expireDirect(run);
          // STRUCTURAL GUARANTEE, not a defence: `runDirect` asserts it never
          // throws, but an assertion is not an enforcement, and on THIS path
          // nothing downstream can settle the outcome — the claimed row would
          // stay `running` and `await outcome` below would never resolve,
          // holding a queue slot forever. So the rejection handler both logs
          // the cause host-side under a reference AND settles, through the
          // latch and the ONE bounded fenced write.
          //
          // The published failure follows the SAME rule `classifyDirectFailure`
          // and `expireDirect` use — the DISPATCH CELL, never elapsed time: if
          // the cell says `dispatched`, the upstream may have performed the
          // call, so the honest answer is ambiguous; otherwise the call did not
          // run. No third rule.
          const finishedRun = runDirect(run)
            .catch(async (cause: unknown) => {
              // The reference is minted BEFORE the latch: once the latch is
              // taken this handler owns the outcome, and any expression that
              // could throw between taking it and publishing would leave
              // `outcome` unresolvable with nothing able to settle it. The
              // diagnosis runs after the latch only because `formatCause` is
              // total by construction; nothing else fallible may join it.
              const ref = crypto.randomUUID();
              if (!directDrive.settle()) return;
              console.error(
                `[ExecutionManager] direct resume continuation threw ${ref}: ${formatCause(cause)}`,
              );
              const error: ExecutionError =
                run.drive.dispatch.state === "dispatched"
                  ? {
                      name: OUTCOME_AMBIGUOUS_ERROR_NAME,
                      message: `[ExecutionManager] Direct call failed after dispatch; the upstream may have performed the call. Reference: ${ref}`,
                    }
                  : {
                      name: "ConduitInternalError",
                      message: `[ExecutionManager] Direct resume continuation failed; the call did not run. Reference: ${ref}`,
                    };
              // TOTAL, by construction. The bounded settle is best effort —
              // the very fault that brought us here can be a store that
              // cannot accept a write at all, and `settleDirect` is called
              // outside any try inside the settle helper, so it may THROW
              // rather than reject. If it does, the intended outcome is not
              // known to be durable, which is exactly what `unknown` means.
              // The caller gets an answer on every path; that is the
              // guarantee this handler exists to make.
              try {
                await settleBounded(
                  run,
                  { status: "failed", error },
                  { status: "failed", executionId: run.execution.id, error },
                );
              } catch (settleCause) {
                console.error(
                  `[ExecutionManager] direct resume fallback settle failed ${ref}: ${formatCause(settleCause)}`,
                );
                run.resolveOutcome({
                  status: "unknown",
                  executionId: run.execution.id,
                  reason: "persist-failed",
                });
              }
            })
            .finally(() => directDrive.dispose());
          directDrive.resolveFinished(finishedRun);
          directDrive.resolveSettledAt(settledAt);
          // D-A11: may be `unknown` (persist-timeout / persist-failed).
          const settled = await outcome;
          return { ...settled, decisionApplied: decisions.consumed(executionId) };
        }

        // Load the durable prefix and stage the decision bound to the pending
        // call's identity (design D6). Serialization MUST match the invoker's:
        // request = JSON.stringify(pausedOn.input) via the shared identity from
        // journal.ts — so it cannot drift and fail every approved resume closed.
        // Still inside the guard phase for a code row: this read is post-claim
        // and the client is waiting on it, so it races the same expiry every
        // guard read does.
        const gotPrefix = await raceGuard(deps.store.replayJournal.listByExecution(executionId));
        if (gotPrefix.expired) return gotPrefix.outcome;
        const prefix = toSandboxJournal(gotPrefix.value);
        // THE HANDOVER, re-checked once — the code row's twin of the direct
        // arm's `if (directDrive.settled) return guardExpiry`. Between the
        // guard read above and the drive start below there is no `await` that
        // is not itself a `raceGuard`, so this is the last point at which an
        // expiry can be observed before the guest program could dispatch the
        // approved call. If the latch is gone, the expiry owns the outcome.
        if (codeGuardExpiry !== undefined && !takeCodeGuardLatch()) {
          return await codeGuardExpiry;
        }
        // The drive owns terminalization from here, and this resume now holds
        // the latch, so the timer has nothing left to do.
        clearTimeout(codeGuardTimer);

        // DEFERRED: process-crash recovery of a `running` execution (design
        // D8/F5). An earlier revision wrote an attempt marker before each live
        // upstream call so a resume could detect a "fired-but-unjournaled" side
        // effect. It was removed because it delivered no
        // reachable in-scope guarantee: a marker is only read on this
        // PAUSED-recovery path, but a genuine host crash mid-call leaves the row
        // `running` (start persists running then drives; the claim above flips
        // paused→running then drives) — never `paused` — so the marker for a real
        // crashed side effect is never reached here. The append-throw case the
        // design actually promises (a live appendBarrier THROW after a side
        // effect → terminal failed:outcome-ambiguous) is handled WITHIN the drive
        // by `captured.ambiguous`, needing no marker.
        //
        // Safely terminalizing a stranded `running` row needs to distinguish
        // "crashed mid-call" from "legitimately running right now" — undecidable
        // in a single-process MVP without the multi-worker lease/heartbeat the
        // design explicitly defers (§7). So the MVP guarantee is NO
        // DOUBLE-EXECUTION (resume only claims `paused`, so a stranded `running`
        // row is never re-driven), NOT crash recovery (a host crash mid-call
        // leaves a zombie `running` row until an operator intervenes).

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
        // Routed by kind here; R1's shipped resume drives code rows only.
        const running: Extract<Execution, { kind: "code" }> = {
          ...(execution as Extract<Execution, { kind: "code" }>),
          status: "running",
        };
        delete running.pausedOn;
        // `deadlineFor(undefined)` is DELIBERATE, not a missing argument: the
        // original `start()` limits are not persisted on the Execution row, so
        // a resumed drive gets the DEFAULT wall-clock window — matching the
        // sandbox, which also receives `undefined` limits below (its own §16
        // interrupt still fires). Honoring the original tighter budget on resume
        // needs Execution to persist `limits` — tracked, its own change.
        const upstreamSession = makeUpstreamSession();
        try {
          const invoke = deps.makeInvoker({
            executionId,
            decisions,
            deadline: deadlineFor(undefined),
            upstreamSession,
            // The row's OWN persisted attribution (§4.3), not a default: a row
            // started under a named client keeps that client id on resume.
            // Step 4 above used the default profile once, for the mandatory
            // check; the drive itself stays unscoped when no resolver exists
            // (D8) — absent must stay absent under exactOptionalPropertyTypes.
            projection: running.projection,
            clientId: running.clientId,
            ...(boundScope !== undefined ? { scope: boundScope } : {}),
          });
          const outcome = await drive(
            running,
            invoke,
            prefix,
            undefined,
            undefined,
            boundScope !== undefined ? { scope: boundScope, projection: "code" } : undefined,
          );
          // Read AFTER the drive settles: `consumed` is host-side truth that
          // the staged decision was taken by the pending call (design D6) —
          // the CLI's verb reporting keys on this, never on error names.
          return { ...outcome, decisionApplied: decisions.consumed(executionId) };
        } finally {
          try {
            await upstreamSession.dispose();
          } catch (cause) {
            // Same best-effort discipline as start(): never let a throwing
            // dispose change the resumed drive's own outcome.
            console.error(
              `[ExecutionManager] upstream session scope dispose failed after resume(). Context: { executionId: ${executionId}, cause: ${formatCause(cause)} }`,
            );
          }
        }
      } catch (cause) {
        // A throw in the preparation window (NOT from inside drive — drive
        // finalizes its own faults and re-throws already-terminalized). Best
        // effort: terminalize the claimed row `failed` so it is never stranded
        // `running`, then re-throw the original fault. `failClaimedResume` only
        // fires on a still-`running` row, so if drive already finalized it to a
        // terminal state this is a harmless no-op.
        //
        // The stored reason is OPAQUE. The guard's reads (`tools.get`,
        // `getGeneration`, the scope resolver) flow through here, and a store
        // rejection carries host-only detail — a database path — into a row
        // `check_execution` hands back to the agent. The cause goes to the
        // daemon log under a fresh reference; only the reference is persisted.
        const ref = crypto.randomUUID();
        console.error(`[ExecutionManager] resume preparation failed ${ref}: ${formatCause(cause)}`);
        if (directDrive !== undefined) {
          // The prep-window catch for a DIRECT row settles
          // through the ONE bounded fenced write, not `failClaimedResume` and
          // not an unbounded `settleDirect` — a stalled store here would
          // otherwise hang `resume()` past every budget. Best effort: the
          // original fault still surfaces below whatever the write did.
          // Latch-or-defer, exactly as the guard sites do: if the budget
          // already elapsed, the expiry handler owns the write and this must
          // not issue a second one. The original fault still surfaces either
          // way — this branch always re-throws.
          const prepError: ExecutionError = {
            name: "ConduitInternalError",
            message: `[ExecutionManager] Resume preparation failed. Reference: ${ref}`,
          };
          await terminalizeDirect(directDrive, { status: "failed", error: prepError }, prepError);
          throw cause;
        }
        // This is a CLIENT-VISIBLE path: awaited raw, a store that never
        // answers here held `resume()` open past every budget. Best effort
        // either way — this branch re-throws the original fault whatever the
        // write did, so the write's own fate does not change the answer.
        await failClaimedBounded(executionId, `resume preparation failed. Reference: ${ref}`, ref);
        throw cause;
      } finally {
        // Every exit from the guard phase stops its timer, including the
        // exits that throw. A surviving timer would terminalize a row this
        // resume has already answered for.
        clearTimeout(codeGuardTimer);
      }
    },

    get(executionId) {
      return deps.store.executions.get(executionId);
    },
  };
}

function neverPauses(op: string): () => Promise<PendingApproval> {
  return async () => {
    throw new Error(`[ExecutionManager] ${op} cannot pause; only a call gates on approval.`);
  };
}

function toSandboxError(error: unknown): SandboxError {
  // TOTAL. This runs after the settle latch on the direct paths (through
  // `classifyDirectFailure`), where a throw leaves the outcome unresolvable.
  // Reading `name`/`message` off a hostile Error is fallible too — either can
  // be a getter that throws — so the whole conversion is guarded, and
  // `formatCause` sanitizes and bounds whatever comes back.
  try {
    if (error instanceof Error) {
      return { name: formatCause(error.name), message: formatCause(error.message) };
    }
  } catch {
    return { name: "Error", message: "<unprintable cause>" };
  }
  return { name: "Error", message: formatCause(error) };
}

function toRowOutcome(
  outcome: JournalEntry["outcome"],
): { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } } {
  return outcome.ok
    ? { ok: true, value: outcome.value }
    : { ok: false, error: { name: outcome.error.name, message: outcome.error.message } };
}
