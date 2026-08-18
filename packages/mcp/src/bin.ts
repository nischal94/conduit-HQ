#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ConduitStore } from "@conduithq/sdk";
import { takeStateDir } from "./args.js";
import { DaemonUnavailable, daemonRequest } from "./daemon/client.js";
import { DaemonExit, daemonPaths, MAINTENANCE_ROLE_DOCTOR, runDaemon } from "./daemon/conduitd.js";
import { acquireExclusiveIfPresent, describeHolder, readLockHolder } from "./daemon/locks.js";
import { sweepOrphanedExecutions } from "./daemon/sweep.js";
import { DEFAULT_CONDUIT_DIR, DEFAULT_KEY_FILE, KEYGEN_ONE_LINER, resolveEnv } from "./env.js";
import { runStdioServer } from "./runtime-stdio.js";
import { READ_DEADLINE_MS } from "./server.js";

const VERSION = "0.1.0";
const HELP = `conduit-mcp ${VERSION} — Conduit MCP server (stdio)

The stdio server opens NO database: the daemon owns ~/.conduit/conduit.db and
the server reaches it over a Unix socket, auto-starting one if none is running.
So the env below belongs to the DAEMON's environment on that path, not to this
client's — an auto-started daemon inherits no CONDUIT_* value.

Env: CONDUIT_DB — REFUSED by the daemon-backed server AND by --doctor (both
  reach the daemon, which serves exactly the default database, §9.3); unset it
  to use either.
· CONDUIT_MASTER_KEY (base64, 32 bytes; generate: ${KEYGEN_ONE_LINER}) — read by
  the daemon and by --doctor --offline, not by the stdio server.
· CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1 (dev/demo ONLY) — belongs to the daemon,
  which makes the upstream calls.
· CONDUIT_APPROVAL_TTL (milliseconds) — read by whichever process runs the
  execution (the daemon, on the server path).
Flags: --version · --help · --daemon (run the store-owning daemon; stop with
  SIGTERM/SIGINT)
· --doctor — ask the running daemon for its health (auto-starts one if absent)
· --doctor --offline — diagnose a SICK install: takes the maintenance lock
  exclusively (so it refuses beside a live daemon or a rotation) and inspects
  key + files WITHOUT opening the database`;

/**
 * The default `--doctor`: ask the DAEMON about its own health (§9 item 1).
 *
 * The old implementation called `openStoreFromEnv` directly, which is not
 * read-only — it creates and heals files, sets journal mode, runs
 * migrations and may bootstrap the key canary. Outside any lock, that
 * made a diagnostic command a second writer against a database the daemon
 * owns, which is exactly the ownership break §17 exists to close.
 *
 * So the health being reported is now the daemon's, not a private
 * re-derivation of it. That is also the more truthful answer: a diagnostic
 * that opens its own store tells the operator whether A store opens, while
 * what they need to know is whether THE store their agent will use is
 * healthy. The handshake supplies the db path and the effective egress
 * setting; `catalog.listing` supplies the source count — no new capability
 * row (§3.3), just the reads `serve` already carries.
 *
 * Auto-start is deliberate rather than incidental: on a healthy install
 * with no daemon running, "start one and report on it" IS the diagnosis
 * the operator wants, and it exercises the same spawn path a real client
 * takes. A daemon that cannot start fails here loudly, which is the
 * finding.
 */
