import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DaemonUnavailable, daemonRequest, UNCORRELATED } from "./client.js";
import { daemonPaths } from "./conduitd.js";
import { encodeFrame, FRAME_CAP, FrameTooLarge } from "./frames.js";
import { bundleDaemonHelper, type HelperBundle } from "./helpers/bundle.js";
import { acquireExclusive, type HeldLock, probeShared } from "./locks.js";
import { DAEMON_LOG, daemonEntryPoint, daemonSpawnEnv, PLATFORM_PATH } from "./spawn.js";

/**
 * Real-process client tests (design §3.5 decision table, §5 retry rule,
 * §3.1 spawn boundary). Every lifecycle assertion here spawns a genuine
 * daemon child against a temp state dir: lock acquisition, socket bind,
 * READY timing, SIGKILL and process death are exercised by the kernel,
 * never simulated. Generous timeouts so a loaded machine reports a real
 * failure rather than a flake.
 */

const TIMEOUT = 60_000;

// Same bundling approach as conduitd.test.ts; see `helpers/bundle.ts`.
let HELPER = "";
let bundle: HelperBundle | undefined;

beforeAll(async () => {
  bundle = await bundleDaemonHelper();
  HELPER = bundle.helper;
}, TIMEOUT);

afterAll(() => {
  bundle?.cleanup();
});

let dir: string | undefined;
const children: ChildProcess[] = [];
const locks: HeldLock[] = [];

afterEach(async () => {
  await Promise.all(
    children.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      child.kill("SIGKILL");
      // Bounded, and SIGKILL is always re-sent above rather than skipped
      // when `killed` is already true: a child sent SIGTERM earlier may
      // still be draining, and `killed` only records that a signal was
      // delivered, not that the process is gone. A hung reap must never
      // take the whole hook down with it — the temp dir is removed
      // regardless, and a stray child cannot outlive the test run.
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }),
  );
  children.length = 0;
  for (const lock of locks) await lock.release();
  locks.length = 0;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
  // Generous: reaping a real daemon to actual exit can outlast vitest's
  // 10s hook default on a loaded machine, and a timed-out hook leaves a
  // daemon running against a directory the next test deletes.
}, TIMEOUT);

function newStateDir(): string {
  dir = mkdtempSync(join(tmpdir(), "cdc-"));
  return dir;
}

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * The spawn function injected into `daemonRequest` for tests. It launches
 * the SAME bundled daemon helper the conduitd tests use, against a temp
 * state dir — the production `spawnDaemon` targets `bin.js --daemon`,
 * which resolves `~/.conduit` and would touch a real database.
 *
 * The constructed-environment property of the real `spawnDaemon` is
 * asserted separately and directly, below, rather than through this
 * fixture: only the real function can prove its own env is an allowlist.
 */
function testSpawn(extraArgs: string[] = []): (stateDir: string) => void {
  return (stateDir: string) => {
    // Deliberately NOT detached, unlike the production spawn: the test
    // must be able to reap this child before its temp state dir is
    // removed, and a detached+unref'd child cannot be waited on here.
    // Detachment is a property of `spawnDaemon`, asserted in the spawn
    // boundary tests; this fixture only needs a daemon to talk to.
    const child = spawn(process.execPath, [HELPER, stateDir, ...extraArgs], {
      // stderr inherited so a daemon that fails to start says why in the
      // test output, instead of failing as an opaque deadline timeout.
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, CONDUIT_MASTER_KEY: TEST_KEY },
    });
    children.push(child);
  };
}

/** Spawns a daemon and waits for it to be serving, returning the child. */
async function runningDaemon(stateDir: string, extraArgs: string[] = []): Promise<ChildProcess> {
  const child = spawn(process.execPath, [HELPER, stateDir, ...extraArgs], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, CONDUIT_MASTER_KEY: TEST_KEY },
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon never reported listening")), TIMEOUT);
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}

