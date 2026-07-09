/**
 * §5.5 design D4/F2 — replay-journal reconstruction and pausedOn-identity.
 *
 * Pure functions only: no store, no sandbox I/O. `toSandboxJournal` turns
 * the persisted replay-journal rows (Task 1's `ReplayJournalRow[]`, which
 * carry an `ordinal` for storage ordering) into the sandbox's in-memory
 * `JournalEntry[]` prefix (sandbox.ts) — the memoized tool-call results a
 * resumed execution replays against before proceeding live. `matchesPending`
 * is the identity check at that same resume boundary: it decides whether a
 * pending approval decision (Task 4, decisions.ts) actually belongs to the
 * call the execution is paused on, using the identical exact-match
 * comparison Task 4 uses for its own staged-decision lookup.
 */

import type { JournalEntry } from "../sandbox/sandbox.js";
import type { ReplayJournalRow } from "../store/store.js";
import type { PendingApproval } from "../types.js";
import { identitiesMatch, type PendingCallIdentity } from "./decisions.js";

/**
 * Reconstructs the sandbox's journal prefix from persisted rows. Rows are
 * sorted by `ordinal` first — the store's `listByExecution` documents
 * insertion order as the deterministic-replay order, but this function
 * takes no dependency on that guarantee and re-sorts explicitly, since
 * `ordinal` is the actual correctness-bearing field. `ordinal` itself is
 * dropped: the sandbox's `JournalEntry` has no ordinal field, only array
 * position, which the sort now encodes.
 */
export function toSandboxJournal(rows: ReplayJournalRow[]): JournalEntry[] {
  return [...rows]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(({ op, request, outcome }) => ({ op, request, outcome }));
}

/**
 * True iff the pending call `identity` is the exact call an execution is
 * paused on (`pausedOn`). `pausedOn` (types.ts) carries `toolName` + `input`
 * (a value), not a pre-serialized request, so its identity is derived here
 * via `JSON.stringify(pausedOn.input)` — the same serialization the invoker
 * uses to build `PendingCallIdentity.request` (decisions.ts). Delegates the
 * actual comparison to `identitiesMatch` (decisions.ts) rather than
 * re-deriving it: a second, independently-written equality would risk
 * drifting from Task 4's and silently breaking the confused-deputy defense
 * this identity check exists for.
 */
export function matchesPending(identity: PendingCallIdentity, pausedOn: PendingApproval): boolean {
  const pausedIdentity: PendingCallIdentity = {
    op: "call",
    toolName: pausedOn.toolName,
    request: JSON.stringify(pausedOn.input),
  };
  return identitiesMatch(identity, pausedIdentity);
}
