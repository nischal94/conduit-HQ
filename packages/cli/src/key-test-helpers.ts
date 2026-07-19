import { openStoreClientFromEnv } from "@conduithq/mcp";

/** Builds a real db at dbPath containing one sealed secret (fresh throwaway key). */
export async function createDbWithOneSecret(dbPath: string): Promise<string> {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const { store, client } = await openStoreClientFromEnv({
    CONDUIT_DB: dbPath,
    CONDUIT_MASTER_KEY: key,
  });
  await store.secrets.put("cred_seed", "seed-secret");
  client.close();
  return key;
}