describe("daemonRequest — the §3.5 decision table", () => {
  it(
    "INVARIANT §17: a client with no daemon auto-starts and completes its request",
    async () => {
      const stateDir = newStateDir();
      // Nothing is running and no lock is held — decision-table row 4.
      expect(await probeShared(daemonPaths(stateDir).lifecycleLockDb)).toBe("free");

      const response = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "anything" },
        deadlineMs: 45_000,
        spawn: testSpawn(),
      });

      // A real answer from a daemon this call started itself.
      expect(response.kind).toBe("result");
      expect(existsSync(daemonPaths(stateDir).socket)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a client auto-starts against a state directory that does not exist yet",
    async () => {
      // A fresh install: nothing has created `~/.conduit`. The client
      // must read this as decision-table row 4 (a lock nobody can open
      // is a lock nobody holds) and spawn, rather than dying on a raw
      // ENOENT out of the boundary check.
      const parent = newStateDir();
      const stateDir = join(parent, "nested", "conduit");
      expect(existsSync(stateDir)).toBe(false);
      // The probes read "free" against the missing directory rather than
      // throwing — the property that lets the loop reach row 4 at all.
      expect(await probeShared(daemonPaths(stateDir).lifecycleLockDb)).toBe("free");

      const response = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "anything" },
        deadlineMs: 45_000,
        spawn: testSpawn(),
      });

      expect(response.kind).toBe("result");
      expect(existsSync(daemonPaths(stateDir).socket)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a client connects as soon as a STARTING daemon binds, without waiting out its deadline",
    async () => {
      const stateDir = newStateDir();
      // A healthy daemon that holds the lifecycle lock for a while
      // before binding — the real window where the store opens and the
      // sweep runs. The client sees "lock held, nothing to connect to",
      // which is indistinguishable from DRAINING from outside.
      const delayMs = 4_000;

      const startedAt = Date.now();
      const response = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "anything" },
        // Far larger than the bind delay: if the wait only watched for
        // lifecycle RELEASE, it would burn this entire budget against a
        // daemon that came up fine seconds earlier.
        deadlineMs: 45_000,
        spawn: testSpawn(["--delay-bind-ms", String(delayMs)]),
      });
      const elapsed = Date.now() - startedAt;

      expect(response.kind).toBe("result");
      // Connected on the socket appearing, not on the deadline expiring.
      expect(elapsed).toBeLessThan(30_000);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a client fails fast during rotation and never spawns a daemon",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);

      // Rotation holds maintenance EXCLUSIVE — decision-table row 1.
      const rotation = await acquireExclusive(paths.maintenanceLockDb);
      expect(rotation).not.toBeNull();
      if (rotation) locks.push(rotation);

      let spawnCalls = 0;
      const started = Date.now();
      await expect(
        daemonRequest({
          stateDir,
          role: "serve",
          request: { kind: "search", query: "anything" },
          deadlineMs: 30_000,
          spawn: () => {
            spawnCalls++;
          },
        }),
      ).rejects.toThrow(DaemonUnavailable);

      // Fail FAST: no retry spin against a rotation that must be allowed
      // to finish, and above all no spawn — a daemon started now would
      // only exit "rotation in progress" itself.
      expect(spawnCalls).toBe(0);
      expect(Date.now() - started).toBeLessThan(10_000);
    },
    TIMEOUT,
  );

  it(
    "reports the rotation-in-progress code, distinct from a generic unavailability",
    async () => {
      const stateDir = newStateDir();
      const rotation = await acquireExclusive(daemonPaths(stateDir).maintenanceLockDb);
      if (rotation) locks.push(rotation);

      const err = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "x" },
        deadlineMs: 10_000,
        spawn: () => {},
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DaemonUnavailable);
      expect((err as DaemonUnavailable).code).toBe("rotation-in-progress");
    },
    TIMEOUT,
  );

  it(
    "connects to an already-running daemon without spawning a second one",
    async () => {
      const stateDir = newStateDir();
      await runningDaemon(stateDir);

      let spawnCalls = 0;
      const response = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "anything" },
        deadlineMs: 30_000,
        spawn: () => {
          spawnCalls++;
        },
      });

      expect(response.kind).toBe("result");
      expect(spawnCalls).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "spawns AT MOST ONCE — a spawn that starts nothing yields a typed refusal, not a spawn loop",
    async () => {
      // §3.5 says spawn-then-re-probe happens once. A second spawn after
      // a failed re-probe would mean something is wrong that another
      // process cannot fix, and repeated spawning is how fork bombs
      // happen. The injected spawn counts calls and deliberately starts
      // nothing, so every re-probe still lands on row 4 — exactly the
      // shape that would spin if the guard were absent.
      const stateDir = newStateDir();

      let spawnCalls = 0;
      const err = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "x" },
        // Short: the bound under test is the spawn COUNT, and the
        // deadline only has to be long enough to re-enter the table.
        deadlineMs: 2_000,
        spawn: () => {
          spawnCalls++;
        },
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DaemonUnavailable);
      expect((err as DaemonUnavailable).code).toBe("unavailable");
      // The terminal message must name the daemon's own log — the cause
      // is never on the wire, so without the path this is a dead end.
      expect((err as DaemonUnavailable).message).toContain(DAEMON_LOG);
      expect(spawnCalls).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "a client whose own env sets CONDUIT_DB is refused end-to-end with refused-custom-db",
    async () => {
      // Closes the seam between the two halves that were pinned
      // separately: the client DECLARES its CONDUIT_DB in the handshake
      // (rather than hiding it), and the daemon REFUSES that handshake.
      // Neither half alone proves a client carrying a custom db is
      // actually turned away through the real request path.
      const stateDir = newStateDir();
      await runningDaemon(stateDir);

      const previous = process.env.CONDUIT_DB;
      process.env.CONDUIT_DB = join(stateDir, "someone-elses.db");
      try {
        const response = await daemonRequest({
          stateDir,
          role: "serve",
          request: { kind: "search", query: "x" },
          deadlineMs: 30_000,
          spawn: () => {},
        });
        expect(response).toMatchObject({ kind: "error", code: "refused-custom-db" });
      } finally {
        if (previous === undefined) delete process.env.CONDUIT_DB;
        else process.env.CONDUIT_DB = previous;
      }
    },
    TIMEOUT,
  );

  it(
    "an oversized request is refused BEFORE connecting — never in the ambiguous zone",
    async () => {
      // The request is encoded up front, so a request too large to frame
      // fails while the client can still prove no daemon saw it. Throwing
      // from the write inside `exchange` instead would make an
      // impossible-to-succeed request indistinguishable from one that had
      // already gone out, i.e. a spurious outcome-unknown.
      const stateDir = newStateDir();

      let spawnCalls = 0;
      const err = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "execute", code: "x".repeat(FRAME_CAP + 1), deadlineMs: 1_000 },
        deadlineMs: 10_000,
        spawn: () => {
          spawnCalls++;
        },
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(FrameTooLarge);
      // Nothing was probed, spawned, or connected on the way to the
      // refusal — the whole point of encoding first.
      expect(spawnCalls).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "refuses a request whose kind falls outside the client's capability row",
    async () => {
      const stateDir = newStateDir();
      await runningDaemon(stateDir);

      // `serve` may not list approvals (§3.3) — the daemon's authorization
      // boundary, reached through the real client path.
      const response = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "approvals.list" },
        deadlineMs: 30_000,
        spawn: () => {},
      });

      expect(response).toMatchObject({ kind: "error", code: "invalid" });
    },
    TIMEOUT,
  );
});

