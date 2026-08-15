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
import { type Client, createClient, LibsqlError } from "@libsql/client";

export interface HeldLock {
  release(): Promise<void>;
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
  return {
    async release() {
      try {
        await client.execute("ROLLBACK");
      } finally {
        client.close();
      }
    },
  };
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
  return {
    async release() {
      try {
        await client.execute("ROLLBACK");
      } finally {
        client.close();
      }
    },
  };
}

/**
 * Attempt SHARED, roll back immediately. "busy" = an EXCLUSIVE holder
 * exists. Detection ALWAYS probes SHARED, never EXCLUSIVE: an EXCLUSIVE
 * probe attempt cannot distinguish "a SHARED holder exists" (which also
 * blocks a would-be EXCLUSIVE acquire) from "an EXCLUSIVE holder exists"
 * — only a SHARED probe (which coexists with other SHARED holders but is
 * blocked by an EXCLUSIVE holder) tells the two apart.
 */
export async function probeShared(lockDbPath: string): Promise<"free" | "busy"> {
  const held = await acquireShared(lockDbPath);
  if (!held) return "busy";
  await held.release();
  return "free";
}
