#!/usr/bin/env node
import type { ConduitStore } from "@conduithq/sdk";
import { DaemonExit, runDaemon } from "./daemon/conduitd.js";
import { sweepOrphanedExecutions } from "./daemon/sweep.js";
import { DEFAULT_CONDUIT_DIR, KEYGEN_ONE_LINER } from "./env.js";
import { runStdioServer } from "./runtime-stdio.js";
import { openStoreFromEnv } from "./store-open.js";

const VERSION = "0.1.0";
const HELP = `conduit-mcp ${VERSION} — Conduit MCP server (stdio)

The stdio server opens NO database: the daemon owns ~/.conduit/conduit.db and
the server reaches it over a Unix socket, auto-starting one if none is running.
So the env below belongs to the DAEMON's environment on that path, not to this
client's — an auto-started daemon inherits no CONDUIT_* value.

Env: CONDUIT_DB — REFUSED by the daemon-backed server (it serves exactly the
  default database, §9.3); unset it to use the daemon. Still honored by --doctor.
· CONDUIT_MASTER_KEY (base64, 32 bytes; generate: ${KEYGEN_ONE_LINER}) — read by
  the daemon and by --doctor, not by the stdio server.
· CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1 (dev/demo ONLY) — belongs to the daemon,
  which makes the upstream calls.
· CONDUIT_APPROVAL_TTL (milliseconds) — read by whichever process runs the
  execution (the daemon, on the server path).
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
    // `--state-dir <path>` runs the daemon against a non-default state
    // directory. This is the OPERATOR-BY-HAND path design §3.1 already
    // sanctions (the same posture as `CONDUIT_MASTER_KEY`), and it is an
    // argument rather than an environment variable on purpose: auto-start
    // constructs the child's environment from an allowlist and strips
    // every `CONDUIT_*`, so an env-based override would be both ignored
    // there and, if honored, exactly the client-chosen redirection §9.3
    // removes. A client can never reach this — only a person running the
    // command can.
    const at = process.argv.indexOf("--state-dir");
    const override = at === -1 ? undefined : process.argv[at + 1];
    if (at !== -1 && (override === undefined || override.startsWith("--"))) {
      console.error("[conduitd] --state-dir requires a path argument");
      process.exitCode = 1;
      return;
    }
    try {
      await runDaemon({ stateDir: override ?? DEFAULT_CONDUIT_DIR, sweep: sweepDaemonStore });
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
    // Exit HARD, not by falling off the end of `main`. `runDaemon`
    // resolving means the drain deadline passed and BOTH locks were
    // released — but abandoned in-flight work (a request stalled in the
    // store or an upstream layer, or a sweep write that lost the SIGTERM
    // race) is not cancelled by that release, only unawaited. Left alive,
    // those promises keep Node's event loop open, and a stalled store
    // call can still land AFTER a successor or a rotation has taken the
    // locks — two writers against one database, which is exactly the
    // single-ownership property §3.5 exists to guarantee. Abandoned work
    // must therefore die with the process the instant ownership is
    // released. The rows it leaves behind are recovered the same way a
    // crash's are: by the successor's crash-terminal sweep. That is the
    // whole recovery model, and it is only sound if we truly look like a
    // crash here rather than lingering with released locks.
    process.exit(process.exitCode ?? 0);
  }
  await runStdioServer();
}

main().catch((error) => {
  console.error(`[ConduitMcp] Fatal: ${String(error instanceof Error ? error.message : error)}`);
  process.exit(1);
});