describe("the READY-gate decoder handoff", () => {
  it(
    "does not lose a frame that arrives coalesced with READY in one chunk",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);

      // A stand-in daemon that writes READY and the handshake reply in a
      // SINGLE write, so both frames land in one chunk. The real daemon
      // cannot currently produce this — it is purely reactive after
      // READY — which is exactly why the client must not depend on that
      // timing. This is the regression pin for the decoder handoff:
      // before it, the READY gate's decoder was discarded along with
      // everything it had read past READY, and the client hung until its
      // deadline and reported a spurious outcome-unknown.
      const server = createServer((socket) => {
        socket.write(
          Buffer.concat([
            encodeFrame({ kind: "ready" }),
            encodeFrame({
              kind: "handshake.ok",
              protocol: 1,
              dbPath: paths.db,
              allowPrivateEgress: false,
            }),
          ]),
        );
        socket.once("data", () => {
          socket.write(encodeFrame({ kind: "result", requestId: "r1", payload: ["coalesced"] }));
        });
      });
      await new Promise<void>((resolve) => server.listen(paths.socket, resolve));

      // The client only takes the connect path when lifecycle reads busy.
      const lifecycle = await acquireExclusive(paths.lifecycleLockDb);
      expect(lifecycle).not.toBeNull();
      if (lifecycle) locks.push(lifecycle);

      try {
        const response = await daemonRequest({
          stateDir,
          role: "serve",
          request: { kind: "search", query: "anything" },
          deadlineMs: 15_000,
          spawn: () => {},
        });
        expect(response).toMatchObject({ kind: "result", payload: ["coalesced"] });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    TIMEOUT,
  );
});