async function doctor(): Promise<number> {
  try {
    // Captured from the handshake, which is where the daemon reports its
    // effective non-secret configuration (§9 item 3). The egress setting
    // in particular is reportable by NO other means on a live install —
    // `--offline` refuses while a daemon runs — and it is among the most
    // likely things an operator is actually debugging.
    let daemonConfig: { dbPath: string; allowPrivateEgress: boolean } | undefined;
    const response = await daemonRequest({
      stateDir: DEFAULT_CONDUIT_DIR,
      onHandshake: (info) => {
        daemonConfig = info;
      },
      // `serve` is the agent-facing read role, and `catalog.listing` is
      // one of its D-B1 reads. Doctor deliberately does NOT get a
      // capability of its own: a new row would be a wider authorization
      // surface for a command that only needs to read what serve reads.
      role: "serve",
      request: { kind: "catalog.listing" },
      // A read's budget (§17 deadline discipline): the handshake and the
      // listing are both bounded store reads, and the only slow case is
      // the cold start this may itself trigger — precisely what
      // READ_DEADLINE_MS is sized for.
      deadlineMs: READ_DEADLINE_MS,
    });

    if (response.kind === "error") {
      console.error(`daemon reported: ${response.code} — ${response.message}`);
      return 1;
    }
    if (response.kind !== "result") {
      // `outcome-unknown` on a read: the connection died mid-request. For
      // a diagnostic there is nothing ambiguous to protect (a read has no
      // side effects to duplicate), but it is still a failed diagnosis.
      console.error(
        "daemon health could not be determined: the connection dropped before the daemon answered. " +
          `Re-run; if it persists, see ${join(DEFAULT_CONDUIT_DIR, "conduitd.log")}`,
      );
      return 1;
    }

    // Typed by `RpcPayloadFor<"catalog.listing">` rather than re-declared
    // through a cast. The cast this replaces was the OTHER half of the
    // payload-seam defect: it described the same wire kind differently from
    // `runtime-stdio.ts`'s, so the two readers of one projection disagreed
    // about its shape. The VALUE-level hedges below stay — a diagnostic
    // reports what arrived and must not throw while doing it.
    const payload = response.payload;
    const sourceCount = typeof payload.sourceCount === "number" ? payload.sourceCount : 0;
    console.error("ok: daemon reachable (handshake accepted)");
    if (daemonConfig !== undefined) {
      console.error(`ok: daemon owns the database at ${daemonConfig.dbPath}`);
      console.error(
        `egress opt-in: ${daemonConfig.allowPrivateEgress ? "ENABLED (unsafe — dev/demo only)" : "off (fail-closed default)"}`,
      );
    } else {
      // Said rather than left blank. The db path and the egress setting are
      // among the most likely things an operator is debugging, and their
      // ABSENCE from a report that otherwise looks healthy reads as "not
      // applicable" instead of "not observed". A missing handshake is a real
      // (if odd) state — the response arrived without one being surfaced —
      // and naming it is what stops a reader silently assuming the default.
      console.error(
        "warn: daemon config could not be read from the handshake — db path and egress setting " +
          "are NOT being reported below (this is an observation gap, not a confirmed default).",
      );
    }
    console.error(
      `ok: ${sourceCount} source(s) in catalog${sourceCount === 0 ? " — onboard one with `conduit add-mcp`" : ""}`,
    );
    console.error(
      `ok: ${Array.isArray(payload.connections) ? payload.connections.length : 0} connection(s) advertised`,
    );
    return 0;
  } catch (error) {
    if (error instanceof DaemonUnavailable) {
      console.error(error.message);
      console.error(
        "For a sick or unreachable daemon, diagnose offline: conduit-mcp --doctor --offline",
      );
      return 1;
    }
    console.error(String(error instanceof Error ? error.message : error));
    return 1;
  }
}

/**
 * `--doctor --offline`: inspect a SICK install without opening the store.
 *
 * Two properties define this mode, and both are load-bearing.
 *
 * **It takes the maintenance lock EXCLUSIVE**, so it cannot run beside a
 * live daemon or a rotation. That is not caution about reading — it is
 * what makes the report COHERENT. An inspection racing a rotation would
 * report a key file and a db that belong to different moments.
 *
 * **It never calls `openStoreFromEnv`**, which is the whole point:
 * that path creates, heals and migrates. This mode answers from the
 * filesystem and from key RESOLUTION alone (`resolveEnv` reads and
 * decodes; it opens nothing), so a genuinely broken install is described
 * rather than silently repaired. The cost is accepted and stated in the
 * output: it cannot verify the key actually DECRYPTS the database,
 * because proving that requires opening the store and checking the canary.
 */
