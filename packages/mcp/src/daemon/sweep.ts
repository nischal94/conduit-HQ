/**
 * The crash-terminal sweep (design §3.5, "durable execution state after a
 * crash"). A daemon that dies mid-request leaves its execution rows
 * durably `running`: `manager.ts` records that process-crash recovery of
 * a `running` row is deferred, so nothing else repairs them, and the next
 * daemon would serve a database containing executions that will never
 * finish and that no one is running.
 *
 * Why this needs NO schema change — the question §8 explicitly left open
 * for planning. The design worried that identifying "rows owned by a dead
 * daemon" would need a daemon epoch or lease in durable state. It does
 * not, because §3.5 already establishes something stronger: exactly one
 * daemon may exist (lifecycle EXCLUSIVE), and this sweep runs at a point
 * in the startup order where THIS process holds both locks and has not
 * yet bound its endpoint. No other daemon can exist, no client can be
 * connected, and this daemon has started nothing. Therefore every
 * `running` row visible here is, without qualification, owned by a
 * process that is gone. The epoch a lease would have carried is supplied
 * by the lock ordering instead of by a column.
 *
 * Never replays. The outcome of a killed execution is genuinely unknown —
 * its upstream calls may have landed — so re-running the code could
 * duplicate side effects that already happened. §5's `outcome unknown`
 * is the honest answer, and the row is terminalized as `failed` carrying
 * that reason rather than being retried or silently completed.
 */
import type { ConduitStore } from "@conduithq/sdk";

/**
 * The stored `error.name` on a swept row. Distinct from an ordinary
 * execution failure on purpose: a reader (the approvals CLI, a future
 * status command) must be able to tell "this code threw" from "a daemon
 * died while this was in flight and nobody knows what happened".
 */
export const OUTCOME_AMBIGUOUS = "ConduitOutcomeAmbiguous";

const SWEEP_REASON =
  "daemon died while this execution was running; the outcome is unknown and was not replayed";

/**
 * Terminalizes every durably-`running` execution, returning how many were
 * swept. One log line per swept row — the operator-visible record that a
 * crash left work behind, and which work.
 *
 * Idempotent by construction: `failClaimedResume` is a guarded
 * `WHERE status='running'` update, so a second pass matches nothing. That
 * matters because `runDaemon` races this call against the stop signal and
 * may abandon it half-finished; the next startup simply runs it again.
 */
export async function sweepOrphanedExecutions(
  store: ConduitStore,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  const ids = await store.executions.listRunningIds();
  let swept = 0;
  for (const id of ids) {
    // Reuses the store's existing guarded terminalizer (design §8/F5)
    // rather than adding a bulk UPDATE: it already writes exactly the
    // columns this needs (status, ended_at, paused_on=NULL, error) under
    // a `WHERE status='running'` guard, and it deliberately needs no
    // parsed Execution — the crash being recovered from may be what left
    // the row's JSON unreadable in the first place.
    await store.executions.failClaimedResume(id, SWEEP_REASON, OUTCOME_AMBIGUOUS);
    swept++;
    log(`[conduitd] Crash-terminal sweep: execution terminalized. Context: {executionId: ${id}}`);
  }
  if (swept > 0) {
    log(`[conduitd] Crash-terminal sweep complete. Context: {swept: ${swept}}`);
  }
  return swept;
}
