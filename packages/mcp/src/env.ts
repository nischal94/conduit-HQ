import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const KEYGEN_ONE_LINER = `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`;

export interface ResolvedEnv {
  dbPath: string;
  keyBytes: Uint8Array<ArrayBuffer>;
  allowPrivateEgress: boolean;
}

export function resolveEnv(env: NodeJS.ProcessEnv): ResolvedEnv {
  const raw = env.CONDUIT_MASTER_KEY;
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `[ConduitMcp] Missing CONDUIT_MASTER_KEY: set it in your MCP client config. ` +
        `Generate one with: ${KEYGEN_ONE_LINER}`,
    );
  }
  const trimmed = raw.trim();
  const keyBytes = Buffer.from(trimmed, "base64");
  // Canonical-encoding check (design M8): Buffer.from silently ignores
  // invalid base64 characters — re-encode and compare so a corrupted key is
  // a loud per-cause failure, not 32 quietly-wrong bytes.
  if (keyBytes.length !== 32 || keyBytes.toString("base64") !== trimmed) {
    throw new Error(
      `[ConduitMcp] Malformed CONDUIT_MASTER_KEY: expected canonical base64 of exactly 32 bytes ` +
        `(got ${keyBytes.length} bytes${keyBytes.toString("base64") !== trimmed ? ", non-canonical encoding" : ""}). ` +
        `Generate a valid key with: ${KEYGEN_ONE_LINER}`,
    );
  }
  const dbPath = env.CONDUIT_DB?.trim() || join(homedir(), ".conduit", "conduit.db");
  return {
    dbPath,
    // Copy out of the pooled Buffer (Uint8Array<ArrayBufferLike>) into a
    // Uint8Array backed by its own ArrayBuffer — matches SecretBox's
    // Uint8Array<ArrayBuffer> contract (see generateKeyBytes in sdk/secrets.ts).
    keyBytes: Uint8Array.from(keyBytes),
    allowPrivateEgress: env.CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS === "1",
  };
}

/** Creates the db's parent directory 0700 (it holds encrypted secrets — design M7). */
export function ensureDbDir(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
}
