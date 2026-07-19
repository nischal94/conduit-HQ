import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const KEYGEN_ONE_LINER = `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`;

export const DEFAULT_CONDUIT_DIR = join(homedir(), ".conduit");
export const DEFAULT_KEY_FILE = join(DEFAULT_CONDUIT_DIR, "master-key");

export interface ResolvedEnv {
  dbPath: string;
  keyBytes: Uint8Array<ArrayBuffer>;
  /** Where the key came from — rotate refuses "env"; canary errors name it (design §1). */
  keySource: "env" | "file";
  allowPrivateEgress: boolean;
}

export interface ResolveEnvOptions {
  /** Test seam; production always uses DEFAULT_KEY_FILE. */
  keyFilePath?: string;
  /** Sink for the wide-perms warning (default: console.error — stdout is the MCP wire). */
  warn?: (message: string) => void;
}

function decodeKey(raw: string, sourceLabel: string): Uint8Array<ArrayBuffer> {
  const trimmed = raw.trim();
  const keyBytes = Buffer.from(trimmed, "base64");
  // Canonical-encoding check (design M8): Buffer.from silently ignores
  // invalid base64 characters — re-encode and compare so a corrupted key is
  // a loud per-cause failure, not 32 quietly-wrong bytes.
  if (keyBytes.length !== 32 || keyBytes.toString("base64") !== trimmed) {
    throw new Error(
      `[ConduitMcp] Malformed master key in ${sourceLabel}: expected canonical base64 of exactly 32 bytes ` +
        `(got ${keyBytes.length} bytes${keyBytes.toString("base64") !== trimmed ? ", non-canonical encoding" : ""}). ` +
        `Generate a valid key with: conduit key generate (or ${KEYGEN_ONE_LINER})`,
    );
  }
  // Copy out of the pooled Buffer into a Uint8Array backed by its own
  // ArrayBuffer — matches SecretBox's Uint8Array<ArrayBuffer> contract.
  return Uint8Array.from(keyBytes);
}

export function resolveEnv(env: NodeJS.ProcessEnv, opts?: ResolveEnvOptions): ResolvedEnv {
  const keyFilePath = opts?.keyFilePath ?? DEFAULT_KEY_FILE;
  const warn = opts?.warn ?? ((message: string) => console.error(message));
  const dbPath = env.CONDUIT_DB?.trim() || join(DEFAULT_CONDUIT_DIR, "conduit.db");
  const allowPrivateEgress = env.CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS === "1";

  const raw = env.CONDUIT_MASTER_KEY;
  if (raw !== undefined && raw.trim() !== "") {
    return {
      dbPath,
      keyBytes: decodeKey(raw, "CONDUIT_MASTER_KEY"),
      keySource: "env",
      allowPrivateEgress,
    };
  }

  if (existsSync(keyFilePath)) {
    if ((statSync(keyFilePath).mode & 0o077) !== 0) {
      warn(
        `[ConduitMcp] WARNING: ${keyFilePath} permissions are wider than 0600 — ` +
          `fix with: chmod 600 ${keyFilePath}`,
      );
    }
    return {
      dbPath,
      keyBytes: decodeKey(readFileSync(keyFilePath, "utf8"), keyFilePath),
      keySource: "file",
      allowPrivateEgress,
    };
  }

  throw new Error(
    `[ConduitMcp] Missing master key: set CONDUIT_MASTER_KEY in your MCP client config, ` +
      `or create ${keyFilePath} with: conduit key generate`,
  );
}

/** Creates the db's parent directory 0700 (it holds encrypted secrets — design M7). */
export function ensureDbDir(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
}

/**
 * Design §4: the db file is 0600 from birth. Create it empty (`wx`, 0600)
 * BEFORE @libsql/client touches the path — SQLite accepts a zero-length file
 * as a fresh db and creates -wal/-shm with the db file's permissions
 * (verified 2026-07-19). Existing wider-perms files (and sidecars) are
 * healed. Guarantee scope: everything opening through openStoreFromEnv /
 * openStoreClientFromEnv; direct createClient callers bypass by design.
 */
export function ensureDbFile(dbPath: string): void {
  ensureDbDir(dbPath);
  if (!existsSync(dbPath)) {
    try {
      closeSync(openSync(dbPath, "wx", 0o600));
      return; // fresh 0600 file; no sidecars can exist yet
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      // lost a concurrent-create race — fall through to heal
    }
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    if (existsSync(path) && (statSync(path).mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
    }
  }
}
