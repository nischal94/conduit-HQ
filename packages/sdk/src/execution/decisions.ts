/**
 * §5.5 design D6 — request-bound, one-shot operator decisions.
 *
 * This is the confused-deputy defense at the resume boundary. When an
 * execution pauses at an approval gate (spec §5.5), a human decides on the
 * ONE pending call. That decision is staged here, bound to the pending
 * call's exact identity — `{ op, toolName, request }`. On resume the invoker
 * takes the decision back out ONLY if the call it is about to run has the
 * identical identity. An approval for `github.create_issue` can therefore
 * never authorize `github.delete_repo`: a divergent identity does not match,
 * so the invoker fails closed rather than reusing the approval.
 *
 * Two structural guarantees make that hold:
 *  - **Request-bound.** `take` returns the decision only when op, toolName,
 *    AND the byte-exact request string all match. A mismatch returns
 *    undefined; the caller (the invoker) treats "staged-but-no-match" as a
 *    resume divergence and blocks.
 *  - **One-shot.** A successful `take` deletes the decision, so an approval
 *    is consumed exactly once and can never authorize a second call.
 *
 * The store is in-memory (a `Map` keyed by executionId) and has no
 * dependencies. Each execution holds at most one pending decision, matching
 * the sandbox's single-pending-call suspension model (sandbox/sandbox.ts).
 */

/**
 * The identity of the one pending tool call a decision is bound to. It
 * mirrors the sandbox's `pending: { op: "call"; request }` (sandbox.ts),
 * with `toolName` split out so the invoker can build it from its `(path,
 * input)` arguments. `request` is the canonical serialization of the call's
 * input (see the invoker for the exact form) — equality is byte-exact.
 */
export interface PendingCallIdentity {
  op: "call";
  toolName: string;
  request: string;
}

/** An operator's decision on a paused call: allow it through, or block it. */
export type ApprovalDecision = { kind: "approve" } | { kind: "deny" };

/**
 * The seam the execution manager stages decisions into and the invoker
 * consumes them from. Kept deliberately narrow: stage, take (identity-bound,
 * one-shot), and a non-consuming peek so the invoker can distinguish
 * "no decision for this execution" (the common resume path — behave as
 * today) from "a decision is staged but this call diverges from it" (fail
 * closed).
 */
export interface ApprovalDecisions {
  /** Bind a decision to the pending call's identity for one execution. */
  stage(executionId: string, identity: PendingCallIdentity, decision: ApprovalDecision): void;
  /**
   * Consume the decision iff `identity` matches the staged one exactly.
   * Returns the decision and deletes it (one-shot) on a match; returns
   * undefined on no-match or when nothing is staged — the decision, if any,
   * is left untouched so it is not silently discarded by a probing call.
   */
  take(executionId: string, identity: PendingCallIdentity): ApprovalDecision | undefined;
  /** True iff a decision is currently staged for this execution (non-consuming). */
  peek(executionId: string): boolean;
  /**
   * Drop any staged decision for this execution unconditionally. Called on a
   * resume replay-divergence (design F2): once the first live call proves it
   * is not the approved call, the staged decision must never authorize a
   * later call, so it is discarded rather than left in place.
   */
  discard(executionId: string): void;
}

interface StagedDecision {
  identity: PendingCallIdentity;
  decision: ApprovalDecision;
}

/**
 * Exact-match comparison for two pending-call identities: op, toolName, and
 * the byte-exact request string must all match. Exported so journal.ts's
 * `matchesPending` (the pausedOn-identity check on resume) reuses this exact
 * comparison rather than re-deriving it — two definitions of "identities
 * match" would be a latent confused-deputy bug if they ever drifted apart.
 */
export function identitiesMatch(a: PendingCallIdentity, b: PendingCallIdentity): boolean {
  return a.op === b.op && a.toolName === b.toolName && a.request === b.request;
}

/**
 * The in-memory implementation. No dependencies; not persisted — a decision
 * lives only for the resume it was staged for.
 */
export function createInMemoryApprovalDecisions(): ApprovalDecisions {
  const staged = new Map<string, StagedDecision>();

  return {
    stage(executionId, identity, decision) {
      staged.set(executionId, { identity, decision });
    },

    take(executionId, identity) {
      const entry = staged.get(executionId);
      if (entry === undefined) {
        return undefined;
      }
      // Fail-closed contract: on an identity MISMATCH we return undefined but
      // deliberately DO NOT delete the staged decision. The invoker reads
      // undefined-with-something-staged (via peek) as a resume divergence and
      // blocks; leaving the decision in place means the mismatch cannot be
      // laundered into a "no decision, take the normal path" outcome.
      if (!identitiesMatch(entry.identity, identity)) {
        return undefined;
      }
      staged.delete(executionId); // one-shot: consumed on match
      return entry.decision;
    },

    peek(executionId) {
      return staged.has(executionId);
    },

    discard(executionId) {
      staged.delete(executionId);
    },
  };
}
