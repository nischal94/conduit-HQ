import {
  DaemonUnavailable,
  DEFAULT_CONDUIT_DIR,
  daemonRequest,
  deadlineForRequest,
  type PausedListRow,
  type ResumePayload,
  type RpcRequest,
  type RpcResponse,
} from "@conduithq/mcp";

/**
 * `conduit approvals list|approve|deny` — the human approval queue (design
 * §2.3), driven through the DAEMON since Task 7 (§17).
 *
 * **This command opens no database.** Before the conversion it called
 * `openStoreFromEnv` directly, which was survivable only while nothing else
 * held the db. Task 6 removed that condition: every `conduit serve`
 * auto-starts a daemon, so a direct open here became a SECOND owner of
 * `~/.conduit/conduit.db` automatically rather than only when an operator
 * opted in — the dual ownership §17 exists to eliminate. Both operations now
 * travel the capability-scoped `approvals` RPC set (`approvals.list`,
 * `approvals.resume`), and auto-start lives inside `daemonRequest`, so "no
 * daemon yet" is an ordinary first call rather than a failure.
 *
 * `list` still NEVER writes: it renders the daemon's paused-row projection
 * and computes the expiry label at DISPLAY time. `approve`/`deny` drive
 * `manager.resume` inside the daemon — including the M6 fresh-runtime rule,
 * which now holds daemon-side where the store lives.
 *
 * The single injectable dep is the daemon call itself (the DI seam that
 * replaced `openStore`/`createRuntime`): tests drive the whole command
 * against a fake daemon with no sockets, exactly as `runStdioServer`'s
 * tests do for `serve`.
 */

export type ApprovalsDaemonCall = (request: RpcRequest) => Promise<RpcResponse>;

