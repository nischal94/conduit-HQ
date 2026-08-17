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
 * The lock-db files are kernel lock handles with a `.db` extension. They
 * carry no PRODUCT data — the one thing they do store is the diagnostic
 * holder row described at `HOLDER_TABLE` below, which exists so a refusal
 * can name WHO holds the lock. That row is never the exclusion mechanism
 * (§3.4: "the registry may still report metadata for a good error
 * message, but the lock provides the exclusion") and nothing branches on
 * it; it is advisory text for a human reading an error.
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
function heldLock(client: Client, stamped: boolean): HeldLock {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await client.execute("ROLLBACK");
        // Clear the diagnostic row on the way out, so a LATER refusal
        // cannot name this now-departed process as the current holder.
        // Runs AFTER the ROLLBACK that ends the hold, which is when the
        // row becomes writable again on this connection.
        //
        // `clearHolder` swallows its own faults: a release must never
        // fail on account of diagnostics, and wrapping the ROLLBACK in
        // that same tolerance would hide a genuine release failure.
        //
        // Best-effort, and incompletely so on purpose: a SIGKILLed
        // holder never runs this and leaves its row behind. That residue
        // is inherent — the kernel drops the lock without giving anyone
        // a chance to tidy up — and is why the refusal prose hedges
        // ("may be stale") rather than asserting.
        if (stamped) await clearHolder(client);
      } finally {
        client.close();
      }
    },
  };
}

function isBusy(err: unknown): boolean {
  return err instanceof LibsqlError && err.code === "SQLITE_BUSY";
}

/**
 * Who currently holds a lock, for DIAGNOSTICS ONLY (§3.4).
 *
 * `role` is the acquirer's own word for itself ("daemon", "rotate",
 * "doctor --offline"), `pid` its process id, `since` an ISO timestamp.
 * Nothing in the system branches on any of it: the kernel lock is the
 * exclusion, and this row only turns "could not acquire" into "could not
 * acquire — a daemon (pid 4711) has held it since 12:04".
 *
 * Deliberately NOT trusted as truth about liveness. A row can outlive its
 * writer (SIGKILL leaves it behind while the kernel drops the lock), so a
 * reader that finds one has learned who LAST acquired, not who is live —
 * which is why the row is only ever read as a companion to a BUSY answer
 * the kernel already gave. The two together are sound: the kernel says
 * "someone holds it", the row says who most recently claimed it.
 */
export interface LockHolder {
  pid: number;
  role: string;
  since: string;
}

/**
 * One row, id pinned to 1 — the table holds the CURRENT holder, never a
 * history. This lives in the LOCK db, which carries no product data and
 * has no migration story; it is not a product schema change (§3.4's
 * sanctioned diagnostic metadata).
 */
const HOLDER_TABLE =
  "CREATE TABLE IF NOT EXISTS lock_holder (" +
  "id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, " +
  "role TEXT NOT NULL, since TEXT NOT NULL)";

/**
 * Stamps the holder row, BEFORE the acquiring transaction opens.
 *
 * The ordering is forced, not stylistic. An EXCLUSIVE holder blocks every
 * reader on the file, so a row written INSIDE the hold is unreadable for
 * exactly as long as the hold lasts — useless to the refusal it exists to
 * inform. Written before the transaction, the row is durable and readable
 * by anyone the hold does not block, which is precisely the case that
 * matters: a daemon holding maintenance SHARED lets `readLockHolder`
 * through, and that is the refusal `key rotate` must be able to name.
 *
 * Best-effort by construction: a failure here must never turn into a
 * failure to acquire. Diagnostic prose is not worth converting a working
 * lock acquisition into a refusal, so every fault is swallowed and the
 * caller simply gets a hold with no readable metadata behind it.
 */
async function stampHolder(client: Client, role: string): Promise<void> {
  try {
    await client.execute(HOLDER_TABLE);
    await client.execute({
      sql:
        "INSERT INTO lock_holder (id, pid, role, since) VALUES (1, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, role = excluded.role, since = excluded.since",
      args: [process.pid, role, new Date().toISOString()],
    });
  } catch {
    // Intentionally silent — see the doc above.
  }
}

/**
 * Removes this connection's holder row. Best-effort: see `heldLock`.
 */
