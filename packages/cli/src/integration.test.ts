import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMcp, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Ring-2 integration suite (Lane B Task 7): drives the REAL COMPILED conduit
 * CLI bin (`dist/bin.js serve`) over a real stdio child process — proves the
 * `serve` command actually starts the shared `runStdioServer` seam through
 * the CLI's own dispatch/bin door, and that the M8 stdout-purity invariant
 * (pinned in packages/mcp) survives that extra layer.
 *
 * Mirrors packages/mcp/src/integration.test.ts's fixtures and helpers; the
 * one difference is the spawned command: `node dist/bin.js serve` instead of
 * `node dist/bin.js`.
 */

const PREFIX = "github.acme.prod";
const NAMESPACE = "github";
const SECRET = "Bearer it_secret_do_not_leak_7f3a";

const mcpToolsList = [
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
    name: "delete_repo",
    description: "Permanently delete a repository",
    inputSchema: { type: "object", properties: { repo: { type: "string" } } },
    annotations: { destructiveHint: true },
  },
];

const ISSUES_RESULT = { issues: [{ id: 1, title: "Fix login bug" }] };

interface UpstreamCall {
  name: string;
  arguments: unknown;
  sawAuthHeader: boolean;
}

/** Loopback MCP upstream (same shape as packages/mcp's integration test). */
function startMcpServer(): Promise<{
  server: Server;
  port: number;
  upstreamCalls: UpstreamCall[];
}> {
  const upstreamCalls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const payload = JSON.parse(body) as {
        id: string;
        params: { name: string; arguments: unknown };
      };
      upstreamCalls.push({
        name: payload.params.name,
        arguments: payload.params.arguments,
        sawAuthHeader: req.headers.authorization === SECRET,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: ISSUES_RESULT }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, upstreamCalls });
    });
  });
}

const scratch = mkdtempSync(join(tmpdir(), "conduit-cli-it-"));
const dbPath = join(scratch, "it.db");
const masterKey = SecretBox.generateKeyBytes();
const masterKeyB64 = Buffer.from(masterKey).toString("base64");
const cliBinPath = join(process.cwd(), "dist", "bin.js");

/** Seeds one source/integration/connection/secret + tools, in-process. */
async function seedStore(): Promise<void> {
  const client = createClient({ url: `file:${dbPath}` });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(masterKey),
  });
  const tools = normalizeMcp({ namespace: NAMESPACE, tools: mcpToolsList });
  await store.sources.upsert({
    id: "src_gh",
    type: "mcp",
    namespace: NAMESPACE,
    location: mcpLocation,
  });
  await store.integrations.upsert({ id: "int_gh", sourceId: "src_gh", namespace: NAMESPACE });
  await store.connections.upsert({
    id: "conn_gh",
    integrationId: "int_gh",
    prefix: PREFIX,
    credentialRef: "cred_gh",
  });
  await store.secrets.put("cred_gh", SECRET);
  await store.tools.replaceNamespace(NAMESPACE, tools);
  await store.policies.upsert({
    toolName: `${NAMESPACE}.list_issues`,
    action: "allow",
    seededFrom: "safe",
    manualOverride: true,
    redactFields: [],
  });
  await store.policies.upsert({
    toolName: `${NAMESPACE}.delete_repo`,
    action: "allow",
    seededFrom: "destructive",
    manualOverride: true,
    redactFields: [],
  });
  client.close();
}

let upstream: { server: Server; port: number; upstreamCalls: UpstreamCall[] };
let mcpLocation: string;

const clients: Client[] = [];
const transports: StdioClientTransport[] = [];

/** Spawns `conduit serve` via the compiled CLI bin + a connected Client. */
async function spawnClient(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [cliBinPath, "serve"],
    env,
    stderr: "pipe",
  });
  transports.push(transport);
  const client = new Client({ name: "cli-it-client", version: "0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function textPayload(res: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = res.content as Array<{ type: string; text: string }>;
  const first = content[0];
  if (first === undefined) {
    throw new Error("[integration.test] callTool response had no content entries.");
  }
  return JSON.parse(first.text);
}

const baseEnv = (): Record<string, string> => ({
  CONDUIT_DB: dbPath,
  CONDUIT_MASTER_KEY: masterKeyB64,
  CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1",
});

beforeAll(async () => {
  upstream = await startMcpServer();
  mcpLocation = `http://127.0.0.1:${upstream.port}/mcp`;
  await seedStore();
}, 30_000);

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => {
      // best-effort — the process may already be gone (killed by the test).
    });
  }
  for (const transport of transports.splice(0)) {
    await transport.close().catch(() => {
      // same as above.
    });
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    upstream.server.close(() => resolve());
  });
  rmSync(scratch, { recursive: true, force: true });
});

describe("ring-2: conduit serve (spawned CLI bin)", () => {
  it("workflow: conduit serve exposes the two-tool MCP surface via tools/list", async () => {
    const client = await spawnClient(baseEnv());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_execution", "execute"]);

    // Also drive a real call through, proving the server started for real —
    // not just that listTools happens to work.
    const res = await client.callTool({
      name: "execute",
      arguments: {
        code: `
          const { items } = await tools.search({ query: "list issues" });
          const path = items[0].path;
          const result = await tools.github.list_issues({ owner: "acme", repo: "site" });
          return { path, result };
        `,
      },
    });
    const payload = textPayload(res) as {
      status: string;
      result: { path: string; result: unknown };
    };
    expect(payload.status).toBe("completed");
    expect(payload.result).toEqual({ path: "github.list_issues", result: ISSUES_RESULT });
  });

  it("INVARIANT /mcp M8: stdout purity holds through conduit serve — every stdout byte the client transport did NOT consume is protocol-framed", async () => {
    // A fresh, unseeded db + the egress opt-in: startup writes both
    // diagnostics (the egress WARNING and the empty-catalog "0 sources"
    // hint, from the shared runStdioServer seam) — both MUST land on
    // stderr only, or the JSON-RPC framing below would desync.
    const emptyDbPath = join(scratch, "empty-purity.db"); // cleaned with scratch in afterAll
    const transport = new StdioClientTransport({
      command: "node",
      args: [cliBinPath, "serve"],
      env: { ...baseEnv(), CONDUIT_DB: emptyDbPath },
      stderr: "pipe",
    });
    transports.push(transport);
    const client = new Client({ name: "cli-it-client-purity", version: "0" });
    await client.connect(transport);
    clients.push(client);

    const res = await client.callTool({
      name: "execute",
      arguments: {
        code: 'const { items } = await tools.search({ query: "anything" }); return items.length;',
      },
    });
    const payload = textPayload(res) as { status: string; result: unknown };
    expect(payload.status).toBe("completed");
    expect(payload.result).toBe(0);

    const stderr = await new Promise<string>((resolve) => {
      const stream = transport.stderr;
      if (stream === null) {
        resolve("");
        return;
      }
      let data = "";
      stream.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
      });
      setTimeout(() => resolve(data), 50);
    });
    expect(stderr).toMatch(/CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS/); // egress warning
    expect(stderr).toMatch(/0 sources in catalog/); // empty-catalog hint

    // The protocol conversation succeeded end-to-end (initialize + callTool +
    // listTools round-trips) — if either diagnostic line had leaked onto
    // stdout, the client's JSON-RPC framing would have desynced and this
    // would have thrown or hung instead.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_execution", "execute"]);
  });
});
