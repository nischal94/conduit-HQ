import { type ConduitStore, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { type Client, createClient } from "@libsql/client";
import { ensureDbFile, type ResolvedEnv, type ResolveEnvOptions, resolveEnv } from "./env.js";

/**
 * The env→store opening sequence: resolve env (key file fallback, design
 * §1), ensure the db file exists 0600 (design §4), open the libsql client,
 * open the encrypted store (canary check inside — design §2). Shared by
 * `conduit-mcp`'s bin (--doctor), `runStdioServer`, and the CLI.
 *
 * `opts` threads `ResolveEnvOptions` through to `resolveEnv` — needed so
 * `conduit key rotate` can point key resolution at a temp `keyFilePath` (and
 * `CONDUIT_DB` via `env`) in tests instead of the real `~/.conduit`
 * (controller-logged deviation D1). Only `conduit key rotate` passes `opts`
 * in production, with values equal to the defaults; tests use it to redirect
 * into a temp dir.
 */
export async function openStoreClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts?: ResolveEnvOptions,
): Promise<{ env: ResolvedEnv; store: ConduitStore; client: Client }> {
  const resolved = resolveEnv(env, opts);
  ensureDbFile(resolved.dbPath);
  const client = createClient({ url: `file:${resolved.dbPath}` });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(resolved.keyBytes),
    keyContext: { dbPath: resolved.dbPath, keySource: resolved.keySource },
  });
  return { env: resolved, store, client };
}

/** Back-compat shape — everything except `conduit key rotate` uses this. */
export async function openStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ env: ResolvedEnv; store: ConduitStore }> {
  const { env: resolved, store } = await openStoreClientFromEnv(env);
  return { env: resolved, store };
}
