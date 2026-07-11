import { openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureDbDir, resolveEnv } from "./env.js";
import { createConduitMcpServer } from "./server.js";

/**
 * Starts the Conduit MCP server on stdio. Shared by the `conduit-mcp` bin
 * and (later) `conduit serve` — the security-sensitive stdio startup,
 * including the M8 stdout-purity redirect, has one home.
 */
export async function runStdioServer(opts: { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  // M8: stdout carries protocol frames ONLY. Route console.* to stderr as
  // defense-in-depth; the spawned-bin stdout-purity test pins the invariant.
  const toStderr = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(" ")}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.error = toStderr;

  const env = resolveEnv(opts.env ?? process.env);
  // openStoreFromEnv sequence, inlined for now — Task 4 factors this out
  // into a shared module alongside bin.ts's copy.
  ensureDbDir(env.dbPath);
  const client = createClient({ url: `file:${env.dbPath}` });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(env.keyBytes),
  });

  if (env.allowPrivateEgress) {
    console.error(
      "[ConduitMcp] WARNING: CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1 — private-network egress " +
        "is OPEN. Dev/demo only; unset it for anything real (§9.3).",
    );
  }
  if ((await store.sources.list()).length === 0) {
    console.error("[ConduitMcp] 0 sources in catalog — seed with scripts/seed-demo.mjs");
  }
  const server = createConduitMcpServer({ store, allowPrivateEgress: env.allowPrivateEgress });
  await server.connect(new StdioServerTransport());
}
