import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ConduitStore, normalizeMcp, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { createApprovalRuntime } from "./runtime.js";

/**
 * Proves the composition wired by `createApprovalRuntime` is reachable:
 * sandbox executes, manager reaches a terminal outcome. Mirrors
 * server.test.ts's store fixture (in-memory libsql + SecretBox).
 */

async function seedStore(): Promise<ConduitStore> {
  const client = createClient({ url: ":memory:" });
  return openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
  });
}

describe("createApprovalRuntime", () => {
  it("returns { manager } and the manager runs trivial code to a terminal outcome", async () => {
    const store = await seedStore();
    const runtime = await createApprovalRuntime({ store, allowPrivateEgress: false });
    expect(runtime.manager).toBeDefined();

    const outcome = await runtime.manager.start("return 42;");
    expect(outcome.status).toBe("completed");
    expect((outcome as { value: unknown }).value).toBe(42);
  });
});

/**
 * Lane B PR #31 review carry-over (Greptile P2 + opus whole-branch Minor):
 * `createApprovalRuntime` is the single home of the §9.3 egress boundary
 * wiring (server.ts's `execute` handler and the CLI's approvals both go
 * through it), but Lane A's own suite only proved the invariant
 * TRANSITIVELY via server.test.ts. This pins it DIRECTLY at the seam that
 * owns it — both callers now compose against a test that fails loud if the
 * `allowPrivateEgress` wiring in runtime.ts ever regresses. Also exercises
 * runtime.ts's `log` default (console.error → stderr): neither test below
 * passes a `log` option, the first caller in this suite to omit it.
 */
describe("createApprovalRuntime — INVARIANT §9.3 direct pin", () => {
  let upstream: { server: Server; port: number; calls: number };

  const NEGOTIATED_VERSION = "2025-06-18";
  const SESSION_ID = "sess-runtime-1";

  /**
   * Streamable-HTTP MCP fixture (mirrors Task 6's `createStreamableFixture`
   * helper in sdk/pipeline/upstream.test.ts — copied local since test files
   * don't share exports across packages). Owns the handshake bookkeeping —
   * replies to `initialize` and `notifications/initialized` — and only
   * counts + answers the `tools/call` request.
   */
  function startLoopbackUpstream(): Promise<{ server: Server; port: number; calls: number }> {
    const state = { calls: 0 };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}") as { id?: string; method?: string };
        if (parsed.method === "initialize") {
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": SESSION_ID,
          });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                protocolVersion: NEGOTIATED_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "0" },
              },
            }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (req.method === "DELETE") {
          res.writeHead(200);
          res.end();
          return;
        }
        state.calls++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { ok: true } }));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve({
          server,
          port: (server.address() as AddressInfo).port,
          get calls() {
            return state.calls;
          },
        });
      });
    });
  }

  afterEach(async () => {
    if (upstream !== undefined) {
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    }
  });

  async function seedLoopbackTool(location: string): Promise<ConduitStore> {
    const store = await seedStore();
    const tools = normalizeMcp({
      namespace: "loop",
      tools: [
        {
          name: "ping",
          description: "Ping the loopback upstream",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    await store.sources.upsert({ id: "src_loop", type: "mcp", namespace: "loop", location });
    await store.integrations.upsert({ id: "int_loop", sourceId: "src_loop", namespace: "loop" });
    await store.connections.upsert({ id: "conn_loop", integrationId: "int_loop", prefix: "loop" });
    await store.tools.replaceNamespace("loop", tools);
    return store;
  }

  it("INVARIANT §9.3: allowPrivateEgress:false BLOCKS a loopback upstream call without naming the env var", async () => {
    upstream = await startLoopbackUpstream();
    const store = await seedLoopbackTool(`http://127.0.0.1:${upstream.port}/mcp`);

    const runtime = await createApprovalRuntime({ store, allowPrivateEgress: false });
    const outcome = await runtime.manager.start("return await tools.loop.ping({});");

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.message).toMatch(/loopback\/private egress is off by default/i);
      expect(outcome.error.message).not.toContain("CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS");
    }
    expect(upstream.calls).toBe(0);
  });

  it("INVARIANT §9.3: allowPrivateEgress:true opts in — the loopback call reaches the upstream", async () => {
    upstream = await startLoopbackUpstream();
    const store = await seedLoopbackTool(`http://127.0.0.1:${upstream.port}/mcp`);

    const runtime = await createApprovalRuntime({ store, allowPrivateEgress: true });
    const outcome = await runtime.manager.start("return await tools.loop.ping({});");

    expect(outcome.status).toBe("completed");
    expect(upstream.calls).toBe(1);
  });
});
