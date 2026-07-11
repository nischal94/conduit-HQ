#!/usr/bin/env node

// Demo seed script (task 9). Seeds one source/integration/connection/secret
// against an upstream MCP server's real tools/list (falling back to the
// smoke-test's inline 3-tool fixture when the upstream is unreachable), and
// upserts an ALLOW-ONLY policy for every seeded tool — this is a demo, not a
// policy-authoring exercise, so gate-one can never strand on an unresolvable
// pause. Prints a ready-to-paste Claude Desktop config snippet to stderr.
//
// Usage: node scripts/seed-demo.mjs <upstream-mcp-url>
// stdout: NOTHING, ever.
// stderr: progress, the fallback notice (if triggered), and the config
// snippet.

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDbDir, resolveEnv } from "../packages/mcp/dist/index.js";
import { normalizeMcp, openSqliteStore, SecretBox } from "../packages/sdk/dist/index.js";

// scripts/ sits outside the pnpm workspace's own node_modules, so a bare
// `@libsql/client` specifier does not resolve from here (pnpm's strict
// node_modules gives that dependency only to the packages that declare it).
// Both @conduithq/sdk and @conduithq/mcp declare it directly, so anchor
// resolution at the sdk package — same dependency, same version, zero new
// deps — rather than reaching into the pnpm store by a brittle literal path.
const { createClient } = createRequire(new URL("../packages/sdk/dist/index.js", import.meta.url))(
  "@libsql/client",
);

const NAMESPACE = "github";
const SOURCE_ID = "src_github_demo";
const INTEGRATION_ID = "int_github_demo";
const CONNECTION_ID = "conn_github_demo";
const PREFIX = "github.acme.prod";
const CREDENTIAL_REF = "cred_gh";
const DEMO_SECRET = "Bearer demo_secret_token_2026";

// Copied from packages/sdk/src/e2e.smoke.test.ts's `mcpToolsList` fixture —
// used verbatim when the upstream tools/list fetch fails, so the demo still
// seeds a representative safe/review/destructive spread.
const FALLBACK_TOOLS_LIST = [
  {
    name: "list_issues",
    description: "List open issues in a repository",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_issue",
    description: "Create a new issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "delete_repo",
    description: "Permanently delete a repository",
    inputSchema: { type: "object", properties: { repo: { type: "string" } } },
    annotations: { destructiveHint: true },
  },
];

async function fetchToolsList(url) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`[SeedDemo] upstream responded ${response.status}`);
  }
  const payload = await response.json();
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("[SeedDemo] upstream tools/list response missing result.tools array");
  }
  return tools;
}

function repoRoot() {
  // scripts/seed-demo.mjs -> repo root is one directory up.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function printConfigSnippet(env, isLoopback) {
  const binPath = join(repoRoot(), "packages", "mcp", "dist", "bin.js");
  const configEnv = {
    CONDUIT_DB: env.dbPath,
    CONDUIT_MASTER_KEY: "<your key>",
  };
  if (isLoopback) {
    configEnv.CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS = "1";
  }
  const snippet = {
    mcpServers: {
      conduit: {
        command: "node",
        args: [binPath],
        env: configEnv,
      },
    },
  };
  console.error("[SeedDemo] Claude Desktop config snippet:");
  console.error(JSON.stringify(snippet, null, 2));
}

async function main() {
  const upstreamUrl = process.argv[2];
  if (upstreamUrl === undefined || upstreamUrl === "") {
    console.error("[SeedDemo] Usage: node scripts/seed-demo.mjs <upstream-mcp-url>");
    process.exit(1);
  }

  const env = resolveEnv(process.env);
  ensureDbDir(env.dbPath);
  const client = createClient({ url: `file:${env.dbPath}` });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(env.keyBytes),
  });

  let rawTools;
  try {
    rawTools = await fetchToolsList(upstreamUrl);
    console.error(`[SeedDemo] fetched ${rawTools.length} tool(s) from ${upstreamUrl}`);
  } catch (cause) {
    console.error(
      `[SeedDemo] Failed to fetch tools/list from upstream: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Falling back to the inline 3-tool demo fixture (list_issues/create_issue/delete_repo).`,
    );
    rawTools = FALLBACK_TOOLS_LIST;
  }

  const tools = normalizeMcp({ namespace: NAMESPACE, tools: rawTools });

  await store.sources.upsert({
    id: SOURCE_ID,
    type: "mcp",
    namespace: NAMESPACE,
    location: upstreamUrl,
  });
  await store.integrations.upsert({
    id: INTEGRATION_ID,
    sourceId: SOURCE_ID,
    namespace: NAMESPACE,
  });
  await store.connections.upsert({
    id: CONNECTION_ID,
    integrationId: INTEGRATION_ID,
    prefix: PREFIX,
    credentialRef: CREDENTIAL_REF,
  });
  await store.secrets.put(CREDENTIAL_REF, DEMO_SECRET);
  await store.tools.replaceNamespace(NAMESPACE, tools);

  // Allow-only demo: seed every tool with an unconditional allow so gate-one
  // never strands on a require_approval pause the operator hasn't set up an
  // approver for.
  for (const tool of tools) {
    await store.policies.upsert({
      toolName: tool.name,
      action: "allow",
      seededFrom: tool.riskClass,
      manualOverride: true,
      redactFields: [],
    });
  }
  console.error(
    `[SeedDemo] seeded ${tools.length} tool(s) with allow policies under prefix ${PREFIX}`,
  );

  let isLoopback = false;
  try {
    const parsed = new URL(upstreamUrl);
    isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1";
  } catch {
    // Malformed URL: leave isLoopback false, config snippet omits the flag.
  }
  printConfigSnippet(env, isLoopback);
}

main().catch((error) => {
  // Bad-env failures (resolveEnv) are already formatted with a `[ConduitMcp]`
  // prefix; anything else gets a `[SeedDemo]` prefix here so every failure
  // path is still traceable to its source.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith("[") ? message : `[SeedDemo] ${message}`);
  process.exit(1);
});
