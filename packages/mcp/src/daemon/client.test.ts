import { type ChildProcess, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONDUIT_DIR } from "../env.js";
import {
  DaemonUnavailable,
  daemonRequest,
  isDefaultStateDir,
  LIFECYCLE_WAIT_POLL_MS_FOR_TEST,
  MIN_PASS_BUDGET_MS,
  resolveEffectiveStateDir,
  sameDirectoryIdentity,
  UNCORRELATED,
} from "./client.js";
import { daemonPaths } from "./conduitd.js";
import { encodeFrame, FRAME_CAP, FrameTooLarge } from "./frames.js";
import { bundleDaemonHelper, type HelperBundle } from "./helpers/bundle.js";
import {
  acquireExclusive,
  type HeldLock,
  MAINTENANCE_PROBE_BUSY_TIMEOUT_MS,
  probeShared,
} from "./locks.js";
import { DAEMON_LOG, daemonEntryPoint, daemonSpawnEnv, PLATFORM_PATH } from "./spawn.js";
import { StateDirError } from "./state-dir.js";

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
    "INVARIANT §17 / §3.1: autoStart:false on a custom state dir REFUSES with the by-hand command and spawns NO daemon (F5)",
    async () => {
      // The §3.1 spawn boundary: `spawnDaemon` receives only `--daemon` and
      // derives the DEFAULT state dir — it cannot be handed a client-chosen
      // dir. So auto-starting for a custom `--state-dir` would spawn a
      // default-dir daemon while this call polls the custom dir forever. A
      // caller on a custom dir passes autoStart:false, and finding no daemon
      // becomes an actionable refusal, not a misdirected spawn.
      const stateDir = newStateDir();
      // Row 4: nothing running, no lock held — the spawn case.
      expect(await probeShared(daemonPaths(stateDir).lifecycleLockDb)).toBe("free");

      let spawnCalls = 0;
      let caught: unknown;
      try {
        await daemonRequest({
          stateDir,
          role: "serve",
          request: { kind: "search", query: "anything" },
          deadlineMs: 30_000,
          autoStart: false,
          spawn: () => {
            spawnCalls++;
          },
        });
        throw new Error("expected a DaemonUnavailable");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(DaemonUnavailable);
      const message = (caught as DaemonUnavailable).message;
      // Names the exact by-hand start command for THIS custom dir.
      expect(message).toContain(`conduit-mcp --daemon --state-dir ${stateDir}`);
      expect(message).toContain("auto-start is disabled for custom directories");
      // And crucially: NO default-dir daemon was spawned.
      expect(spawnCalls).toBe(0);
      expect(existsSync(daemonPaths(stateDir).socket)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "autoStart defaults to on — an injected spawn seam auto-starts without an explicit autoStart (F5 regression guard)",
    async () => {
      // The boundary must not accidentally disable the common path. An
      // injected `spawn` seam is a caller that has taken explicit ownership
      // of WHERE the daemon starts (production's zero-arg `spawnDaemon`
      // reaches this only for the default dir), so a spawn is permitted
      // through it with autoStart left unset.
      const stateDir = newStateDir();
      const response = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "anything" },
        deadlineMs: 45_000,
        spawn: testSpawn(),
      });
      expect(response.kind).toBe("result");
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: auto-start targets only the canonical default state directory — a production request (no injected spawn) on a CUSTOM dir REFUSES and spawns nothing (F5 structural)",
    async () => {
      // The structural half of F5: the boundary is a property of
      // `daemonRequest`, not of caller discipline. With NO injected spawn
      // seam (the production path) and a custom `stateDir`, the request must
      // refuse at row 4 with the by-hand command — even with autoStart unset
      // and even with autoStart:true, because the zero-argument production
      // `spawnDaemon` can only ever start the DEFAULT-dir daemon, which would
      // answer nobody. The refusal is checked for EVERY client role, since a
      // new caller in any role must be safe without reasoning about the gate.
      for (const role of ["serve", "approvals", "add-mcp"] as const) {
        const stateDir = newStateDir();
        // Row 4: nothing running, no lock held.
        expect(await probeShared(daemonPaths(stateDir).lifecycleLockDb)).toBe("free");

        // autoStart deliberately UNSET — the default must be safe.
        const err = await daemonRequest({
          stateDir,
          role,
          request: { kind: "search", query: "anything" },
          deadlineMs: 30_000,
          // No `spawn` seam: this is the production path.
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(DaemonUnavailable);
        const message = (err as DaemonUnavailable).message;
        expect(message).toContain(`conduit-mcp --daemon --state-dir ${stateDir}`);
        expect(message).toContain("auto-start is disabled for custom directories");
        // No daemon was ever started against this custom dir — no socket
        // appeared, and no default-dir daemon was misdirected here.
        expect(existsSync(daemonPaths(stateDir).socket)).toBe(false);

        // And autoStart:true cannot OPEN a spawn the gate forbids for a
        // custom production dir — the child would still derive the wrong dir.
        const errForced = await daemonRequest({
          stateDir,
          role,
          request: { kind: "search", query: "anything" },
          deadlineMs: 30_000,
          autoStart: true,
        }).catch((e: unknown) => e);
        expect(errForced).toBeInstanceOf(DaemonUnavailable);
        expect(existsSync(daemonPaths(stateDir).socket)).toBe(false);

        rmSync(stateDir, { recursive: true, force: true });
      }
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
    "INVARIANT §17 / §3.5: a TRANSIENT exclusive on maintenance does not refuse a healthy auto-start — row 1 rides out a commit-length hold and the request completes",
    async () => {
      // The CI red on docs-only PR #51, reproduced at the layer where it
      // lived: the daemon's own holder-stamp commit is a transient EXCLUSIVE
      // on the maintenance lock db, and a zero-timeout row-1 probe read it
      // as rotation — terminally, since row 1 never retries. Here an
      // EXCLUSIVE that clears inside the shipped window stands in for that
      // commit, held and released by INDEPENDENT processes (SQLite's busy
      // handler blocks this process's event loop for the wait, so nothing
      // scheduled here could release it in time).
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const helper = fileURLToPath(new URL("./helpers/hold-lock.ts", import.meta.url));
      const holder = spawn(process.execPath, [helper, "exclusive", paths.maintenanceLockDb], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      await new Promise<void>((resolveHeld) => {
        holder.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("HELD")) resolveHeld();
        });
      });
      expect(await probeShared(paths.maintenanceLockDb)).toBe("busy");
      // Released at a fifth of the window: derived from the constant so a
      // narrowed constant fails here, with a 4/5 margin for CI scheduling.
      const releaseAtMs = Math.floor(MAINTENANCE_PROBE_BUSY_TIMEOUT_MS / 5);
      spawn(
        process.execPath,
        ["-e", `setTimeout(() => process.kill(${holder.pid}, "SIGKILL"), ${releaseAtMs})`],
        { stdio: "ignore" },
      );

      let spawnCalls = 0;
      const realSpawn = testSpawn();
      const response = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "anything" },
        deadlineMs: 45_000,
        spawn: (dir) => {
          spawnCalls++;
          realSpawn(dir);
        },
      });

      // Not refused as rotation: the client rode out the transient, took
      // row 4, started a daemon, and got a real answer from it.
      expect(response.kind).toBe("result");
      expect(spawnCalls).toBe(1);
      expect(existsSync(paths.socket)).toBe(true);
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
    "INVARIANT §17: a request refused during rotation leaves the spawn budget intact for the next one",
    async () => {
      // The rotation WINDOW, end to end — the case behind the Codex P2
      // note on the spawn-once policy: a client that attempted while
      // maintenance was held must not have spent anything that would
      // leave it unable to start a daemon once rotation finishes.
      //
      // Both halves matter and neither alone proves it. The refusal half
      // pins fail-fast-with-no-spawn; the release half pins that a FRESH
      // request afterwards still auto-starts normally. A policy that
      // consumed the budget during the refused window would pass the
      // first half and fail the second.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);

      const rotation = await acquireExclusive(paths.maintenanceLockDb);
      expect(rotation).not.toBeNull();

      let spawnCalls = 0;
      const spawn = testSpawn();
      const counting = (dir: string): void => {
        spawnCalls++;
        spawn(dir);
      };

      // Half 1: refused while rotation holds maintenance EXCLUSIVE, and
      // nothing was spawned on the way to the refusal.
      const err = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "x" },
        deadlineMs: 10_000,
        spawn: counting,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DaemonUnavailable);
      expect((err as DaemonUnavailable).code).toBe("rotation-in-progress");
      expect(spawnCalls).toBe(0);

      // Rotation finishes and releases the maintenance lock.
      await rotation?.release();

      // Half 2: the very next request auto-starts and completes. Nothing
      // about the refused attempt closed the path back.
      const response = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "anything" },
        deadlineMs: 45_000,
        spawn: counting,
      });
      expect(response.kind).toBe("result");
      expect(spawnCalls).toBe(1);
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
    "INVARIANT §17: the spawn budget is ONE regardless of how long the deadline allows re-entry",
    async () => {
      // The companion to the test above, and the one that actually pins
      // the budget against a TIME-bounded decision loop. That test uses a
      // 2s deadline, which the retired fixed pass count (MAX_PASSES = 4)
      // would have bounded on its own — so it could pass without the
      // spawn guard being load-bearing at all. Re-entry is now bounded by
      // the caller's deadline instead, so the honest question is what
      // happens when the deadline leaves room for MANY re-entries.
      //
      // The injected spawn deliberately starts nothing, so every single
      // re-entry lands on row 4 again — precisely the shape that becomes
      // a fork bomb if the once-only guard is anything other than
      // unconditional.
      const stateDir = newStateDir();

      let spawnCalls = 0;
      const err = await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "x" },
        // Long enough for dozens of passes at the poll interval.
        deadlineMs: 15_000,
        spawn: () => {
          spawnCalls++;
        },
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DaemonUnavailable);
      expect((err as DaemonUnavailable).code).toBe("unavailable");
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

