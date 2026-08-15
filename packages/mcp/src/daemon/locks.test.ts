import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireExclusive, probeShared } from "./locks.js";

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

afterEach(() => {
  for (const child of children) {
    if (!child.killed) child.kill("SIGKILL");
  }
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

describe("locks.ts (design §3.5 — SQLite lock primitive)", () => {
  it("INVARIANT §17: lock-db-shared-blocks-exclusive-through-libsql", async () => {
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("shared", db);

    expect(await acquireExclusive(db)).toBeNull();

    holder.kill("SIGKILL");
    await waitFor(async () => (await acquireExclusive(db)) !== null);
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
    await waitFor(async () => (await acquireExclusive(db)) !== null);
  });

  it("INVARIANT §17: lock-db-sibling-connection-close-does-not-release-lock", async () => {
    const db = newLockDbPath();
    const { child: holder } = await spawnHolder("exclusive", db);

    // A second, unrelated client opens and closes against the SAME file
    // while the hold lives — must not disturb the held lock.
    expect(await probeShared(db)).toBe("busy");
    expect(await probeShared(db)).toBe("busy");
    expect(await acquireExclusive(db)).toBeNull();

    holder.kill("SIGKILL");
    await waitFor(async () => (await acquireExclusive(db)) !== null);
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
    await waitFor(async () => (await acquireExclusive(db)) !== null);

    // Confirm the grandchild really did outlive its parent's death, then
    // clean it up — it is not attached to our children[] kill list.
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();
    process.kill(grandchildPid, "SIGKILL");
  });
});
