import { createApprovalRuntime, openStoreFromEnv, type ResolvedEnv } from "@conduithq/mcp";
import {
  type ConduitStore,
  type Execution,
  logSandboxDiagnosticsTo,
  type ResumeOutcome,
} from "@conduithq/sdk";

/**
 * `conduit approvals list|approve|deny` — the human approval queue (design
 * §2.3). `list` reads `store.executions.listPaused()` and computes the
 * expiry label at DISPLAY time from the stored `pausedOn.expiresAt` — it
 * NEVER writes. `approve`/`deny` build a FRESH `ApprovalRuntime` per call
 * (M6 fresh-catalog rule — see runtime.ts's doc comment) and drive
 * `manager.resume`, printing the resulting outcome status.
 *
 * Injectable deps mirror add-mcp.ts's DI convention: production defaults to
 * the real store/runtime; tests substitute a runtime factory to pin
 * individual outcome branches in isolation (real-path coverage also drives
 * an actual manager, including a genuine double-approve `conflict`).
 */

export interface ApprovalsDeps {
  /** Defaults to `openStoreFromEnv`; injectable so tests can pre-open a store. */
  openStore: (env?: NodeJS.ProcessEnv) => Promise<{ env: ResolvedEnv; store: ConduitStore }>;
  /** Defaults to `createApprovalRuntime`; injectable so tests can pin
   * individual outcome branches in isolation. Deliberately NOT
   * given a `log` option here — the seam's own default (console.error) is
   * what production wiring exercises. */
  createRuntime: (opts: { store: ConduitStore; allowPrivateEgress: boolean }) => Promise<{
    manager: {
      resume: (id: string, decision: { kind: "approve" | "deny" }) => Promise<ResumeOutcome>;
    };
  }>;
  env: NodeJS.ProcessEnv;
  now: () => number;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface ApprovalsResult {
  exitCode: number;
}

const PROD_DEPS: ApprovalsDeps = {
  openStore: openStoreFromEnv,
  createRuntime: createApprovalRuntime,
  env: process.env,
  now: () => Date.now(),
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
};

interface PausedRow {
  executionId: string;
  tool: string;
  waitingSince: number;
  expiresAt: number;
  expired: boolean;
}

function toPausedRow(execution: Execution, now: number): PausedRow {
  const pausedOn = execution.pausedOn;
  if (pausedOn === undefined) {
    // Defensive — listPaused only returns status:"paused" rows, which always
    // carry pausedOn (manager.ts invariant). A row without it is corrupt
    // state; surface it rather than silently drop the row.
    throw new Error(
      `[conduit approvals] listPaused returned a paused row with no pausedOn. Context: { executionId: ${execution.id} }`,
    );
  }
  return {
    executionId: execution.id,
    tool: pausedOn.toolName,
    waitingSince: execution.startedAt,
    expiresAt: pausedOn.expiresAt,
    expired: pausedOn.expiresAt < now,
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
  const { store } = await deps.openStore(deps.env);
  const paused = await store.executions.listPaused();
  const now = deps.now();
  const rows = paused.map((execution) => toPausedRow(execution, now));

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

export async function runDecide(
  kind: "approve" | "deny",
  executionId: string | undefined,
  deps: ApprovalsDeps,
): Promise<ApprovalsResult> {
  if (executionId === undefined || executionId.trim() === "") {
    deps.stderr(`[conduit approvals] ${kind}: missing required <execution-id>.\n`);
    return { exitCode: 1 };
  }

  const { env, store } = await deps.openStore(deps.env);
  // M6: fresh runtime per invocation — never cached across calls.
  const runtime = await deps.createRuntime({ store, allowPrivateEgress: env.allowPrivateEgress });
  const outcome = await runtime.manager.resume(executionId, { kind });

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
        `[conduit approvals] The deny was applied; the execution then paused again on a new approval: ` +
          `${outcome.pending.toolName} (${outcome.pending.reason}). ` +
          `Run "conduit approvals list" to see the queue and decide again.\n`,
      );
    } else {
      const driveOutcome =
        outcome.status === "failed"
          ? `failed (${outcome.error.name}: ${outcome.error.message})`
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
    deps.stderr(
      `[conduit approvals] Execution paused again on a new approval: ` +
        `${outcome.pending.toolName} (${outcome.pending.reason}). ` +
        `Run "conduit approvals list" to see the queue and decide again.\n`,
    );
    return { exitCode: 0 };
  }
  if (outcome.status === "conflict" || outcome.status === "failed") {
    if (outcome.status === "failed") {
      deps.stderr(
        `[conduit approvals] ${kind} failed: ${outcome.error.name}: ${outcome.error.message}\n`,
      );
    } else {
      deps.stderr(
        `[conduit approvals] ${kind}: execution ${executionId} was not in a resumable (paused) state.\n`,
      );
    }
    return { exitCode: 1 };
  }
  if (kind === "deny" && !outcome.decisionApplied) {
    // The drive settled as completed without the staged deny ever being
    // consumed — the resumed replay never re-reached the pending call (a
    // divergence that never manifested as a call). The denied call did not
    // run, but the operator's verb did not land either; exit codes track
    // the verb.
    deps.stderr(
      `[conduit approvals] deny was never applied: the resumed execution completed without ` +
        `re-reaching the pending call, so no decision was consumed. The denied call did not run.\n`,
    );
    return { exitCode: 1 };
  }
  return { exitCode: 0 };
}

/** Production entrypoint wired into the CLI dispatch (bin.ts). */
export async function approvals(argv: string[]): Promise<number> {
  // Route sandbox module-recovery diagnostics to this command's stderr, ONCE
  // (the sink is process-global; this is the CLI process's entry point). A
  // resumed execution can itself overflow, so the operator sees the recovery.
  logSandboxDiagnosticsTo((line) => PROD_DEPS.stderr(line));
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list": {
      const json = rest.includes("--json");
      const result = await runList({ json }, PROD_DEPS);
      return result.exitCode;
    }
    case "approve":
    case "deny": {
      const result = await runDecide(sub, rest[0], PROD_DEPS);
      return result.exitCode;
    }
    default: {
      PROD_DEPS.stderr(
        `[conduit approvals] Unknown subcommand: ${sub ?? "(none)"}. Usage: conduit approvals list|approve|deny [<execution-id>]\n`,
      );
      return 1;
    }
  }
}
