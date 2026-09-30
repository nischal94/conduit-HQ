import { type DemoResult, judgeEvidence, runDemo, times } from "../demo/run.js";
import { INSTALL_NOTES_URL } from "../version.js";

export const DEMO_USAGE = `Usage: conduit demo

Shows Conduit's approval gate end to end, in memory, with no external
network (loopback only) and no setup. A local demo upstream exposes one
tool that needs approval. The demo approves one call and denies another,
then reports what the upstream actually received. It never opens or
creates anything in ~/.conduit.

Exit code: 0 when every check passes, 1 otherwise.`;

/** Printed BEFORE the run, so the few seconds of QuickJS boot are visibly working. */
export const DEMO_HEADER = "conduit demo — the approval gate, end to end (in memory). Running…";

/** Printed after PASS: the adopter's next command, at the moment they need it. */
export const NEXT_STEP = `Next: follow step 4 of ${INSTALL_NOTES_URL} to govern your own agent's calls.`;

function runtimeLog(log: string[]): string[] {
  return ["Runtime log:", ...log.map((l) => `  ${l}`)];
}

/**
 * The verdict is re-derived here from the evidence, so a result whose `ok`
 * flag disagrees with its evidence renders FAIL. Any disagreement fails closed.
 */
export function renderDemo(result: DemoResult): {
  stdout: string;
  stderr: string;
  exitCode: 0 | 1;
} {
  if (result.evidence === null) {
    // Nothing ran, so there is no observation to report.
    return {
      stdout: `[conduit demo] Setup failed: ${result.failures.join("; ")}. Context: { checks: none ran }\n\nFAIL\n`,
      stderr: [...runtimeLog(result.log), ""].join("\n"),
      exitCode: 1,
    };
  }
  const failures = [...new Set([...judgeEvidence(result.evidence), ...result.failures])];
  const ok = result.ok && failures.length === 0;
  const { approve, deny, replay } = result.evidence;
  const lines = [
    `approve: ${approve.pausedBeforeRun ? "paused before it ran" : "DID NOT PAUSE"}; after approval the upstream received it ${times(approve.approvedCalls)}${approve.exactInput ? ", with the exact input" : ", NOT with the exact input"}`,
    `deny:    ${deny.pausedBeforeRun ? "paused before it ran" : "DID NOT PAUSE"}; after denial the upstream received it ${times(deny.deniedCalls)}`,
    `replay:  approving the same call again was ${replay.status === "conflict" ? "refused (conflict)" : `answered ${replay.status}`}; upstream total is still ${replay.totalCallsAfter}`,
    "",
    ok ? "PASS" : "FAIL",
    ...(ok ? [NEXT_STEP] : []),
  ];
  const stderr = ok
    ? ""
    : [
        "[conduit demo] Checks failed:",
        ...failures.map((f) => `  - ${f}`),
        ...runtimeLog(result.log),
        "",
      ].join("\n");
  return { stdout: `${lines.join("\n")}\n`, stderr, exitCode: ok ? 0 : 1 };
}

export async function demo(
  argv: string[],
  opts: { run?: () => Promise<DemoResult> } = {},
): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write(
      `[conduit demo] Unexpected arguments: ${argv.join(" ")}\n\n${DEMO_USAGE}\n`,
    );
    return 1;
  }
  process.stdout.write(`${DEMO_HEADER}\n\n`);
  const out = renderDemo(await (opts.run ?? runDemo)());
  process.stdout.write(out.stdout);
  if (out.stderr !== "") {
    process.stderr.write(out.stderr);
  }
  return out.exitCode;
}
