/**
 * SQLite lock primitive (design §3.5). Node has no `flock(2)`/`fcntl` API
 * and a native dep is off the table (CLAUDE.md supply-chain rules), so the
 * kernel mutual-exclusion primitive is SQLite's own POSIX advisory
 * locking via @libsql/client, on a dedicated rollback-journal database
 * file. WAL changes lock semantics — journal_mode=DELETE gives true
 * shared/exclusive fcntl ranges instead.
 *
 * Every hold uses ONE dedicated client for its whole lifetime — never a
 * shared/pooled one. `client.execute()` calls on a single Client each run
 * on the same physical local connection (verified empirically for the
 * `file:` protocol), so PRAGMA + BEGIN + the hold all land on that one
 * connection, and `close()` drops it, releasing the OS-level lock.
 *
 * The lock-db files carry no data; their contents are never read. They
 * are kernel lock handles with a `.db` extension.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { type Client, createClient, LibsqlError } from "@libsql/client";

export interface HeldLock {
  /**
   * Releases the hold. Idempotent: a second call is a no-op that
   * resolves. Release lands in `finally` blocks and shutdown paths that
   * can plausibly run twice, and without the guard the second call
   * issues `ROLLBACK` on an already-closed client — surfacing as a
   * confusing libsql error from a caller that did nothing wrong, and
   * masking whatever real failure was being unwound at the time.
   */
  release(): Promise<void>;
}

/**
 * Wraps a held client's release in a one-shot guard. Shared by both
 * acquisitions so the idempotence is a property of every `HeldLock`
 * this module hands out, not of each construction site remembering it.
 */
function heldLock(client: Client): HeldLock {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await client.execute("ROLLBACK");
      } finally {
        client.close();
      }
    },
  };
}

function isBusy(err: unknown): boolean {
  return err instanceof LibsqlError && err.code === "SQLITE_BUSY";
}

function openLockClient(lockDbPath: string): Client {
  const client = createClient({ url: `file:${lockDbPath}` });
  return client;
}

async function prepareConnection(client: Client): Promise<void> {
  await client.execute("PRAGMA journal_mode=DELETE");
  await client.execute("PRAGMA busy_timeout=0");
}

/**
 * BEGIN EXCLUSIVE, busy_timeout=0, journal_mode=DELETE. null = BUSY.
 * Held open until `release()` is called (or the process dies, which
 * drops the fd and releases the fcntl lock at the kernel level).
 */
export async function acquireExclusive(lockDbPath: string): Promise<HeldLock | null> {
  const client = openLockClient(lockDbPath);
  try {
    await prepareConnection(client);
    await client.execute("BEGIN EXCLUSIVE");
  } catch (err) {
    client.close();
    if (isBusy(err)) return null;
    throw err;
  }
  return heldLock(client);
}

/**
 * BEGIN + SELECT count(*) FROM sqlite_schema (forces db SHARED lock).
 * null = BUSY. A plain `BEGIN` is deferred and acquires nothing, and
 * `SELECT 1` need not touch the file — the schema read is what actually
 * forces the SHARED lock the design depends on.
 */
export async function acquireShared(lockDbPath: string): Promise<HeldLock | null> {
  const client = openLockClient(lockDbPath);
  try {
    await prepareConnection(client);
    await client.execute("BEGIN");
    await client.execute("SELECT count(*) FROM sqlite_schema");
  } catch (err) {
    client.close();
    if (isBusy(err)) return null;
    throw err;
  }
  return heldLock(client);
}

/**
 * Attempt SHARED, roll back immediately. "busy" = an EXCLUSIVE holder
 * exists. Detection ALWAYS probes SHARED, never EXCLUSIVE: an EXCLUSIVE
 * probe attempt cannot distinguish "a SHARED holder exists" (which also
 * blocks a would-be EXCLUSIVE acquire) from "an EXCLUSIVE holder exists"
 * — only a SHARED probe (which coexists with other SHARED holders but is
 * blocked by an EXCLUSIVE holder) tells the two apart.
 *
 * A lock db whose PARENT DIRECTORY does not exist reads "free", which is
 * the truthful answer rather than a swallowed error: on a fresh install
 * the state directory has not been created yet, and a lock file nobody
 * can open is a lock nobody can be holding. Probing is deliberately
 * read-only about the filesystem — it never creates the directory, so a
 * client asking "is anyone there?" cannot mutate the state directory it
 * is only inspecting (§3.2: creation is the daemon's prerogative).
 * Only the missing-directory errno is treated this way; every other
 * open failure still throws.
 */
export async function probeShared(lockDbPath: string): Promise<"free" | "busy"> {
  let held: HeldLock | null;
  try {
    held = await acquireShared(lockDbPath);
  } catch (err) {
    if (isMissingDirectory(err, lockDbPath)) return "free";
    throw err;
  }
  if (!held) return "busy";
  await held.release();
  return "free";
}

/**
 * True when the failure is "this lock db could not be opened because its
 * directory isn't there".
 *
 * The shape is awkward, and deliberately not trusted. libsql surfaces
 * this as a PLAIN `Error` — not a `LibsqlError`, and with an empty
 * `code` — whose message embeds the raw SQLite result code (`14` is
 * `SQLITE_CANTOPEN`). There is no typed field to branch on, so the
 * message is only a HINT here, never the decision.
 *
 * The decision is made against the filesystem: this returns true only
 * when the lock db's parent directory genuinely does not exist. That
 * matters because `SQLITE_CANTOPEN` also covers permission denials and
 * I/O faults, and reading either as "free" would let a client spawn a
 * daemon against a state directory it cannot actually use. Checking the
 * directory directly makes the answer true or false for a reason that
 * does not depend on libsql's error prose staying stable.
 */
function isMissingDirectory(err: unknown, lockDbPath: string): boolean {
  if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return true;
  if (!(err instanceof Error) || !err.message.includes("ConnectionFailed")) return false;
  return !existsSync(dirname(lockDbPath));
}
