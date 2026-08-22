import {
  AGENT_VERSION,
  createSkewReporter,
  type DaemonStatusPayload,
  type DaemonStopPayload,
  DaemonUnavailable,
  DEFAULT_CONDUIT_DIR,
  daemonPaths,
  daemonRequest,
  deadlineForRequest,
  probeShared,
  type RpcRequest,
  type RpcResponse,
  resolveEffectiveStateDir,
} from "@conduithq/mcp";

/**
 * `conduit daemon status|stop` — the operator's window onto the background
 * daemon, over the `control` capability (spec §3.2).
 *
 * **Neither verb ever spawns a daemon** (`autoStart: false`). `status` must
 * not create the thing it is asking about — a status command that starts a
 * daemon reports a fact it just manufactured — and `stop`'s absent case is
 * already the goal state, so starting one to stop it would be absurd.
 *
 * **"Not running" is keyed on the `DaemonUnavailable` CODE, never on
 * message text.** The message is human prose that carries paths and
 * deadlines and is free to change; the code is the contract. Matching on
 * text would make a reworded diagnostic silently reclassify an absent
 * daemon as an unexpected failure, or worse, the reverse.
 *
 * **Exit codes are NORMATIVE (spec §3.2).** `status` exits 3 when the
 * daemon is absent — the systemctl convention, and distinct from both 0
 * (running) and 1 (something went wrong), so a script can never read "not
 * running" as healthy. `stop` exits 0 for stopped-or-not-running, because
 * the operator's verb is a goal state and it is reached either way, and 1
 * only when the daemon is still draining or refused.
 *
 * **`stop` waits for VERIFIED termination**, not for the ack. The daemon
 * acks the stop and then drains in-flight work, so the ack means "will
 * stop", not "stopped". `conduit daemon stop && conduit key rotate` must
 * work back to back, and `key rotate` needs the lifecycle lock actually
 * free — so this command polls the lock rather than trusting the ack.
 */

/**
 * Normative-local: how long `stop` waits for verified termination. Covers
 * the daemon's 30s drain deadline plus margin for lock release.
 */
export const STOP_WAIT_MS = 35_000;
const STOP_POLL_MS = 100;

