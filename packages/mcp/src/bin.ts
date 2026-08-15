#!/usr/bin/env node
import type { ConduitStore } from "@conduithq/sdk";
import { DaemonExit, runDaemon } from "./daemon/conduitd.js";
import { sweepOrphanedExecutions } from "./daemon/sweep.js";
import { DEFAULT_CONDUIT_DIR, KEYGEN_ONE_LINER } from "./env.js";
import { runStdioServer } from "./runtime-stdio.js";
import { openStoreFromEnv } from "./store-open.js";

const VERSION = "0.1.0";
const HELP = `conduit-mcp ${VERSION} — Conduit MCP server (stdio)
Env: CONDUIT_DB (default ~/.conduit/conduit.db) · CONDUIT_MASTER_KEY (base64, 32 bytes;
generate: ${KEYGEN_ONE_LINER}) · CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1 (dev/demo ONLY)
· CONDUIT_APPROVAL_TTL (milliseconds)
Flags: --version · --help · --doctor (validate config without an MCP client)
· --daemon (run the store-owning daemon; stop with SIGTERM/SIGINT)`;

async function doctor(): Promise<number> {
  try {
    const { env, store } = await openStoreFromEnv();
    const sources = await store.sources.list();
    console.error(`ok: key decodes (32 bytes)`);
    console.error(`ok: database opens at ${env.dbPath}`);
    console.error(
      `ok: ${sources.length} source(s) in catalog${sources.length === 0 ? " — onboard one with `conduit add-mcp`" : ""}`,
    );
    console.error(
      `egress opt-in: ${env.allowPrivateEgress ? "ENABLED (unsafe — dev/demo only)" : "off (fail-closed default)"}`,
    );
    return 0;
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 1;
  }
}

/**
 * Adapts the sweep to the daemon's `CrashTerminalSweep` seam, which is
 * `(store) => Promise<void>`. The swept count is already logged by the
 * sweep itself, so discarding the return value here loses nothing — the
 * seam exists to fix WHERE the sweep runs in the startup order, not to
 * report on it. Lines go to stderr, which under `--daemon` is the
 * inherited log descriptor the spawning client opened.
 */
async function sweepDaemonStore(store: ConduitStore): Promise<void> {
  await sweepOrphanedExecutions(store);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--version") {
    console.error(VERSION);
    return;
  }
  if (arg === "--help") {
    console.error(HELP);
    return;
  }
  if (arg === "--doctor") {
    process.exitCode = await doctor();
    return;
  }
  if (arg === "--daemon") {
    try {
      await runDaemon({ stateDir: DEFAULT_CONDUIT_DIR, sweep: sweepDaemonStore });
    } catch (error) {
      // The two refusal paths carry their own exit codes (§3.5's client
      // decision table) — a client branches on the code, not on prose.
      if (error instanceof DaemonExit) {
        console.error(error.message);
        process.exitCode = error.code;
        return;
      }
      throw error;
    }
    return;
  }
  await runStdioServer();
}

main().catch((error) => {
  console.error(`[ConduitMcp] Fatal: ${String(error instanceof Error ? error.message : error)}`);
  process.exit(1);
});
