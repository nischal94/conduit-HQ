#!/usr/bin/env node
import { openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { ensureDbDir, KEYGEN_ONE_LINER, resolveEnv } from "./env.js";
import { runStdioServer } from "./runtime-stdio.js";

const VERSION = "0.1.0";
const HELP = `conduit-mcp ${VERSION} — Conduit MCP server (stdio)
Env: CONDUIT_DB (default ~/.conduit/conduit.db) · CONDUIT_MASTER_KEY (base64, 32 bytes;
generate: ${KEYGEN_ONE_LINER}) · CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1 (dev/demo ONLY)
· CONDUIT_APPROVAL_TTL (milliseconds)
Flags: --version · --help · --doctor (validate config without an MCP client)`;

async function openStoreFromEnv() {
  const env = resolveEnv(process.env);
  ensureDbDir(env.dbPath);
  const client = createClient({ url: `file:${env.dbPath}` });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(env.keyBytes),
  });
  return { env, store };
}

async function doctor(): Promise<number> {
  try {
    const { env, store } = await openStoreFromEnv();
    const sources = await store.sources.list();
    console.error(`ok: key decodes (32 bytes)`);
    console.error(`ok: database opens at ${env.dbPath}`);
    console.error(
      `ok: ${sources.length} source(s) in catalog${sources.length === 0 ? " — seed with scripts/seed-demo.mjs" : ""}`,
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
  await runStdioServer();
}

main().catch((error) => {
  console.error(`[ConduitMcp] Fatal: ${String(error instanceof Error ? error.message : error)}`);
  process.exit(1);
});
