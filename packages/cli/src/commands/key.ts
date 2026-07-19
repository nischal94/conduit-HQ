import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONDUIT_DIR, openStoreClientFromEnv } from "@conduithq/mcp";
import { ReencryptError, reencryptSecrets, SecretBox } from "@conduithq/sdk";

export const KEY_USAGE = `conduit key — manage the Conduit master key

Usage: conduit key <subcommand>

Subcommands:
  generate   Mint a new master key at ~/.conduit/master-key (0600).
             Refuses if a key file exists, CONDUIT_MASTER_KEY is set,
             or the default db already holds sealed secrets.
  rotate     Re-seal every stored secret under a fresh key (stop-first:
             stop all conduit processes and MCP clients before running).
             Refuses for env-managed keys and custom CONDUIT_DB paths.

Run with --help for this text. See packages/cli/README.md for the
rotation walkthrough and crash-recovery procedures.`;

export interface KeyDeps {
  env: NodeJS.ProcessEnv;
  conduitDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  openStoreClient: typeof openStoreClientFromEnv;
}

const PROD_DEPS: KeyDeps = {
  env: process.env,
  conduitDir: DEFAULT_CONDUIT_DIR,
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
  openStoreClient: openStoreClientFromEnv,
};

export interface KeyResult {
  exitCode: number;
}

export async function runKey(args: string[], overrides?: Partial<KeyDeps>): Promise<KeyResult> {
  const deps: KeyDeps = { ...PROD_DEPS, ...overrides };
  const [sub] = args;
  if (sub === "generate") return runKeyGenerate(deps);
  if (sub === "rotate") return runKeyRotate(deps);
  deps.stderr(`${KEY_USAGE}\n`);
  return { exitCode: 1 };
}

/** fsync a directory so a just-created/renamed entry survives a host crash. Best-effort on non-POSIX. */
function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function countSealedRows(dbPath: string): Promise<number> {
  // Raw count — no key needed, and MUST NOT create the db as a side effect.
  if (!existsSync(dbPath)) return 0;
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const rs = await client.execute("SELECT COUNT(*) AS n FROM secrets");
    return Number(rs.rows[0]?.n ?? 0);
  } catch {
    return 0; // no secrets table = nothing sealed
  } finally {
    client.close();
  }
}

