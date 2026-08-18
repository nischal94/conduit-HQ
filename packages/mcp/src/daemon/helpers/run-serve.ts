/**
 * Real-process test fixture: runs the stdio MCP server (`runStdioServer`)
 * against a GIVEN daemon state directory, so an integration test can drive
 * the true serve path over real stdio without touching `~/.conduit`.
 *
 * Usage: node run-serve.mjs <stateDir>
 *
 * Why this exists rather than spawning `dist/bin.js` directly: since Task 6
 * the serve process reaches its database only through a daemon, and the
 * daemon derives its state directory from the AUTHENTICATED OS UID (design
 * §3.1) — `spawnDaemon` strips `HOME` precisely so a client cannot redirect
 * it. That is the security property, and a test must not weaken it. So the
 * test supplies the state directory the one supported way: as a code-level
 * argument, the same posture as an operator starting a daemon BY HAND.
 *
 * Everything security-relevant is still the REAL code path: the same
 * `runStdioServer`, the same M8 stdout redirect, the same `daemonRequest`
 * client, the same capability-scoped RPC set, over a real socket to a real
 * daemon process. Only the directory differs from production.
 *
 * This file imports its siblings with explicit `.ts` extensions (see
 * hold-lock.ts for the reasoning), which `tsc` rejects without
 * `allowImportingTsExtensions` — so it is excluded from the package
 * tsconfig. It is never built or imported by product code.
 */
import { runStdioServer } from "../../runtime-stdio.ts";

const [, , stateDir] = process.argv;

if (!stateDir) {
  console.error("run-serve: missing stateDir argument");
  process.exit(1);
}

// No try/catch: `runStdioServer` owns its own startup-failure exits (it
// prints the daemon's refusal or the DaemonUnavailable guidance and exits
// 1), and swallowing anything else here would hide a real fault behind a
// test-harness message.
await runStdioServer({ stateDir });