describe("daemonRequest — the §5 retry rule", () => {
  it(
    "INVARIANT §17: a daemon killed after the request is written yields outcome-unknown, never a retry",
    async () => {
      const stateDir = newStateDir();
      // --stall-execute holds the request inside the manager layer, so
      // the daemon is killed strictly AFTER the request bytes are on the
      // wire and strictly BEFORE any response could be written — the
      // exact ambiguous window §5 defines.
      const daemon = await runningDaemon(stateDir, ["--stall-execute"]);

      let spawnCalls = 0;
      const pending = daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "execute", code: "return 1", deadlineMs: 20_000 },
        deadlineMs: 40_000,
        spawn: () => {
          spawnCalls++;
        },
      });

      // Give the request time to reach the daemon and stall there.
      await new Promise((r) => setTimeout(r, 1500));
      daemon.kill("SIGKILL");

      const response = await pending;

      // Scope, stated exactly: this pins the CLIENT-SIDE §5 contract —
      // once the request bytes are written and the connection then dies,
      // the client returns `outcome-unknown` and does not retry. It does
      // NOT pin that a real in-flight execution was ambiguous: the
      // fixture stubs `manager.start`, so no genuine work was running.
      // That the daemon's stranded row reaches a defined terminal state
      // is the separate invariant below.
      expect(response.kind).toBe("outcome-unknown");
      // Never re-attempted against a freshly spawned daemon.
      expect(spawnCalls).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "a client-synthesized outcome-unknown carries the uncorrelated sentinel when no id was ever assigned",
    async () => {
      const stateDir = newStateDir();
      const daemon = await runningDaemon(stateDir, ["--stall-execute"]);

      const pending = daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "execute", code: "return 1", deadlineMs: 20_000 },
        deadlineMs: 40_000,
        spawn: () => {},
      });
      await new Promise((r) => setTimeout(r, 1500));
      daemon.kill("SIGKILL");

      const response = await pending;
      // Correlation ids are daemon-assigned and none reached the client,
      // so the sentinel says the daemon-log lookup is impossible rather
      // than naming an id no log will ever contain.
      expect(response).toEqual({ kind: "outcome-unknown", requestId: UNCORRELATED });
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a killed daemon's running execution is terminalized on restart and never re-runs",
    async () => {
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      // --stall-running persists the execution row and THEN stalls, so
      // the row is durably `running` at the moment the process dies —
      // which is precisely the state a crashed daemon strands.
      const daemon = await runningDaemon(stateDir, ["--stall-running"]);

      // Drive a real execution into the daemon and let it stall there, so
      // the row is durably `running` when the process dies.
      const pending = daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "execute", code: "return 1", deadlineMs: 20_000 },
        deadlineMs: 40_000,
        spawn: () => {},
      });
      await new Promise((r) => setTimeout(r, 1500));
      daemon.kill("SIGKILL");
      expect((await pending).kind).toBe("outcome-unknown");
      await new Promise<void>((r) => daemon.once("exit", () => r()));

      const runningBefore = await runningIds(paths.db);
      expect(runningBefore.length).toBeGreaterThan(0);

      // Attribute a real audit row to the stranded execution, standing in
      // for the upstream call it had already made before the daemon died.
      // Seeding is what gives this assertion teeth: the stalled fixture
      // makes no upstream calls of its own, so a count that starts at
      // zero stays at zero even if the sweep DID replay — the comparison
      // would hold vacuously. Starting from a non-zero count means a
      // replay, which re-enters the pipeline and appends fresh trace
      // rows, moves the number and fails the test.
      const strandedId = runningBefore[0];
      if (strandedId === undefined) throw new Error("no stranded execution to seed");
      await seedTraceRow(paths.db, strandedId);
      const tracesBefore = await traceCount(paths.db);
      expect(tracesBefore).toBeGreaterThan(0);

      // Restart: the sweep runs after both locks and before bind.
      await runningDaemon(stateDir, ["--sweep-on-start"]);

      // The audit trail is untouched — nothing re-ran. A replay would
      // have appended at least one more row here.
      expect(await traceCount(paths.db)).toBe(tracesBefore);

      // Terminalized, and terminalized as AMBIGUOUS rather than as an
      // ordinary failure — the outcome genuinely is not known.
      expect(await runningIds(paths.db)).toHaveLength(0);
      for (const id of runningBefore) {
        const row = await executionRow(paths.db, id);
        expect(row.status).toBe("failed");
        expect(String(row.error)).toContain("ConduitOutcomeAmbiguous");
        // Never replayed: no result was invented for it.
        expect(row.result ?? null).toBeNull();
      }
    },
    TIMEOUT,
  );
});

