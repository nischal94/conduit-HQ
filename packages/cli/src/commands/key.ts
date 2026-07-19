import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONDUIT_DIR, openStoreClientFromEnv } from "@conduithq/mcp";
import { SecretBox } from "@conduithq/sdk";

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

async function runKeyRotate(deps: KeyDeps): Promise<KeyResult> {
  deps.stderr("[ConduitKey] rotate lands in the next commit of this branch.\n");
  return { exitCode: 1 };
}
