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
 * Note that this composes with the daemon's own defense, which was ruled
 * to be a SEPARATE layer rather than a substitute for this one: the
 * daemon must hold the database boundary on its own, because a daemon an
 * operator starts by hand never passes through this spawn path at all.
 * Concretely, `daemonPaths` derives the database from the state directory
 * rather than from env, and the handshake refuses a client carrying
 * `CONDUIT_DB`. This
 * module is the outer layer of that same guarantee, not a substitute for
 * it — a daemon an operator starts BY HAND never passes through here.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONDUIT_DIR } from "../env.js";

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
 * Starts a detached daemon against the DEFAULT state directory and returns
 * immediately.
 *
 * **Zero-argument by construction (Codex ARC F5 — the structural half).**
 * The spawned child receives only `--daemon` and derives the default state
 * directory from its own uid (`bin.ts`: no `--state-dir`, so `runDaemon`
 * falls back to `DEFAULT_CONDUIT_DIR`). A client cannot select the daemon's
 * state directory, so this function must not be able to be HANDED one
 * either: taking a `stateDir` parameter would let a caller spawn a child
 * whose cwd and log sit under a directory the child then never serves —
 * the "default daemon running, client polling a custom dir" split F5
 * closes. The directory is hardcoded here, matching what the child derives,
 * so the cwd/log and the served database can never diverge.
 *
 * The one path that legitimately spawns against a non-default directory is
 * a TEST injecting its own spawn seam (`DaemonRequestOptions.spawn`); that
 * seam takes the dir it targets. Production auto-start (`daemonRequest`
 * with no injected seam) reaches this function and only ever for the
 * default directory — see the auto-start gate in `client.ts`.
 *
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
/**
 * The child's argv, as a pure function of the SPAWNER's environment.
 *
 * Split out of `spawnDaemon` so the env→argv translation is testable
 * without spawning a process. It is the only place the §5 volume gate
 * crosses the spawn boundary, and it crosses as an ARGUMENT: the child's
 * constructed env is exactly `{PATH}`, so `CONDUIT_DAEMON_DEBUG` is read
 * HERE and never inherited. Reading it in the child instead would mean
 * either inheriting the environment (which §3.1 forbids) or adding a second
 * allowlist entry a client could set.
 *
 * Exactly `"1"`, not any truthy value: an opt-in gate with a fuzzy
 * predicate turns a stray `CONDUIT_DAEMON_DEBUG=0` into debug logging.
 */
export function daemonArgv(env: NodeJS.ProcessEnv): string[] {
  const argv = [daemonEntryPoint(), "--daemon"];
  if (env.CONDUIT_DAEMON_DEBUG === "1") argv.push("--debug");
  return argv;
}

export function spawnDaemon(): void {
  const stateDir = DEFAULT_CONDUIT_DIR;
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

  const argv = daemonArgv(process.env);

  try {
    const child = spawn(process.execPath, argv, {
      // Explicit, never inherited (§3.1): an inherited cwd would silently
      // anchor every relative path the daemon, sandbox, or an upstream
      // session ever resolves.
      cwd: stateDir,
      // The allowlist. `PATH` is the daemon-owned constant; every
      // `CONDUIT_*` variable is absent, and so is `HOME`. Since §17 §4 the
      // default state directory is anchored on BOTH sides to the passwd
      // entry for the real uid (`env.ts`: `join(userInfo().homedir,
      // ".conduit")`), which does NOT consult `$HOME` at all — so the CLIENT
      // (full environment) and this HOME-stripped child compute the SAME
      // `~/.conduit` string whether `HOME` is set or not. Stripping `HOME`
      // here is now belt-and-braces rather than the sole guarantee: a hostile
      // `HOME` is doubly inert — absent from the child, and unread by the
      // resolver on either side. (Before §17 §4 the default used
      // `os.homedir()`, which honors `$HOME`; that made the client and this
      // child agree only because the child's `HOME` was stripped, and left
      // the client itself honoring a poisoned `HOME` — the P2-HOME hole.)
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
    // A spawn failure is asynchronous: `spawn` returns a ChildProcess
    // before the fork/exec is known to have worked, and a broken entry
    // point, EAGAIN, or EPERM arrives later as an 'error' event. Without
    // a listener that event is an unhandled 'error' on an EventEmitter,
    // which throws and takes the CLIENT process down — a failed
    // auto-start would kill the MCP client rather than degrading to the
    // typed `DaemonUnavailable` the client is designed to report.
    //
    // The line goes to the log fd the client already opened, because
    // that is the file `DaemonUnavailable` tells the operator to read.
    // The fd is closed in the `finally` below, so by the time a late
    // event fires it is usually gone; stderr is the fallback so the
    // diagnosis is never silently lost. Writing must never itself throw
    // here — this handler exists to PREVENT a crash.
    child.once("error", (err: NodeJS.ErrnoException) => {
      const line = `[conduitd] Daemon spawn failed: ${err.code ?? "unknown"}: ${err.message}. Context: {stateDir: ${stateDir}, entryPoint: ${daemonEntryPoint()}}\n`;
      try {
        writeSync(logFd, line);
      } catch {
        try {
          process.stderr.write(line);
        } catch {
          /* nothing left to report through; the client still survives */
        }
      }
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
