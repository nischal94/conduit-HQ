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

/**
 * Ring-2 integration suite (task 10): drives the REAL COMPILED bin
 * (`dist/bin.js`) over real stdio child processes — the only ring that
 * proves stdout purity, cross-process approval, and client-timeout survival,
 * none of which the ring-1 InMemoryTransport suite (server.test.ts) can
 * exercise. Each `it` spawns its own bin (or two, for the approval case) so
 * failures stay isolated; the shared fixtures below (db path, key, upstream
 * server) are set up once in beforeAll and reused across cases.
 *
 * NOT safe for `.concurrent`: cases mutate the shared `src_gh` source row
 * (policy flips, the slow-upstream repoint) and must run sequentially.
 */

const execFileAsync = promisify(execFile);

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

/**
 * Loopback MCP upstream (copied shape from sdk/e2e.smoke.test.ts's
 * startMcpServer — kept local per the brief). `/mcp` answers tools/call for
 * every tool except `delete_repo`, which it holds open for `delayMs` before
 * responding — the vehicle for the client-timeout case: the sandbox has no
 * real timers, so "slow" must come from the upstream response itself.
 */
function startMcpServer(delayMs = 0): Promise<{
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
      const respond = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: ISSUES_RESULT }));
      };
      if (payload.params.name === "delete_repo" && delayMs > 0) {
        setTimeout(respond, delayMs);
      } else {
        respond();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, upstreamCalls });
    });
  });
}

const scratch = mkdtempSync(join(tmpdir(), "conduit-mcp-it-"));
const dbPath = join(scratch, "it.db");
const masterKey = SecretBox.generateKeyBytes();
const masterKeyB64 = Buffer.from(masterKey).toString("base64");
const binPath = join(process.cwd(), "dist", "bin.js");

/** Seeds one source/integration/connection/secret + tools, in-process. */
async function seedStore(policy: "allow" | "require_approval"): Promise<void> {
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
    action: policy,
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

/** Spawns a fresh bin + connected Client; tracked for teardown. */
async function spawnClient(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [binPath],
    env,
    stderr: "pipe",
  });
  transports.push(transport);
  const client = new Client({ name: "it-client", version: "0" });
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

/** Reads all currently-buffered bytes off a piped stderr stream. */
function drainStderr(transport: StdioClientTransport): Promise<string> {
  return new Promise((resolve) => {
    const stream = transport.stderr;
    if (stream === null) {
      resolve("");
      return;
    }
    let data = "";
    stream.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    // Give the child a tick to flush any buffered writes before resolving.
    setTimeout(() => resolve(data), 50);
  });
}

const baseEnv = (): Record<string, string> => ({
  CONDUIT_DB: dbPath,
  CONDUIT_MASTER_KEY: masterKeyB64,
  CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS: "1",
});

