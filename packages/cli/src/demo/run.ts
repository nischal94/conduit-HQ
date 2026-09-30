// packages/cli/src/demo/run.ts
import { createApprovalRuntime, provisionSourceRequest } from "@conduithq/mcp";
import {
  type ExecutionManager,
  type ExecutionOutcome,
  openSqliteStore,
  type ResumeOutcome,
  SecretBox,
} from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { DEMO_NAMESPACE, DEMO_TOOL, type DemoUpstream, startDemoUpstream } from "./upstream.js";

export const APPROVED_INPUT = { title: "approved by you" };
export const DENIED_INPUT = { title: "denied by you" };

export interface DemoEvidence {
  approve: {
    pausedBeforeRun: boolean;
    status: string;
    decisionApplied: boolean;
    approvedCalls: number;
    exactInput: boolean;
    /** The execution's error (`name: message`) when it ended `failed`. */
    error?: string;
  };
  deny: {
    pausedBeforeRun: boolean;
    status: string;
    decisionApplied: boolean;
    deniedCalls: number;
    /** The execution's error (`name: message`) when it ended `failed`. */
    error?: string;
  };
  replay: { status: string; totalCallsAfter: number };
}

interface DemoResultBase {
  ok: boolean;
  failures: string[];
  /** Runtime log lines, kept out of stdout; the command prints them only on failure. */
  log: string[];
}

/**
 * `evidence` is null only when the demo could not start: nothing was
 * observed, so there is nothing to report. `renderDemo` re-derives the
 * verdict from `evidence` and does not trust `ok` alone.
 */
export type DemoResult =
  | (DemoResultBase & { evidence: DemoEvidence })
  | (DemoResultBase & { ok: false; evidence: null });

/** The two manager calls the demo makes. */
export type DemoManager = Pick<ExecutionManager, "start" | "resume">;

export interface DemoDeps {
  startUpstream?: () => Promise<DemoUpstream>;
  /** Test seam: wraps the runtime's manager so a test can make it lie. */
  wrapManager?: (manager: DemoManager) => DemoManager;
}

function program(input: { title: string }): string {
  return `return await tools.${DEMO_NAMESPACE}.${DEMO_TOOL}(${JSON.stringify(input)});`;
}

function countWithTitle(calls: DemoUpstream["calls"], title: string): number {
  return calls.filter(
    (c) =>
      c.name === DEMO_TOOL && (c.arguments as { title?: unknown } | undefined)?.title === title,
  ).length;
}

export function times(n: number): string {
  return n === 1 ? "1 time" : `${n} times`;
}

function errorOf(outcome: ExecutionOutcome | ResumeOutcome): { error?: string } {
  return outcome.status === "failed"
    ? { error: `${outcome.error.name}: ${outcome.error.message}` }
    : {};
}

function cause(error: string | undefined): string {
  return error === undefined ? "" : `: ${error}`;
}

/**
 * The demo's verdict, as a pure function of the evidence, so each of the
 * nine checks can be proven to fail on its own (run.test.ts). Returns one
 * message per broken check; an empty list is a PASS. A failed execution's
 * error is appended to the message of the check it broke.
 */
export function judgeEvidence(e: DemoEvidence): string[] {
  const failures: string[] = [];
  if (!e.approve.pausedBeforeRun) {
    failures.push("the approve execution did not pause before the upstream call");
  }
  if (e.approve.status !== "completed" || !e.approve.decisionApplied) {
    const status = `(status ${e.approve.status})${cause(e.approve.error)}`;
    failures.push(
      e.approve.decisionApplied
        ? `the approval was applied, but the approved call did not complete ${status}`
        : `the approval was not applied ${status}`,
    );
  }
  if (e.approve.approvedCalls !== 1) {
    failures.push(`the approved call ran ${times(e.approve.approvedCalls)}, expected 1 time`);
  }
  if (!e.approve.exactInput) {
    failures.push("the upstream did not receive the exact approved input");
  }
  if (!e.deny.pausedBeforeRun) {
    failures.push("the deny execution did not pause before the upstream call");
  }
  if (!e.deny.decisionApplied) {
    failures.push(`the denial was not applied (status ${e.deny.status})${cause(e.deny.error)}`);
  }
  if (e.deny.deniedCalls !== 0) {
    failures.push(`the denied call ran ${times(e.deny.deniedCalls)}, expected 0 times`);
  }
  if (e.replay.status !== "conflict") {
    failures.push(`a replayed approval returned ${e.replay.status}, expected conflict`);
  }
  if (e.replay.totalCallsAfter !== 1) {
    failures.push(
      `the upstream received ${times(e.replay.totalCallsAfter)} in total, expected 1 time`,
    );
  }
  return failures;
}