export interface ApprovalsDeps {
  /** Every read and every resume goes through here, capability `approvals`. */
  daemon: ApprovalsDaemonCall;
  now: () => number;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface ApprovalsResult {
  exitCode: number;
}

/**
 * Production deps for one invocation.
 *
 * `stateDir` is a CODE-level parameter threaded from the (undocumented)
 * `--state-dir` flag and never read from the environment — the same posture
 * `serve` takes, and for the same reason: the state directory selects which
 * daemon, and therefore which database, this command decides against.
 */
function prodDeps(stateDir: string): ApprovalsDeps {
  return {
    daemon: (request) =>
      daemonRequest({
        stateDir,
        role: "approvals",
        request,
        // Per-kind, via the shared table: a resume is queued and then RUNS,
        // so it carries the derived resume budget rather than a read's.
        deadlineMs: deadlineForRequest(request),
      }),
    now: () => Date.now(),
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  };
}

/**
 * The daemon's `approvals.list` projection — the rows `connection.ts` sends,
 * imported from the daemon side (`PausedListRow`) so the two ends of the
 * socket cannot drift apart on this shape.
 *
 * Structurally FLAT and narrower than a stored `Execution`: the daemon
 * projects the five fields this command renders and drops the raw
 * `pausedOn`, whose `input` is the paused call's arguments. A corrupt row
 * (paused with no `pausedOn`) is omitted and logged daemon-side, so nothing
 * here has to defend against it.
 */
type PausedRowWire = PausedListRow;

/**
 * One daemon round trip, reduced to either a payload or an operator-facing
 * refusal. Every non-`result` answer is a REFUSAL rather than an empty
 * success, which matters most for `list`: rendering "no paused executions"
 * for a queue the daemon never reported would tell an operator that nothing
 * awaits them, which is the one wrong answer this command must never give.
 */
type Answer = { ok: true; payload: unknown } | { ok: false; line: string; exitCode: number };

function describeResponse(response: RpcResponse, verb: string): Answer {
  if (response.kind === "result") return { ok: true, payload: response.payload };
  if (response.kind === "outcome-unknown") {
    // §5's ambiguity, and the one answer whose mishandling is dangerous in
    // BOTH directions. The connection died after the request bytes went
    // out, so the resume may have driven the execution and may not have.
    // Reporting the verb as landed would be the same false positive the
    // decisionApplied contract exists to kill; retrying could apply a
    // second decision to an execution that already consumed one. So: no
    // verb line, a non-zero exit, and a lookup instruction.
    return {
      ok: false,
      exitCode: 1,
      line:
        `[conduit approvals] The outcome of this ${verb} is UNKNOWN: the daemon connection was ` +
        `lost after the request was sent, so it may or may not have been applied ` +
        `(requestId ${response.requestId}). Do NOT retry it — run "conduit approvals list" to ` +
        `see whether the execution is still awaiting a decision.\n`,
    };
  }
  if (response.kind === "error") {
    // The daemon's own typed refusal. Its message is client-safe by
    // construction (`connection.ts` sends a fixed string for `internal`),
    // and it is strictly more useful than a generic line: `busy` and
    // `rotation-in-progress` each name a different next step.
    return {
      ok: false,
      exitCode: 1,
      line: `[conduit approvals] ${verb} refused by the daemon (${response.code}): ${response.message}\n`,
    };
  }
  // `ready`/`handshake.ok` are prefaces the client already consumed.
  return {
    ok: false,
    exitCode: 1,
    line: `[conduit approvals] ${verb} failed: protocol desync (unexpected ${response.kind} frame).\n`,
  };
}

/**
 * Calls the daemon, folding a thrown `DaemonUnavailable` into the same
 * Answer shape. That error is NOT dressed up: it already carries the state
 * directory, the deadline, and the daemon log path that explains why a
 * child exited — everything the operator needs to act, and this is an
 * operator-facing command, so unlike the agent-facing `serve` seam there is
 * nothing here to redact it from.
 */
async function ask(deps: ApprovalsDeps, request: RpcRequest, verb: string): Promise<Answer> {
  try {
    return describeResponse(await deps.daemon(request), verb);
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      line:
        error instanceof DaemonUnavailable
          ? `${error.message}\n`
          : `[conduit approvals] ${verb} could not reach the Conduit daemon: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
    };
  }
}

interface PausedRow {
  executionId: string;
  tool: string;
  waitingSince: number;
  expiresAt: number;
  expired: boolean;
}

function toPausedRow(row: PausedRowWire, now: number): PausedRow {
  return {
    executionId: row.executionId,
    tool: row.toolName,
    waitingSince: row.startedAt,
    expiresAt: row.expiresAt,
    // The only DISPLAY-time derivation: `list` never writes, so expiry is
    // computed against the caller's clock rather than read from a row.
    expired: row.expiresAt < now,
  };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

function expiryLabel(row: PausedRow, now: number): string {
  return row.expired
    ? "EXPIRED (finalizes on next resume)"
    : `${formatDuration(row.expiresAt - now)} remaining`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function renderTable(rows: PausedRow[], now: number): string {
  if (rows.length === 0) {
    return "No paused executions awaiting approval.\n";
  }
  const idWidth = Math.max(7, ...rows.map((r) => r.executionId.length));
  const toolWidth = Math.max(4, ...rows.map((r) => r.tool.length));
  const lines = rows.map((row) => {
    const waiting = new Date(row.waitingSince).toISOString();
    return `${pad(row.executionId, idWidth)}  ${pad(row.tool, toolWidth)}  ${pad(waiting, 24)}  ${expiryLabel(row, now)}`;
  });
  const header = `${pad("EXEC ID", idWidth)}  ${pad("TOOL", toolWidth)}  ${pad("WAITING SINCE", 24)}  EXPIRY`;
  return `${[header, ...lines].join("\n")}\n`;
}

export async function runList(
  args: { json: boolean },
  deps: ApprovalsDeps,
): Promise<ApprovalsResult> {
  const answer = await ask(deps, { kind: "approvals.list" }, "list");
  if (!answer.ok) {
    deps.stderr(answer.line);
    return { exitCode: answer.exitCode };
  }
  const now = deps.now();
  const rows = (answer.payload as PausedRowWire[]).map((row) => toPausedRow(row, now));

  if (args.json) {
    deps.stdout(
      `${JSON.stringify(
        rows.map((row) => ({
          executionId: row.executionId,
          tool: row.tool,
          waitingSince: row.waitingSince,
          expiresAt: row.expiresAt,
          expired: row.expired,
        })),
      )}\n`,
    );
  } else {
    deps.stdout(renderTable(rows, now));
  }
  return { exitCode: 0 };
}

const EXPIRED_LINE =
  "[conduit approvals] The approval expired before the decision applied: " +
  "the execution was finalized as expired, and no tool call was made.";

/**
 * Shared queue guidance for a drive that re-paused on a fresh approval —
 * one source of truth for the wording, whichever branch reports it (the
 * applied-deny informational line and the generic paused arm).
 */
function pausedAgainGuidance(pending: { toolName: string; reason: string } | undefined): string {
  // `pending` is optional on the wire projection (`ExecutePayload`) even
  // though the daemon always fills it for a paused arm. The fallback keeps
  // the ACTIONABLE half of the guidance — the queue command — rather than
  // printing "undefined (undefined)" at an operator, since the projection's
  // optionality is a type fact this command does not get to assume away.
  return pending === undefined
    ? 'paused again on a new approval. Run "conduit approvals list" to see the queue and decide again.'
    : `paused again on a new approval: ${pending.toolName} (${pending.reason}). ` +
        `Run "conduit approvals list" to see the queue and decide again.`;
}

/**
 * One rendering of the projected error envelope for operator-facing lines.
 * `code` carries what the raw `SandboxError.name` used to, so the operator
 * text is unchanged across the daemon conversion.
 */
function formatOutcomeError(error: { code: string; message: string } | undefined): string {
  return error === undefined ? "an unreported error" : `${error.code}: ${error.message}`;
}

export async function runDecide(
  kind: "approve" | "deny",
  executionId: string | undefined,
  deps: ApprovalsDeps,
): Promise<ApprovalsResult> {
  if (executionId === undefined || executionId.trim() === "") {
    deps.stderr(`[conduit approvals] ${kind}: missing required <execution-id>.\n`);
    return { exitCode: 1 };
  }

  // The daemon drives the resume — including the M6 fresh-runtime-per-call
  // rule, which now holds on the side that owns the store.
  const answer = await ask(deps, { kind: "approvals.resume", executionId, decision: kind }, kind);
  if (!answer.ok) {
    deps.stderr(answer.line);
    return { exitCode: answer.exitCode };
  }
  const outcome = answer.payload as ResumePayload;

  // Deny verb-truth: the exit code and the "denied" line report the OPERATOR'S
  // VERB, and the verb's success is `decisionApplied` — the manager's host-side
  // record that the staged deny was consumed by the pending call (decisions
  // seam, design D6). Never key this on the outcome's error name: names are
  // guest-reachable (a guest can forge ConduitPolicyBlocked, or catch the real
  // one and continue), so name-matching is wrong in both directions. The deny
  // landing and the drive's own fate are independent axes — the guest may
  // catch the (catchable) denial and complete, run into a later unrelated
  // failure, or pause on a new approval; in every case the deny itself
  // succeeded, so report "denied" (exit 0) plus one informational line about
  // what the drive then did.
  if (kind === "deny" && outcome.decisionApplied) {
    deps.stdout("denied\n");
    if (outcome.status === "paused") {
      deps.stderr(
        `[conduit approvals] The deny was applied; the execution then ${pausedAgainGuidance(outcome.pending)}\n`,
      );
    } else {
      const driveOutcome =
        outcome.status === "failed"
          ? `failed (${formatOutcomeError(outcome.error)})`
          : outcome.status;
      deps.stderr(
        `[conduit approvals] The deny was applied; the execution then settled as ${driveOutcome}.\n`,
      );
    }
    return { exitCode: 0 };
  }

  deps.stdout(`${outcome.status}\n`);

  if (outcome.status === "expired") {
    deps.stderr(`${EXPIRED_LINE}\n`);
    return { exitCode: 0 };
  }
  if (outcome.status === "paused") {
    // The approved call ran, and the resumed execution reached ANOTHER
    // require_approval call (manager re-enters the drive loop on resume) —
    // a fresh pausedOn is persisted and a second human decision is needed.
    deps.stderr(`[conduit approvals] Execution ${pausedAgainGuidance(outcome.pending)}\n`);
    return { exitCode: 0 };
  }
  if (outcome.status === "conflict" || outcome.status === "failed") {
    if (outcome.status === "failed") {
      deps.stderr(`[conduit approvals] ${kind} failed: ${formatOutcomeError(outcome.error)}\n`);
    } else {
      deps.stderr(
        `[conduit approvals] ${kind}: execution ${executionId} was not in a resumable (paused) state.\n`,
      );
    }
    return { exitCode: 1 };
  }
  if (!outcome.decisionApplied) {
    // Structurally only status "completed" reaches here today, but the
    // message reports `outcome.status` rather than hardcoding it — the
    // guarantee is branch ordering, not a type guard, so a future status arm
    // reaching this branch must not describe the wrong fate. The drive
    // settled without the staged decision
    // ever being consumed — the resumed replay never re-reached the pending
    // call (a divergence that never manifested as a call). The pending call
    // did not run, but the operator's verb did not land either; exit codes
    // track the verb, for BOTH verbs symmetrically.
    deps.stderr(
      `[conduit approvals] ${kind} was never applied: the resumed execution settled as ` +
        `${outcome.status} without re-reaching the pending call, so no decision was consumed. ` +
        `The pending call did not run.\n`,
    );
    return { exitCode: 1 };
  }
  return { exitCode: 0 };
}

export interface ApprovalsOptions {
  /** Defaults to the uid-derived `DEFAULT_CONDUIT_DIR` (design §3.1). */
  stateDir?: string;
}

/** Production entrypoint wired into the CLI dispatch (bin.ts). */
export async function approvals(argv: string[], opts: ApprovalsOptions = {}): Promise<number> {
  // NOTE: sandbox module-recovery diagnostics are registered by the DAEMON
  // (`conduitd.ts`), not here — the same move `server.ts` made in D-B1.
  // Since Task 7 this process runs no sandbox at all: a resumed execution
  // replays inside the daemon, so a sink installed here could never fire,
  // and leaving one would imply this process still executes guest code.
  const deps = prodDeps(opts.stateDir ?? DEFAULT_CONDUIT_DIR);
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list": {
      const json = rest.includes("--json");
      const result = await runList({ json }, deps);
      return result.exitCode;
    }
    case "approve":
    case "deny": {
      const result = await runDecide(sub, rest[0], deps);
      return result.exitCode;
    }
    default: {
      deps.stderr(
        `[conduit approvals] Unknown subcommand: ${sub ?? "(none)"}. Usage: conduit approvals list|approve|deny [<execution-id>]\n`,
      );
      return 1;
    }
  }
}
