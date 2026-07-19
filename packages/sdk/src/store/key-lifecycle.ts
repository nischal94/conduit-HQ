import type { Client } from "@libsql/client";
import type { SecretBox } from "../secrets.js";

/**
 * Key-lifecycle primitives (design 2026-07-19, spec §16.3 / §17 v1 step 1):
 * the startup canary that makes a wrong master key fail loud at store open,
 * and the re-encryption primitive `conduit key rotate` drives. Lives beside
 * the sqlite schema it touches; NOT part of the cross-backend ConduitStore
 * contract (a D1 backend needs its own).
 */

export const CANARY_REF = "__conduit.key-canary.v1__";
export const CANARY_SENTINEL = "conduit-key-canary";

export interface StoreKeyContext {
  dbPath?: string;
  keySource?: "env" | "file";
}

export class KeyCanaryError extends Error {
  readonly kind: "wrong-key" | "canary-corruption";
  constructor(kind: "wrong-key" | "canary-corruption", message: string) {
    super(message);
    this.name = "KeyCanaryError";
    this.kind = kind;
  }
}

function contextSuffix(context?: StoreKeyContext): string {
  return ` Context: { db: ${context?.dbPath ?? "unknown"}, keySource: ${context?.keySource ?? "unknown"} }`;
}

/** True iff `box` opens at least one non-canary secrets row. False when no row opens OR none exist. */
async function anyRealRowOpens(client: Client, box: SecretBox): Promise<boolean> {
  const rows = await client.execute({
    sql: "SELECT sealed FROM secrets WHERE ref != ? ORDER BY ref",
    args: [CANARY_REF],
  });
  for (const row of rows.rows) {
    try {
      await box.open(String(row.sealed));
      return true;
    } catch {
      // keep probing — one corrupt row must not condemn a correct key
    }
  }
  return false;
}

async function hasRealRows(client: Client): Promise<boolean> {
  const rs = await client.execute({
    sql: "SELECT 1 FROM secrets WHERE ref != ? LIMIT 1",
    args: [CANARY_REF],
  });
  return rs.rows.length > 0;
}

/**
 * Verify (or bootstrap) the key canary. Called by openSqliteStore after
 * schema setup so every product bin fails loud at startup on a wrong key.
 *
 * - Canary present: open + compare the sentinel. On failure, probe ALL real
 *   rows: any opens → canary-corruption (the key is fine); none → ambiguous
 *   wrong-key.
 * - Canary absent + real rows (legacy db): probe rows FIRST — the db is
 *   never bound to an unverified key. Any opens → create the canary; none →
 *   ambiguous wrong-key, no canary written.
 * - Canary absent + empty table: create freely (INSERT OR IGNORE tolerates
 *   the M5 first-run race — both racers hold the same key), then re-read and
 *   verify.
 */
export async function ensureKeyCanary(
  client: Client,
  secretBox: SecretBox,
  context?: StoreKeyContext,
): Promise<void> {
  const existing = await client.execute({
    sql: "SELECT sealed FROM secrets WHERE ref = ?",
    args: [CANARY_REF],
  });

  const wrongKey = () =>
    new KeyCanaryError(
      "wrong-key",
      "[SqliteStore] Failed to open store: wrong master key — or, if this key is known-correct, " +
        "the stored rows are corrupted/foreign. If this db was mid-rotation, see the rotation-recovery " +
        `procedure (master-key.next / master-key.bak).${contextSuffix(context)}`,
    );
  const corruption = () =>
    new KeyCanaryError(
      "canary-corruption",
      "[SqliteStore] Failed to open store: the key canary is damaged but a real secret decrypts — " +
        "the master key is correct. Recovery: delete the canary row (see README one-liner) and " +
        `reopen; it is recreated under the verified key.${contextSuffix(context)}`,
    );

  const sealed = existing.rows[0]?.sealed;
  if (sealed !== undefined) {
    try {
      if ((await secretBox.open(String(sealed))) === CANARY_SENTINEL) return;
    } catch {
      // fall through to the probe — decrypt failure alone can't name the cause
    }
    throw (await anyRealRowOpens(client, secretBox)) ? corruption() : wrongKey();
  }

  if (await hasRealRows(client)) {
    if (!(await anyRealRowOpens(client, secretBox))) throw wrongKey();
  }

  await client.execute({
    sql: "INSERT OR IGNORE INTO secrets (ref, sealed, created_at) VALUES (?, ?, ?)",
    args: [CANARY_REF, await secretBox.seal(CANARY_SENTINEL), Date.now()],
  });
  // Re-read and verify: under the M5 race the surviving row is the racer's,
  // sealed with the SAME key — if it doesn't verify, something else wrote it.
  const reread = await client.execute({
    sql: "SELECT sealed FROM secrets WHERE ref = ?",
    args: [CANARY_REF],
  });
  try {
    if ((await secretBox.open(String(reread.rows[0]?.sealed))) === CANARY_SENTINEL) return;
  } catch {
    // fall through
  }
  throw wrongKey();
}