/**
 * Never throws: a run that cannot start (the loopback bind fails, onboarding
 * is refused, the store cannot open) is a FAIL with the reason and the
 * captured log, so the operator sees what the runtime said.
 */
export async function runDemo(deps: DemoDeps = {}): Promise<DemoResult> {
  const log: string[] = [];
  try {
    return await drive(deps, log);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, evidence: null, failures: [`the demo could not run: ${reason}`], log };
  }
}

async function drive(deps: DemoDeps, log: string[]): Promise<DemoResult> {
  const sink = (line: string): void => {
    log.push(line);
  };
  const upstream = await (deps.startUpstream ?? startDemoUpstream)();
  // Cleanup is armed before anything else can throw, so a failure can never
  // leave the loopback server open and hang the process.
  let client: ReturnType<typeof createClient> | undefined;
  try {
    client = createClient({ url: ":memory:" });
    const store = await openSqliteStore({
      client,
      secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
      log: sink,
    });
    await provisionSourceRequest(
      {
        namespace: DEMO_NAMESPACE,
        url: upstream.url,
        prefix: "demo.local",
        replace: false,
        clearCredential: false,
      },
      { store, log: sink },
    );
    // Private egress is granted HERE, in code, to this process only, for the
    // loopback server this process just started. The adopter's daemon and
    // the CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS env var are never touched.
    const runtime = await createApprovalRuntime({ store, allowPrivateEgress: true, log: sink });
    const manager: DemoManager = deps.wrapManager
      ? deps.wrapManager(runtime.manager)
      : runtime.manager;

    // Act 1: approve.
    const a = await manager.start(program(APPROVED_INPUT));
    const aPausedBeforeRun = a.status === "paused" && upstream.calls.length === 0;
    const aResumed =
      a.status === "paused"
        ? await manager.resume(a.executionId, { kind: "approve" }, a.pending.callId)
        : undefined;
    const approvedCalls = countWithTitle(upstream.calls, APPROVED_INPUT.title);
    const exactInput =
      upstream.calls.length > 0 &&
      JSON.stringify(upstream.calls[0]?.arguments) === JSON.stringify(APPROVED_INPUT);

    // Act 2: deny.
    const callsBeforeDeny = upstream.calls.length;
    const d = await manager.start(program(DENIED_INPUT));
    const dPausedBeforeRun = d.status === "paused" && upstream.calls.length === callsBeforeDeny;
    const dResumed =
      d.status === "paused"
        ? await manager.resume(d.executionId, { kind: "deny" }, d.pending.callId)
        : undefined;
    const deniedCalls = countWithTitle(upstream.calls, DENIED_INPUT.title);

    // Act 3: replay the approval of the call that already ran.
    const replay =
      a.status === "paused"
        ? await manager.resume(a.executionId, { kind: "approve" }, a.pending.callId)
        : undefined;
    const totalCallsAfter = upstream.calls.length;

    const evidence: DemoEvidence = {
      approve: {
        pausedBeforeRun: aPausedBeforeRun,
        status: aResumed?.status ?? a.status,
        decisionApplied: aResumed?.decisionApplied ?? false,
        approvedCalls,
        exactInput,
        ...errorOf(aResumed ?? a),
      },
      deny: {
        pausedBeforeRun: dPausedBeforeRun,
        status: dResumed?.status ?? d.status,
        decisionApplied: dResumed?.decisionApplied ?? false,
        deniedCalls,
        ...errorOf(dResumed ?? d),
      },
      replay: { status: replay?.status ?? "not-run", totalCallsAfter },
    };

    const failures = judgeEvidence(evidence);
    return { ok: failures.length === 0, evidence, failures, log };
  } finally {
    client?.close();
    await upstream.close();
  }
}
