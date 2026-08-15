/**
 * Real-process test fixture: runs a daemon against the given state
 * directory until killed or signalled. Spawned by conduitd.test.ts via
 * `process.execPath` — Node 22's native TypeScript support runs this file
 * directly, no build step needed.
 *
 * Usage: node run-daemon.ts <stateDir> [--sweep-marker <path>]
 *
 * Every lifecycle line the daemon logs goes to stdout (one per line) so
 * the parent test can wait on a specific transition — "ready", "draining",
 * "stopped", "already running", "rotation in progress" — rather than
 * sleeping and hoping. Refusal exits carry the daemon's own exit code, so
 * the parent asserts on the code rather than scraping prose.
 *
 * With --sweep-marker, a crash-terminal sweep is passed into the seam that
 * writes the given path when it runs; the parent asserts the file exists
 * to prove the sweep executed at its point in the startup order.
 *
 * This file imports its siblings with explicit `.ts` extensions (see
 * hold-lock.ts for the reasoning), which `tsc` rejects without
 * `allowImportingTsExtensions` — so it is excluded from the package
 * tsconfig. It is never built or imported by product code.
 */
import { writeFileSync } from "node:fs";
// Explicit .ts extensions: run directly via `process.execPath` under
// Node's native TypeScript support, never compiled by tsup, so Node's ESM
// resolver needs the literal on-disk extension.
import { createApprovalRuntime } from "../../runtime.ts";
import { type CrashTerminalSweep, DaemonExit, runDaemon } from "../conduitd.ts";

const [, , stateDir, ...rest] = process.argv;

if (!stateDir) {
  console.error("run-daemon: missing stateDir argument");
  process.exit(1);
}

const markerFlag = rest.indexOf("--sweep-marker");
const sweepMarker = markerFlag === -1 ? undefined : rest[markerFlag + 1];
const stallSweep = rest.includes("--stall-sweep");
const stallExecute = rest.includes("--stall-execute");

/** Never settles — the caller is expected to be killed, not to wait. */
function forever(): Promise<never> {
  return new Promise<never>(() => {});
}

const sweep: CrashTerminalSweep | undefined =
  stallSweep || sweepMarker !== undefined
    ? async () => {
        if (sweepMarker !== undefined) writeFileSync(sweepMarker, "swept");
        if (stallSweep) {
          // Blocks startup after both locks are held and before bind —
          // the window where a signal must still unwind cleanly.
          console.log("stalling sweep");
          await forever();
        }
      }
    : undefined;

/**
 * Stalls one execution inside the store/manager layer, which §16's
 * sandbox budgets do not bound — the case a bounded drain exists for.
 * Supplied through the daemon's own `createRuntime` seam, so the daemon
 * under test is the real one with only this collaborator replaced.
 */
const createRuntime = stallExecute
  ? async (runtimeOpts: Parameters<typeof createApprovalRuntime>[0]) => {
      const built = await createApprovalRuntime(runtimeOpts);
      return {
        ...built,
        manager: {
          ...built.manager,
          start: () => {
            console.log("stalling execute");
            return forever();
          },
        },
      };
    }
  : undefined;

try {
  await runDaemon({
    stateDir,
    ...(sweep !== undefined ? { sweep } : {}),
    ...(createRuntime !== undefined ? { createRuntime } : {}),
    // stdout, not stderr: the parent reads these as the readiness
    // protocol, and mixing them with Node's own stderr noise would make
    // the line-oriented wait fragile.
    log: (line: string) => {
      console.log(line);
    },
  });
  process.exit(0);
} catch (err) {
  if (err instanceof DaemonExit) {
    process.exit(err.code);
  }
  console.error(`run-daemon: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
}
