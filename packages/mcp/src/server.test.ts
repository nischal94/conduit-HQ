import {
  type ConduitStore,
  normalizeMcp,
  openSqliteStore,
  SecretBox,
  setSandboxDiagnostic,
} from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createConduitMcpServer } from "./server.js";

/**
 * Ring-1 protocol suite: drives `createConduitMcpServer` entirely over
 * `InMemoryTransport` — no sockets, no upstream fetch. The `execute` happy
 * path only ever calls `tools.search`, which the catalog answers locally
 * (execute.ts createCatalogToolHost); the require_approval pause test never
 * reaches upstream either, because policy refuses BEFORE the invoker calls
 * out (§5.3 step 2 precedes step 3).
 */

const PREFIX = "github.acme.prod";

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

async function seedStore(): Promise<ConduitStore> {
  const client = createClient({ url: ":memory:" });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
  });

  const tools = normalizeMcp({ namespace: "github", tools: mcpToolsList });
  await store.sources.upsert({
    id: "src_gh",
    type: "mcp",
    namespace: "github",
    location: "http://127.0.0.1:1/mcp",
  });
  await store.integrations.upsert({ id: "int_gh", sourceId: "src_gh", namespace: "github" });
  await store.connections.upsert({
    id: "conn_gh",
    integrationId: "int_gh",
    prefix: PREFIX,
    credentialRef: "cred_gh",
  });
  await store.secrets.put("cred_gh", "Bearer ghp_test_secret");
  await store.tools.replaceNamespace("github", tools);

  return store;
}