async function doctorOffline(): Promise<number> {
  const paths = daemonPaths(DEFAULT_CONDUIT_DIR);
  // One reading of "the state directory isn't there", shared with the two
  // `key` subcommands: nothing can hold a lock in a directory that does
  // not exist, so `no-state-dir` proceeds to report on the fresh install
  // rather than refusing. The directory is never created to take the lock
  // — creation is the daemon's prerogative (§3.2), and a read-only
  // diagnostic must not provision the state it claims to inspect.
  const acquisition = await acquireExclusiveIfPresent(paths.maintenanceLockDb, {
    role: MAINTENANCE_ROLE_DOCTOR,
  });
  if (acquisition.outcome === "busy") {
    const holder = describeHolder(await readLockHolder(paths.maintenanceLockDb));
    console.error(
      "offline diagnosis refused: the maintenance lock is held, so a daemon is running or a key " +
        `rotation is in progress.${holder} An offline inspection beside a live owner would report a ` +
        "state nobody was ever in. Stop the daemon (SIGTERM) or wait for the rotation, then re-run — " +
        "or run `conduit-mcp --doctor` to ask the live daemon instead.",
    );
    return 1;
  }
  try {
    // Key resolution only — decode and report the source. `resolveEnv`
    // reads the key file (or the env var) and validates its shape; it
    // opens no database and creates nothing.
    let keyOk = false;
    try {
      const resolved = resolveEnv(process.env);
      console.error(`ok: key decodes (32 bytes), source: ${resolved.keySource}`);
      console.error(
        `egress opt-in: ${resolved.allowPrivateEgress ? "ENABLED (unsafe — dev/demo only)" : "off (fail-closed default)"}`,
      );
      keyOk = true;
    } catch (error) {
      // Reported, NOT thrown: a missing or malformed key is the single
      // most likely reason someone is running the offline doctor, and the
      // file-level findings below are exactly what they need next. The
      // verbatim `resolveEnv` diagnostics ("Missing master key",
      // "Malformed master key in …") are the pinned contract and reach
      // stderr unchanged.
      console.error(String(error instanceof Error ? error.message : error));
    }

    // Folded into the exit code below. A file-level finding is a FINDING:
    // printing "missing: database at …" and then exiting 0 tells every
    // caller that reads status rather than prose — a health check, a CI
    // step, an operator's `&&` — that the install is fine, which is the one
    // wrong answer a sick-install diagnostic must never give.
    let missing = false;

    for (const [label, path] of [
      ["key file", DEFAULT_KEY_FILE],
      ["database", paths.db],
    ] as const) {
      if (!existsSync(path)) {
        console.error(`missing: ${label} at ${path}`);
        missing = true;
        continue;
      }
      const mode = statSync(path).mode & 0o777;
      const wide = (mode & 0o077) !== 0;
      console.error(
        `ok: ${label} present at ${path} (mode ${mode.toString(8).padStart(4, "0")})${
          wide ? ` — WARNING: wider than 0600, fix with: chmod 600 ${path}` : ""
        }`,
      );
    }

    // Named explicitly rather than left as an unstated limit: this mode
    // trades the canary check for not touching the database at all.
    console.error(
      "note: offline mode does not open the database, so it cannot confirm the key DECRYPTS it. " +
        "Run `conduit-mcp --doctor` against a live daemon for that.",
    );
    return keyOk && !missing ? 0 : 1;
  } finally {
    if (acquisition.outcome === "acquired") await acquisition.lock.release();
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
    // `--offline` is scanned rather than positionally required so
    // `--doctor --offline` reads naturally in either order.
    process.exitCode = process.argv.includes("--offline") ? await doctorOffline() : await doctor();
    return;
  }
  if (arg === "--daemon") {
    // `--state-dir <path>` runs the daemon against a non-default state
    // directory — see `args.ts` for why it is an argument rather than an
    // environment variable, and why BOTH bins parse it through that one
    // function. The parse this replaced was a second, textually different
    // reading of the same flag; a daemon started under one reading and a
    // client pointed at it under the other reach different databases.
    const parsed = takeStateDir("[conduitd]", process.argv);
    if ("error" in parsed) {
      // The shared parser's line ends in a newline; `console.error` adds
      // its own, so the message is trimmed back to this bin's convention.
      console.error(parsed.error.trimEnd());
      process.exitCode = 1;
      return;
    }
    const override = parsed.stateDir;
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
