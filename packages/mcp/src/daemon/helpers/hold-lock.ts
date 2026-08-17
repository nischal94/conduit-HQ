/**
 * Real-process test fixture: acquires a lock on the given lock-db path and
 * holds it forever (until killed). Spawned by locks.test.ts via
 * `process.execPath` — Node 22's native TypeScript support runs this file
 * directly, no build step needed.
 *
 * Usage: node hold-lock.ts <shared|exclusive> <lockDbPath> [--spawn-grandchild]
 *
 * Prints "HELD\n" to stdout once the lock is acquired (the parent waits on
 * this line before proceeding), then sleeps forever. With
 * --spawn-grandchild, this process spawns its own detached sleeping child
 * BEFORE printing "HELD\n" and prints the grandchild's pid on a second
 * line — used by the orphan-child SIGKILL test to prove the lock releases
 * on this process's death even while an unrelated descendant keeps running.
 *
 * This file imports its sibling with an explicit `.ts` extension (see
 * below), which `tsc` rejects without `allowImportingTsExtensions` — so
 * it is excluded from the package tsconfig (packages/mcp/tsconfig.json).
 * It is never built or imported by product code; vitest type-checks it
 * independently when running locks.test.ts.
 */
import { spawn } from "node:child_process";
// Explicit .ts extension (not the usual .js convention): this file is a
// test-only fixture run directly via `process.execPath` under Node's
// native TypeScript support, never compiled by tsup, so Node's ESM
// resolver needs the literal on-disk extension.
import { acquireExclusive, acquireShared } from "../locks.ts";

const [, , mode, lockDbPath, flag] = process.argv;

if (mode !== "shared" && mode !== "exclusive") {
  console.error(`hold-lock: unknown mode "${mode}" (expected "shared" or "exclusive")`);
  process.exit(1);
}
if (!lockDbPath) {
  console.error("hold-lock: missing lockDbPath argument");
  process.exit(1);
}

if (flag === "--spawn-grandchild") {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
    stdio: "ignore",
    detached: true,
  });
  grandchild.unref();
  console.log(String(grandchild.pid));
}

const held =
  mode === "exclusive" ? await acquireExclusive(lockDbPath) : await acquireShared(lockDbPath);

if (!held) {
  console.error(`hold-lock: could not acquire ${mode} lock on ${lockDbPath} (BUSY)`);
  process.exit(1);
}

console.log("HELD");

// Sleep forever — the parent test kills this process to release the lock.
// A bare `await new Promise(() => {})` does NOT keep the event loop alive
// (an unresolved promise registers no pending work), so the process would
// exit almost immediately and silently release the lock. setInterval is a
// genuine keep-alive handle.
setInterval(() => {}, 1 << 30);