async function connect(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textPayload(res: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = res.content as Array<{ text: string }>;
  const first = content[0];
  if (first === undefined) {
    throw new Error("[server.test] callTool response had no content entries.");
  }
  return JSON.parse(first.text);
}

describe("createConduitMcpServer", () => {
  let store: ConduitStore;
  let server: Server;

  beforeEach(async () => {
    store = await seedStore();
    server = createConduitMcpServer({ store, log: () => {} });
  });

  it("routes sandbox module-recovery diagnostics to THIS server's log — and leaks no guest code", async () => {
    // The recovery sink is process-global (the shared module is too), installed
    // once at construction by createConduitMcpServer. Prove it actually ROUTES:
    // drive a real overflow through the server, then a benign call that
    // rebuilds, and assert the events land on this server's log in the
    // "[sandbox]" format with NO guest code.
    setSandboxDiagnostic(undefined);
    const lines: string[] = [];
    const own = createConduitMcpServer({ store, log: (line) => lines.push(line) });
    const client = await connect(own);
    const overflow = "let x = { secretMarker: 1 }; for (let i=0;i<20000;i++) x={n:x}; return x;";
    await client.callTool({ name: "execute", arguments: { code: overflow } });
    await client.callTool({ name: "execute", arguments: { code: "return 1;" } }); // rebuilds

    const diag = lines.filter((l) => l.startsWith("[sandbox] "));
    expect(diag.some((l) => l.includes("sandbox.module.poisoned"))).toBe(true);
    expect(diag.some((l) => l.includes("sandbox.module.recovery.ok"))).toBe(true);
    // No diagnostic line carries guest code or values.
    for (const l of diag) {
      expect(l).not.toContain("secretMarker");
      expect(l).not.toContain('"n"');
    }
    setSandboxDiagnostic(undefined);
  }, 30_000);

  it("one owner per process: the last server constructed owns the global sink (documented model)", async () => {
    // Two servers in one process is not our deployment model, but the semantics
    // must be explicit and pinned, not silent: last-writer-wins.
    setSandboxDiagnostic(undefined);
    const first: string[] = [];
    const second: string[] = [];
    createConduitMcpServer({ store, log: (line) => first.push(line) });
    const later = createConduitMcpServer({ store, log: (line) => second.push(line) });
    const client = await connect(later);
    await client.callTool({
      name: "execute",
      arguments: { code: "let x={v:0};for(let i=0;i<20000;i++)x={n:x};return x;" },
    });
    await client.callTool({ name: "execute", arguments: { code: "return 1;" } });

    expect(second.some((l) => l.includes("sandbox.module.recovery.ok"))).toBe(true);
    expect(first.some((l) => l.startsWith("[sandbox] "))).toBe(false);
    setSandboxDiagnostic(undefined);
  }, 30_000);

  it("tools/list exposes exactly execute + check_execution, with fresh connections", async () => {
    const client = await connect(server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_execution", "execute"]);
    const execute = tools.find((t) => t.name === "execute");
    expect(execute?.description).toContain("github.acme.prod");
    expect((execute?.inputSchema.properties as Record<string, unknown>).requestKey).toBeDefined();
  });

  it("execute runs code through the sandbox and returns a completed payload", async () => {
    const client = await connect(server);
    const res = await client.callTool({
      name: "execute",
      arguments: {
        code: 'const { items } = await tools.search({ query: "issues" }); return items.length;',
      },
    });
    const payload = textPayload(res) as { status: string; executionId: string };
    expect(payload.status).toBe("completed");
    expect(payload.executionId).toMatch(/^exec_/);
  });

  it("check_execution resolves by executionId and by requestKey; unknown → not_found", async () => {
    const client = await connect(server);
    const run = await client.callTool({
      name: "execute",
      arguments: { code: "return 42;", requestKey: "rk-1" },
    });
    const { executionId } = textPayload(run) as { executionId: string };
    for (const args of [{ executionId }, { requestKey: "rk-1" }]) {
      const res = await client.callTool({ name: "check_execution", arguments: args });
      const p = textPayload(res) as { status: string; result: unknown };
      expect(p.status).toBe("completed");
      expect(p.result).toBe(42);
    }
    const missing = await client.callTool({
      name: "check_execution",
      arguments: { executionId: "exec_nope" },
    });
    expect(textPayload(missing)).toEqual({ status: "not_found" });
  });

  it("INVARIANT M1: there is no resume/approve tool on the MCP surface", async () => {
    const client = await connect(server);
    const { tools } = await client.listTools();
    expect(tools.some((t) => /resume|approve/i.test(t.name))).toBe(false);
    await expect(client.callTool({ name: "resume", arguments: {} })).rejects.toThrow();
  });

  it("malformed arguments → InvalidParams protocol error (handler-owned validation)", async () => {
    // McpError's wire message is `"MCP error <code>: <message>"`, doubled again
    // by the client's own McpError wrap on the way back — so the protocol
    // contract that actually matters, and the only thing safe to assert, is
    // the numeric JSON-RPC error code, not substrings of the human text.
    const client = await connect(server);
    await expect(client.callTool({ name: "execute", arguments: {} })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    // neither executionId nor requestKey
    await expect(client.callTool({ name: "check_execution", arguments: {} })).rejects.toMatchObject(
      {
        code: ErrorCode.InvalidParams,
      },
    );
    // both executionId and requestKey
    await expect(
      client.callTool({
        name: "check_execution",
        arguments: { executionId: "exec_x", requestKey: "rk-1" },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });

  it("a new connection appears on the NEXT tools/list without restart (M6)", async () => {
    const client = await connect(server);
    await store.integrations.upsert({ id: "int2", sourceId: "src2", namespace: "stripe" });
    await store.sources.upsert({
      id: "src2",
      type: "mcp",
      namespace: "stripe",
      location: "http://127.0.0.1:1/mcp",
    });
    await store.connections.upsert({
      id: "conn2",
      integrationId: "int2",
      prefix: "stripe.acme.live",
    });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "execute")?.description).toContain("stripe.acme.live");
  });

  it("check_execution store fault is redacted behind a correlation id (no raw cause leaks)", async () => {
    const rawCause = "ENOENT: no such file or directory, corrupt-column-blowup";
    store.executions.get = async () => {
      throw new Error(rawCause);
    };
    const client = await connect(server);
    await expect(
      client.callTool({ name: "check_execution", arguments: { executionId: "exec_x" } }),
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringMatching(/correlation \w+/),
    });
    await expect(
      client.callTool({ name: "check_execution", arguments: { executionId: "exec_x" } }),
    ).rejects.not.toMatchObject({
      message: expect.stringContaining(rawCause),
    });
  });

  it("a require_approval policy pauses; payload carries pending + stop-and-report message", async () => {
    const client = await connect(server);
    const res = await client.callTool({
      name: "execute",
      arguments: { code: 'return await tools.github.delete_repo({ repo: "x" });' },
    });
    const p = textPayload(res) as {
      status: string;
      pending: { toolName: string };
      message: string;
    };
    expect(p.status).toBe("paused");
    expect(p.pending.toolName).toBe("github.delete_repo");
    expect(p.message).toMatch(/stop/i);
  });
});