async function runKeyGenerate(deps: KeyDeps): Promise<KeyResult> {
  const keyPath = join(deps.conduitDir, "master-key");

  if (deps.env.CONDUIT_MASTER_KEY !== undefined && deps.env.CONDUIT_MASTER_KEY.trim() !== "") {
    deps.stderr(
      "[ConduitKey] generate refused: CONDUIT_MASTER_KEY is set (env overrides any key file, so a " +
        "differing file is a delayed lockout). A fresh install can unset the env var and re-run; an " +
        "env-key install with a populated db cannot migrate to file keys in v1 — keep the env key, " +
        "or delete the db and re-onboard.\n",
    );
    return { exitCode: 1 };
  }
  if (existsSync(keyPath)) {
    deps.stderr(
      `[ConduitKey] generate refused: ${keyPath} already exists. To change keys, run: conduit key rotate\n`,
    );
    return { exitCode: 1 };
  }
  const dbPath = join(deps.conduitDir, "conduit.db");
  if ((await countSealedRows(dbPath)) > 0) {
    deps.stderr(
      `[ConduitKey] generate refused: ${dbPath} already holds sealed secrets under some other key — a ` +
        "fresh key cannot decrypt them. Locate the original key, or delete the db and re-onboard.\n",
    );
    return { exitCode: 1 };
  }

  mkdirSync(deps.conduitDir, { recursive: true, mode: 0o700 });
  const stale = readdirSync(deps.conduitDir).filter((f) => f.startsWith("master-key.tmp-"));
  if (stale.length > 0) {
    deps.stderr(
      `[ConduitKey] note: leftover temp key files from a crashed run: ${stale.join(", ")} — inert ` +
        "(never read); remove them at leisure.\n",
    );
  }

  const keyBase64 = Buffer.from(SecretBox.generateKeyBytes()).toString("base64");
  const tmpPath = join(deps.conduitDir, `master-key.tmp-${process.pid}`);
  // Durable-staging publication (design pass-3 #1 / pass-4 #1): content is
  // fsynced BEFORE the final name exists; link() never replaces, so EEXIST
  // is the concurrent-generate loser. Same inode — unlinking the temp after
  // link leaves the published key untouched.
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeSync(fd, `${keyBase64}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmpPath, keyPath);
  } catch (cause) {
    unlinkSync(tmpPath);
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      deps.stderr(
        `[ConduitKey] generate refused: ${keyPath} appeared concurrently — another generate won. ` +
          "Re-run to inspect state; nothing was overwritten.\n",
      );
      return { exitCode: 1 };
    }
    throw cause;
  }
  let durabilityWarning = "";
  try {
    fsyncDir(deps.conduitDir);
  } catch {
    durabilityWarning =
      "[ConduitKey] WARNING: directory fsync failed — the key file is live and correct, but until " +
      "the entry is durable a host crash could lose it. Verify the disk, then re-run any command to confirm.\n";
  }
  unlinkSync(tmpPath);

  if (durabilityWarning) deps.stderr(durabilityWarning);
  deps.stdout(
    `[ConduitKey] master key generated at ${keyPath} (0600).\n` +
      "Next steps:\n" +
      "  1. Your MCP client config no longer needs CONDUIT_MASTER_KEY for default-path setups.\n" +
      "  2. Onboard an upstream: conduit add-mcp --url <url> --namespace <ns> --prefix <prefix>\n" +
      "  3. Stop-first rule: run this BEFORE wiring clients; see packages/cli/README.md.\n",
  );
  return { exitCode: 0 };
}

const RECOVERY_HINT =
  "Recovery: whichever of master-key / master-key.next opens the db is live — " +
  "promote it (mv) or restore master-key.bak; see packages/cli/README.md.";

/** True iff the failure's cause chain looks like a busy/locked SQLite database. */
function isBusyCause(cause: unknown): boolean {
  const seen = new Set<unknown>();
  let current = cause;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (/SQLITE_BUSY|database is locked/i.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

async function runKeyRotate(deps: KeyDeps): Promise<KeyResult> {
  const keyPath = join(deps.conduitDir, "master-key");
  const bakPath = join(deps.conduitDir, "master-key.bak");
  const nextPath = join(deps.conduitDir, "master-key.next");

  // Refusals (design §3) — each names the way forward.
  if (deps.env.CONDUIT_MASTER_KEY !== undefined && deps.env.CONDUIT_MASTER_KEY.trim() !== "") {
    deps.stderr(
      "[ConduitKey] rotate refused: the key is env-managed (CONDUIT_MASTER_KEY). Rotation is " +
        "unsupported for env-managed keys in v1 — keep using the env key, or delete the db and " +
        "re-onboard (conduit key import is the deferred migration path).\n",
    );
    return { exitCode: 1 };
  }
  if (deps.env.CONDUIT_DB !== undefined && deps.env.CONDUIT_DB.trim() !== "") {
    deps.stderr(
      "[ConduitKey] rotate refused: CONDUIT_DB is set. Rotation is defined only for the default " +
        "db + key-file pair (one global key file cannot serve N dbs). Custom-path installs: manage " +
        "the key via env; rotation story is delete-and-re-onboard.\n",
    );
    return { exitCode: 1 };
  }
  if (existsSync(nextPath)) {
    deps.stderr(
      `[ConduitKey] rotate refused: ${nextPath} exists — a prior rotation crashed mid-flight. ${RECOVERY_HINT}\n`,
    );
    return { exitCode: 1 };
  }

  // 1. Preflight: open the store — the canary proves the old key (design §2).
  //    deps.env deliberately lacks CONDUIT_MASTER_KEY here (checked above), so
  //    resolution is file-sourced. CONDUIT_DB and the key-file path are pinned
  //    to deps.conduitDir (controller deviation D1) — in production
  //    deps.conduitDir === DEFAULT_CONDUIT_DIR so this is a no-op; in tests it
  //    keeps rotation inside the temp dir instead of touching ~/.conduit.
  let opened: Awaited<ReturnType<typeof deps.openStoreClient>>;
  try {
    opened = await deps.openStoreClient(
      { ...deps.env, CONDUIT_DB: join(deps.conduitDir, "conduit.db") },
      { keyFilePath: keyPath },
    );
  } catch (cause) {
    if (isBusyCause(cause)) {
      deps.stderr(
        `[ConduitKey] rotate preflight failed: could not acquire the write lock — stop running conduit processes first. Context: { cause: ${String(cause)} }\n`,
      );
      return { exitCode: 1 };
    }
    deps.stderr(`[ConduitKey] rotate preflight failed: ${String(cause)}\n`);
    return { exitCode: 1 };
  }
  const { client } = opened;

  try {
    // 2. Backup the old key (overwritten each rotation — crash insurance, not history).
    copyFileSync(keyPath, bakPath);
    const bakFd = openSync(bakPath, "r");
    try {
      fsyncSync(bakFd);
    } finally {
      closeSync(bakFd);
    }

    // 3. Persist the NEW key BEFORE the db changes (wx: a racing rotate loses here).
    const newKeyBytes = SecretBox.generateKeyBytes();
    const newKeyBase64 = Buffer.from(newKeyBytes).toString("base64");
    const nextFd = openSync(nextPath, "wx", 0o600);
    try {
      writeSync(nextFd, `${newKeyBase64}\n`);
      fsyncSync(nextFd);
    } finally {
      closeSync(nextFd);
    }
    fsyncDir(deps.conduitDir);

    // 4. Re-seal in ONE write transaction (Task 2 owns atomicity + classification).
    const oldBox = await SecretBox.fromKeyBytes(opened.env.keyBytes);
    const newBox = await SecretBox.fromKeyBytes(newKeyBytes);
    let count: number;
    try {
      count = await reencryptSecrets(client, oldBox, newBox);
    } catch (cause) {
      if (cause instanceof ReencryptError && cause.dbState === "unchanged") {
        // Confirmed still-old → this run's .next is provably meaningless.
        try {
          unlinkSync(nextPath);
        } catch {
          deps.stderr(
            `[ConduitKey] note: could not remove ${nextPath} — delete it before retrying.\n`,
          );
        }
        if (isBusyCause(cause)) {
          deps.stderr(
            `[ConduitKey] rotation failed: could not acquire the write lock — stop running conduit processes first. Context: { cause: ${cause.message} }\n`,
          );
        } else {
          deps.stderr(`[ConduitKey] rotation failed (db unchanged): ${cause.message}\n`);
        }
        return { exitCode: 1 };
      }
      // Uncertain outcome → NEVER delete .next (design pass-4 #2).
      deps.stderr(
        `[ConduitKey] rotation failed with UNCERTAIN db state: ${String(cause)}\n${RECOVERY_HINT}\n`,
      );
      return { exitCode: 1 };
    }

    // 5. Promote (two failure states — design pass-4 #3).
    try {
      renameSync(nextPath, keyPath);
    } catch (cause) {
      deps.stderr(
        `[ConduitKey] rotation committed but promotion failed: ${String(cause)}\n` +
          `The db is under the NEW key at ${nextPath}. Recovery: mv ${nextPath} ${keyPath}\n`,
      );
      return { exitCode: 1 };
    }
    let promoteWarning = "";
    try {
      fsyncDir(deps.conduitDir);
    } catch {
      promoteWarning =
        "[ConduitKey] WARNING: directory fsync failed after promotion — the new key is live and " +
        "correct, but until the entry is durable a host crash could revert it; master-key.bak " +
        "still holds the old key.\n";
    }

    // 6. Hygiene — best-effort defense-in-depth (design pass-2 #2), never a failure.
    let hygieneWarning = "";
    try {
      await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      await client.execute("VACUUM");
    } catch (cause) {
      hygieneWarning =
        `[ConduitKey] WARNING: post-rotation cleanup (checkpoint/VACUUM) failed: ${String(cause)} — ` +
        "old-key ciphertext may linger in WAL/free pages. Once all conduit processes are stopped, " +
        "re-run it via the one-liner in packages/cli/README.md.\n";
    }

    if (promoteWarning) deps.stderr(promoteWarning);
    if (hygieneWarning) deps.stderr(hygieneWarning);
    deps.stdout(
      `[ConduitKey] rotation complete: ${count} secrets re-sealed under the new key.\n` +
        "Restart your MCP clients now (any process started before rotation holds the old key).\n" +
        "Back up the db and key file TOGETHER — old db backups pair only with master-key.bak-era keys.\n",
    );
    return { exitCode: 0 };
  } finally {
    client.close();
  }
}
