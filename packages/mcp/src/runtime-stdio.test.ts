import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { daemonPaths } from "./daemon/conduitd.js";
import { encodeFrame, FrameDecoder } from "./daemon/frames.js";
import { bundleDaemonHelper, type HelperBundle } from "./daemon/helpers/bundle.js";
import { acquireExclusive, type HeldLock } from "./daemon/locks.js";
import { AGENT_VERSION } from "./env.js";

/**
 * The §17 version-skew startup path (`runStdioServer`).
 *
 * The failure this pins: a user upgrades Conduit while an OLD daemon is
 * still running (there is no stop command and no idle-exit — it runs until
 * killed). A NEW `serve` client handshakes fine (both `protocol: 1`, a
 * vocabulary-only change never bumps it), then sends `catalog.listing`,
 * which the old daemon's smaller `serve` capability set refuses with an
 * opaque `code: "invalid"` "capability does not permit" error. Before this
 * fix the user saw that capability error and `exit 1`; now the daemon's
 * missing `agentVersion` in `handshake.ok` is the skew tell, and the client
 * prints an actionable "stop the stale daemon" message instead.
 *
 * `runStdioServer` calls `process.exit`, so it is exercised in a REAL child
 * (the bundled `run-serve` fixture) whose stderr and exit code are read.
 * The daemon it talks to is a DOUBLE bound in-process: it holds the
 * lifecycle lock (so the client takes the connect path rather than
 * spawning) and speaks whichever handshake shape the case is proving.
 */

const TIMEOUT = 60_000;

let bundle: HelperBundle | undefined;

beforeAll(async () => {
  bundle = await bundleDaemonHelper();
}, TIMEOUT);

afterAll(() => {
  bundle?.cleanup();
});

let dir: string | undefined;
const servers: Server[] = [];
const locks: HeldLock[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.length = 0;
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers.length = 0;
  for (const lock of locks) await lock.release();
  locks.length = 0;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function newStateDir(): string {
  dir = mkdtempSync(join(tmpdir(), "cdc-rs-"));
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Binds a daemon DOUBLE at a state dir's socket, holding its lifecycle lock
 * so the client connects to it (row 2/3) instead of spawning. On the first
 * client frame (the handshake) it writes the given `handshakeOk`; on the
 * next frame (the `catalog.listing`) it refuses with the given error.
 */
async function fakeDaemon(
  stateDir: string,
  handshakeOk: Record<string, unknown>,
  refusal: { code: string; message: string },
): Promise<void> {
  const paths = daemonPaths(stateDir);
  const lock = await acquireExclusive(paths.lifecycleLockDb);
  if (lock === null) throw new Error("could not hold the fake daemon's lifecycle lock");
  locks.push(lock);

  const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    let seen = 0;
    socket.write(encodeFrame({ kind: "ready" }));
    socket.on("data", (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch {
        return;
      }
      for (const _frame of frames) {
        seen += 1;
        if (seen === 1) {
          socket.write(encodeFrame(handshakeOk as never));
        } else {
          // The request frame (catalog.listing) — refuse it, exactly as an
          // old daemon's out-of-set capability check does.
          socket.write(
            encodeFrame({
              kind: "error",
              requestId: "r1",
              code: refusal.code,
              message: refusal.message,
            } as never),
          );
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
}

/** Runs the real `runStdioServer` against `stateDir` and returns its exit + stderr. */
function runServe(stateDir: string): Promise<{ code: number | null; stderr: string }> {
  if (bundle === undefined) throw new Error("helper bundle not built");
  const serveHelper = bundle.serve;
  return new Promise((resolve, reject) => {
    // Hermetic env: strip ambient CONDUIT_* so an exported CONDUIT_DB does
    // not turn this into a refused-custom-db case by accident.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CONDUIT_")) delete env[key];
    }
    const child = spawn(process.execPath, [serveHelper, stateDir], {
      stdio: ["ignore", "ignore", "pipe"],
      env,
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`run-serve did not exit; stderr so far: ${stderr}`));
    }, TIMEOUT - 5_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

describe("runStdioServer version-skew startup (§17)", () => {
  it(
    "INVARIANT §17: an OLD daemon (handshake.ok WITHOUT agentVersion) refusing catalog.listing yields the DISTINCT skew message + exit 1",
    async () => {
      const stateDir = newStateDir();
      // The exact old-daemon shape: a valid handshake.ok that predates
      // `agentVersion`, then the capability refusal its smaller serve set
      // produces for catalog.listing.
      await fakeDaemon(
        stateDir,
        {
          kind: "handshake.ok",
          protocol: 1,
          dbPath: daemonPaths(stateDir).db,
          allowPrivateEgress: false,
        },
        { code: "invalid", message: 'capability "serve" does not permit "catalog.listing"' },
      );

      const { code, stderr } = await runServe(stateDir);
      expect(code).toBe(1);
      // The DISTINCT skew message: names the stale daemon AND the stop command.
      expect(stderr).toContain("older Conduit build");
      expect(stderr).toContain("pkill -f 'bin.js --daemon'");
      // NOT the generic capability refusal — that opaque text is the whole
      // thing the skew branch exists to avoid surfacing.
      expect(stderr).not.toContain("does not permit");
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a CURRENT daemon (handshake.ok WITH agentVersion) refusing with refused-custom-db keeps its OWN message, not the skew one",
    async () => {
      const stateDir = newStateDir();
      // A current daemon: handshake carries agentVersion, and the refusal is
      // a real refused-custom-db (§9.3 item 3), whose own words name the fix.
      await fakeDaemon(
        stateDir,
        {
          kind: "handshake.ok",
          protocol: 1,
          dbPath: daemonPaths(stateDir).db,
          allowPrivateEgress: false,
          agentVersion: AGENT_VERSION,
        },
        {
          code: "refused-custom-db",
          message: "custom db paths bypass the daemon in v1; unset CONDUIT_DB to use it",
        },
      );

      const { code, stderr } = await runServe(stateDir);
      expect(code).toBe(1);
      // The existing generic refusal path, with the daemon's own words.
      expect(stderr).toContain("the daemon refused this client");
      expect(stderr).toContain("refused-custom-db");
      // And crucially NOT misreported as version skew.
      expect(stderr).not.toContain("older Conduit build");
    },
    TIMEOUT,
  );
});