export interface DaemonCmdDeps {
  daemon: (request: RpcRequest) => Promise<RpcResponse>;
  /** Reads the lifecycle lock: "busy" while a daemon still holds it. */
  probeLifecycle: () => Promise<"free" | "busy">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * Skew reporting for this process (spec §4), at MODULE scope so "once per
 * process" is true by construction — the same posture `approvals.ts` takes,
 * and for the same reason: a per-invocation latch would silently become
 * "once per invocation" the day anything called the entrypoint twice.
 *
 * Production-only: tests build their own `DaemonCmdDeps` and never reach
 * `prodDeps`, so this latch is untouched across test cases.
 */
const reportSkew = createSkewReporter((line) => process.stderr.write(`${line}\n`));

function prodDeps(stateDir: string): DaemonCmdDeps {
  // Resolved once, so the lock this command polls is the one the daemon it
  // just spoke to holds — the same single resolver every other consumer runs.
  const paths = daemonPaths(resolveEffectiveStateDir(stateDir));
  return {
    daemon: (request) =>
      daemonRequest({
        stateDir,
        role: "control",
        request,
        deadlineMs: deadlineForRequest(request),
        // NEVER spawns (spec §3.2) — see the module docblock.
        autoStart: false,
        // Skew WARNS and never blocks (spec §4).
        onHandshake: reportSkew,
      }),
    probeLifecycle: () => probeShared(paths.lifecycleLockDb),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  };
}

/**
 * A pre-control daemon rejects the control handshake as an invalid
 * capability: its vocabulary predates `control` entirely, so it answers the
 * handshake rather than the request.
 */
function isPreControlRejection(response: RpcResponse): boolean {
  return (
    response.kind === "error" &&
    response.code === "invalid" &&
    response.message.includes("handshake.capability must be one of")
  );
}

const PRE_CONTROL_REMEDIATION =
  "[conduit daemon] the running daemon predates the control API and cannot be reached over " +
  "RPC. Stop it by signal: find the conduit process running with --daemon and send it " +
  "SIGTERM (safe: paused approvals are durable and survive). The next command auto-starts " +
  "a current daemon.";

/**
 * The refusal arms both verbs share, reduced to either an exit code or the
 * payload the caller may now read.
 *
 * Returning the PAYLOAD rather than a "keep going" signal is what keeps the
 * one unavoidable cast in one place: the wire type says `unknown` for these
 * kinds (correctly — a decoder cannot know which kind it is answering), so
 * a caller that only learned "not refused" would have to re-narrow the
 * response itself, at every call site.
 */
type Accepted<P> = { ok: true; payload: P } | { ok: false; exitCode: number };

function acceptResult<P>(verb: string, response: RpcResponse, deps: DaemonCmdDeps): Accepted<P> {
  if (isPreControlRejection(response)) {
    deps.stderr(`${PRE_CONTROL_REMEDIATION}\n`);
    return { ok: false, exitCode: 1 };
  }
  if (response.kind !== "result") {
    deps.stderr(`[conduit daemon] ${verb} failed: unexpected ${response.kind} answer.\n`);
    return { ok: false, exitCode: 1 };
  }
  return { ok: true, payload: response.payload as P };
}

function unavailableExitCode(
  err: DaemonUnavailable,
  absentExitCode: number,
  deps: DaemonCmdDeps,
): number {
  if (err.code === "rotation-in-progress") {
    // A rotating daemon is not a missing one: the operator's next step is
    // to wait for the rotation, not to start anything.
    deps.stderr(`[conduit daemon] ${err.message}\n`);
    return 1;
  }
  deps.stdout("not running\n");
  return absentExitCode;
}

export async function runStatus(deps: DaemonCmdDeps): Promise<number> {
  let response: RpcResponse;
  try {
    response = await deps.daemon({ kind: "daemon.status" });
  } catch (err) {
    if (err instanceof DaemonUnavailable) {
      // Exit 3 (normative, spec §3.2): scripts must never read "not
      // running" as healthy.
      return unavailableExitCode(err, 3, deps);
    }
    throw err;
  }
  // Typed by `RpcPayloadFor<"daemon.status">` on the daemon's side; the
  // client seam types `payload` as `unknown`, so this names the projection
  // both ends are compiled against.
  const accepted = acceptResult<DaemonStatusPayload>("status", response, deps);
  if (!accepted.ok) return accepted.exitCode;
  const status = accepted.payload;
  deps.stdout(
    "running\n" +
      `  pid:         ${status.pid}\n` +
      `  version:     ${status.agentVersion} (this CLI: ${AGENT_VERSION})\n` +
      `  started:     ${new Date(status.startedAt).toISOString()}\n` +
      `  db:          ${status.dbPath}\n` +
      `  connections: ${status.connections}\n` +
      `  in flight:   ${status.executionsInFlight} running, ${status.queueDepth} queued\n` +
      `  log:         ${status.logPath ?? "stderr (hand-started)"}${
        status.logSizeBytes !== null ? ` (${status.logSizeBytes} bytes)` : ""
      }\n`,
  );
  return 0;
}

export async function runStop(deps: DaemonCmdDeps): Promise<number> {
  let response: RpcResponse;
  try {
    response = await deps.daemon({ kind: "daemon.stop" });
  } catch (err) {
    if (err instanceof DaemonUnavailable) {
      // Idempotent (spec §3.2): the operator wanted it stopped; it is.
      return unavailableExitCode(err, 0, deps);
    }
    throw err;
  }
  // The ack payload (`{stopping: true}`) carries nothing this command
  // reports: it means "will stop", and the fact worth printing is whether
  // it DID, which the lock below answers.
  const accepted = acceptResult<DaemonStopPayload>("stop", response, deps);
  if (!accepted.ok) return accepted.exitCode;

  // Ack received; wait for VERIFIED termination — see the module docblock.
  const waitUntil = deps.now() + STOP_WAIT_MS;
  while (deps.now() < waitUntil) {
    if ((await deps.probeLifecycle()) === "free") {
      deps.stdout("stopped\n");
      return 0;
    }
    await deps.sleep(STOP_POLL_MS);
  }
  deps.stderr(
    "[conduit daemon] stop requested; the daemon is still draining in-flight work " +
      "(bounded by its drain deadline). Re-run `conduit daemon status` to confirm it exited.\n",
  );
  return 1;
}

export interface DaemonCmdOptions {
  /** Defaults to the uid-derived `DEFAULT_CONDUIT_DIR` (design §3.1). */
  stateDir?: string;
}

/** Production entrypoint wired into the CLI dispatch (bin.ts). */
export async function daemonCommand(argv: string[], opts: DaemonCmdOptions = {}): Promise<number> {
  const deps = prodDeps(opts.stateDir ?? DEFAULT_CONDUIT_DIR);
  const [sub] = argv;
  switch (sub) {
    case "status":
      return runStatus(deps);
    case "stop":
      return runStop(deps);
    default:
      deps.stderr(
        `[conduit daemon] Unknown subcommand: ${sub ?? "(none)"}. Usage: conduit daemon status|stop\n`,
      );
      return 1;
  }
}
