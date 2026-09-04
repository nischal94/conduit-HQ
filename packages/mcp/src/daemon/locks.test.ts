import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireExclusive,
  acquireExclusiveIfPresent,
  acquireShared,
  describeHolder,
  MAINTENANCE_PROBE_BUSY_TIMEOUT_MS,
  probeShared,
  probeSharedWithin,
  readLockHolder,
} from "./locks.js";

/**
 * Real-process lock tests (design §3.5, normative — no in-memory fakes):
 * every test spawns `helpers/hold-lock.ts` as a genuine child process that
 * acquires a lock via @libsql/client in its own process and holds it until
 * killed. This is the only way to prove the fcntl-backed release-on-death
 * property the design depends on.
 */

const HELPER = fileURLToPath(new URL("./helpers/hold-lock.ts", import.meta.url));

let dir: string | undefined;
const children: ChildProcess[] = [];

afterEach(async () => {
  // Reaped to ACTUAL exit before the directory is removed, matching the
  // other suites. A killed-but-not-yet-exited holder still has the lock
  // db open, so removing the directory underneath it leaves its handles
  // to leak into the next test's acquisition.
  await Promise.all(
    children.map((child) => {
      // `exitCode === null` also covers a signal-terminated child (whose
      // code is null and whose `signalCode` is set), so both are checked
      // before deciding anything is still alive.
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      if (!child.killed) child.kill("SIGKILL");
      return new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }),
  );
  children.length = 0;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function newLockDbPath(): string {
  dir = mkdtempSync(join(tmpdir(), "lk-"));
  return join(dir, "m.lock.db");
}

/**
 * Spawns helpers/hold-lock.ts and resolves once it prints "HELD", with
 * every stdout line printed before "HELD" (e.g. the grandchild pid line
 * from --spawn-grandchild). One listener collects the whole stream so a
 * separate reader can't race it for the same chunk.
 */
function spawnHolder(
  mode: "shared" | "exclusive" | "stamp-loop",
  db: string,
  extraArgs: string[] = [],
): Promise<{ child: ChildProcess; linesBeforeHeld: string[] }> {
  const child = spawn(process.execPath, [HELPER, mode, db, ...extraArgs], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.includes("HELD")) {
        const lines = buf.split("\n").filter((l) => l.length > 0);
        const heldIndex = lines.indexOf("HELD");
        resolve({ child, linesBeforeHeld: lines.slice(0, heldIndex) });
      }
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

/**
 * Polls until an EXCLUSIVE acquire succeeds, releasing it immediately —
 * used to detect "the lock is free again" without leaking the acquired
 * HeldLock (and its open transaction + client) past the check. A bare
 * `waitFor(async () => (await acquireExclusive(db)) !== null)` would hold
 * the successful acquire open for the rest of the test, racing afterEach's
 * rmSync against a still-open sqlite connection on that file.
 */
async function waitForExclusiveFree(db: string, timeoutMs = 5000): Promise<void> {
  await waitFor(async () => {
    const held = await acquireExclusive(db);
    if (!held) return false;
    await held.release();
    return true;
  }, timeoutMs);
}

describe("locks.ts (design §3.5 — SQLite lock primitive)", () => {
  it("INVARIANT §17: lock-db-shared-blocks-exclusive-through-libsql", async () => {
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("shared", db);

    expect(await acquireExclusive(db)).toBeNull();

    holder.kill("SIGKILL");
    await waitForExclusiveFree(db);
  });

  it("INVARIANT §17: lock-db-probe-distinguishes-shared-and-exclusive", async () => {
    const db = newLockDbPath();

    const { child: sharedHolder } = await spawnHolder("shared", db);
    expect(await probeShared(db)).toBe("free"); // readers coexist with readers
    expect(await acquireExclusive(db)).toBeNull(); // but a writer is blocked
    sharedHolder.kill("SIGKILL");
    await waitFor(async () => (await probeShared(db)) === "free");

    const { child: exclusiveHolder } = await spawnHolder("exclusive", db);
    await waitFor(async () => (await probeShared(db)) === "busy");
    exclusiveHolder.kill("SIGKILL");
  });

  it("INVARIANT §17: lock-db-transaction-remains-held-until-explicit-close", async () => {
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("exclusive", db);

    // The hold is a live open transaction, not a one-shot statement: it
    // must still block a fresh acquire attempt well after the child
    // printed HELD, with no further action from the holder.
    await new Promise((r) => setTimeout(r, 200));
    expect(await acquireExclusive(db)).toBeNull();

    holder.kill("SIGKILL");
    await waitForExclusiveFree(db);
  });

  it("INVARIANT §17: lock-db-sibling-connection-close-does-not-release-lock", async () => {
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("exclusive", db);

    // A second, unrelated client actually opens against the SAME file
    // and closes — the plain POSIX close-drops-locks footgun this
    // invariant pins. Its own read is refused (the holder's EXCLUSIVE
    // lock correctly blocks it too — expected, not the thing under
    // test), but the open + refused-read + close sequence must not
    // disturb the holder's lock. If close() dropped ALL locks on the
    // shared fd (rather than just this connection's own advisory range),
    // that's exactly what would silently release it.
    const sibling = createClient({ url: `file:${db}` });
    await expect(sibling.execute("SELECT count(*) FROM sqlite_schema")).rejects.toThrow(
      /SQLITE_BUSY/,
    );
    sibling.close();

    expect(await acquireExclusive(db)).toBeNull();

    holder.kill("SIGKILL");
    await waitForExclusiveFree(db);
  });

  it("INVARIANT §17: lock-db-releases-after-sigkill-with-orphan-child-alive", async () => {
    const db = newLockDbPath();
    const { child: holder, linesBeforeHeld } = await spawnHolder("exclusive", db, [
      "--spawn-grandchild",
    ]);
    const grandchildPid = Number(linesBeforeHeld[0]);
    expect(Number.isInteger(grandchildPid)).toBe(true);

    expect(await acquireExclusive(db)).toBeNull();

    holder.kill("SIGKILL");
    // The lock must free even though the grandchild (an orphan once
    // holder dies) is still running.
    await waitForExclusiveFree(db);

    // Confirm the grandchild really did outlive its parent's death, then
    // clean it up — it is not attached to our children[] kill list.
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();
    process.kill(grandchildPid, "SIGKILL");
  });

  it("acquireShared: acquires in-process, survives while held, and blocks a concurrent EXCLUSIVE holder", async () => {
    const db = newLockDbPath();

    const held = await acquireShared(db);
    expect(held).not.toBeNull();

    // The in-process SHARED hold survives while a real cross-process
    // EXCLUSIVE attempt is made against the same file.
    expect(await acquireExclusive(db)).toBeNull();

    await held?.release();
    // Released — a fresh EXCLUSIVE acquire now succeeds.
    const afterRelease = await acquireExclusive(db);
    expect(afterRelease).not.toBeNull();
    await afterRelease?.release();
  });

  it("INVARIANT §17 / §3.4: a FAILED acquisition leaves no holder row naming a never-holder", async () => {
    // The stamp is written BEFORE the acquiring transaction opens, and that
    // ordering is forced (every stamp-after-acquire variant is either
    // invisible-because-uncommitted, rolled back on release, or BUSY —
    // see `stampHolder`). The cost is a window in which a row can exist for
    // an acquisition that never happened, and a row naming a process that
    // never held the lock is AFFIRMATIVELY WRONG, not merely stale: the
    // next refusal would send an operator after an innocent pid.
    //
    // The failure path is the half that code can close, and this pins it: a
    // live SHARED holder makes the EXCLUSIVE acquire below fail, and the
    // loser must clean up the stamp it just wrote.
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("shared", db);

    // The real holder took the lock with no role, so any row present after
    // the failed attempt below can only have come from that attempt.
    const before = await readLockHolder(db);
    expect(before).toBeNull();

    const refused = await acquireExclusive(db, { role: "rotate" });
    expect(refused).toBeNull();

    // The row the losing acquirer stamped must be gone. Left behind, it
    // would name THIS process (pid + role "rotate") as the holder of a
    // lock it never obtained.
    const after = await readLockHolder(db);
    expect(after).toBeNull();
    expect(describeHolder(after)).toBe("");

    holder.kill("SIGKILL");
    await waitForExclusiveFree(db);
  });

  it("acquireExclusive: default is fail-fast — BUSY answers immediately, it never waits out a live holder", async () => {
    // The regression this pins: giving acquireExclusive a universal
    // busy_timeout turned rotation's maintenance acquisition from
    // non-blocking fail-fast into wait-and-acquire — a SHARED holder
    // releasing during the wait let the "refused" acquisition silently
    // succeed. Default-opts acquireExclusive must answer BUSY on the
    // spot; only the daemon lifecycle call opts into the collision
    // backoff, explicitly.
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("shared", db);

    const started = Date.now();
    expect(await acquireExclusive(db)).toBeNull();
    const elapsed = Date.now() - started;
    // Well under EXCLUSIVE_ACQUIRE_BUSY_TIMEOUT_MS (1000): a waiting
    // acquisition would sit the full second before giving up.
    expect(elapsed).toBeLessThan(250);

    holder.kill("SIGKILL");
    await waitForExclusiveFree(db);
  });

  it("acquireShared: returns null (BUSY) while a real EXCLUSIVE holder lives", async () => {
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("exclusive", db);

    expect(await acquireShared(db)).toBeNull();

    holder.kill("SIGKILL");
    await waitForExclusiveFree(db);
  });

  it("probeShared: a lock db whose directory does not exist reads free, and is not created", async () => {
    // The fresh-install case. A lock file nobody can open is a lock
    // nobody holds, so "free" is the truthful answer rather than a
    // swallowed error — it is what lets the client reach decision-table
    // row 4 and spawn instead of dying on a raw open failure.
    const missing = join(newLockDbPath(), "..", "absent-dir", "lc.lock.db");
    expect(existsSync(dirname(missing))).toBe(false);

    expect(await probeShared(missing)).toBe("free");

    // Probing is read-only about the filesystem: a client asking "is
    // anyone there?" must not create the state directory it is only
    // inspecting (§3.2 — creation is the daemon's prerogative).
    expect(existsSync(dirname(missing))).toBe(false);
  });

  it("INVARIANT §17 / §3.4: the holder row is CLEARED on release — a refusal never names a departed process", async () => {
    // THE BUG THIS PINS: the row was stamped pre-BEGIN and never cleared,
    // so after an orderly release it lingered. A later refusal caused by a
    // DIFFERENT, role-less holder would then flatly assert "held by
    // conduit key rotate (pid N)" — naming a process that had already
    // exited. That is materially worse than naming nobody: it sends the
    // operator to kill a pid that is already gone.
    const db = newLockDbPath();

    // A SHARED hold, because that is the readable case and the one
    // production depends on: the daemon holds maintenance SHARED, and a
    // refused `key rotate` reads the row past it. (An EXCLUSIVE holder
    // blocks every reader, so its own row is unreadable while it lives —
    // inherent to the primitive, which is why the prose hedges.)
    const held = await acquireShared(db, { role: "daemon" });
    expect(held).not.toBeNull();
    expect(await readLockHolder(db)).toMatchObject({ role: "daemon" });

    await held?.release();
    // Cleared on the way out — nothing to misattribute.
    expect(await readLockHolder(db)).toBeNull();

    // The scenario that made it dangerous: a role-less holder now owns the
    // lock for real. The refusal must not name the departed rotate.
    const { child: anonymous } = await spawnHolder("exclusive", db);
    expect(await acquireExclusive(db)).toBeNull(); // genuinely busy
    expect(describeHolder(await readLockHolder(db))).toBe("");

    anonymous.kill("SIGKILL");
    await waitForExclusiveFree(db);
  });

  it("a surviving holder row is rendered HEDGED — diagnosis, not authority", async () => {
    // A SIGKILLed holder cannot clear its row, so the residue is inherent.
    // What the code owes the operator is honest framing: the row is a
    // lead, never a verdict.
    const db = newLockDbPath();
    const held = await acquireShared(db, { role: "daemon" });
    const rendered = describeHolder(await readLockHolder(db));
    await held?.release();

    expect(rendered).toMatch(/Last acquired by daemon \(pid \d+\)/);
    expect(rendered).toMatch(/may be stale/);
    // Never the unqualified assertion it used to make.
    expect(rendered).not.toMatch(/Held by/);
  });

  it("acquireExclusiveIfPresent: a missing state directory reads `no-state-dir`, and is not created", async () => {
    // The shared missing-directory reading — one policy for the key
    // subcommands and the offline doctor, rather than each inventing its
    // own. `acquireExclusive` alone THROWS raw SQLITE_CANTOPEN here.
    const missing = join(newLockDbPath(), "..", "absent-dir", "m.lock.db");
    expect(existsSync(dirname(missing))).toBe(false);

    await expect(acquireExclusive(missing)).rejects.toThrow(); // the raw behavior
    expect(await acquireExclusiveIfPresent(missing)).toEqual({ outcome: "no-state-dir" });

    // Inspecting must never provision the directory (§3.2).
    expect(existsSync(dirname(missing))).toBe(false);
  });

  it("acquireExclusiveIfPresent: distinguishes acquired from busy on a directory that exists", async () => {
    const db = newLockDbPath();
    const first = await acquireExclusiveIfPresent(db, { role: "daemon" });
    expect(first.outcome).toBe("acquired");

    const second = await acquireExclusiveIfPresent(db);
    expect(second).toEqual({ outcome: "busy" });

    if (first.outcome === "acquired") await first.lock.release();
  });

  it("release() is idempotent — a second call is a no-op, not a ROLLBACK on a closed client", async () => {
    // Release lands in `finally` blocks and shutdown paths that can
    // plausibly run twice. Without the guard the second call issues
    // ROLLBACK on an already-closed client, which rejects with a
    // confusing libsql error from a caller that did nothing wrong — and
    // in a `finally` that would mask whatever real failure was being
    // unwound at the time.
    const db = newLockDbPath();
    const held = await acquireExclusive(db);
    expect(held).not.toBeNull();
    if (!held) throw new Error("expected the lock");

    await held.release();
    // The lock is genuinely released, not merely marked so.
    const second = await acquireExclusive(db);
    expect(second).not.toBeNull();
    if (second) await second.release();

    // The double release resolves rather than throwing.
    await expect(held.release()).resolves.toBeUndefined();
  });
});

/**
 * The widest transient the window must ride out: one holder-stamp commit
 * (journal write + fsync) on a loaded CI disk. Tens of milliseconds is the
 * observed order; 50 ms is the modelled bound the tests hold against.
 */
const WIDEST_COMMIT_MS = 50;

describe("probeShared — a transient write is not a rotation (design §3.5, the maintenance probe)", () => {
  // The §3.5 table reads "BUSY on a SHARED probe = an EXCLUSIVE holder =
  // rotation". That inference is sound for a HELD transaction and unsound
  // for an autocommit write: every commit in rollback-journal mode passes
  // through PENDING → EXCLUSIVE for the duration of its journal write and
  // fsync, and the daemon writes exactly such commits on the maintenance
  // lock db at startup (`stampHolder`) and shutdown (`clearHolder`). A
  // client probing with busy_timeout=0 inside that window misreads a
  // daemon coming up as a rotation in progress — and row 1 is fail-fast,
  // so there is no retry to recover from the misread. A rotation, by
  // contrast, holds EXCLUSIVE for its entire re-seal. The probe window
  // separates the two: a transient EXCLUSIVE clears inside it, a held one
  // does not.
  it("INVARIANT §17 / §3.5: an EXCLUSIVE released inside the probe window reads free — a write commit is not a rotation", async () => {
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("exclusive", db);
    await waitFor(async () => (await probeShared(db)) === "busy");

    // The holder (a separate process, as the committing daemon is in
    // production) is released at a FIXED point modelling the widest commit a
    // loaded CI disk has been observed to take — a literal, not a fraction
    // of the constant, so the assertion below is what pins the constant:
    // the window must cover a real commit with margin, and narrowing it to
    // where it no longer does fails HERE, not in the arithmetic. The release
    // is an in-process timer: the window is async by design (see the timer
    // test below), and a spawned killer's own startup latency on a loaded
    // runner is exactly the kind of skew this test must not depend on.
    //
    // A SIGKILL drop is HARDER than production's ordered commit unlock: it
    // leaves a hot journal the prober must roll back (an EXCLUSIVE of its
    // own) before its SHARED read can succeed. The commit-shaped release is
    // exercised separately by the stamp-loop test.
    expect(MAINTENANCE_PROBE_BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(WIDEST_COMMIT_MS * 3);
    setTimeout(() => holder.kill("SIGKILL"), WIDEST_COMMIT_MS);

    expect(await probeSharedWithin(db, MAINTENANCE_PROBE_BUSY_TIMEOUT_MS)).toBe("free");
  });

  it("probeSharedWithin never blocks the event loop — a timer armed in THIS process fires mid-window", async () => {
    // The reason the window is async timers and not SQLite's busy handler:
    // the handler sleeps inside the native call and stalls Node for the
    // whole wait (a probe with busy_timeout=2000 held an in-process 150 ms
    // timer hostage until it gave up — measured while building this fix).
    // With async re-probing, an in-process release lands on time, and so
    // does everything else the client process is doing meanwhile.
    const db = newLockDbPath();
    const held = await acquireExclusive(db);
    expect(held).not.toBeNull();
    if (!held) throw new Error("expected the lock");
    const releaseAtMs = Math.floor(MAINTENANCE_PROBE_BUSY_TIMEOUT_MS / 3);
    const started = Date.now();
    let firedAt = 0;
    setTimeout(() => {
      firedAt = Date.now();
      void held.release();
    }, releaseAtMs);

    expect(await probeSharedWithin(db, MAINTENANCE_PROBE_BUSY_TIMEOUT_MS)).toBe("free");
    // Total duration alone would let a sub-window blocking wait pass; the
    // timer's own firing time is the direct witness that the loop was
    // free to run it on schedule (generous slack for scheduling).
    expect(firedAt - started).toBeGreaterThanOrEqual(releaseAtMs);
    expect(firedAt - started).toBeLessThan(releaseAtMs + 60);
    expect(Date.now() - started).toBeLessThan(MAINTENANCE_PROBE_BUSY_TIMEOUT_MS);
  });

  it("INVARIANT §17 / §3.5: real holder-stamp COMMITS are ridden out — the production transient, not a SIGKILL stand-in", async () => {
    const db = newLockDbPath();
    // A child performs the daemon's exact maintenance acquisition in a tight
    // loop — stamp (autocommit write: PENDING → EXCLUSIVE → ordered unlock)
    // then SHARED hold then release — so the transient recurs continuously.
    await spawnHolder("stamp-loop", db);

    // Every windowed probe must read "free": the transient always clears
    // inside the shipped window. 40 probes span far more than one commit
    // period, so the probe meets the transient many times over. Whether a
    // given probe actually collided with a commit is not observable from
    // out here without a flaky "at least one raw BUSY" assertion; the
    // multi-probe behavior this relies on is pinned deterministically by
    // the SIGKILL-released and in-process-timer tests (a single-probe
    // implementation fails both), so this test's job is the commit-SHAPED
    // release — ordered unlock, no hot journal — not the collision count.
    for (let i = 0; i < 40; i++) {
      expect(await probeSharedWithin(db, MAINTENANCE_PROBE_BUSY_TIMEOUT_MS)).toBe("free");
    }
  });

  it("INVARIANT §17 / §3.5: an EXCLUSIVE held PAST the probe window still reads busy — rotation detection survives the window", async () => {
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("exclusive", db);
    await waitFor(async () => (await probeShared(db)) === "busy");

    const started = Date.now();
    expect(await probeSharedWithin(db, 200)).toBe("busy");
    // The answer is BUSY only after the window elapsed — the holder was
    // never released, so the probe waited the full window and then gave
    // the verdict a rotation deserves. (Lower bound only: scheduling under
    // load can only make it later.)
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);

    holder.kill("SIGKILL");
  });

  it("INVARIANT §17 / §3.5: the default probe stays fail-fast — no window unless a caller asks for one", async () => {
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("exclusive", db);
    await waitFor(async () => (await probeShared(db)) === "busy");

    const started = Date.now();
    expect(await probeShared(db)).toBe("busy");
    // busy_timeout=0: BUSY answers at once. The bound is generous against
    // CI scheduling; the point is "no 200ms-class wait was introduced".
    expect(Date.now() - started).toBeLessThan(100);

    holder.kill("SIGKILL");
  });
});