async function clearHolder(client: Client): Promise<void> {
  try {
    await client.execute("DELETE FROM lock_holder WHERE id = 1");
  } catch {
    // Intentionally silent — diagnostics never fail a release.
  }
}

/**
 * Reads the holder row, or null when there is nothing legible to report.
 *
 * Null covers every "we cannot say who" case with one answer, because the
 * caller's response to all of them is identical — omit the clause naming
 * the holder. That includes the lock db not existing yet, the table never
 * having been created, and the read itself being BUSY (which is what an
 * EXCLUSIVE holder produces). None of those are errors worth surfacing:
 * the refusal this decorates has already been decided by the kernel.
 */
export async function readLockHolder(lockDbPath: string): Promise<LockHolder | null> {
  if (!existsSync(lockDbPath)) return null;
  const client = createClient({ url: `file:${lockDbPath}` });
  try {
    await client.execute("PRAGMA busy_timeout=0");
    const rs = await client.execute("SELECT pid, role, since FROM lock_holder WHERE id = 1");
    const row = rs.rows[0];
    if (row === undefined) return null;
    const pid = Number(row.pid);
    const role = String(row.role);
    const since = String(row.since);
    if (!Number.isInteger(pid) || role === "" || since === "") return null;
    return { pid, role, since };
  } catch {
    return null;
  } finally {
    client.close();
  }
}

/**
 * Renders a holder as a clause for an error message, or "" when unknown.
 *
 * Deliberately hedged — "last acquired by", never "held by". The row is
 * cleared on an orderly release, but a SIGKILLed holder leaves its row
 * behind while the kernel drops its lock, so the process named here can be
 * dead while a DIFFERENT, role-less acquirer holds the lock for real.
 * Asserting a specific culprit in that case would be worse than saying
 * nothing: it sends the operator to kill a pid that is already gone and
 * leaves them puzzled when the lock stays busy. The wording makes the row
 * what it actually is — a lead, not a verdict.
 */
export function describeHolder(holder: LockHolder | null): string {
  if (holder === null) return "";
  return ` Last acquired by ${holder.role} (pid ${holder.pid}) at ${holder.since} (may be stale).`;
}

function openLockClient(lockDbPath: string): Client {
  const client = createClient({ url: `file:${lockDbPath}` });
  return client;
}

async function prepareConnection(client: Client, busyTimeoutMs = 0): Promise<void> {
  await client.execute("PRAGMA journal_mode=DELETE");
  await client.execute(`PRAGMA busy_timeout=${busyTimeoutMs}`);
}

/**
 * Collision backoff for the daemon LIFECYCLE acquisition — and for it
 * alone. How long that one acquisition lets SQLite's busy handler ride
 * out ANOTHER acquirer's transient locks before reading BUSY as "held".
 *
 * With busy_timeout=0, two processes racing BEGIN EXCLUSIVE on the same
 * fresh lock db can BOTH fail: each takes SHARED on its way up, one wins
 * PENDING and gets immediate BUSY on EXCLUSIVE (the loser's SHARED is
 * still there), while the loser gets immediate BUSY on PENDING. Both read
 * the mutual collision as "a daemon already holds this" and refuse — the
 * concurrent auto-start race ends with ZERO daemons, violating §3.5's
 * "exactly one survives". The busy handler breaks the symmetry: SQLite
 * returns immediate BUSY (handler deliberately not invoked) only to the
 * side whose wait would deadlock — the SHARED holder blocking a PENDING
 * holder — so that side backs off and releases, and the PENDING holder's
 * handler then completes the upgrade. One winner, one refusal.
 *
 * The window only needs to cover a peer's µs-scale acquisition attempt;
 * 1s is comfortably past that under CI load. The cost is bounded refusal
 * latency: a daemon losing to an ESTABLISHED holder waits up to this long
 * before exiting "already running", which no §3.5 path depends on being
 * instant.
 *
 * Lifecycle alone gets the backoff because symmetric auto-start is the
 * only place two processes race BEGIN EXCLUSIVE on a fresh lock db.
 * Rotation's MAINTENANCE acquisition must stay fail-fast per §3.5's
 * probe/hold table: a busy maintenance lock is its decision input
 * ("a daemon is up — coordinate, don't wait"), so waiting-then-acquiring
 * would turn a refusal into a silent takeover. Hence the DEFAULT below
 * is 0 and only conduitd's lifecycle call passes this.
 */