describe("the auto-start default-dir gate — filesystem identity (Codex ARC pass 3)", () => {
  // A scaffold whose layout the identity check must see through. `base`
  // stands in for the parent of a canonical default; every path below is
  // built relative to a THROWAWAY default so no test touches the real
  // `~/.conduit`. The gate compares against a passed-in `defaultDir` via
  // `sameDirectoryIdentity` — the exact function `isDefaultStateDir` calls
  // with `DEFAULT_CONDUIT_DIR`, so this exercises the production predicate,
  // not a re-implementation of it.
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cdc-idgate-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("INVARIANT §17: auto-start targets only the canonical default state dir, by filesystem identity — a symlink+`..` into a custom 0700 dir does NOT classify as default", () => {
    // THE ATTACK. `<default>/link` is a symlink into a custom directory,
    // and the client is pointed at `<default>/link/..`. `path.resolve`
    // (the OLD gate) collapses `link/..` LEXICALLY to `<default>` and would
    // classify it as the default — but a real filesystem operation
    // resolves `link` through the symlink first, so `assertStateDir` /
    // `daemonPaths` operate on a DIFFERENT directory than the lexical
    // default. The identity gate compares the object the kernel actually
    // lands on, so the spoof is refused.
    const defaultDir = join(base, "default");
    const custom = join(base, "custom");
    mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    mkdirSync(custom, { recursive: true, mode: 0o700 });
    symlinkSync(custom, join(defaultDir, "link"));

    const attack = `${defaultDir}/link/..`;

    // The old lexical check WOULD have accepted this — the exact bug.
    expect(resolve(attack)).toBe(resolve(defaultDir));
    // The identity check refuses it: a real fs op on `attack` does not land
    // on the default directory's inode.
    expect(sameDirectoryIdentity(attack, defaultDir)).toBe(false);
  });

  it("INVARIANT §17: a genuine default still classifies as default — the legitimate auto-start path is not over-tightened (existing dir, and not-yet-existing fresh install)", () => {
    // An existing real default is default.
    const existingDefault = join(base, "default-exists");
    mkdirSync(existingDefault, { recursive: true, mode: 0o700 });
    expect(sameDirectoryIdentity(existingDefault, existingDefault)).toBe(true);

    // A FRESH INSTALL: the default does not exist yet. The gate must still
    // classify the default constant as default (both genuinely absent,
    // identical canonical form) so a first-run auto-start is not broken.
    const freshDefault = join(base, "nested", "default-fresh");
    expect(existsSync(freshDefault)).toBe(false);
    expect(sameDirectoryIdentity(freshDefault, freshDefault)).toBe(true);
  });

  it("INVARIANT §17: a plain custom dir (no symlink trick) is still refused — no regression", () => {
    const defaultDir = join(base, "default");
    const custom = join(base, "custom");
    mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    mkdirSync(custom, { recursive: true, mode: 0o700 });
    expect(sameDirectoryIdentity(custom, defaultDir)).toBe(false);
  });

  it("INVARIANT §17: a trailing slash and a `.` spelling of the REAL default still classify default — identity, not string", () => {
    const defaultDir = join(base, "default");
    mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    expect(sameDirectoryIdentity(`${defaultDir}/`, defaultDir)).toBe(true);
    expect(sameDirectoryIdentity(join(defaultDir, "."), defaultDir)).toBe(true);
    // A symlink whose target IS the default is a legitimate alias — same
    // inode, so it classifies default (unlike the symlink-to-CUSTOM above).
    const aliasToDefault = join(base, "alias");
    symlinkSync(defaultDir, aliasToDefault);
    expect(sameDirectoryIdentity(aliasToDefault, defaultDir)).toBe(true);
  });

  it("INVARIANT §17: fresh-install reasoning is not spoofable — a symlinked existing ancestor with `..` cannot forge the default, and a dangling symlink is not 'absent'", () => {
    // Default absent (fresh install). `lk` is a symlink into a SIBLING
    // subtree; `lk/../default` filesystem-resolves to that subtree's
    // sibling, NOT to the intended default. The kernel-faithful canonical
    // walk exposes the divergence a lexical `resolve` would hide.
    const freshDefault = join(base, "default");
    const sub = join(base, "sub", "custom");
    mkdirSync(sub, { recursive: true, mode: 0o700 });
    symlinkSync(join(base, "sub", "custom"), join(base, "lk"));
    const spoof = `${join(base, "lk")}/../default`;
    expect(sameDirectoryIdentity(spoof, freshDefault)).toBe(false);

    // A DANGLING symlink at the candidate is NOT a genuine absence: it is a
    // symlink entry that could be retargeted, so it must not be admitted to
    // the fresh-install (tail-is-lexical) branch.
    const dangling = join(base, "dangling");
    symlinkSync(join(base, "no-such-target"), dangling);
    expect(sameDirectoryIdentity(dangling, freshDefault)).toBe(false);
  });

  it("isDefaultStateDir routes through the identity check against the real DEFAULT_CONDUIT_DIR — a custom temp dir is never the default", () => {
    // The production entry point: no temp `defaultDir` seam. A throwaway
    // temp directory can never share an inode with the real
    // `DEFAULT_CONDUIT_DIR`, so the public gate every role uses refuses it.
    const custom = mkdtempSync(join(tmpdir(), "cdc-notdefault-"));
    try {
      expect(isDefaultStateDir(custom)).toBe(false);
      // And it agrees with the seam it delegates to.
      expect(isDefaultStateDir(custom)).toBe(sameDirectoryIdentity(custom, DEFAULT_CONDUIT_DIR));
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });
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

describe("handshake.ok agentVersion (§17 version-skew diagnosis)", () => {
  /**
   * Drives one request against a daemon double that answers the handshake
   * with a caller-chosen `handshake.ok` frame, then a trivial result. The
   * point is to put a handshake shape on the wire the current daemon would
   * or would not send — specifically, one that OMITS `agentVersion`, which
   * is exactly the frame a daemon built before this field existed sends.
   */
  async function askAgainstHandshake(
    handshakeOk: Record<string, unknown>,
  ): Promise<{ dbPath: string; allowPrivateEgress: boolean; agentVersion: string | undefined }> {
    const stateDir = newStateDir();
    const paths = daemonPaths(stateDir);
    const server = createServer((socket) => {
      socket.write(encodeFrame({ kind: "ready" }));
      let handshakeSent = false;
      socket.on("data", () => {
        if (!handshakeSent) {
          handshakeSent = true;
          socket.write(encodeFrame(handshakeOk as never));
          return;
        }
        socket.write(encodeFrame({ kind: "result", requestId: "r1", payload: [] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    // The client only takes the connect path when lifecycle reads busy.
    const lifecycle = await acquireExclusive(paths.lifecycleLockDb);
    if (lifecycle) locks.push(lifecycle);
    let observed:
      | { dbPath: string; allowPrivateEgress: boolean; agentVersion: string | undefined }
      | undefined;
    try {
      await daemonRequest({
        stateDir,
        role: "serve",
        request: { kind: "search", query: "anything" },
        deadlineMs: 15_000,
        spawn: () => {},
        onHandshake: (info) => {
          observed = info;
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (observed === undefined) throw new Error("onHandshake never fired");
    return observed;
  }

  it(
    "INVARIANT §17: a handshake.ok WITHOUT agentVersion is accepted (backward compat) and onHandshake reports it undefined",
    async () => {
      // The load-bearing compatibility case: a NEW client MUST complete the
      // handshake with an OLD daemon whose handshake.ok predates
      // `agentVersion`, because that absence is the very skew signal
      // downstream code branches on. Rejecting the frame here would break the
      // diagnosis it exists to enable — the client could never observe the
      // stale daemon to name it.
      const info = await askAgainstHandshake({
        kind: "handshake.ok",
        protocol: 1,
        dbPath: "/tmp/x.db",
        allowPrivateEgress: false,
        // agentVersion deliberately ABSENT — the pre-this-PR daemon frame.
      });
      expect(info.agentVersion).toBeUndefined();
      expect(info.dbPath).toBe("/tmp/x.db");
      expect(info.allowPrivateEgress).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "a handshake.ok WITH agentVersion surfaces the string through onHandshake",
    async () => {
      const info = await askAgainstHandshake({
        kind: "handshake.ok",
        protocol: 1,
        dbPath: "/tmp/x.db",
        allowPrivateEgress: true,
        agentVersion: "9.9.9",
      });
      expect(info.agentVersion).toBe("9.9.9");
      expect(info.allowPrivateEgress).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "a handshake.ok whose agentVersion is present but NOT a string is rejected as malformed",
    async () => {
      // Present-but-wrong-type is a malformed frame, distinct from absent:
      // the decoder tolerates absence (old daemon) but not a non-string
      // value. A rejected handshake yields outcome-unknown, never a
      // completed handshake — so onHandshake must not fire.
      const stateDir = newStateDir();
      const paths = daemonPaths(stateDir);
      const server = createServer((socket) => {
        socket.write(encodeFrame({ kind: "ready" }));
        socket.once("data", () => {
          socket.write(
            encodeFrame({
              kind: "handshake.ok",
              protocol: 1,
              dbPath: "/tmp/x.db",
              allowPrivateEgress: false,
              agentVersion: 42,
            } as never),
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
      const lifecycle = await acquireExclusive(paths.lifecycleLockDb);
      if (lifecycle) locks.push(lifecycle);
      let fired = false;
      try {
        const response = await daemonRequest({
          stateDir,
          role: "serve",
          request: { kind: "search", query: "anything" },
          deadlineMs: 15_000,
          spawn: () => {},
          onHandshake: () => {
            fired = true;
          },
        });
        expect(response.kind).toBe("outcome-unknown");
        expect(fired).toBe(false);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    TIMEOUT,
  );
});

describe("the re-entry floor (MIN_PASS_BUDGET_MS)", () => {
  it("INVARIANT §17: the floor is derived from the poll interval, leaving room for real polls", () => {
    // The floor exists so a re-entry always has room to DO the work it is
    // re-entering for: a couple of `LIFECYCLE_WAIT_POLL_MS` polls plus the
    // probe round-trips between them. Pinning the RELATIONSHIP rather than
    // the number is what makes a mutation to 0 — or to any value that no
    // longer clears a poll — a test failure instead of a silent hot spin.
    expect(MIN_PASS_BUDGET_MS).toBeGreaterThanOrEqual(LIFECYCLE_WAIT_POLL_MS_FOR_TEST * 2);
    expect(MIN_PASS_BUDGET_MS).toBe(LIFECYCLE_WAIT_POLL_MS_FOR_TEST * 4);
  });

  it(
    "a budget below the floor refuses immediately rather than spinning the decision table",
    async () => {
      // The behavioral half of the same invariant. With the floor at 0 the
      // `while` guard admits a pass that has no time to act, and the loop
      // re-probes hot until the deadline — the exact failure the floor
      // replaced a fixed pass count to prevent. A sub-floor budget must
      // therefore come back promptly with the terminal refusal.
      const stateDir = newStateDir();
      const started = Date.now();
      await expect(
        daemonRequest({
          stateDir,
          role: "serve",
          request: { kind: "catalog.listing" },
          // Below the floor by construction, so the loop must not be entered.
          deadlineMs: MIN_PASS_BUDGET_MS - 1,
          spawn: () => {
            throw new Error("a sub-floor budget must never reach the spawn boundary");
          },
        }),
      ).rejects.toBeInstanceOf(DaemonUnavailable);
      // Generous, but far below the deadline a hot spin would burn.
      expect(Date.now() - started).toBeLessThan(MIN_PASS_BUDGET_MS * 10);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a sub-floor deadline is refused BY NAMING THE MINIMUM, not as an absent daemon",
    async () => {
      // A sub-floor budget probes nothing and spawns nothing, so reporting
      // the generic "no daemon could be reached or started" would state
      // evidence about a daemon that was never looked for — and point the
      // operator at a daemon log with nothing in it. The refusal must
      // instead name the floor, so the caller can fix the one thing that is
      // actually wrong: their own arithmetic.
      await expect(
        daemonRequest({
          stateDir: newStateDir(),
          role: "serve",
          request: { kind: "catalog.listing" },
          deadlineMs: MIN_PASS_BUDGET_MS - 1,
          spawn: () => {
            throw new Error("a sub-floor budget must never reach the spawn boundary");
          },
        }),
      ).rejects.toThrow(new RegExp(`minimumMs: ${MIN_PASS_BUDGET_MS}`));
    },
    TIMEOUT,
  );

  it(
    "a non-finite deadline is refused by the same floor check",
    async () => {
      // `NaN` compares false against every bound, so without the explicit
      // finiteness check it would pass the floor guard and then make the
      // loop's own `remaining(expiry) >= MIN_PASS_BUDGET_MS` false forever —
      // the same silent no-probe, reached by a different route.
      await expect(
        daemonRequest({
          stateDir: newStateDir(),
          role: "serve",
          request: { kind: "catalog.listing" },
          deadlineMs: Number.NaN,
          spawn: () => {
            throw new Error("a non-finite budget must never reach the spawn boundary");
          },
        }),
      ).rejects.toBeInstanceOf(DaemonUnavailable);
    },
    TIMEOUT,
  );
});

describe("the result-payload seam", () => {
  /**
   * Drives one request against a daemon double that answers with a chosen
   * `result` payload. The double is deliberately dumber than the real
   * daemon — the point is to put a payload on the wire that the real
   * daemon would never send, which is the case the seam exists for.
   */
  async function askWithPayload(
    request: Parameters<typeof daemonRequest>[0]["request"],
    payload: unknown,
    // The stub server below grants whatever is asked, so this only has to
    // be the role the REAL daemon would require for the kind — `control`
    // for the daemon.* kinds, `approvals` for everything else here.
    role: Parameters<typeof daemonRequest>[0]["role"] = "approvals",
  ): Promise<Awaited<ReturnType<typeof daemonRequest>>> {
    const stateDir = newStateDir();
    const paths = daemonPaths(stateDir);
    const server = createServer((socket) => {
      socket.write(encodeFrame({ kind: "ready" }));
      socket.once("data", () => {
        socket.write(
          encodeFrame({
            kind: "handshake.ok",
            protocol: 1,
            dbPath: paths.db,
            allowPrivateEgress: false,
          }),
        );
        socket.once("data", () => {
          socket.write(encodeFrame({ kind: "result", requestId: "r_seam", payload }));
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
    const lifecycle = await acquireExclusive(paths.lifecycleLockDb);
    if (lifecycle) locks.push(lifecycle);
    try {
      return await daemonRequest({
        stateDir,
        role,
        request,
        deadlineMs: 15_000,
        spawn: () => {},
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it(
    "INVARIANT §17: a non-array approvals.list payload is REFUSED, never handed on as a queue",
    async () => {
      // The exact shape the specialists converged on: `decodeResponse`
      // accepted this (it has a `payload` key), the CLI cast it, and
      // `.map` threw a raw TypeError out of an operator command. The
      // refusal must instead be typed, and its wording must forbid the
      // dangerous inference — an operator who reads "no rows" concludes
      // nothing awaits them.
      const response = await askWithPayload({ kind: "approvals.list" }, {});
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("do NOT assume it is empty");
      // NOT §5 ambiguity: a read has no side effect to be ambiguous about,
      // and telling an operator their list may have changed something
      // would be both false and unactionable.
      expect(response.kind).not.toBe("outcome-unknown");
    },
    TIMEOUT,
  );

  it(
    "a paused row missing the fields the renderer reads is refused, not rendered as Invalid Date",
    async () => {
      // `startedAt` reaches `new Date(...).toISOString()` and `expiresAt`
      // an arithmetic comparison. Undefined renders "Invalid Date" at an
      // operator; a non-finite value throws RangeError mid-table. Both
      // present a protocol fault as a malformed queue instead of a
      // refusal, so the ROW SET is refused rather than the bad row dropped
      // — a silently shorter queue is the same lie as an empty one.
      const response = await askWithPayload({ kind: "approvals.list" }, [
        { executionId: "exec_1", toolName: "delete_repo", reason: "r", expiresAt: 1 },
      ]);
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("do NOT assume it is empty");
    },
    TIMEOUT,
  );

  it(
    "a well-formed approvals.list payload passes the seam untouched",
    async () => {
      // The guard must not be a wall: the shape the daemon actually sends
      // has to survive it, or the seam would refuse every real queue.
      const rows = [
        {
          executionId: "exec_1",
          startedAt: 1,
          toolName: "delete_repo",
          reason: "destructive",
          expiresAt: 2,
        },
      ];
      const response = await askWithPayload({ kind: "approvals.list" }, rows);
      expect(response).toMatchObject({ kind: "result", payload: rows });
    },
    TIMEOUT,
  );

  /**
   * The seam covers ALL structurally-consumed kinds, not `approvals.list`
   * alone. One malformed case per kind below, each asserting the same two
   * things: the answer is a typed refusal (never a `result` a caller would
   * read defaults out of), and its wording forbids the specific wrong
   * inference that kind's malformed payload would otherwise invite.
   */

  it(
    "INVARIANT §17: a catalog.listing payload without a usable source count is REFUSED",
    async () => {
      // `sourceCount` drives the "0 sources — onboard one" startup hint and
      // `connections` the advertised tool list. Before the seam covered this
      // kind, a payload missing either degraded to a plausible default —
      // telling an operator with a full catalog that nothing is onboarded.
      const response = await askWithPayload(
        { kind: "catalog.listing" },
        { connections: [{ prefix: "gh", label: "github tools" }] },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("do NOT assume it is empty");
    },
    TIMEOUT,
  );

  it(
    "a catalog.listing payload whose connections are not listing views is REFUSED",
    async () => {
      const response = await askWithPayload(
        { kind: "catalog.listing" },
        { connections: ["gh"], sourceCount: 1 },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("catalog");
    },
    TIMEOUT,
  );

  it(
    "a well-formed catalog.listing payload passes the seam untouched",
    async () => {
      const listing = { connections: [{ prefix: "gh", label: "github tools" }], sourceCount: 2 };
      const response = await askWithPayload({ kind: "catalog.listing" }, listing);
      expect(response).toMatchObject({ kind: "result", payload: listing });
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a source.provision payload with malformed counts is REFUSED, not printed as success",
    async () => {
      // The site where a bad payload was worst: the daemon has ALREADY
      // committed the atomic write, and the CLI would print "undefined safe,
      // undefined review" as a success line — an onboarding the operator
      // would rationally re-run against a source that is already there.
      const response = await askWithPayload(
        {
          kind: "source.provision",
          namespace: "ns",
          url: "https://u",
          prefix: "p",
          replace: false,
          clearCredential: false,
        },
        { namespace: "ns", prefix: "p", toolCount: 3, credential: "absent" },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("do NOT assume");
      expect(response.message).toContain("nothing was written");
    },
    TIMEOUT,
  );

  it(
    "a source.revalidate payload whose warnings are not an array of strings is REFUSED",
    async () => {
      // `warnings` is genuinely optional — absence is a well-formed answer
      // the caller's `?? []` handles. A PRESENT non-array is a protocol
      // fault, and swallowing it as "no advisories" hides the one thing the
      // daemon was trying to tell the operator.
      const response = await askWithPayload(
        { kind: "source.revalidate", namespace: "ns" },
        {
          namespace: "ns",
          prefix: "p",
          toolCount: 1,
          counts: { safe: 1, review: 0, destructive: 0 },
          credential: "present",
          warnings: "a retarget notice",
        },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("source.revalidate");
    },
    TIMEOUT,
  );

  it(
    "a source.provision payload missing toolCount is REFUSED, not printed as 'seeded undefined tools'",
    async () => {
      // Same class as the malformed `counts` case: the daemon has already
      // committed the write, and every field the success line interpolates
      // fails the same way. `counts` alone was an arbitrary place to stop.
      const response = await askWithPayload(
        {
          kind: "source.provision",
          namespace: "ns",
          url: "https://u",
          prefix: "p",
          replace: false,
          clearCredential: false,
        },
        {
          namespace: "ns",
          prefix: "p",
          counts: { safe: 1, review: 0, destructive: 0 },
          credential: "absent",
        },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("do NOT assume");
      expect(response.message).toContain("nothing was written");
    },
    TIMEOUT,
  );

  it(
    "a provisioning payload with absent warnings passes the seam untouched",
    async () => {
      const payload = {
        namespace: "ns",
        prefix: "p",
        toolCount: 2,
        counts: { safe: 2, review: 0, destructive: 0 },
        credential: "absent",
      };
      const response = await askWithPayload(
        {
          kind: "source.provision",
          namespace: "ns",
          url: "https://u",
          prefix: "p",
          replace: false,
          clearCredential: false,
        },
        payload,
      );
      expect(response).toMatchObject({ kind: "result", payload });
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: an approvals.resume payload with no decisionApplied is REFUSED, never read as false",
    async () => {
      // The sharpest arm of the whole seam. `decisionApplied` is the
      // OPERATOR'S VERB truth, and an absent field defaulting to `false`
      // reports a deny that LANDED as "never applied" (exit 1) — sending the
      // operator to re-issue a decision the execution already consumed.
      // Absence must be a refusal, not a hedge.
      const response = await askWithPayload(
        { kind: "approvals.resume", executionId: "exec_1", decision: "deny" },
        { status: "completed", executionId: "exec_1" },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("Do NOT assume it was not");
      // NOT §5 ambiguity: the response arrived, so the failure is a
      // malformed answer rather than an unknown outcome.
      expect(response.kind).not.toBe("outcome-unknown");
    },
    TIMEOUT,
  );

  it(
    "an approvals.resume payload carrying decisionApplied but no status is REFUSED",
    async () => {
      // The other half of the same false negative. `runDecide` selects its
      // ENTIRE output path on `status`: without one it prints "settled as
      // undefined" and then falls through to the never-applied arm — exit 1
      // on a decision that may well have landed, which is the identical
      // wrong answer omitting `decisionApplied` produces. Guarding one
      // field and not the other left the seam short of its own standard.
      const response = await askWithPayload(
        { kind: "approvals.resume", executionId: "exec_1", decision: "deny" },
        { executionId: "exec_1", decisionApplied: false },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("Do NOT assume it was not applied");
    },
    TIMEOUT,
  );

  it(
    "a well-formed approvals.resume payload passes the seam untouched",
    async () => {
      const payload = { status: "completed", executionId: "exec_1", decisionApplied: true };
      const response = await askWithPayload(
        { kind: "approvals.resume", executionId: "exec_1", decision: "deny" },
        payload,
      );
      expect(response).toMatchObject({ kind: "result", payload });
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: an execute payload carrying no status is REFUSED",
    async () => {
      // These payloads are handed to the AGENT verbatim, so no client field
      // access throws — but every documented branch of the execute/check
      // protocol keys on `status`, and a payload without one is a frame the
      // agent cannot act on. The refusal must not let it read as "did not
      // run".
      const response = await askWithPayload(
        { kind: "execute", code: "x", deadlineMs: 1000 },
        { executionId: "exec_1", result: null },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("do NOT assume it did not run");
    },
    TIMEOUT,
  );

  it(
    "an execution.get payload carrying no status is REFUSED",
    async () => {
      const response = await askWithPayload({ kind: "execution.get", executionId: "exec_1" }, {});
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("execution.get");
    },
    TIMEOUT,
  );

  it(
    "a well-formed check payload passes the seam untouched",
    async () => {
      const payload = { status: "not_found" };
      const response = await askWithPayload(
        { kind: "execution.getByRequestKey", requestKey: "k" },
        payload,
      );
      expect(response).toMatchObject({ kind: "result", payload });
    },
    TIMEOUT,
  );

  // --- F6: the guard checks status is a LEGAL MEMBER, not merely a string,
  // and that arm-mandatory fields are present. Before F6 these all passed the
  // seam as well-formed answers and produced wrong output ("settled as
  // bogus", a completed execute with no executionId to look up).

  it(
    "INVARIANT §17: an execute payload with an ILLEGAL status value is REFUSED (not just a string)",
    async () => {
      const response = await askWithPayload(
        { kind: "execute", code: "x", deadlineMs: 1000 },
        { status: "bogus", executionId: "exec_1" },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("no legal execution status");
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: an execute payload with a legal status but NO executionId is REFUSED",
    async () => {
      // {status:"completed"} with no executionId used to pass — the agent
      // could not then look the execution up. executionId is the arm-mandatory
      // field on every non-not_found arm.
      const response = await askWithPayload(
        { kind: "execute", code: "x", deadlineMs: 1000 },
        { status: "completed" },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("no legal execution status");
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: an approvals.resume payload with an ILLEGAL status settles nothing — REFUSED, never 'settled as bogus'",
    async () => {
      // {status:"bogus",decisionApplied:true} used to pass the seam and let
      // the deny arm print "settled as bogus". A legal status member is
      // required.
      const response = await askWithPayload(
        { kind: "approvals.resume", executionId: "exec_1", decision: "deny" },
        { status: "bogus", executionId: "exec_1", decisionApplied: true },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("Do NOT assume it was not");
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a check payload with an ILLEGAL body status is REFUSED",
    async () => {
      const response = await askWithPayload(
        { kind: "execution.get", executionId: "exec_1" },
        { status: "bogus", executionId: "exec_1" },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("no legal execution status");
    },
    TIMEOUT,
  );

  it(
    "a check payload with the legal 'running' status passes untouched (the check set is wider than execute)",
    async () => {
      // `running` is legal for check but NOT for execute — proving the two
      // predicates carry their own value-sets rather than sharing execute's.
      const payload = { status: "running", executionId: "exec_1" };
      const response = await askWithPayload(
        { kind: "execution.get", executionId: "exec_1" },
        payload,
      );
      expect(response).toMatchObject({ kind: "result", payload });
    },
    TIMEOUT,
  );

  it(
    "an execute payload with the legal 'running' status is REFUSED (running is NOT an execute status)",
    async () => {
      // The converse of the above: `running` is a check-only status. An
      // execute answer claiming it is malformed, and the shared predicates
      // are what make execute reject exactly what check accepts.
      const response = await askWithPayload(
        { kind: "execute", code: "x", deadlineMs: 1000 },
        { status: "running", executionId: "exec_1" },
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("no legal execution status");
    },
    TIMEOUT,
  );

  const STATUS_PAYLOAD = {
    pid: 4242,
    agentVersion: "0.1.0",
    startedAt: 1_700_000_000_000,
    dbPath: "/state/conduit.db",
    connections: 1,
    executionsInFlight: 0,
    queueDepth: 0,
    logPath: null,
    logSizeBytes: null,
  };

  it(
    "INVARIANT §17: a daemon.status payload with a malformed startedAt is REFUSED, never rendered",
    async () => {
      // `conduit daemon status` renders this through
      // `new Date(startedAt).toISOString()`, which throws a RangeError on a
      // non-finite value — a stack trace at the operator instead of a typed
      // refusal, the same failure the approvals.list row guard prevents.
      const response = await askWithPayload(
        { kind: "daemon.status" },
        { ...STATUS_PAYLOAD, startedAt: Number.NaN },
        "control",
      );
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("do NOT assume it is unhealthy");
      // A read: no side effect to be ambiguous about (§5).
      expect(response.kind).not.toBe("outcome-unknown");
    },
    TIMEOUT,
  );

  it(
    "a daemon.status payload missing logPath is REFUSED (absent is not the same fact as null)",
    async () => {
      // The renderer's `?? "stderr (hand-started)"` would turn an ABSENT
      // field into a confident claim the daemon is hand-started — a
      // different fact from the daemon reporting it has no log file.
      const { logPath: _omitted, ...withoutLogPath } = STATUS_PAYLOAD;
      const response = await askWithPayload({ kind: "daemon.status" }, withoutLogPath, "control");
      expect(response.kind).toBe("error");
      if (response.kind !== "error") throw new Error("expected an error frame");
      expect(response.message).toContain("status projection");
    },
    TIMEOUT,
  );

  it(
    "a well-formed daemon.status payload passes the seam untouched",
    async () => {
      const response = await askWithPayload({ kind: "daemon.status" }, STATUS_PAYLOAD, "control");
      expect(response).toMatchObject({ kind: "result", payload: STATUS_PAYLOAD });
    },
    TIMEOUT,
  );

  it(
    "a daemon.status payload whose log fields are a real path and size passes untouched",
    async () => {
      // The nullable pair's OTHER legal arm: a file-logging daemon.
      const payload = { ...STATUS_PAYLOAD, logPath: "/state/conduitd.log", logSizeBytes: 8192 };
      const response = await askWithPayload({ kind: "daemon.status" }, payload, "control");
      expect(response).toMatchObject({ kind: "result", payload });
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
 * The §17 state-directory boundary at the PROCESS level (the five-consumer
 * unification). The deterministic unit halves live in state-dir-resolve.test.ts
 * (reverse-alias derivation) and state-dir.test.ts (ancestor-chain rule); these
 * are the missing REAL-process halves — where pass 4's scope error hid — that
 * prove a client and a by-hand daemon resolving the same operator argv MEET at
 * one filesystem object, that a leaf swap sends zero bytes, that a poisoned
 * HOME cannot desynchronize client and daemon, and that a custom NOT_FOUND is
 * refused.
 */
describe("daemonRequest — §17 one-effective-base boundary (process level)", () => {
  it(
    "INVARIANT §17: reverse-alias client and by-hand daemon meet at one object — client and daemon each resolve the SAME `<attacker>/link/../custom` argv and round-trip succeeds",
    async () => {
      // The attacker owns a traversable dir holding a symlink `link` -> the
      // real custom state dir. Both the client and the (by-hand) daemon are
      // pointed at `<attacker>/link/../custom` — the raw argv, NOT path.join'd.
      // OLD behavior: `daemonPaths` lexically strips `link/..` and derives the
      // socket/locks under `<attacker>/custom`, so a client and a daemon on the
      // same argv could land in different dirs. The fix threads the ONE
      // kernel-faithful resolver into both processes, so both reach the real
      // custom object and the round-trip completes.
      const root = newStateDir();
      const home = join(root, "home");
      const custom = join(home, "custom");
      const attacker = join(root, "attacker");
      mkdirSync(custom, { recursive: true, mode: 0o700 });
      mkdirSync(attacker, { recursive: true, mode: 0o700 });
      // `link` -> the real custom dir. `<attacker>/link` resolves to custom;
      // `/..` pops to custom's parent (home); `/custom` re-descends to custom.
      symlinkSync(custom, join(attacker, "link"));
      const attackArgv = `${attacker}${sep}link${sep}..${sep}custom`;

      // Sanity: the raw spelling kernel-resolves (by INODE — statSync follows
      // symlinks + `..` in the kernel) to the real custom object, which is why
      // it passes validation. `realpathSync` is deliberately NOT used: on macOS
      // it returns the lexically-collapsed `<attacker>/custom` string (the very
      // bug the fix closes), so inode identity is the faithful check.
      const inoOf = (p: string): bigint => statSync(p, { bigint: true }).ino;
      expect(inoOf(attackArgv)).toBe(inoOf(custom));

      // A spawn seam that hands the daemon helper the RAW attack argv (not a
      // pre-resolved dir): the daemon must resolve it ITSELF, exactly as the
      // production `--daemon` entry does, so this pins the cross-PROCESS
      // agreement rather than a value passed between them.
      const spawnAtRawArgv = (_resolved: string): void => {
        const child = spawn(process.execPath, [HELPER, attackArgv], {
          stdio: ["ignore", "ignore", "inherit"],
          env: { ...process.env, CONDUIT_MASTER_KEY: TEST_KEY },
        });
        children.push(child);
      };

      const response = await daemonRequest({
        stateDir: attackArgv,
        role: "serve",
        request: { kind: "search", query: "anything" },
        deadlineMs: 45_000,
        spawn: spawnAtRawArgv,
      });

      expect(response.kind).toBe("result");
      // The socket the client reached lives inside the REAL custom object —
      // never the attacker's lexical `<attacker>/custom` sibling (which does
      // not even exist). Compared by inode, not by realpath string.
      const effective = resolveEffectiveStateDir(attackArgv);
      expect(inoOf(effective)).toBe(inoOf(custom));
      expect(existsSync(daemonPaths(effective).socket)).toBe(true);
      expect(existsSync(join(attacker, "custom"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a leaf swapped between validation and connect sends ZERO request bytes",
    async () => {
      // Drive the client's REAL post-READY (dev,ino) re-check end-to-end. The
      // client validates the leaf (row 4: nothing running), captures its
      // identity, then spawns. We use the spawn seam — invoked AFTER validation
      // — to perform the parent-owner swap: rename the validated leaf out and
      // recreate a fresh same-named 0700 dir (a NEW inode), then start a real
      // daemon in the swapped-in dir so a socket exists and the client reaches
      // READY. At READY the client re-lstats the leaf, finds a different
      // (dev,ino) than it validated, and MUST abort before writing a byte.
      const stateDir = newStateDir();
      // Materialize the (soon-to-be-validated) leaf as a real 0700 dir under a
      // self-owned chain, so validation passes and captures its identity.
      mkdirSync(join(stateDir, "leaf"), { mode: 0o700 });
      const leaf = join(stateDir, "leaf");
      const validatedIno = statSync(leaf, { bigint: true }).ino;

      const swapThenSpawn = (resolved: string): void => {
        // The swap: the validated leaf is renamed away and a fresh inode is
        // dropped at the same path — exactly what a parent-owner rename does.
        renameSync(leaf, `${leaf}.evicted`);
        mkdirSync(leaf, { mode: 0o700 });
        // Confirm the inode genuinely changed (else the test proves nothing).
        expect(statSync(leaf, { bigint: true }).ino).not.toBe(validatedIno);
        // Start a real daemon in the swapped-in dir so the client can connect
        // and reach READY — the window in which the re-check must fire.
        const child = spawn(process.execPath, [HELPER, resolved], {
          stdio: ["ignore", "ignore", "inherit"],
          env: { ...process.env, CONDUIT_MASTER_KEY: TEST_KEY },
        });
        children.push(child);
      };

      const err = await daemonRequest({
        stateDir: leaf,
        role: "add-mcp", // the role whose request carries the add secret
        request: { kind: "search", query: "swap-should-block-this" },
        deadlineMs: 45_000,
        spawn: swapThenSpawn,
      }).catch((e: unknown) => e);

      // The client aborted on the detected swap with the typed refusal, in the
      // retryable (pre-write) zone — never an outcome-unknown, which would mean
      // a byte had gone out.
      expect(err).toBeInstanceOf(StateDirError);
      expect((err as StateDirError).code).toBe("UNSAFE_ANCESTOR");
      expect((err as StateDirError).message).toContain("No bytes were written");

      rmSync(`${leaf}.evicted`, { recursive: true, force: true });
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: an attacker-owned (world-writable non-sticky) ancestor is REFUSED — no spawn, no connect",
    async () => {
      // A custom base whose existing parent is world-writable and NOT sticky:
      // any uid can rename/replace the leaf, so the client must refuse before
      // it ever spawns or connects. (Foreign-uid ownership cannot be simulated
      // without root; the writable-non-sticky clause is the real, unprivileged
      // half of §3.2 and the one an unprivileged attacker actually exploits.)
      const root = newStateDir();
      const openParent = join(root, "open");
      mkdirSync(openParent, { mode: 0o777 });
      // chmod again to defeat umask so the mode is genuinely 0777.
      const { chmodSync } = await import("node:fs");
      chmodSync(openParent, 0o777);
      const custom = join(openParent, "state");
      mkdirSync(custom, { mode: 0o700 });

      let spawnCalls = 0;
      const err = await daemonRequest({
        stateDir: custom,
        role: "add-mcp",
        request: { kind: "search", query: "anything" },
        deadlineMs: 30_000,
        spawn: () => {
          spawnCalls += 1;
        },
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StateDirError);
      expect((err as StateDirError).code).toBe("UNSAFE_ANCESTOR");
      expect(spawnCalls).toBe(0);
      expect(existsSync(daemonPaths(custom).socket)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: poisoned-HOME auto-start — client and the HOME-stripped daemon derive the SAME passwd-anchored default, unaffected by HOME",
    async () => {
      // The auto-started daemon child is HOME-stripped and derives the default
      // from the passwd entry; the client runs with a full environment. Before
      // §4 the default used `os.homedir()`, which honors $HOME, so a poisoned
      // client HOME desynchronized them. This pins the §4.3 proof at the
      // PROCESS boundary with a real spawned child: `DEFAULT_CONDUIT_DIR` is
      // `join(userInfo().homedir, ".conduit")`, and the child — spawned with a
      // hostile HOME — computes the SAME `userInfo().homedir` this process
      // does, while `os.homedir()` (the OLD source) diverges to the poison.
      // That divergence is exactly the hole the fix closes, so the test asserts
      // both: the passwd home matches across the boundary, and the HOME-honoring
      // primitive would NOT have.
      const { DEFAULT_CONDUIT_DIR } = await import("../env.js");
      const probeResult = await new Promise<{ passwd: string; homeEnv: string }>((res, rej) => {
        const probe = spawn(
          process.execPath,
          [
            "-e",
            "const os=require('node:os');console.log(JSON.stringify({passwd:os.userInfo().homedir,homeEnv:os.homedir()}))",
          ],
          {
            stdio: ["ignore", "pipe", "inherit"],
            env: { PATH: process.env.PATH, HOME: "/tmp/poison-home-does-not-exist" },
          },
        );
        let buf = "";
        probe.stdout?.on("data", (c: Buffer) => {
          buf += c.toString("utf8");
        });
        probe.once("error", rej);
        probe.once("exit", (code) =>
          code === 0 ? res(JSON.parse(buf.trim())) : rej(new Error(`probe exited ${code}: ${buf}`)),
        );
      });
      // The child's passwd home (the source `DEFAULT_CONDUIT_DIR` now uses)
      // equals this process's — HOME changed nothing. So both sides bind the
      // same `~/.conduit`.
      expect(join(probeResult.passwd, ".conduit")).toBe(DEFAULT_CONDUIT_DIR);
      // And the OLD source (`os.homedir()`) WOULD have desynchronized: with a
      // poisoned HOME it returns the poison, which is precisely the P2-HOME
      // hole the fix removes.
      expect(probeResult.homeEnv).toBe("/tmp/poison-home-does-not-exist");
      expect(join(probeResult.passwd, ".conduit")).not.toContain("poison-home");
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a custom state dir whose canonical form does not exist is REFUSED with the by-hand start command (production cannot auto-start a custom daemon), and spawns nothing",
    async () => {
      // A custom dir that does not exist yet. Production (no injected spawn
      // seam) cannot auto-start a custom daemon, so accepting NOT_FOUND as
      // "fresh install, proceed" would only open the ancestor-swap window. The
      // refusal names the by-hand command. This is the PRODUCTION path — no
      // `spawn` seam — so the §5 custom-NOT_FOUND refusal applies.
      const root = newStateDir();
      const custom = join(root, "does-not-exist-yet");
      expect(existsSync(custom)).toBe(false);

      const err = await daemonRequest({
        stateDir: custom,
        role: "add-mcp",
        request: { kind: "search", query: "anything" },
        deadlineMs: 30_000,
        // No spawn seam: production path.
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DaemonUnavailable);
      const message = (err as DaemonUnavailable).message;
      expect(message).toContain(`conduit-mcp --daemon --state-dir ${custom}`);
      expect(message).toContain("does not exist");
      expect(existsSync(daemonPaths(resolveEffectiveStateDir(custom)).socket)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17 / §9.1: the default --doctor's report comes from the DAEMON — handshake config (db path, egress) and the daemon's own source count arrive over the socket via the serve-role catalog.listing read, not a private store open",
    async () => {
      // The substance of the daemon-backed `--doctor` (bin.ts `doctor()`): it
      // reaches the daemon over the socket using the `serve` role's existing
      // `catalog.listing` read (no new capability row), reads the db path and
      // effective egress from `handshake.ok` (§9 item 3), and reports the
      // daemon's OWN source count — never re-deriving health from a private
      // store open. This is the EXACT mechanism `doctor()` runs; pinning it at
      // the client level keeps the invariant isolable now that §4 makes the
      // default dir passwd-anchored (a `bin.js --doctor` cannot be redirected
      // to a temp dir: HOME no longer moves the default, and the daemon-backed
      // doctor REFUSES a custom `--state-dir` by design — invariant §17/§3.1).
      const stateDir = newStateDir();
      // A real daemon seeded with exactly one source (the `--seed-catalog`
      // helper upserts one source/integration/connection/secret before bind).
      await runningDaemon(stateDir, ["--seed-catalog"]);

      let handshake: { dbPath: string; allowPrivateEgress: boolean } | undefined;
      const response = await daemonRequest({
        stateDir,
        role: "serve", // doctor deliberately reuses the serve read role
        request: { kind: "catalog.listing" },
        deadlineMs: 30_000,
        autoStart: false, // the daemon is already running; never spawn
        onHandshake: (info) => {
          handshake = info;
        },
      });

      // The handshake carried the daemon's effective non-secret config — the
      // db path under THIS daemon's state dir and the fail-closed egress
      // default — exactly what `doctor()` prints. The daemon resolves its base
      // through the shared resolver (§17 §2), so its db path is the CANONICAL
      // form (on macOS /var → /private/var); compare against the resolved base.
      expect(handshake).toBeDefined();
      expect(handshake?.dbPath).toBe(daemonPaths(resolveEffectiveStateDir(stateDir)).db);
      expect(handshake?.allowPrivateEgress).toBe(false);
      // The source count is the daemon's own, counted over the socket.
      expect(response.kind).toBe("result");
      if (response.kind !== "result") throw new Error("expected a result");
      expect(response.payload.sourceCount).toBe(1);
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
