import type { DescribeOptions, SearchHit, SearchOptions, ToolDescription } from "../catalog.js";
import type { Execution } from "../types.js";

/**
 * Sandbox (spec §5.3–§5.5, §16): the isolated runtime that executes
 * agent-written code. The interface is the seam (same discipline as
 * Catalog/ConduitStore): callers may not assume QuickJS — a different
 * engine must be able to replace it without touching call sites.
 *
 * Deliberately absent from this vocabulary: policies, credentials,
 * connections. The sandbox calls tools by reference through a ToolHost;
 * the §5.3 pipeline (policy → credentials → upstream → trace) mounts
 * behind that interface, host-side, outside the sandbox (spec §9.2).
 */
export interface Sandbox {
  execute(request: ExecutionRequest): Promise<SandboxResult>;
}

export interface ExecutionRequest {
  /** Agent-written code, run as an async function body; its `return` value is the result. */
  code: string;
  /** Host-side bridge for `tools.*` calls emitted by the code. */
  tools: ToolHost;
  /**
   * Recorded non-determinism (spec §5.5). Omit on first run — the sandbox
   * generates and returns them; supply the recorded pair on replay and
   * `Date.now()` / `Math.random()` repeat verbatim.
   */
  seeds?: ExecutionSeeds;
  /**
   * Memoized tool-call results from a prior run (spec §5.5). Journaled
   * calls return without re-hitting the host; execution proceeds live
   * from the first un-journaled call.
   */
  journal?: readonly JournalEntry[];
  /** Overrides for the §16 resource limits; defaults apply per limit. */
  limits?: Partial<SandboxLimits>;
}

/**
 * One journaled tool-call result (spec §5.5). An Execution is pure data —
 * code + seeds + journal — so pause/resume survives restarts and needs no
 * VM snapshot. Entries are consumed in call order; deterministic code
 * (enforced by the seeds) makes that order stable across replays.
 *
 * Entries whose error name is in NON_MEMOIZABLE_ERROR_NAMES
 * (pipeline/errors.ts) record a policy refusal, not a result; the §5.5
 * execution manager (pending — INVARIANTS.md) MUST strip them before replay
 * so an approved call re-executes live instead of replaying its own denial.
 */
export interface JournalEntry {
  op: "search" | "describe" | "call";
  /** Canonical JSON of the request payload; replay verifies it matches. */
  request: string;
  outcome: { ok: true; value: unknown } | { ok: false; error: SandboxError };
}

/** The `{ now, random }` pair recorded per execution (spec §5.5). */
export type ExecutionSeeds = Execution["seeds"];

/** Per-execution resource caps (spec §16): a runaway is interrupted, not babysat. */
export interface SandboxLimits {
  /** Wall-clock ceiling for the whole execution. */
  wallClockMs: number;
  /** Sandbox heap ceiling. */
  memoryBytes: number;
  /** Cap on the serialized size of the execution's return value. */
  maxOutputBytes: number;
}

/** Spec §16 defaults: 60s / 128 MB / 1 MB, operator-tunable. */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  wallClockMs: 60_000,
  memoryBytes: 128 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
};

/**
 * What sandboxed code reaches when it calls `tools.*` — the host side of
 * the bridge. Implementations own the §5.3 pipeline; the catalog-backed
 * one lives in execute.ts.
 *
 * Suspension contract (spec §5.5): the sandbox never holds a live VM
 * across one of these calls. An un-journaled tool call aborts the guest
 * run; the host performs the call while the VM is idle, journals the
 * result, and replays. `call` should still be time-bound (upstream
 * timeouts are a pipeline concern) — host time burns the execution's
 * §16 wall-clock budget.
 */
export interface ToolHost {
  search(options: SearchOptions): Promise<SearchHit[]>;
  describe(path: string, options?: DescribeOptions): Promise<ToolDescription | undefined>;
  call(path: string, input: unknown): Promise<unknown>;
}

export type SandboxResult =
  | { status: "completed"; value: unknown; seeds: ExecutionSeeds; journal: JournalEntry[] }
  | { status: "failed"; error: SandboxError; seeds: ExecutionSeeds; journal: JournalEntry[] }
  | {
      status: "interrupted";
      reason: InterruptReason;
      seeds: ExecutionSeeds;
      journal: JournalEntry[];
    };

/** Which §16 cap fired. */
export type InterruptReason = "wall_clock" | "memory" | "output_size";

/** A guest error, reduced to data — no handles or engine objects escape the sandbox. */
export interface SandboxError {
  name: string;
  message: string;
}

/** Fresh non-determinism for a first run; recorded on the Execution for replay (spec §5.5). */
export function generateSeeds(): ExecutionSeeds {
  return {
    now: Date.now(),
    random: Math.floor(Math.random() * 0x1_0000_0000),
  };
}
