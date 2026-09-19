import { createDispatchCell, type DispatchCell } from "../pipeline/dispatch.js";
import { printableName } from "../policy.js";
import type { ConduitStore, DirectSettle } from "../store/store.js";
import type { ExecutionOutcome } from "./manager.js";

/**
 * §5.3/§11 budgets for the direct arm. Injectable per manager
 * (`ExecutionManagerDeps.direct`) so tests can use small budgets instead of
 * waiting out the real ones.
 */
export interface DirectBudgets {
  /** Wall-clock ceiling on the whole drive, armed at drive construction. */
  driveBudgetMs: number;
  /** Ceiling on the ONE settle write; past it the outcome is `unknown`. */
  settleWriteBudgetMs: number;
  /** How long the slot waits for the continuation after settle (§5.3 row #45). */
  slotRetentionMs: number;
  /** §4.1: a deliverable over this many UTF-8 bytes settles `discarded`. */
  resultBytesMax: number;
}

export const DIRECT_DEFAULTS: DirectBudgets = {
  driveBudgetMs: 60_000,
  settleWriteBudgetMs: 5_000,
  slotRetentionMs: 30_000,
  resultBytesMax: 262_144,
};

/**
 * The truthful non-answer (D-A11): the effect may have landed and the
 * row may not yet say so. NEVER a claimed terminal — a caller must re-list,
 * not retry.
 */
export type UnknownOutcome = {
  status: "unknown";
  executionId: string;
  reason: "persist-timeout" | "persist-failed";
};

export type DirectOutcome = ExecutionOutcome | UnknownOutcome;

export interface DirectDriveHandle {
  executionId: string;
  /** Client-visible. Resolves within driveBudgetMs + settleWriteBudgetMs. Never rejects. */
  outcome: Promise<DirectOutcome>;
  /** "released" when the continuation finished within slotRetentionMs of settle; else "abandoned". Never rejects. */
  retention: Promise<"released" | "abandoned">;
  /**
   * Resolves when the continuation and any tracked settle write have actually
   * stopped. Never rejects — and may NEVER RESOLVE: a quarantined
   * continuation (a store read that never returns) leaves it pending by
   * design. `outcome` and `retention` always settle; only `finished` can
   * hang. Await it only where hanging is acceptable.
   */
  finished: Promise<void>;
}

export interface DirectDrive {
  readonly executionId: string;
  readonly attempt: string;
  readonly dispatch: DispatchCell;
  /** Remaining budget in ms; the invoker's deadline(). */
  deadline(): number;
  /** Take the settle latch. True iff this caller is the first. */
  settle(): boolean;
  readonly settled: boolean;
}

export interface OwnedDirectDrive extends DirectDrive {
  dispose(): void;
  /** Reassignable: the resume path creates the drive before the run exists. */
  onExpire: (() => void) | undefined;
  /** Deferred lifecycle wiring for the resume path. */
  resolveFinished(p: Promise<void>): void;
  resolveSettledAt(p: Promise<void>): void;
  /** Guard exits: settle both lifecycle promises and cancel the timer. */
  finishEarly(): void;
  /**
   * D-A2: the guard exits that issue a settle WRITE. Resolves
   * `settledAt` (the row is decided, so retention starts now — the spec
   * measures it from settle, not from the write's completion) and cancels the
   * timer, but leaves `finished` for the caller to resolve on the write, so
   * "the work has actually stopped" stays true.
   */
  settleEarly(): void;
  readonly finished: Promise<void>;
  readonly settledAt: Promise<void>;
}

/**
 * D-A13: the drive OWNS its budget timer, armed at construction — before any
 * store write — so a hung `create()` cannot postpone the timeout. `onExpire`
 * runs at most once, only if the latch is still free; `dispose()` clears the
 * timer (call it in the continuation's `finally`).
 */
