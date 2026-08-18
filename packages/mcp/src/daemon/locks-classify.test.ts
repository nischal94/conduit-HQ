import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regression pins for the two error-CLASSIFICATION defects behind the
 * auto-start flake (Task F). Both were bugs about deciding what an error
 * MEANS from what it IS, and neither was observable from any pre-existing
 * test: the whole suite passed before the fix as well as after.
 *
 * These are deliberately UNIT tests over synthetic errors, which is the
 * one place this package departs from the real-spawned-process convention
 * in `locks.test.ts` — and only because the thing under test is a pure
 * predicate over an error shape. The shapes asserted here were captured
 * verbatim from instrumented real cross-process runs, so the synthesis
 * reproduces an observed reality rather than inventing one. Anything that
 * touches ACTUAL lock acquisition still belongs in `locks.test.ts` against
 * real children; nothing here acquires a lock.
 *
 * `@libsql/client` is mocked so `execute` can raise the exact shapes.
 * That is why this lives in its own file: `vi.mock` hoists to module
 * scope, and applying it inside `locks.test.ts` would defeat that suite's
 * real-process guarantee.
 */

const execute = vi.fn();
const close = vi.fn();

vi.mock("@libsql/client", () => ({
  createClient: () => ({ execute, close }),
  // Present so the module under test can import it; the whole point of
  // the fix is that classification never branches on this type.
  LibsqlError: class LibsqlError extends Error {},
}));

const { acquireShared, probeShared } = await import("./locks.js");

/** The plain-`Error` shape libsql raises from a cross-process conflict. */
function sqliteError(code: string, rawCode: number, message: string): Error {
  const err = new Error(message);
  Object.assign(err, { code, rawCode });
  return err;
}

afterEach(() => {
  execute.mockReset();
  close.mockReset();
});

describe("lock error classification (Task F regression pins)", () => {
  /**
   * `PRAGMA journal_mode` / `PRAGMA busy_timeout` succeed, then the schema
   * read that actually takes SHARED raises `err` — the precise sequence
   * `acquireShared` performs.
   */
  function failOnSchemaRead(err: Error): void {
    execute.mockImplementation((sql: string) => {
      if (typeof sql === "string" && sql.includes("sqlite_schema")) return Promise.reject(err);
      return Promise.resolve({ rows: [] });
    });
  }

  it("INVARIANT §17: a BUSY raised as a PLAIN Error is a lock answer, never a raw throw", async () => {
    // THE FLAKE. libsql raises BUSY as a `LibsqlError` from some call
    // sites and as a plain `Error` from the one that matters here — the
    // schema read, when a second PROCESS holds the file lock. Captured
    // verbatim from an instrumented real run:
    //   ctor=Error isLibsql=false code="SQLITE_BUSY" rawCode=5
    //     msg="database is locked"
    // The retired `err instanceof LibsqlError` guard rejected exactly this
    // shape, so a genuine "someone holds this" answer escaped as a raw
    // throw and killed a client polling a daemon through its startup
    // window.
    failOnSchemaRead(sqliteError("SQLITE_BUSY", 5, "database is locked"));

    await expect(acquireShared("/tmp/whatever.lock.db")).resolves.toBeNull();
    await expect(probeShared("/tmp/whatever.lock.db")).resolves.toBe("busy");
  });

  it("INVARIANT §17: a LOCKED raised as a PLAIN Error is a lock answer, never a raw throw", async () => {
    // SQLite returns LOCKED (6) rather than BUSY (5) when the conflicting
    // connection is in the SAME process — a distinction about WHICH
    // connection is in the way, not about whether the lock is available.
    // Both answer the only question this predicate asks. Aligned with the
    // repo's sibling classifier (`isBusyCause` in cli/src/commands/key.ts),
    // which has always treated the pair as one.
    failOnSchemaRead(sqliteError("SQLITE_LOCKED", 6, "database is locked"));

    await expect(acquireShared("/tmp/whatever.lock.db")).resolves.toBeNull();
    await expect(probeShared("/tmp/whatever.lock.db")).resolves.toBe("busy");
  });

  it("classifies on the numeric rawCode when the textual code is absent", async () => {
    // A future libsql that drops the string `code` must still classify —
    // the reason the predicate accepts either field rather than trusting
    // libsql's error prose.
    for (const rawCode of [5, 6]) {
      failOnSchemaRead(sqliteError("", rawCode, "some future wording"));
      await expect(probeShared("/tmp/whatever.lock.db")).resolves.toBe("busy");
    }
  });

  it("a NON-busy fault still throws — the classifier widened, it did not swallow", async () => {
    // The counterweight to the two pins above. Reading an arbitrary fault
    // as "busy" would be strictly worse than the original bug: a client
    // would wait out a daemon that is not there, and an I/O error or a
    // corrupt lock db would present as ordinary contention.
    failOnSchemaRead(sqliteError("SQLITE_CORRUPT", 11, "database disk image is malformed"));

    await expect(probeShared("/tmp/whatever.lock.db")).rejects.toThrow(/malformed/);
  });
});