export class ReencryptError extends Error {
  /**
   * "unchanged" — the failure occurred strictly before COMMIT was issued, or
   * the explicit rollback succeeded: every row is still under the OLD key and
   * the caller may safely delete a staged new-key file.
   * "unknown" — COMMIT itself threw (SQLite may or may not have committed) or
   * the rollback failed: the caller must NOT delete either candidate key.
   */
  readonly dbState: "unchanged" | "unknown";
  constructor(dbState: "unchanged" | "unknown", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReencryptError";
    this.dbState = dbState;
  }
}

/** Exported for the invariant pin on commit-boundary classification (design pass-4 #2). */
export function classifyReencryptFailure(
  phase: "before-commit" | "commit" | "rollback-failed",
  _cause: unknown,
): "unchanged" | "unknown" {
  return phase === "before-commit" ? "unchanged" : "unknown";
}

/**
 * Re-seal every secrets row (canary included) from oldBox to newBox inside
 * ONE interactive write transaction (BEGIN IMMEDIATE — writer exclusion for
 * the duration; a competing writer surfaces as SQLITE_BUSY within
 * busy_timeout, which lands here as dbState "unchanged": the refusal path).
 * Returns the number of rows re-sealed. The store handle that supplied
 * oldBox is DEAD after a successful return — its SecretBox is the old key.
 */
export async function reencryptSecrets(
  client: Client,
  oldBox: SecretBox,
  newBox: SecretBox,
): Promise<number> {
  let tx: Awaited<ReturnType<Client["transaction"]>>;
  try {
    tx = await client.transaction("write");
  } catch (cause) {
    throw new ReencryptError(
      "unchanged",
      `[KeyLifecycle] Rotation failed: could not acquire the write lock — stop running conduit processes first. Context: { cause: ${String(cause)} }`,
      cause,
    );
  }
  try {
    let count = 0;
    try {
      const rows = await tx.execute("SELECT ref, sealed FROM secrets ORDER BY ref");
      for (const row of rows.rows) {
        const plaintext = await oldBox.open(String(row.sealed));
        await tx.execute({
          sql: "UPDATE secrets SET sealed = ? WHERE ref = ?",
          args: [await newBox.seal(plaintext), String(row.ref)],
        });
        count++;
      }
    } catch (cause) {
      try {
        await tx.rollback();
      } catch (rollbackCause) {
        throw new ReencryptError(
          classifyReencryptFailure("rollback-failed", rollbackCause),
          `[KeyLifecycle] Rotation failed AND rollback failed — db state uncertain; do NOT delete either key file. Context: { cause: ${String(cause)} }`,
          cause,
        );
      }
      throw new ReencryptError(
        classifyReencryptFailure("before-commit", cause),
        `[KeyLifecycle] Rotation failed before commit; every secret is still under the old key. Context: { cause: ${String(cause)} }`,
        cause,
      );
    }
    try {
      await tx.commit();
    } catch (cause) {
      throw new ReencryptError(
        classifyReencryptFailure("commit", cause),
        `[KeyLifecycle] Rotation COMMIT outcome uncertain — do NOT delete either key file; whichever key opens the db is live. Context: { cause: ${String(cause)} }`,
        cause,
      );
    }
    return count;
  } finally {
    tx.close();
  }
}
