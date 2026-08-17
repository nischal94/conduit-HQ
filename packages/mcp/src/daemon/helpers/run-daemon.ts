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
import { FRAME_CAP } from "../frames.ts";
import { sweepOrphanedExecutions } from "../sweep.ts";

const [, , stateDir, ...rest] = process.argv;

if (!stateDir) {
  console.error("run-daemon: missing stateDir argument");
  process.exit(1);
}

const markerFlag = rest.indexOf("--sweep-marker");
const sweepMarker = markerFlag === -1 ? undefined : rest[markerFlag + 1];
const stallSweep = rest.includes("--stall-sweep");
const stallExecute = rest.includes("--stall-execute");
/**
 * Stalls BOTH `start` and `resume` inside the manager layer, so one
 * daemon can have its concurrency cap filled by executes and then be
 * handed an `approvals.resume` that must queue behind them. Distinct from
 * --stall-execute, which only stalls start and so cannot exercise the
 * resume dispatch path at all.
 */
const stallSandbox = rest.includes("--stall-sandbox");
const stallRunning = rest.includes("--stall-running");
/** manager.start rejects — the store-fault path that must not kill the daemon. */
const throwExecute = rest.includes("--throw-execute");
/** manager.start returns a legal result too large for one IPC frame. */
const hugeExecute = rest.includes("--huge-execute");
/** Delays the bind so a client sees a healthy STARTING daemon. */
const delayBindFlag = rest.indexOf("--delay-bind-ms");
const delayBindMs = delayBindFlag === -1 ? 0 : Number(rest[delayBindFlag + 1] ?? 0);
/**
 * Seeds one source/integration/connection/secret so `catalog.listing` has
 * something to project. Written through the sweep seam because that is the
 * one hook that runs with the daemon's OWN store, after both locks are held
 * and before the endpoint is bound — so the rows are durably in place
 * before any client can connect, with no second opener involved.
 *
 * The seeded connection deliberately carries a `credentialRef` pointing at
 * a real stored secret: the §3.3.1 assertion is that neither ever reaches
 * the wire, which is vacuous unless they actually exist.
 */
const seedCatalog = rest.includes("--seed-catalog");

/** Never settles — the caller is expected to be killed, not to wait. */
function forever(): Promise<never> {
  return new Promise<never>(() => {});
}

/**
 * With --sweep-on-start the REAL crash-terminal sweep is wired into the
 * seam, exactly as `bin.ts` wires it for a production daemon. The
 * marker/stall variants below stay synthetic because they test WHERE the
 * seam fires, not what the sweep does.
 */
const realSweep = rest.includes("--sweep-on-start");

const sweep: CrashTerminalSweep | undefined = seedCatalog
  ? async (store) => {
      await store.sources.upsert({
        id: "src_gh",
        type: "mcp",
        namespace: "github",
        location: "http://127.0.0.1:1/mcp",
      });
      await store.integrations.upsert({
        id: "int_gh",
        sourceId: "src_gh",
        namespace: "github",
      });
      await store.connections.upsert({
        id: "conn_gh",
        integrationId: "int_gh",
        prefix: "github.acme.prod",
        credentialRef: "cred_gh",
      });
      await store.secrets.put("cred_gh", "Bearer ghp_seeded_secret_do_not_leak");
      console.log("seeded catalog");
    }
  : realSweep
    ? async (store) => {
        await sweepOrphanedExecutions(store, (line) => {
          console.log(line);
        });
      }
    : stallSweep || sweepMarker !== undefined || delayBindMs > 0
      ? async () => {
          if (sweepMarker !== undefined) writeFileSync(sweepMarker, "swept");
          if (delayBindMs > 0) {
            // Holds startup in the window a real daemon occupies while the
            // store opens and the sweep runs: lifecycle lock HELD, socket
            // not yet bound. A client probing here sees "busy" with nothing
            // to connect to — the healthy STARTING state.
            console.log("delaying bind");
            await new Promise((resolve) => setTimeout(resolve, delayBindMs));
          }
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
const createRuntime = stallSandbox
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
          resume: () => {
            // Only ever reached if the resume was DISPATCHED. With the
            // cap already full it must instead sit in the queue, so the
            // absence of this line is the assertion.
            console.log("stalling resume");
            return forever();
          },
        },
      };
    }
  : throwExecute
    ? async (runtimeOpts: Parameters<typeof createApprovalRuntime>[0]) => {
        const built = await createApprovalRuntime(runtimeOpts);
        return {
          ...built,
          manager: {
            ...built.manager,
            // Rejects the way a store fault would. Reached from INSIDE the
            // queue's run closure, which is invoked as `void dispatch(...)`
            // — so before the fix this became an unhandled rejection and
            // took the whole daemon down with it.
            start: () => {
              console.log("throwing execute");
              return Promise.reject(new Error("simulated store fault"));
            },
          },
        };
      }
    : hugeExecute
      ? async (runtimeOpts: Parameters<typeof createApprovalRuntime>[0]) => {
          const built = await createApprovalRuntime(runtimeOpts);
          return {
            ...built,
            manager: {
              ...built.manager,
              // A perfectly legal result that simply does not fit one
              // frame. The sandbox's default maxOutputBytes EQUALS
              // FRAME_CAP, so the envelope around a max-size payload
              // necessarily overflows — no hostile input required.
              //
              // Returns a real `completed` ExecutionOutcome rather than a
              // bare object: since D-B1 the daemon projects the outcome
              // through `outcomeToPayload` BEFORE framing, and a shape
              // with no `status` projects to `undefined` — which frames
              // small and would make this test pass while pinning nothing.
              start: async () => {
                console.log("huge execute");
                return {
                  status: "completed",
                  executionId: "exec_huge",
                  value: { oversize: "x".repeat(FRAME_CAP) },
                } as never;
              },
            },
          };
        }
      : stallExecute
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
        : stallRunning
          ? async (runtimeOpts: Parameters<typeof createApprovalRuntime>[0]) => {
              const built = await createApprovalRuntime(runtimeOpts);
              return {
                ...built,
                manager: {
                  ...built.manager,
                  // Unlike --stall-execute, this PERSISTS the execution row
                  // first and stalls afterwards, leaving the row durably
                  // `running` — the state a SIGKILLed daemon actually strands,
                  // and the precondition the crash-terminal sweep recovers.
                  // Stalling before the write would leave nothing to sweep.
                  start: async (code: string) => {
                    await runtimeOpts.store.executions.put({
                      id: `exec_stalled_${Date.now()}`,
                      code,
                      status: "running",
                      seeds: { now: Date.now(), random: 0.5 },
                      startedAt: Date.now(),
                    });
                    console.log("stalling running");
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
