import { type ConduitStore, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { ensureDbDir, type ResolvedEnv, resolveEnv } from "./env.js";

/**
 * The env→store opening sequence: resolve env, ensure the db directory
 * exists, open the libsql client, and open the encrypted store. Shared by
 * `conduit-mcp`'s bin (--doctor) and `runStdioServer` — one home for the
 * sequence so both call sites stay behaviorally identical.
 */
export async function openStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ env: ResolvedEnv; store: ConduitStore }> {
  const resolved = resolveEnv(env);
  ensureDbDir(resolved.dbPath);
  const client = createClient({ url: `file:${resolved.dbPath}` });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(resolved.keyBytes),
  });
  return { env: resolved, store };
}