export const EXCLUSIVE_ACQUIRE_BUSY_TIMEOUT_MS = 1000;

/**
 * BEGIN EXCLUSIVE, journal_mode=DELETE. null = BUSY (someone holds it).
 * Held open until `release()` is called (or the process dies, which
 * drops the fd and releases the fcntl lock at the kernel level).
 *
 * Non-blocking by default (`busyTimeoutMs: 0`): BUSY answers immediately,
 * per the design's probe/hold semantics. Callers that must survive a
 * SYMMETRIC acquisition race (daemon lifecycle) opt into the collision
 * backoff by passing `EXCLUSIVE_ACQUIRE_BUSY_TIMEOUT_MS` — see its doc.
 */
export async function acquireExclusive(
  lockDbPath: string,
  opts?: { busyTimeoutMs?: number; role?: string },
): Promise<HeldLock | null> {
  const client = openLockClient(lockDbPath);
  try {
    await prepareConnection(client, opts?.busyTimeoutMs ?? 0);
    // Stamped BEFORE the hold opens — an EXCLUSIVE transaction blocks
    // every reader, so a row written inside it could never be read while
    // it mattered. See `stampHolder`.
    if (opts?.role !== undefined) await stampHolder(client, opts.role);
    await client.execute("BEGIN EXCLUSIVE");
  } catch (err) {
    client.close();
    if (isBusy(err)) return null;
    throw err;
  }
  return heldLock(client, opts?.role !== undefined);
}

/**
 * BEGIN + SELECT count(*) FROM sqlite_schema (forces db SHARED lock).
 * null = BUSY. A plain `BEGIN` is deferred and acquires nothing, and
 * `SELECT 1` need not touch the file — the schema read is what actually
 * forces the SHARED lock the design depends on.
 */
export async function acquireShared(
  lockDbPath: string,
  opts?: { role?: string },
): Promise<HeldLock | null> {
  const client = openLockClient(lockDbPath);
  try {
    await prepareConnection(client);
    if (opts?.role !== undefined) await stampHolder(client, opts.role);
    await client.execute("BEGIN");
    await client.execute("SELECT count(*) FROM sqlite_schema");
  } catch (err) {
    client.close();
    if (isBusy(err)) return null;
    throw err;
  }
  return heldLock(client, opts?.role !== undefined);
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
 * The three-way answer an acquirer needs on a state directory that may not
 * exist yet — `probeShared`'s missing-directory reading, applied to an
 * EXCLUSIVE acquisition.
 *
 * `acquireExclusive` alone cannot express this: it returns null for BUSY and
 * THROWS the raw libsql `SQLITE_CANTOPEN` when the directory is absent, so
 * every caller on a fresh install would surface
 * `ConnectionFailed("… : 14")` instead of doing something sensible. That is
 * a real regression on the documented first onboarding step, since
 * `conduit key generate` is precisely the command run before `~/.conduit`
 * exists.
 *
 * `"no-state-dir"` is a distinct answer rather than a silent success because
 * the two callers want opposite things from it:
 *
 * - `key generate` PROCEEDS — it creates the directory itself moments later,
 *   and nothing can hold a lock in a directory that does not exist, so the
 *   absence is proof of exclusivity rather than an obstacle to it.
 * - `key rotate` and the offline doctor fall through to their OWN typed
 *   refusals (a keyless install has nothing to rotate, and nothing to
 *   diagnose), which are far better diagnoses than a lock error.
 *
 * The directory is never CREATED here. Creation is the daemon's prerogative
 * (§3.2), and an acquirer that provisioned the state directory as a side
 * effect of asking "is anyone holding this?" would be mutating the very
 * thing it is inspecting — the property `probeShared` already guarantees.
 */
export type ExclusiveAcquisition =
  | { outcome: "acquired"; lock: HeldLock }
  | { outcome: "busy" }
  | { outcome: "no-state-dir" };

export async function acquireExclusiveIfPresent(
  lockDbPath: string,
  opts?: { busyTimeoutMs?: number; role?: string },
): Promise<ExclusiveAcquisition> {
  let lock: HeldLock | null;
  try {
    lock = await acquireExclusive(lockDbPath, opts);
  } catch (err) {
    if (isMissingDirectory(err, lockDbPath)) return { outcome: "no-state-dir" };
    throw err;
  }
  return lock === null ? { outcome: "busy" } : { outcome: "acquired", lock };
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
