import { type DemoResult, runDemo, times } from "../demo/run.js";
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

export function renderDemo(result: DemoResult): {
  stdout: string;
  stderr: string;
  exitCode: 0 | 1;
} {
  const { approve, deny, replay } = result.evidence;
  const lines = [
    `approve: ${approve.pausedBeforeRun ? "paused before it ran" : "DID NOT PAUSE"}; after approval the upstream received it ${times(approve.approvedCalls)}${approve.exactInput ? ", with the exact input" : ", NOT with the exact input"}`,
    `deny:    ${deny.pausedBeforeRun ? "paused before it ran" : "DID NOT PAUSE"}; after denial the upstream received it ${times(deny.deniedCalls)}`,
    `replay:  approving the same call again was ${replay.status === "conflict" ? "refused (conflict)" : `answered ${replay.status}`}; upstream total is still ${replay.totalCallsAfter}`,
    "",
    result.ok ? "PASS" : "FAIL",
    ...(result.ok ? [NEXT_STEP] : []),
  ];
  const stderr = result.ok
    ? ""
    : [
        "[conduit demo] Checks failed:",
        ...result.failures.map((f) => `  - ${f}`),
        "Runtime log:",
        ...result.log.map((l) => `  ${l}`),
        "",
      ].join("\n");
  return { stdout: `${lines.join("\n")}\n`, stderr, exitCode: result.ok ? 0 : 1 };
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