describe("the §3.1 spawn boundary", () => {
  it(
    "INVARIANT §17: hostile client HOME/PATH/CONDUIT_* values are inert through auto-start",
    async () => {
      // Poison this process's own environment exactly as a hostile client
      // would, then run a child under the product's own constructed env
      // and inspect what that child actually received. Asserting on the
      // child's OBSERVED environment — not on the source of spawn.ts — is
      // what makes this a boundary test rather than a code-reading
      // exercise. No state dir is needed: the environment is constructed
      // from nothing, which is precisely the property under test.
      const poison = {
        HOME: "/tmp/hostile-home",
        PATH: "/tmp/hostile-bin",
        CONDUIT_DB: "/tmp/hostile.db",
        CONDUIT_MASTER_KEY: "aGF4eA==",
        CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1",
      };
      const saved = new Map<string, string | undefined>();
      for (const [k, v] of Object.entries(poison)) {
        saved.set(k, process.env[k]);
        process.env[k] = v;
      }

      try {
        // What a real child actually receives, observed from inside a
        // process spawned with the product's own constructed env — not a
        // re-implementation of it, and not a reading of spawn.ts.
        const childEnv = await observedChildEnv();

        // The allowlist, asserted as an allowlist: PATH is the
        // daemon-owned constant, and nothing the CLIENT could set is
        // present. The one key beyond PATH that may appear is
        // `__CF_USER_TEXT_ENCODING`, which macOS's own process spawn
        // injects below the Node API — it is not inherited from this
        // process's environment and carries no client-controlled value,
        // so it is named here rather than silently tolerated by a loose
        // assertion.
        expect(childEnv.PATH).toBe(PLATFORM_PATH);
        const injectedByOs = new Set(["__CF_USER_TEXT_ENCODING"]);
        expect(Object.keys(childEnv).filter((k) => !injectedByOs.has(k))).toEqual(["PATH"]);

        // Restated explicitly, because these are the specific smuggling
        // vectors §3.1 names — a future refactor that reintroduces any
        // one of them must fail on a line that says why.
        expect(childEnv.HOME).toBeUndefined();
        expect(childEnv.CONDUIT_DB).toBeUndefined();
        expect(childEnv.CONDUIT_MASTER_KEY).toBeUndefined();
        expect(childEnv.CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS).toBeUndefined();
        expect(Object.keys(childEnv).some((k) => k.startsWith("CONDUIT_"))).toBe(false);
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    },
    TIMEOUT,
  );

  it("resolves the daemon executable absolutely from the running package, never through PATH", () => {
    const entry = daemonEntryPoint();
    expect(entry.startsWith("/")).toBe(true);
    // It is this package's own bin, resolved from the location of the
    // running code — so a hostile PATH cannot substitute a different
    // executable for the long-lived daemon.
    expect(entry.endsWith("/bin.js")).toBe(true);
    expect(entry).toContain("/packages/mcp/");
  });

  it("sends daemon stdio to a log in the state directory, never the client's own streams", async () => {
    const stateDir = newStateDir();
    const logPath = join(stateDir, DAEMON_LOG);

    // The descriptor wiring, exercised with the product's own stdio
    // shape but a harmless child. `spawnDaemon` itself is NOT called
    // here on purpose: its child is `bin.js --daemon`, which resolves
    // the DEFAULT state directory and would start a real daemon over
    // the developer's own database.
    const logFd = openSync(logPath, "a", 0o600);
    const probe = spawn(process.execPath, ["-e", "console.log('daemon-side output')"], {
      cwd: stateDir,
      env: daemonSpawnEnv(),
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    children.push(probe);
    await new Promise<void>((resolve) => probe.once("exit", () => resolve()));
    closeSync(logFd);

    // Everything the child wrote landed in the state directory's log. For
    // an MCP client, stdout is a protocol stream — a daemon byte reaching
    // it would corrupt the client that started the daemon.
    expect(readFileSync(logPath, "utf8")).toContain("daemon-side output");
  });

  it(
    "an async spawn failure never crashes the client — it lands in the daemon log and the client reaches its typed refusal",
    async () => {
      // `spawn` reports fork/exec failures ASYNCHRONOUSLY, as an 'error'
      // event. An EventEmitter with no 'error' listener THROWS on emit,
      // so before the fix a broken install path (or EAGAIN/EPERM) took
      // down the whole client process — the exact failure the typed
      // `DaemonUnavailable` exists to report gracefully.
      //
      // Run in a real child so an unhandled 'error' would actually kill a
      // process (inside vitest it would only fail this file), with
      // `spawnDaemon`'s own descriptor/stdio shape and an entry point
      // that cannot be executed.
      const stateDir = newStateDir();
      const logPath = join(stateDir, DAEMON_LOG);
      const unspawnable = join(stateDir, "does-not-exist-anywhere");

      const script = `
        import { closeSync, openSync, writeSync } from "node:fs";
        import { spawn } from "node:child_process";
        const logFd = openSync(${JSON.stringify(logPath)}, "a", 0o600);
        const child = spawn(${JSON.stringify(unspawnable)}, ["--daemon"], {
          cwd: ${JSON.stringify(stateDir)},
          stdio: ["ignore", logFd, logFd],
          detached: true,
        });
        // Mirrors spawn.ts's handler, including the log-fd-then-stderr
        // fallback ordering.
        child.once("error", (err) => {
          const line = "[conduitd] Daemon spawn failed: " + err.code + ": " + err.message + "\\n";
          try { writeSync(logFd, line); } catch { try { process.stderr.write(line); } catch {} }
        });
        child.unref();
        try { closeSync(logFd); } catch {}
        // Survive long enough for the async 'error' to be delivered. If
        // it were unhandled, this process would die before printing.
        setTimeout(() => { console.log("CLIENT SURVIVED"); process.exit(0); }, 750);
      `;

      const probe = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(probe);
      let out = "";
      let errOut = "";
      probe.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      probe.stderr?.on("data", (chunk: Buffer) => {
        errOut += chunk.toString("utf8");
      });
      const exitCode = await new Promise<number | null>((resolve) =>
        probe.once("exit", (code) => resolve(code)),
      );

      // The property under test: an unhandled 'error' would have killed
      // this process before it could print anything.
      expect(out).toContain("CLIENT SURVIVED");
      expect(exitCode).toBe(0);

      // The failure is REPORTED rather than lost. The log fd is closed in
      // `spawnDaemon`'s `finally` before the async 'error' is delivered,
      // so in practice the write fails EBADF and the stderr fallback
      // carries it — which is exactly why the fallback exists rather than
      // being decorative. Either destination satisfies the contract:
      // the diagnosis must not vanish.
      const reported = `${errOut}${readFileSync(logPath, "utf8")}`;
      expect(reported).toContain("Daemon spawn failed");
      expect(reported).toContain("ENOENT");
    },
    TIMEOUT,
  );
});

/**
 * Runs a probe process under the PRODUCT's constructed environment and
 * reports the env that process actually observes.
 *
 * `daemonSpawnEnv()` is the exact value `spawnDaemon` passes, so this
 * observes the real allowlist rather than a copy of it — and it observes
 * it from inside a child, where `process.env` reflects what the kernel
 * delivered, not what the parent intended.
 */
function observedChildEnv(): Promise<NodeJS.ProcessEnv> {
  return new Promise((resolve, reject) => {
    const probe = spawn(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], {
      stdio: ["ignore", "pipe", "inherit"],
      env: daemonSpawnEnv(),
    });
    children.push(probe);
    let out = "";
    probe.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    probe.once("error", reject);
    probe.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`env probe exited ${code}`));
        return;
      }
      resolve(JSON.parse(out.trim()) as NodeJS.ProcessEnv);
    });
  });
}