export function createDirectDrive(args: {
  executionId: string;
  attempt: string;
  now: () => number;
  budgetMs: number;
  onExpire?: () => void;
}): OwnedDirectDrive {
  const end = args.now() + args.budgetMs;
  let settled = false;
  let resolveFinished!: (p: Promise<void>) => void;
  let resolveSettledAt!: (p: Promise<void>) => void;
  const finished = new Promise<void>((r) => {
    resolveFinished = (p) => {
      p.then(
        () => r(),
        () => r(),
      );
    };
  });
  const settledAt = new Promise<void>((r) => {
    resolveSettledAt = (p) => {
      p.then(
        () => r(),
        () => r(),
      );
    };
  });
  const drive: OwnedDirectDrive = {
    executionId: args.executionId,
    attempt: args.attempt,
    dispatch: createDispatchCell(),
    onExpire: args.onExpire,
    // LATCH-AWARE. The timer runs on `setTimeout` while this subtracts an
    // INJECTABLE `now()` — two clocks that can disagree. Once the latch is
    // taken the outcome is already decided, so no remaining budget can be
    // truthful: reporting some would let the invoker's pre-write gate pass and
    // dispatch a call for an execution already published as "did not run".
    deadline: () => (settled ? 0 : end - args.now()),
    settle() {
      if (settled) return false;
      settled = true;
      return true;
    },
    get settled() {
      return settled;
    },
    dispose() {
      clearTimeout(timer);
    },
    resolveFinished,
    resolveSettledAt,
    finished,
    settledAt,
    finishEarly() {
      resolveSettledAt(Promise.resolve());
      resolveFinished(Promise.resolve());
      clearTimeout(timer);
    },
    settleEarly() {
      resolveSettledAt(Promise.resolve());
      clearTimeout(timer);
    },
  };
  // Reads `drive.onExpire` at FIRE time: the resume path assigns it after
  // construction, so a drive created before its run can still settle it.
  const timer = setTimeout(() => {
    if (!settled) drive.onExpire?.();
  }, args.budgetMs);
  timer.unref?.();
  return drive;
}

/**
 * UTF-8 size of what will be sent AND stored (§4.1). `undefined` stringifies
 * to `undefined`, which the store normalizes to `null` — measure it as such.
 */
export function deliverableBytes(deliverable: unknown): number {
  return Buffer.byteLength(JSON.stringify(deliverable) ?? "null", "utf8");
}

/**
 * How the ONE fenced settle write ended (§5.3). `written` is the only arm
 * that licenses publishing the intended outcome; every other arm means "the
 * effect may have landed and the row may not yet say so".
 */
export type SettleResult = "written" | "fenced" | "failed" | "timeout";

/** Host log lines stay readable; a hostile cause cannot flood the daemon log. */
const CAUSE_MAX_LENGTH = 300;

/**
 * THE way a thrown value becomes host-log text. Every `console.error` on the
 * direct and resume paths uses it.
 *
 * Converting a thrown value is FALLIBLE, which is the point. `String(cause)`
 * throws for a value whose `toString` throws, for a revoked Proxy, and for a
 * bare Symbol — and on these paths the conversion sits AFTER the settle latch
 * is spent, where a throw leaves the outcome unresolvable and the caller
 * waiting forever. So the conversion is guarded and falls back to a fixed
 * placeholder that names nothing.
 *
 * The result is also sanitized: a plain cause containing a newline would
 * forge a host log line, and an unbounded one would flood the log. Both are
 * handled by `printableName`'s sanitizing core, which strips control
 * characters and caps length — the same treatment guest-supplied tool names
 * get, for the same reason.
 */
export function formatCause(cause: unknown): string {
  let text: string;
  try {
    text = String(cause);
  } catch {
    // Names nothing about the value: reaching here means even asking what it
    // is was unsafe.
    return "<unprintable cause>";
  }
  return printableName(text, CAUSE_MAX_LENGTH);
}

/**
 * How ONE bounded store call ended. A closed union with no error payload:
 * a store fault's detail is host-only (it can carry a database path or an
 * upstream body) and must never reach a caller that publishes to the agent.
 * Callers that need the cause log it themselves, under a reference.
 */