beforeAll(async () => {
  upstream = await startMcpServer();
  mcpLocation = `http://127.0.0.1:${upstream.port}/mcp`;
  await seedStore("allow");
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

describe("ring-2: spawned bin integration", () => {
  it("4-step workflow end-to-end through the spawned bin", async () => {
    const client = await spawnClient(baseEnv());
    const res = await client.callTool({
      name: "execute",
      arguments: {
        code: `
          const { items } = await tools.search({ query: "list issues" });
          const path = items[0].path;
          const details = await tools.describe.tool({ path, includeSchemas: true });
          const result = await tools.github.list_issues({ owner: "acme", repo: "site" });
          return { path, gotSchema: details.inputSchema !== undefined, result };
        `,
      },
    });
    const payload = textPayload(res) as {
      status: string;
      result: { path: string; gotSchema: boolean; result: unknown };
    };
    expect(payload.status).toBe("completed");
    expect(payload.result).toEqual({
      path: "github.list_issues",
      gotSchema: true,
      result: ISSUES_RESULT,
    });
    // The wire request the loopback upstream actually saw: prefix-stripped
    // name, original arguments, authenticated.
    const call = upstream.upstreamCalls.find((c) => c.name === "list_issues");
    expect(call).toEqual({
      name: "list_issues",
      arguments: { owner: "acme", repo: "site" },
      sawAuthHeader: true,
    });
  });

  it("stdout purity: every stdout byte the client transport did NOT consume is protocol-framed", async () => {
    // A bin against a FRESH, UNSEEDED db (its own temp CONDUIT_DB) with the
    // egress opt-in set: startup writes BOTH diagnostics the brief names —
    // the egress WARNING and the empty-catalog "0 sources" hint (bin.ts) —
    // and both MUST land on stderr only. A corrupted stdout kills the whole
    // JSON-RPC session, so the full protocol conversation below succeeding
    // is itself the stdout-purity proof.
    const emptyDbPath = join(scratch, "empty-purity.db"); // cleaned with scratch in afterAll
    const transport = new StdioClientTransport({
      command: "node",
      args: [binPath],
      env: { ...baseEnv(), CONDUIT_DB: emptyDbPath },
      stderr: "pipe",
    });
    transports.push(transport);
    const client = new Client({ name: "it-client-purity", version: "0" });
    await client.connect(transport);
    clients.push(client);

    // Drive a full call against the empty catalog: search legitimately
    // returns zero items and the execution completes — a clean protocol
    // round-trip while both diagnostics sit on stderr.
    const res = await client.callTool({
      name: "execute",
      arguments: {
        code: 'const { items } = await tools.search({ query: "anything" }); return items.length;',
      },
    });
    const payload = textPayload(res) as { status: string; result: unknown };
    expect(payload.status).toBe("completed");
    expect(payload.result).toBe(0);

    const stderr = await drainStderr(transport);
    expect(stderr).toMatch(/CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS/); // egress warning
    expect(stderr).toMatch(/0 sources in catalog/); // empty-catalog hint

    // The protocol conversation succeeded end-to-end (initialize + callTool +
    // listTools round-trips) — if either diagnostic line had leaked onto
    // stdout, the client's JSON-RPC framing would have desynced and this
    // would have thrown or hung instead.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_execution", "execute"]);
  });

  it("pause → approve from a SEPARATE child process → poll sees the persisted result", async () => {
    await seedStore("require_approval");
    try {
      const client = await spawnClient(baseEnv());
      const paused = await client.callTool({
        name: "execute",
        arguments: {
          code: 'return await tools.github.delete_repo({ repo: "site" });',
          requestKey: "rk-approve-1",
        },
      });
      const pausedPayload = textPayload(paused) as {
        status: string;
        executionId: string;
        pending: { toolName: string };
      };
      expect(pausedPayload.status).toBe("paused");
      expect(pausedPayload.pending.toolName).toBe("github.delete_repo");
      const { executionId } = pausedPayload;

      // Separate one-shot child process approver (Task 9's script) — NOT the
      // same bin process that is still running and holding the MCP session.
      await execFileAsync("node", ["../../scripts/approve-demo.mjs", executionId], {
        cwd: process.cwd(),
        env: { ...process.env, ...baseEnv() },
      });

      const checked = await client.callTool({
        name: "check_execution",
        arguments: { executionId },
      });
      const checkedPayload = textPayload(checked) as { status: string; result: unknown };
      expect(checkedPayload.status).toBe("completed");
      expect(checkedPayload.result).toEqual(ISSUES_RESULT);
    } finally {
      await seedStore("allow");
    }
  });

  it("client timeout on a slow call: server survives; the row settles; requestKey recovers it", async () => {
    const slow = await startMcpServer(3_000);
    try {
      // Re-seed sources/tools to point at the SLOW upstream for this case
      // only; restore the fast one in `finally` so later cases are unaffected.
      const client = createClient({ url: `file:${dbPath}` });
      const store = await openSqliteStore({
        client,
        secretBox: await SecretBox.fromKeyBytes(masterKey),
      });
      await store.sources.upsert({
        id: "src_gh",
        type: "mcp",
        namespace: NAMESPACE,
        location: `http://127.0.0.1:${slow.port}/mcp`,
      });
      client.close();

      const mcpClient = await spawnClient(baseEnv());
      const call = mcpClient.callTool(
        {
          name: "execute",
          arguments: {
            code: 'return await tools.github.delete_repo({ repo: "slow-repo" });',
            requestKey: "slow-1",
          },
        },
        undefined,
        { timeout: 1_000 },
      );
      await expect(call).rejects.toThrow();

      // Poll check_execution (a FRESH bin, since the timed-out client's
      // session may be in an unknown state after the local timeout) until
      // the server-side execution settles.
      const poller = await spawnClient(baseEnv());
      const deadline = Date.now() + 10_000;
      let finalPayload: { status: string; result?: unknown } | undefined;
      while (Date.now() < deadline) {
        const res = await poller.callTool({
          name: "check_execution",
          arguments: { requestKey: "slow-1" },
        });
        const payload = textPayload(res) as { status: string; result?: unknown };
        if (payload.status === "completed") {
          finalPayload = payload;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(finalPayload?.status).toBe("completed");
      expect(finalPayload?.result).toEqual(ISSUES_RESULT);
    } finally {
      await new Promise<void>((resolve) => slow.server.close(() => resolve()));
      // Restore the fast upstream location for later cases.
      const client = createClient({ url: `file:${dbPath}` });
      const store = await openSqliteStore({
        client,
        secretBox: await SecretBox.fromKeyBytes(masterKey),
      });
      await store.sources.upsert({
        id: "src_gh",
        type: "mcp",
        namespace: NAMESPACE,
        location: mcpLocation,
      });
      client.close();
    }
  }, 20_000);

  it("parallel tools/call executes run concurrently and both settle", async () => {
    const client = await spawnClient(baseEnv());
    const [a, b] = await Promise.all([
      client.callTool({
        name: "execute",
        arguments: {
          code: 'return await tools.github.list_issues({ owner: "a", repo: "one" });',
          requestKey: "par-1",
        },
      }),
      client.callTool({
        name: "execute",
        arguments: {
          code: 'return await tools.github.list_issues({ owner: "a", repo: "two" });',
          requestKey: "par-2",
        },
      }),
    ]);
    const payloadA = textPayload(a) as { status: string; result: unknown };
    const payloadB = textPayload(b) as { status: string; result: unknown };
    expect(payloadA.status).toBe("completed");
    expect(payloadB.status).toBe("completed");
    expect(payloadA.result).toEqual(ISSUES_RESULT);
    expect(payloadB.result).toEqual(ISSUES_RESULT);
    const seenRepos = upstream.upstreamCalls
      .filter((c) => c.name === "list_issues")
      .map((c) => (c.arguments as { repo: string }).repo);
    expect(seenRepos).toEqual(expect.arrayContaining(["one", "two"]));
  });

  it("egress fail-closed: WITHOUT the opt-in env, the loopback call fails and the agent-visible error hints at the operator override WITHOUT naming the env var", async () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS;
    const client = await spawnClient(env as Record<string, string>);
    const res = await client.callTool({
      name: "execute",
      arguments: { code: 'return await tools.github.list_issues({ owner: "a", repo: "b" });' },
    });
    const payload = textPayload(res) as {
      status: string;
      error: { hint?: string; message: string };
    };
    expect(payload.status).toBe("failed");
    expect(payload.error.hint).toMatch(/operator/i);
    expect(payload.error.hint).not.toContain("CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS");
    expect(payload.error.message).not.toContain("CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS");
  });
});
