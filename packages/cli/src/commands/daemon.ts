import {
  AGENT_VERSION,
  createSkewReporter,
  DaemonUnavailable,
  DEFAULT_CONDUIT_DIR,
  daemonPaths,
  daemonRequest,
  deadlineForRequest,
  probeShared,
  type RpcRequest,
  type RpcResponse,
  type RpcResponseFor,
  resolveEffectiveStateDir,
  sanitizeVersionForDisplay,
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

/**
 * The daemon seam, kind-GENERIC so the `RpcPayloadFor` map survives the
 * call. Typing this `(request: RpcRequest) => Promise<RpcResponse>` would
 * widen `payload` back to `unknown` at every call site and force each
 * reader to re-narrow it by hand — the untyped call sites the map exists to
 * retire (`RpcResponseFor`'s docblock). With `K` bound by the request, a
 * `daemon.status` call returns a response whose `result` arm is already
 * typed to `DaemonStatusPayload`.
 */
export type DaemonCmdCall = <K extends RpcRequest["kind"]>(
  request: Extract<RpcRequest, { kind: K }>,
) => Promise<RpcResponseFor<K>>;

export interface DaemonCmdDeps {
  daemon: DaemonCmdCall;
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
    // `daemonRequest` is generic in the same kind, so the projection is
    // carried end to end with no annotation of its own.
    daemon: <K extends RpcRequest["kind"]>(request: Extract<RpcRequest, { kind: K }>) =>
      daemonRequest<K>({
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
 * The REFUSAL arms both verbs share: prints the operator line and answers
 * whether the response is a usable result.
 *
 * A TYPE PREDICATE rather than an exit-code return, so a `true` narrows the
 * caller's `response` to the `result` arm — whose `payload` the
 * `RpcResponseFor<K>` map has already typed to that kind's projection. That
 * is what lets both verbs read their payload with no cast at all.
 *
 * Both refusals exit 1, so the caller needs no code from here: a
 * pre-control daemon and a desynced frame are each "this did not happen",
 * distinct from the absent-daemon codes, which are decided before any
 * response exists.
 */
function isUsableResult<K extends RpcRequest["kind"]>(
  verb: string,
  response: RpcResponseFor<K>,
  deps: DaemonCmdDeps,
): response is Extract<RpcResponseFor<K>, { kind: "result" }> {
  if (isPreControlRejection(response)) {
    deps.stderr(`${PRE_CONTROL_REMEDIATION}\n`);
    return false;
  }
  if (response.kind !== "result") {
    deps.stderr(`[conduit daemon] ${verb} failed: unexpected ${response.kind} answer.\n`);
    return false;
  }
  return true;
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
  let response: RpcResponseFor<"daemon.status">;
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
  if (!isUsableResult("status", response, deps)) return 1;
  // Already `DaemonStatusPayload` — the kind-generic seam carried the
  // projection through. The client guard (`isDaemonStatusShape`) is what
  // makes that compile-time claim safe to READ: a malformed payload was
  // refused above as an `error` frame, so no field access here can throw.
  const status = response.payload;
  deps.stdout(
    "running\n" +
      `  pid:         ${status.pid}\n` +
      // The daemon's version is UNTRUSTED DISPLAY INPUT — it arrives over a
      // socket and lands on a terminal, exactly like the skew warning's
      // copy of it, so it goes through the same allowlist. The guard proves
      // it is a STRING; it does not prove the string is printable.
      `  version:     ${sanitizeVersionForDisplay(status.agentVersion)} (this CLI: ${AGENT_VERSION})\n` +
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
  let response: RpcResponseFor<"daemon.stop">;
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
  // it DID, which the lock below answers. So the result is checked for the
  // refusal arms and its payload deliberately never read.
  if (!isUsableResult("stop", response, deps)) return 1;

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
