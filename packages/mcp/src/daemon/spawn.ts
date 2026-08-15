/**
 * The spawn boundary (design §3.1). A spawned child ordinarily inherits
 * the client's entire environment — `CONDUIT_MASTER_KEY`, `CONDUIT_DB`,
 * `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS`, and even `HOME`, which is where
 * `~/.conduit` resolves from. Auto-start from an arbitrary client would
 * therefore let that client smuggle security configuration into a
 * long-lived process that then serves EVERY other client, defeating
 * §9.3's default-only decision.
 *
 * So the daemon's environment is CONSTRUCTED, never inherited. The
 * enumeration below is an allowlist, not a filter: nothing reaches the
 * child unless this file names it. That distinction matters — a denylist
 * of "strip CONDUIT_*" would silently pass every variable someone adds
 * later, and the failure would be invisible.
 *
 * Note that this composes with the daemon's own defense (task 4, D2):
 * `daemonPaths` derives the database from the state directory rather than
 * from env, and the handshake refuses a client carrying `CONDUIT_DB`. This
 * module is the outer layer of that same guarantee, not a substitute for
 * it — a daemon an operator starts BY HAND never passes through here.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The daemon's `PATH`, fixed here rather than reused from the client. An
 * inherited `PATH` would let the client influence executable resolution
 * inside the long-lived daemon and in every subprocess the daemon later
 * spawns (sandbox tooling, upstream helpers) — a persistent influence far
 * outlasting the client that supplied it. These are the standard system
 * directories on both supported platforms.
 */
export const PLATFORM_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** The daemon's log file inside the state directory. */
export const DAEMON_LOG = "conduitd.log";

/**
 * Absolute path to this package's own CLI entry point. Resolved from
 * `import.meta.url` — the location of the RUNNING package's compiled
 * code — and never through a `PATH` lookup: the client is already running
 * the same package, so its own installation directory is the one trusted
 * source for the executable. A `PATH` lookup would resolve `conduit-mcp`
 * through a directory the client's environment controls, which is exactly
 * the substitution this boundary exists to prevent.
 *
 * `spawn.ts` builds to `dist/spawn.js` and the bin entry is
 * `dist/bin.js`, so they are siblings at runtime.
 */
export function daemonEntryPoint(): string {
  return fileURLToPath(new URL("./bin.js", import.meta.url));
}

/**
 * The constructed environment handed to the daemon (§3.1). Exported so a
 * test can assert on the actual value the spawn uses, rather than on a
 * re-implementation of it that could drift from the real one.
 *
 * An ALLOWLIST, not a filter: nothing reaches the child unless named
 * here. A denylist ("strip CONDUIT_*") would silently pass any variable
 * added later, and that failure would be invisible until it mattered.
 */
export function daemonSpawnEnv(): NodeJS.ProcessEnv {
  return { PATH: PLATFORM_PATH };
}

/**
 * Starts a detached daemon against `stateDir` and returns immediately.
 * Deliberately returns `void`: §3.5 step 2 is explicit that the spawning
 * client never acquires a lock or otherwise coordinates with the child —
 * it spawns and then re-probes like any other client. There is no
 * handshake with the child to report, and a pid would only invite a
 * caller to branch on liveness, which §3.5 forbids (PIDs are reused).
 *
 * Two clients racing here produce two children; one wins the lifecycle
 * lock and the other exits `already running`. That is the designed
 * outcome, not a race to prevent.
 */
export function spawnDaemon(stateDir: string): void {
  // On a fresh install the state directory does not exist yet, and the
  // log below is opened INSIDE it — so the directory has to exist before
  // the very first daemon can be started. `recursive: true` makes this
  // idempotent for every subsequent spawn. This creates the directory
  // but validates nothing: the boundary check is the daemon's, run over
  // this same path by `ensureStateDir` as its first act, and a
  // 0700-mode create that loses a race to a hostile directory is caught
  // there rather than trusted here.
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  // Opened by the CLIENT rather than letting the child create it: the
  // child must inherit descriptors that are already pointed at the log,
  // so nothing it writes can reach the client's own stdout/stderr — a
  // daemon's diagnostics must not interleave into an MCP client's stdio
  // protocol stream.
  const logFd = openSync(join(stateDir, DAEMON_LOG), "a", 0o600);

  try {
    const child = spawn(process.execPath, [daemonEntryPoint(), "--daemon"], {
      // Explicit, never inherited (§3.1): an inherited cwd would silently
      // anchor every relative path the daemon, sandbox, or an upstream
      // session ever resolves.
      cwd: stateDir,
      // The allowlist. `PATH` is the daemon-owned constant; every
      // `CONDUIT_*` variable is absent, and so is `HOME`. The daemon
      // resolves its state directory through `os.homedir()` (`env.ts`:
      // `join(homedir(), ".conduit")`), and on POSIX `homedir()` returns
      // `$HOME` when it is set and falls back to the passwd entry for
      // the real uid when it is not. Omitting `HOME` from this env is
      // therefore precisely what forces that fallback — the uid the
      // kernel authenticated, not a string the client chose. A hostile
      // `HOME` is inert because it is absent, not because `homedir()`
      // ignores it.
      env: daemonSpawnEnv(),
      // stdin closed; stdout and stderr to the daemon's own log. No other
      // descriptor is inherited — in particular no lock-db descriptor,
      // which §3.1 requires never survive into a daemon child.
      stdio: ["ignore", logFd, logFd],
      // Survives the client's exit: the daemon is a durable background
      // service (§17), not a child of whichever client happened to start
      // it first.
      detached: true,
    });
    // Without this the client's event loop stays alive until the daemon
    // exits — which, the daemon being durable until stopped, is forever.
    child.unref();
  } finally {
    // The child has its own duplicated descriptors by now; this one is
    // the client's copy and would otherwise leak one fd per auto-start.
    // A failed close must never turn a successful spawn into a throw.
    try {
      closeSync(logFd);
    } catch {
      /* the descriptor leaks; the daemon is still running */
    }
  }
}
