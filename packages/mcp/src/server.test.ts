import {
  type ConduitStore,
  DEFAULT_SANDBOX_LIMITS,
  normalizeMcp,
  openSqliteStore,
  SecretBox,
} from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { RESUME_ADMISSION_DEADLINE_MS } from "./daemon/connection.js";
import type { RpcRequest, RpcResponse } from "./daemon/rpc.js";
import { buildCatalogListing, executionToCheckPayload, outcomeToPayload } from "./payloads.js";
import { createApprovalRuntime } from "./runtime.js";
import {
  createConduitMcpServer,
  type DaemonCall,
  deadlineForRequest,
  EXECUTE_ADMISSION_DEADLINE_MS,
  EXECUTE_CLIENT_DEADLINE_MS,
  READ_DEADLINE_MS,
  RESUME_CLIENT_DEADLINE_MS,
} from "./server.js";

/**
 * Ring-1 protocol suite: drives `createConduitMcpServer` entirely over
 * `InMemoryTransport` — no sockets, no upstream fetch. The `execute` happy
 * path only ever calls `tools.search`, which the catalog answers locally
 * (execute.ts createCatalogToolHost); the require_approval pause test never
 * reaches upstream either, because policy refuses BEFORE the invoker calls
 * out (§5.3 step 2 precedes step 3).
 *
 * Since Task 6 the server holds no store, so this ring drives it through an
 * IN-PROCESS fake daemon (`fakeDaemon` below) instead of an in-memory store.
 * The fake answers with the SAME projection functions the real daemon uses
 * (`connection.ts` calls exactly these), so what the ring pins is the MCP
 * surface and the client-side unwrapping — the socket, framing, capability
 * check and queue are ring-2's job (`daemon/conduitd.test.ts`).
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

/**
 * An in-process stand-in for the daemon: same request vocabulary, same
 * projection functions, no socket. Deliberately reuses
 * `buildCatalogListing` / `outcomeToPayload` / `executionToCheckPayload`
 * rather than re-deriving the payloads, so a change to what the daemon
 * actually returns cannot silently diverge from what this ring asserts.
 *
 * `failWith` lets a case inject the daemon's own typed refusals (the
 * `error` and `outcome-unknown` frames) without a real daemon dying.
 */
