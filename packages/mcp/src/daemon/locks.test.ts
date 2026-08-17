import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { acquireExclusive, acquireShared, probeShared } from "./locks.js";

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
  mode: "shared" | "exclusive",
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