export type StoreCallResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "rejected"; cause: unknown }
  | { kind: "timeout" };

/**
 * THE way to call the store on any path a client waits on — the single
 * implementation of "call the store safely".
 *
 * Three failure modes are handled in ONE place, deliberately, because each
 * of them has been a separate hang or a separate stranded row when a call
 * site handled them by hand:
 *
 *  - a SYNCHRONOUS throw. A store method may throw rather than return a
 *    rejected promise, and a synchronous throw happens before any `.catch()`
 *    attached to its result exists. Calling inside a `try` turns it into a
 *    rejection like any other.
 *  - an UNBOUNDED wait. `.catch()` handles a rejection and does nothing at
 *    all for a promise that never settles, so a stalled store hangs every
 *    awaiting caller past every budget. The race against the budget is what
 *    makes the wait finite.
 *  - an UNHANDLED REJECTION from the loser. When the timer wins, the write
 *    is still live and may reject later with nobody awaiting it.
 *
 * Never throws and never rejects: every outcome is an arm of the returned
 * union. The call is NOT cancelled on timeout — it may still land — so
 * callers that must observe its completion keep the returned `call` promise.
 */
export function boundedStoreCall<T>(
  invoke: () => Promise<T>,
  budgetMs: number,
): { result: Promise<StoreCallResult<T>>; call: Promise<StoreCallResult<T>> } {
  let call: Promise<StoreCallResult<T>>;
  try {
    call = invoke().then(
      (value): StoreCallResult<T> => ({ kind: "ok", value }),
      (cause: unknown): StoreCallResult<T> => ({ kind: "rejected", cause }),
    );
  } catch (cause) {
    call = Promise.resolve({ kind: "rejected", cause });
  }
  // The `.then` above already converts BOTH settlements into a fulfilled
  // value, so the loser of the race below can never be an unhandled
  // rejection — that is why this is the only promise kept.
  const result = (async (): Promise<StoreCallResult<T>> => {
    let timerHandle: NodeJS.Timeout | undefined;
    const timer = new Promise<StoreCallResult<T>>((r) => {
      timerHandle = setTimeout(() => r({ kind: "timeout" }), budgetMs);
      timerHandle.unref?.();
    });
    const winner = await Promise.race([call, timer]);
    clearTimeout(timerHandle);
    return winner;
  })();
  return { result, call };
}

/**
 * THE bounded, fenced settle — the single implementation every direct settle
 * path uses (the drive's own settle, the §5.4 guard terminalizations, the
 * guard-phase expiry, the TTL `expired` arm, and the prep-window catch).
 *
 * ONE implementation, deliberately: a per-caller copy of this race is how a
 * missing timeout hides, and a stalled store behind such a copy hangs
 * `resume()` past every budget. A single implementation makes that class of
 * omission unrepresentable rather than merely fixed.
 *
 * Never throws — synchronously either, which is why the call to
 * `settleDirect` sits inside a try: a rejected write is `failed`, a write
 * still pending after
 * `budgetMs` is `timeout`. The write itself is NOT cancelled on timeout — it
 * may still land — so callers that need to observe its completion push the
 * returned `write` promise onto their tracked list.
 */
export function boundedFencedSettle(
  store: Pick<ConduitStore, "executions">,
  id: string,
  attempt: string,
  settle: DirectSettle,
  budgetMs: number,
): { result: Promise<SettleResult>; write: Promise<unknown> } {
  // Built on `boundedStoreCall` so there is ONE implementation of the
  // synchronous-throw guard, the budget race, and the loser's rejection
  // handling. This function adds only the FENCE reading: `settleDirect`
  // returning false means the guarded UPDATE matched no row.
  const { result: bounded, call } = boundedStoreCall(
    () => store.executions.settleDirect(id, attempt, settle),
    budgetMs,
  );
  const result = bounded.then((r): SettleResult => {
    if (r.kind === "timeout") return "timeout";
    if (r.kind === "rejected") return "failed";
    return r.value ? "written" : "fenced";
  });
  return { result, write: call };
}
