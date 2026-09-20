import type { ConduitStore } from "../store/store.js";
import type { ExecutionOutcome } from "./manager.js";

/**
 * The ONE place either request-key uniqueness message is matched (D-A12). The
 * store seam is engine-agnostic, so the raw SQLite text is what identifies a
 * duplicate key — and a second copy of these strings in another file would
 * drift the day the schema's index names change. `start` and `startDirect`
 * both route through `mapCreateConflict` instead of matching inline.
 */
const UNIQUE_MARKERS = [
  "UNIQUE constraint failed: executions.request_key",
  "UNIQUE constraint failed: request_keys.client_id, request_keys.key",
] as const;

/**
 * Maps a failed `executions.create` to a `conflict` outcome when the cause is
 * the request-key uniqueness rule: default profile → the legacy column's
 * unique index; named client → the request_keys primary key. Returns undefined
 * for any other cause so the caller rethrows it.
 *
 * `undefined` is also returned when the unique violation fired but the row it
 * collided with cannot be found — a store fault (e.g. a read-after-write
 * inconsistency), never a legitimate conflict; the caller surfaces the
 * original error rather than fabricating a conflict with no execution behind
 * it.
 */
export async function mapCreateConflict(
  cause: unknown,
  requestKey: string | undefined,
  clientId: string | null,
  store: Pick<ConduitStore, "executions">,
): Promise<ExecutionOutcome | undefined> {
  if (requestKey === undefined) return undefined;
  const text = String(cause);
  if (!UNIQUE_MARKERS.some((m) => text.includes(m))) return undefined;
  const existing = await store.executions.getByRequestKey(requestKey, clientId);
  return existing === undefined ? undefined : { status: "conflict", executionId: existing.id };
}