/**
 * Writes one audit row against `executionId`, standing in for an upstream
 * call the execution had already made when its daemon was killed. Written
 * directly rather than through the store seam because the point is to
 * establish a non-zero baseline, not to exercise the write path.
 */
async function seedTraceRow(dbPath: string, executionId: string): Promise<void> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    await client.execute({
      sql: `INSERT INTO trace_events
              (call_id, execution_id, tool_name, connection_prefix, input, policy_verdict, at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [`call_${executionId}`, executionId, "ns.tool", "ns", "{}", "allow", Date.now()],
    });
  } finally {
    client.close();
  }
}

/** Rows in the audit trail — one per upstream tool call (§11). */
async function traceCount(dbPath: string): Promise<number> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const rs = await client.execute("SELECT count(*) AS n FROM trace_events");
    return Number(rs.rows[0]?.n ?? 0);
  } finally {
    client.close();
  }
}

/** Reads execution ids still `running` straight from the daemon's db. */
async function runningIds(dbPath: string): Promise<string[]> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const rs = await client.execute("SELECT id FROM executions WHERE status = 'running'");
    return rs.rows.map((row) => String(row.id));
  } finally {
    client.close();
  }
}

async function executionRow(
  dbPath: string,
  id: string,
): Promise<{ status: string; error: unknown; result: unknown }> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const rs = await client.execute({
      sql: "SELECT status, error, result FROM executions WHERE id = ?",
      args: [id],
    });
    const row = rs.rows[0];
    if (!row) throw new Error(`no execution row ${id}`);
    return { status: String(row.status), error: row.error, result: row.result };
  } finally {
    client.close();
  }
}
