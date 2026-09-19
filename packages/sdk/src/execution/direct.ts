import { createDispatchCell, type DispatchCell } from "../pipeline/dispatch.js";
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
 * The truthful non-answer (D-A11 final): the effect may have landed and the
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
  /** Resolves when the continuation and any tracked settle write have actually stopped. Never rejects. */
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
    deadline: () => end - args.now(),
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