/**
 * The §3.2-adjacent half: `probeShared` may read "free" ONLY when the lock
 * db is provably absent. `SQLITE_CANTOPEN` also covers permission denials,
 * and reading one as "free" would let a client spawn a daemon against a
 * state directory it cannot actually use.
 *
 * The first version of the Task F fix used `existsSync` here and DID
 * regress this: under an untraversable parent, `existsSync` reports an
 * existing lock db as absent, turning a permission denial into "free".
 * `existsSync` collapses "absent" and "cannot determine" into one `false`;
 * only a literal ENOENT proves absence.
 */
describe("CANTOPEN absence matrix (Task F regression pins)", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) {
      // Restore traversability first, or the cleanup cannot descend.
      try {
        chmodSync(join(root, "unusable"), 0o700);
      } catch {
        // Only present in the untraversable case.
      }
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  /** CANTOPEN, as libsql reports it: plain Error, empty code, `14` in the text. */
  function cantopen(path: string): Error {
    return new Error(`ConnectionFailed("Unable to open connection to local database ${path}: 14")`);
  }

  function failOnOpen(path: string): void {
    execute.mockImplementation(() => Promise.reject(cantopen(path)));
  }

  it("INVARIANT §17: a fresh install (nothing exists) reads free", async () => {
    root = mkdtempSync(join(tmpdir(), "absent-"));
    const lockDb = join(root, "nested", "conduit", "conduitd-lifecycle.lock.db");
    failOnOpen(lockDb);

    // A lock file nobody can open is a lock nobody can be holding — the
    // reading that lets a fresh-install client reach decision-table row 4
    // and spawn, rather than dying on a raw ENOENT.
    await expect(probeShared(lockDb)).resolves.toBe("free");
  });

  it("INVARIANT §17: an existing but UNREADABLE lock db throws — never free", async () => {
    root = mkdtempSync(join(tmpdir(), "absent-"));
    const lockDb = join(root, "conduitd-lifecycle.lock.db");
    writeFileSync(lockDb, "");
    chmodSync(lockDb, 0o000);
    failOnOpen(lockDb);

    // The file EXISTS and cannot be opened: a permission denial, not an
    // absence. Reading it as "free" would let a client spawn against a
    // state directory it cannot use.
    await expect(probeShared(lockDb)).rejects.toThrow(/ConnectionFailed/);
    chmodSync(lockDb, 0o600);
  });

  it("INVARIANT §17: a directory created DURING the failed open still reads free (the TOCTOU)", async () => {
    // The race itself, made deterministic. The retired predicate asked
    // `!existsSync(dirname(lockDbPath))` AFTER the open had already
    // failed, so a client that opened the lock db BEFORE the daemon's
    // `ensureStateDir` and re-checked AFTER it landed found the directory
    // present and rethrew the raw CANTOPEN at a caller that was only
    // asking whether anyone held the lock.
    //
    // The mock creates the state directory as a side effect of the failing
    // open — exactly the interleaving, with none of the timing luck the
    // 60-spawn harness needed to hit it ~11 times.
    root = mkdtempSync(join(tmpdir(), "absent-"));
    const stateDir = join(root, "nested", "conduit");
    const lockDb = join(stateDir, "conduitd-lifecycle.lock.db");
    execute.mockImplementation(() => {
      mkdirSync(stateDir, { recursive: true });
      return Promise.reject(cantopen(lockDb));
    });

    // The lock db FILE is still absent, so no fcntl range on it can be
    // held: "free" is the truthful answer even though its directory now
    // exists.
    await expect(probeShared(lockDb)).resolves.toBe("free");
  });

  it("INVARIANT §17: an UNTRAVERSABLE parent directory throws — never free", async () => {
    // The case the first fix attempt got wrong. `statSync` on the lock db
    // fails with EACCES (not ENOENT) because the parent cannot be
    // traversed — "could not determine", which is deliberately not
    // absence. `existsSync` would have returned false here and read the
    // whole thing as "free".
    root = mkdtempSync(join(tmpdir(), "absent-"));
    const dir = join(root, "unusable");
    mkdirSync(dir);
    const lockDb = join(dir, "conduitd-lifecycle.lock.db");
    writeFileSync(lockDb, "");
    chmodSync(dir, 0o000);
    failOnOpen(lockDb);

    await expect(probeShared(lockDb)).rejects.toThrow(/ConnectionFailed/);
  });
});