function fakeDaemon(
  store: ConduitStore,
  opts: { log?: (line: string) => void; failWith?: () => RpcResponse | undefined } = {},
): DaemonCall {
  const log = opts.log ?? (() => {});
  return async (request: RpcRequest): Promise<RpcResponse> => {
    const injected = opts.failWith?.();
    if (injected !== undefined) return injected;
    const requestId = "r1";
    switch (request.kind) {
      case "catalog.listing":
        return { kind: "result", requestId, payload: await buildCatalogListing(store, log) };
      case "execute": {
        const { manager } = await createApprovalRuntime({ store, allowPrivateEgress: false, log });
        return {
          kind: "result",
          requestId,
          payload: outcomeToPayload(
            await manager.start(
              request.code,
              request.requestKey !== undefined ? { requestKey: request.requestKey } : undefined,
            ),
          ),
        };
      }
      case "execution.get":
        return {
          kind: "result",
          requestId,
          payload: executionToCheckPayload(
            await store.executions.get(request.executionId),
            Date.now(),
          ),
        };
      case "execution.getByRequestKey":
        return {
          kind: "result",
          requestId,
          payload: executionToCheckPayload(
            await store.executions.getByRequestKey(request.requestKey),
            Date.now(),
          ),
        };
      default:
        // The MCP surface must never reach for anything else. If it does,
        // that is the finding — not something to answer politely.
        throw new Error(`[server.test] fake daemon got an unexpected kind: ${request.kind}`);
    }
  };
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
    server = createConduitMcpServer({ daemon: fakeDaemon(store), log: () => {} });
  });

  // NOTE: the two sandbox module-recovery diagnostics cases that lived here
  // moved to `daemon/conduitd.test.ts` with the sandbox itself. Since Task 6
  // this process runs no sandbox, so a sink registered by
  // `createConduitMcpServer` could never fire — asserting on it here would
  // have been a test that passes while pinning nothing.

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

  /**
   * D-B1 client-side unwrapping. The three non-`result` frames the daemon
   * can send are genuinely different verdicts and must not collapse into
   * one generic failure.
   */
  it("INVARIANT §17 / §5: an outcome-unknown execute is reported as ambiguous and tells the agent NOT to retry", async () => {
    // §5's whole point: after the request bytes are written, "the daemon
    // never saw it" and "it ran and the ack was lost" are indistinguishable,
    // and they have opposite correct responses. The agent must be told to
    // look the execution up, never to re-issue it — a replayed tool call is
    // an upstream side effect the operator never authorized.
    const own = createConduitMcpServer({
      daemon: fakeDaemon(store, {
        failWith: () => ({ kind: "outcome-unknown", requestId: "r7" }),
      }),
      log: () => {},
    });
    const client = await connect(own);
    await expect(
      client.callTool({ name: "execute", arguments: { code: "return 1;" } }),
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringMatching(/UNKNOWN/),
    });
    // Names the recovery path and forbids the dangerous one, by correlation id.
    await expect(
      client.callTool({ name: "execute", arguments: { code: "return 1;" } }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/Do NOT retry/) });
    await expect(
      client.callTool({ name: "execute", arguments: { code: "return 1;" } }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/check_execution/) });
    await expect(
      client.callTool({ name: "execute", arguments: { code: "return 1;" } }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/r7/) });
  });

  it("a typed daemon refusal surfaces its code without inventing a result", async () => {
    // `busy` is the queue-full refusal (§3.1). It is NOT an ambiguity — the
    // request provably never ran — so it must read as a refusal the agent
    // can act on, carrying the daemon's own stable code.
    const own = createConduitMcpServer({
      daemon: fakeDaemon(store, {
        failWith: () => ({
          kind: "error",
          requestId: "r9",
          code: "busy",
          message: "daemon busy",
        }),
      }),
      log: () => {},
    });
    const client = await connect(own);
    await expect(
      client.callTool({ name: "execute", arguments: { code: "return 1;" } }),
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringMatching(/busy/),
    });
  });

  it("a daemon transport failure is redacted behind a correlation id (the path names leak nothing)", async () => {
    // DaemonUnavailable's own message carries the state-directory path and
    // the daemon log location — operator information, not agent
    // information. The agent gets a correlation id; the operator gets the
    // cause in the log.
    const rawCause = "no daemon could be reached, stateDir: /Users/somebody/.conduit";
    const own = createConduitMcpServer({
      daemon: () => Promise.reject(new Error(rawCause)),
      log: () => {},
    });
    const client = await connect(own);
    const failure = client.callTool({ name: "execute", arguments: { code: "return 1;" } });
    await expect(failure).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringMatching(/correlation \w+/),
    });
    await expect(failure).rejects.not.toMatchObject({
      message: expect.stringContaining("/Users/somebody/.conduit"),
    });
  });

  it("INVARIANT §17 / §3.3: the MCP surface reaches for NO administrative verb", async () => {
    // The fake daemon throws on any kind outside the serve reads, so this
    // exercises the whole surface and fails loudly if a handler ever
    // reaches for approvals.* or source.* — the §3.3 hard line, pinned at
    // the consumer rather than only at the capability table.
    const seen: RpcRequest["kind"][] = [];
    const own = createConduitMcpServer({
      daemon: async (request) => {
        seen.push(request.kind);
        return await fakeDaemon(store)(request);
      },
      log: () => {},
    });
    const client = await connect(own);
    await client.listTools();
    const run = await client.callTool({
      name: "execute",
      arguments: { code: "return 1;", requestKey: "rk-admin-probe" },
    });
    const { executionId } = textPayload(run) as { executionId: string };
    await client.callTool({ name: "check_execution", arguments: { executionId } });
    await client.callTool({ name: "check_execution", arguments: { requestKey: "rk-admin-probe" } });

    expect(new Set(seen)).toEqual(
      new Set(["catalog.listing", "execute", "execution.get", "execution.getByRequestKey"]),
    );
    for (const administrative of [
      "approvals.list",
      "approvals.resume",
      "source.provision",
      "source.revalidate",
    ]) {
      expect(seen).not.toContain(administrative);
    }
  });

  it("INVARIANT §17 / §5: the client deadline outlasts the daemon's worst legal execute", () => {
    // The defect this pins, concretely: the client's budget bounds the
    // WHOLE round trip, while the daemon may legally spend
    // EXECUTE_ADMISSION_DEADLINE_MS queuing an entry and THEN
    // wallClockMs running it. A client that gives up inside that window
    // returns `outcome-unknown` — "may have run, do NOT retry" — for an
    // execution that is merely slow and completes normally moments
    // later, which spends §5's ambiguity signal on routine slowness. It
    // also loses the race against the daemon's own queue-expiry refusal,
    // a typed retryable `busy` that is strictly the better answer.
    const worstLegalDaemonAnswer =
      EXECUTE_ADMISSION_DEADLINE_MS + DEFAULT_SANDBOX_LIMITS.wallClockMs;
    expect(EXECUTE_CLIENT_DEADLINE_MS).toBeGreaterThan(worstLegalDaemonAnswer);

    // And the budget is actually WIRED per kind — asserting the
    // constants alone would still pass if `deadlineForRequest` handed
    // every request the short read budget.
    expect(deadlineForRequest({ kind: "execute", code: "1", deadlineMs: 0 })).toBe(
      EXECUTE_CLIENT_DEADLINE_MS,
    );
    for (const read of [
      { kind: "catalog.listing" },
      { kind: "execution.get", executionId: "e" },
      { kind: "execution.getByRequestKey", requestKey: "r" },
    ] as const) {
      expect(deadlineForRequest(read)).toBe(READ_DEADLINE_MS);
    }
    // The reads are bounded well BELOW the execute budget — they are
    // store reads answered outside the queue, so inheriting the
    // execute-sized budget would make a wedged daemon hang a tools/list
    // for minutes.
    expect(READ_DEADLINE_MS).toBeLessThan(EXECUTE_CLIENT_DEADLINE_MS);
  });

  it("INVARIANT §17 / §5: `approvals.resume` carries a RUN-sized budget, not a read's — the same ordering constraint as execute", () => {
    // A resume is not a read. `connection.ts` admits it through the SAME
    // ExecutionQueue as execute (so it may wait out
    // RESUME_ADMISSION_DEADLINE_MS) and then it DRIVES a paused
    // execution's replay, bounded by §16's wall clock. Handing it
    // READ_DEADLINE_MS would abandon an approve that is merely queued
    // behind the concurrency cap and report §5 ambiguity — telling an
    // operator their decision may or may not have landed on an execution
    // that would have completed normally seconds later.
    const worstLegalResumeAnswer =
      RESUME_ADMISSION_DEADLINE_MS + DEFAULT_SANDBOX_LIMITS.wallClockMs;
    expect(RESUME_CLIENT_DEADLINE_MS).toBeGreaterThan(worstLegalResumeAnswer);

    // Wired, not merely declared.
    expect(
      deadlineForRequest({
        kind: "approvals.resume",
        executionId: "e",
        decision: "approve",
      }),
    ).toBe(RESUME_CLIENT_DEADLINE_MS);
    expect(RESUME_CLIENT_DEADLINE_MS).toBeGreaterThan(READ_DEADLINE_MS);

    // `approvals.list` IS a read — answered outside the queue, like the
    // D-B1 reads — so it keeps the short budget.
    expect(deadlineForRequest({ kind: "approvals.list" })).toBe(READ_DEADLINE_MS);
  });

  it("execute forwards requestKey to the daemon only when the agent supplied one", async () => {
    // Absent must stay ABSENT on the wire: `decodeRequest` rejects unknown
    // keys, and a materialized `requestKey: undefined` would also make the
    // daemon persist an explicit undefined against the row.
    const sent: RpcRequest[] = [];
    const own = createConduitMcpServer({
      daemon: async (request) => {
        sent.push(request);
        return await fakeDaemon(store)(request);
      },
      log: () => {},
    });
    const client = await connect(own);
    await client.callTool({ name: "execute", arguments: { code: "return 1;" } });
    await client.callTool({
      name: "execute",
      arguments: { code: "return 2;", requestKey: "rk-x" },
    });

    const executes = sent.filter((r) => r.kind === "execute");
    expect(executes[0]).not.toHaveProperty("requestKey");
    expect(executes[1]).toMatchObject({ requestKey: "rk-x" });
    // The admission deadline is always sent, and is finite/non-negative —
    // the decoder rejects anything else (§3.3).
    for (const e of executes) {
      expect(Number.isFinite((e as { deadlineMs: number }).deadlineMs)).toBe(true);
      expect((e as { deadlineMs: number }).deadlineMs).toBeGreaterThan(0);
    }
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
