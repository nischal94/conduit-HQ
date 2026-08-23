import { createSkewReporter } from "@conduithq/mcp";

/**
 * The CLI's ONE version-skew latch (spec §4).
 *
 * Every CLI entry point that talks to the daemon reports skew, and the
 * warning is the same fact each time — so it is issued once per PROCESS,
 * not once per command module. This file exists because "once per process"
 * was previously claimed by three separate module-scope latches
 * (`approvals.ts`, `add-mcp.ts`, `daemon.ts`); a process that crossed two
 * of those modules warned twice, which is exactly the duplicate output the
 * latch is for. One instance, imported at all three sites, makes the claim
 * true by construction.
 *
 * The comparand inside `createSkewReporter` is `AGENT_VERSION` — the mcp
 * package's build version — and that is correct: the daemon IS the mcp
 * package, so the skew being diagnosed is between this CLI's bundled mcp
 * and the running daemon's. It is deliberately NOT the CLI's own `VERSION`
 * from `dispatch.ts`, which names the user-facing CLI release.
 *
 * Production-only: tests build their own deps and never reach the
 * production entrypoints, so this latch is untouched across test cases.
 *
 * `runtime-stdio.ts` keeps its own reporter — different package, and
 * entrypoint-scoped for the reason its own docblock gives.
 */
export const reportSkew = createSkewReporter((line) => process.stderr.write(`${line}\n`));
