import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeMcp, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

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
        method: string;
        params?: { name: string; arguments: unknown };
      };
      // add-mcp's precondition fetch (mcp-fetch.ts) POSTs a bare `tools/list`
      // request with no `params` — answered here so the same stub upstream
      // serves both `serve`'s tools/call traffic and add-mcp's tools/list
      // fetch, no second fixture server.
      if (payload.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { tools: mcpToolsList } }),
        );
        return;
      }
      const params = payload.params as { name: string; arguments: unknown };
      upstreamCalls.push({
        name: params.name,
        arguments: params.arguments,
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

describe("ring-2: conduit add-mcp (spawned CLI bin)", () => {
  const addMcpDbPath = join(scratch, "add-mcp-it.db"); // cleaned with scratch in afterAll

  async function runAddMcp(
    args: string[],
    env: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const { stdout, stderr } = await execFileAsync("node", [cliBinPath, "add-mcp", ...args], {
        env: { ...process.env, ...baseEnv(), CONDUIT_DB: addMcpDbPath, ...env },
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
    }
  }

  async function openAddMcpDb() {
    const client = createClient({ url: `file:${addMcpDbPath}` });
    const store = await openSqliteStore({
      client,
      secretBox: await SecretBox.fromKeyBytes(masterKey),
    });
    return { store, close: () => client.close() };
  }

  it("writes rows against a stub upstream, and re-syncs on a second run against the same url", async () => {
    const upstreamUrl = `http://127.0.0.1:${upstream.port}/mcp`;

    const first = await runAddMcp([
      "--url",
      upstreamUrl,
      "--namespace",
      "ghadd",
      "--prefix",
      "github.acme.add",
    ]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatch(/seeded \d+ tools under github\.acme\.add:/);

    {
      const { store, close } = await openAddMcpDb();
      const source = await store.sources.get("src_ghadd");
      expect(source?.location).toBe(upstreamUrl);
      const tools = await store.tools.list("ghadd");
      expect(tools.length).toBeGreaterThan(0);
      close();
    }

    // Second run against the SAME url: idempotent re-sync, still 0-exit.
    const second = await runAddMcp([
      "--url",
      upstreamUrl,
      "--namespace",
      "ghadd",
      "--prefix",
      "github.acme.add",
    ]);
    expect(second.exitCode).toBe(0);

    {
      const { store, close } = await openAddMcpDb();
      const tools = await store.tools.list("ghadd");
      expect(tools.length).toBeGreaterThan(0);
      close();
    }
  });

  it("INVARIANT /cli add-mcp: a dead url exits non-zero and writes 0 rows", async () => {
    const result = await runAddMcp([
      "--url",
      "http://127.0.0.1:1/mcp-dead",
      "--namespace",
      "ghdead",
      "--prefix",
      "github.acme.dead",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/upstream unreachable/);

    const { store, close } = await openAddMcpDb();
    const source = await store.sources.get("src_ghdead");
    expect(source).toBeUndefined();
    close();
  });
});
