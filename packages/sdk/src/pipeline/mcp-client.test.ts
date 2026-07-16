import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpClient, type McpSession, SUPPORTED_PROTOCOL_VERSIONS } from "./mcp-client.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function serve(handler: Parameters<typeof createServer>[1]): Promise<URL> {
  return new Promise((resolve) => {
    server = createServer(handler).listen(0, "127.0.0.1", () => {
      const addr = server?.address();
      if (addr === null || addr === undefined || typeof addr === "string")
        throw new Error("no port");
      resolve(new URL(`http://127.0.0.1:${addr.port}/mcp`));
    });
  });
}

const budget = () => ({ deadline: () => 5_000, maxBytes: 1024 * 1024 });

function initializeResult(version: string, extra: object = {}) {
  return {
    jsonrpc: "2.0",
    id: "init",
    result: {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "0" },
      ...extra,
    },
  };
}

describe("INVARIANT §18-C4: initialize handshake", () => {
  it("negotiates a supported version, captures the session id, sends initialized with the version header", async () => {
    const seen: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const url = await serve((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ headers: req.headers, body: raw });
        const parsed = JSON.parse(raw);
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(JSON.stringify({ ...initializeResult("2025-06-18"), id: parsed.id }));
        } else {
          res.writeHead(202);
          res.end();
        }
      });
    });
    const session = await createMcpClient(
      { target: url, headers: { authorization: "Bearer t" } },
      budget(),
    ).initialize();
    expect(session).toEqual({ protocolVersion: "2025-06-18", sessionId: "sess-1" });
    const [firstSeen, secondSeen] = seen;
    if (firstSeen === undefined || secondSeen === undefined)
      throw new Error("expected two requests");
    // initialize carried the FULL shape
    const init = JSON.parse(firstSeen.body);
    expect(init.params.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(init.params.clientInfo.name).toBe("conduit");
    expect(init.params.capabilities).toEqual({});
    // initialized carried session + negotiated-version headers + auth
    expect(secondSeen.headers["mcp-session-id"]).toBe("sess-1");
    expect(secondSeen.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(secondSeen.headers.authorization).toBe("Bearer t");
  });

  it("INVARIANT §18-C4: rejects a counter-offer outside the allowlist, naming both sides", async () => {
    const url = await serve((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const parsed = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...initializeResult("1999-01-01"), id: parsed.id }));
      });
    });
    await expect(
      createMcpClient({ target: url, headers: {} }, budget()).initialize(),
    ).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringContaining("1999-01-01"),
    });
  });

  it("rejects a server that does not advertise capabilities.tools", async () => {
    const url = await serve((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const parsed = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...initializeResult("2025-06-18", { capabilities: {} }),
            id: parsed.id,
          }),
        );
      });
    });
    await expect(
      createMcpClient({ target: url, headers: {} }, budget()).initialize(),
    ).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringContaining("tools"),
    });
  });

  it("INVARIANT §18-C4: Mcp-Session-Id validation matrix — empty and non-visible-ASCII rejected; visible-ASCII boundary accepted", async () => {
    for (const [sid, ok] of [
      ["", false],
      ["a b", false],
      ["sid", true],
      ["!~ok-id", true],
    ] as const) {
      const url = await serve((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const parsed = JSON.parse(raw);
          if (parsed.method === "initialize") {
            res.writeHead(200, {
              "content-type": "application/json",
              ...(sid === "" ? { "mcp-session-id": "" } : { "mcp-session-id": sid }),
            });
            res.end(JSON.stringify({ ...initializeResult("2025-06-18"), id: parsed.id }));
          } else {
            res.writeHead(202);
            res.end();
          }
        });
      });
      const attempt = createMcpClient({ target: url, headers: {} }, budget()).initialize();
      if (ok) await expect(attempt).resolves.toMatchObject({ sessionId: sid });
      else await expect(attempt).rejects.toMatchObject({ kind: "protocol" });
      await new Promise<void>((r) => server?.close(() => r()));
      server = undefined;
    }
  });

  it("accepts a sessionless server (no Mcp-Session-Id header)", async () => {
    const url = await serve((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const parsed = JSON.parse(raw);
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...initializeResult("2025-03-26"), id: parsed.id }));
        } else {
          res.writeHead(202);
          res.end();
        }
      });
    });
    const session = await createMcpClient({ target: url, headers: {} }, budget()).initialize();
    expect(session).toEqual({ protocolVersion: "2025-03-26" });
  });

  it("parses an SSE-framed initialize response", async () => {
    const url = await serve((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const parsed = JSON.parse(raw);
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s2" });
          res.end(
            `event: message\ndata: ${JSON.stringify({ ...initializeResult("2025-06-18"), id: parsed.id })}\n\n`,
          );
        } else {
          res.writeHead(202);
          res.end();
        }
      });
    });
    await expect(
      createMcpClient({ target: url, headers: {} }, budget()).initialize(),
    ).resolves.toMatchObject({ sessionId: "s2" });
  });

  it("INVARIANT §18-C4: initialized must be exactly 202 with an empty body", async () => {
    const url = await serve((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const parsed = JSON.parse(raw);
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...initializeResult("2025-06-18"), id: parsed.id }));
        } else {
          res.writeHead(200, { "content-type": "application/json" }); // wrong: not 202
          res.end("{}");
        }
      });
    });
    await expect(
      createMcpClient({ target: url, headers: {} }, budget()).initialize(),
    ).rejects.toMatchObject({ kind: "protocol" });
  });

  it("INVARIANT §18-C4: handshake responses are capped — a huge initialize body is a cap error, and the budget is cumulative", async () => {
    const url = await serve((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"jsonrpc":"2.0","id":"init","result":{"pad":"${"x".repeat(2048)}"}}`);
      });
    });
    const tiny = createMcpClient(
      { target: url, headers: {} },
      { deadline: () => 5_000, maxBytes: 512 },
    );
    await expect(tiny.initialize()).rejects.toMatchObject({ kind: "cap" });
  });

  it("surfaces a JSON-RPC error rejection of initialize with the server's code and message", async () => {
    const url = await serve((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const parsed = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32600, message: "Invalid Request" },
          }),
        );
      });
    });
    await expect(
      createMcpClient({ target: url, headers: {} }, budget()).initialize(),
    ).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringContaining("Invalid Request"),
    });
    await expect(
      createMcpClient({ target: url, headers: {} }, budget()).initialize(),
    ).rejects.toMatchObject({
      message: expect.stringContaining("-32600"),
    });
  });

  it("an exhausted deadline fails as timeout before any request", async () => {
    const url = await serve((_req, res) => res.end());
    const spent = createMcpClient(
      { target: url, headers: {} },
      { deadline: () => 0, maxBytes: 1024 },
    );
    await expect(spent.initialize()).rejects.toMatchObject({ kind: "timeout" });
  });
});

/** A single JSON-RPC response frame, written as a plain JSON body. */
function jsonRpcResponse(id: string, body: object) {
  return JSON.stringify({ jsonrpc: "2.0", id, ...body });
}

function readBody(req: IncomingMessage): Promise<{
  raw: string;
  parsed: Record<string, unknown>;
}> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve({ raw, parsed: raw ? JSON.parse(raw) : {} }));
  });
}

describe("INVARIANT §18-C4: listTools pagination and caps", () => {
  it("INVARIANT §18-C4: tools/list follows nextCursor to completion and the tool-count cap spans ALL pages", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => ({ name: `t1-${i}` }));
    const page2 = Array.from({ length: 2 }, (_, i) => ({ name: `t2-${i}` }));
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/list") {
          const params = parsed.params as { cursor?: string } | undefined;
          res.writeHead(200, { "content-type": "application/json" });
          if (params?.cursor === "p2") {
            res.end(jsonRpcResponse(parsed.id as string, { result: { tools: page2 } }));
          } else {
            res.end(
              jsonRpcResponse(parsed.id as string, {
                result: { tools: page1, nextCursor: "p2" },
              }),
            );
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.listTools(session, 1024)).resolves.toEqual([...page1, ...page2]);
  });

  it("INVARIANT §18-C4: tools/list rejects with a cap error when the running tool count exceeds maxTools, across pages", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => ({ name: `t1-${i}` }));
    const page2 = Array.from({ length: 2 }, (_, i) => ({ name: `t2-${i}` }));
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/list") {
          const params = parsed.params as { cursor?: string } | undefined;
          res.writeHead(200, { "content-type": "application/json" });
          if (params?.cursor === "p2") {
            res.end(jsonRpcResponse(parsed.id as string, { result: { tools: page2 } }));
          } else {
            res.end(
              jsonRpcResponse(parsed.id as string, {
                result: { tools: page1, nextCursor: "p2" },
              }),
            );
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.listTools(session, 3)).rejects.toMatchObject({ kind: "cap" });
  });

  it("INVARIANT §18-C4: the byte budget is cumulative across pages", async () => {
    // Each page's tools array is padded to ~700 bytes; two pages exceed maxBytes:1000.
    const pad = "x".repeat(650);
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/list") {
          const params = parsed.params as { cursor?: string } | undefined;
          res.writeHead(200, { "content-type": "application/json" });
          if (params?.cursor === "p2") {
            res.end(
              jsonRpcResponse(parsed.id as string, {
                result: { tools: [{ name: "b", pad }] },
              }),
            );
          } else {
            res.end(
              jsonRpcResponse(parsed.id as string, {
                result: { tools: [{ name: "a", pad }], nextCursor: "p2" },
              }),
            );
          }
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient(
      { target: url, headers: {} },
      { deadline: () => 5_000, maxBytes: 1000 },
    );
    const session = await client.initialize();
    await expect(client.listTools(session, 1024)).rejects.toMatchObject({ kind: "cap" });
  });
});

describe("INVARIANT §18-C4: callTool", () => {
  it("tools/call returns the JSON-RPC result verbatim with the HTTP status, ignoring an interleaved notification", async () => {
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          // An interleaved notification (no matching id, no method:"ping") then the real response.
          res.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`,
          );
          res.end(
            `data: ${jsonRpcResponse(parsed.id as string, { result: { content: [{ type: "text", text: "ok" }] } })}\n\n`,
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.callTool(session, "demo", {})).resolves.toEqual({
      result: { content: [{ type: "text", text: "ok" }] },
      status: 200,
    });
  });

  it("INVARIANT §18-C4: a server ping mid-stream is answered and the response still arrives", async () => {
    let pingAnswerSeen: unknown;
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        // The client's answer to the ping arrives as its own POST.
        if (parsed.id === "ping-1" && parsed.result !== undefined) {
          pingAnswerSeen = parsed;
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "ping", id: "ping-1" })}\n\n`,
          );
          res.end(`data: ${jsonRpcResponse(parsed.id as string, { result: { content: [] } })}\n\n`);
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.callTool(session, "demo", {})).resolves.toEqual({
      result: { content: [] },
      status: 200,
    });
    expect(pingAnswerSeen).toEqual({ jsonrpc: "2.0", id: "ping-1", result: {} });
  });

  it("INVARIANT §18-C4: reading stops at the matching response — a held-open SSE stream does not time out a delivered result", async () => {
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          // Deliver the matching response, then KEEP THE STREAM OPEN forever.
          res.write(
            `data: ${jsonRpcResponse(parsed.id as string, { result: { content: [{ type: "text", text: "ok" }] } })}\n\n`,
          );
          // Deliberately never res.end() — a server that holds the stream open.
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    const started = Date.now();
    await expect(client.callTool(session, "demo", {})).resolves.toEqual({
      result: { content: [{ type: "text", text: "ok" }] },
      status: 200,
    });
    // Resolved from the matched frame, well before the 5s budget.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("INVARIANT §18-C4: a mid-stream ping is answered while the stream is still open", async () => {
    let pingAnswerSeen = false;
    let responseSentAfterPing = false;
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        // The ping answer arrives as its own POST while the tools/call SSE stream is open.
        if (parsed.id === "ping-live" && parsed.result !== undefined) {
          pingAnswerSeen = true;
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          // Emit ONLY the ping first; hold the response until the ping is answered.
          res.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "ping", id: "ping-live" })}\n\n`,
          );
          const waitForAnswer = setInterval(() => {
            if (pingAnswerSeen) {
              clearInterval(waitForAnswer);
              responseSentAfterPing = true;
              res.end(
                `data: ${jsonRpcResponse(parsed.id as string, { result: { content: [] } })}\n\n`,
              );
            }
          }, 10);
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.callTool(session, "demo", {})).resolves.toEqual({
      result: { content: [] },
      status: 200,
    });
    expect(pingAnswerSeen).toBe(true);
    expect(responseSentAfterPing).toBe(true);
  });

  it("a JSON-RPC error member throws a protocol error naming the code and message", async () => {
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            jsonRpcResponse(parsed.id as string, {
              error: { code: -32601, message: "Method not found" },
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.callTool(session, "demo", {})).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringContaining("-32601"),
    });
    await expect(client.callTool(session, "demo", {})).rejects.toMatchObject({
      message: expect.stringContaining("Method not found"),
    });
  });

  it("a malformed JSON-RPC error member (missing/non-conforming fields) still throws a protocol error with a safe generic message", async () => {
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(200, { "content-type": "application/json" });
          // error member is a bare string, not { code, message }.
          res.end(jsonRpcResponse(parsed.id as string, { error: "totally broken" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.callTool(session, "demo", {})).rejects.toMatchObject({ kind: "protocol" });
    try {
      await client.callTool(session, "demo", {});
      throw new Error("expected rejection");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("undefined (code undefined)");
    }
  });
});

describe("INVARIANT §18-C4: scoped 404-session-expiry retry", () => {
  it("INVARIANT §18-C4: 404 retry fires ONLY when the request carried a session id, at most once", async () => {
    let initializeCount = 0;
    let callCount = 0;
    const callSessionHeaders: (string | string[] | undefined)[] = [];
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          initializeCount++;
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": `sess-${initializeCount}`,
          });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          callCount++;
          callSessionHeaders.push(req.headers["mcp-session-id"]);
          if (callCount === 1) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(jsonRpcResponse(parsed.id as string, { result: { content: [] } }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.callTool(session, "demo", {})).resolves.toEqual({
      result: { content: [] },
      status: 200,
    });
    expect(initializeCount).toBe(2);
    // The retried request must carry the FRESH session's id on the wire —
    // pinning that the retry uses the re-initialized local session, not the
    // stale one that 404'd.
    expect(callSessionHeaders).toEqual(["sess-1", "sess-2"]);
  });

  it("INVARIANT §18-C4: a second consecutive 404 rejects http_status 404", async () => {
    let initializeCount = 0;
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          initializeCount++;
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": `sess-${initializeCount}`,
          });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.callTool(session, "demo", {})).rejects.toMatchObject({
      kind: "http_status",
      status: 404,
    });
    expect(initializeCount).toBe(2);
  });

  it("INVARIANT §18-C4: a sessionless call getting 404 rejects immediately without retrying", async () => {
    let initializeCount = 0;
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          initializeCount++;
          // No mcp-session-id header — sessionless server.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    expect(session.sessionId).toBeUndefined();
    await expect(client.callTool(session, "demo", {})).rejects.toMatchObject({
      kind: "http_status",
      status: 404,
    });
    expect(initializeCount).toBe(1);
  });

  it("INVARIANT §18-C4: a 404 mid-pagination restarts from page one, discarding the stale cursor, keeping the cumulative budget", async () => {
    let initializeCount = 0;
    let page1FetchCount = 0;
    const pad = "x".repeat(50);
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          initializeCount++;
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": `sess-${initializeCount}`,
          });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/list") {
          const params = parsed.params as { cursor?: string } | undefined;
          if (params?.cursor === undefined) {
            page1FetchCount++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              jsonRpcResponse(parsed.id as string, {
                result: { tools: [{ name: "p1", pad }], nextCursor: "p2" },
              }),
            );
            return;
          }
          // page 2 request: 404 on the FIRST attempt only, succeed on retry.
          if (page1FetchCount === 1) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: { tools: [{ name: "p2", pad }] } }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient(
      { target: url, headers: {} },
      { deadline: () => 5_000, maxBytes: 100_000 },
    );
    const session = await client.initialize();
    await expect(client.listTools(session, 1024)).resolves.toEqual([
      { name: "p1", pad },
      { name: "p2", pad },
    ]);
    // page 1 was fetched twice: once before the 404, once after the restart.
    expect(page1FetchCount).toBe(2);
    expect(initializeCount).toBe(2);
  });

  it("INVARIANT §18-C4: the byte budget consumed BEFORE a mid-pagination 404 still counts against the retry — a from-zero retry would fit, the kept budget does not", async () => {
    // Sizing (measured off the wire, JSON bodies): each initialize response
    // is ~150 bytes; each page body with a 1000-byte pad is ~1080 bytes; the
    // 404 and 202 responses are empty. Full sequence:
    //   init(150) + page1(1080) + [404: 0] + re-init(150) + page1(1080) + page2(1080)
    //   ≈ 3540 bytes cumulative > maxBytes 3000 → cap during the retry leg.
    // A retry leg alone from a RESET budget would be ≈ 2310 < 3000 and would
    // resolve — so this test fails if the retry ever resets `bytesLeft`,
    // pinning the "budget NOT reset" half of the mid-pagination invariant.
    let initializeCount = 0;
    let page1FetchCount = 0;
    const pad = "x".repeat(1000);
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          initializeCount++;
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": `sess-${initializeCount}`,
          });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/list") {
          const params = parsed.params as { cursor?: string } | undefined;
          if (params?.cursor === undefined) {
            page1FetchCount++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              jsonRpcResponse(parsed.id as string, {
                result: { tools: [{ name: "p1", pad }], nextCursor: "p2" },
              }),
            );
            return;
          }
          if (page1FetchCount === 1) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: { tools: [{ name: "p2", pad }] } }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient(
      { target: url, headers: {} },
      { deadline: () => 5_000, maxBytes: 3000 },
    );
    const session = await client.initialize();
    await expect(client.listTools(session, 1024)).rejects.toMatchObject({ kind: "cap" });
    // The retry DID start (re-handshake + page-one restart happened) — the
    // cap fired only because the pre-404 bytes were kept on the budget.
    expect(initializeCount).toBe(2);
    expect(page1FetchCount).toBe(2);
  });

  it("INVARIANT §18-C4: a delayed 404 from an old session cannot invalidate a newly established session", async () => {
    let initializeCount = 0;
    let callCount = 0;
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          initializeCount++;
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": `sess-${initializeCount}`,
          });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          callCount++;
          if (callCount === 1) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(jsonRpcResponse(parsed.id as string, { result: { content: [] } }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session: McpSession = await client.initialize();
    const originalSessionId = session.sessionId;
    // Simulate a concurrent renewal: someone else already moved the shared
    // session object to a new id before this operation's retry would publish.
    const inFlight = client.callTool(session, "demo", {});
    session.sessionId = "sess-renewed-by-someone-else";
    await expect(inFlight).resolves.toEqual({ result: { content: [] }, status: 200 });
    // The retry's local re-initialize must NOT have clobbered the caller's
    // session, because by the time it would publish, session.sessionId no
    // longer equals the id that 404'd.
    expect(session.sessionId).toBe("sess-renewed-by-someone-else");
    expect(session.sessionId).not.toBe(originalSessionId);
  });
});

describe("INVARIANT §18-C4: deleteSession", () => {
  it("sends DELETE with session + version headers; 404/405 resolve (non-fatal)", async () => {
    for (const status of [200, 404, 405] as const) {
      const seenDeletes: { headers: Record<string, string | string[] | undefined> }[] = [];
      const url = await serve((req, res) => {
        if (req.method === "DELETE") {
          seenDeletes.push({ headers: req.headers });
          res.writeHead(status);
          res.end();
          return;
        }
        readBody(req).then(({ parsed }) => {
          if (parsed.method === "initialize") {
            res.writeHead(200, {
              "content-type": "application/json",
              "mcp-session-id": "sess-del",
            });
            res.end(
              jsonRpcResponse(parsed.id as string, {
                result: initializeResult("2025-06-18").result,
              }),
            );
            return;
          }
          res.writeHead(202);
          res.end();
        });
      });
      const client = createMcpClient({ target: url, headers: {} }, budget());
      const session = await client.initialize();
      await expect(client.deleteSession(session)).resolves.toBeUndefined();
      expect(seenDeletes).toHaveLength(1);
      expect(seenDeletes[0]?.headers["mcp-session-id"]).toBe("sess-del");
      expect(seenDeletes[0]?.headers["mcp-protocol-version"]).toBe("2025-06-18");
      await new Promise<void>((r) => server?.close(() => r()));
      server = undefined;
    }
  });

  it("a non-2xx/404/405 DELETE status throws http_status", async () => {
    const url = await serve((req, res) => {
      if (req.method === "DELETE") {
        res.writeHead(500);
        res.end();
        return;
      }
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-del" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        res.writeHead(202);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.deleteSession(session)).rejects.toMatchObject({
      kind: "http_status",
      status: 500,
    });
  });

  it("INVARIANT §18-C4: deleteSession is deadline-bounded — a never-ending DELETE body cannot outlive the budget", async () => {
    const url = await serve((req, res) => {
      if (req.method === "DELETE") {
        // Headers arrive, body starts, but the stream never ends.
        res.writeHead(200);
        res.write("draining");
        // Deliberately never res.end() — a broken/malicious upstream.
        return;
      }
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-del" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        res.writeHead(202);
        res.end();
      });
    });
    const startedAt = Date.now();
    const client = createMcpClient(
      { target: url, headers: {} },
      { deadline: () => Math.max(0, 500 - (Date.now() - startedAt)), maxBytes: 1024 * 1024 },
    );
    const session = await client.initialize();
    const del = client.deleteSession(session);
    const sentinel = new Promise<"sentinel">((r) => setTimeout(() => r("sentinel"), 3_000));
    const started = Date.now();
    // The rejection must win the race against a 3s sentinel.
    await expect(
      Promise.race([del.then(() => "resolved" as const), sentinel]),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does nothing when the session has no sessionId (sessionless server)", async () => {
    let deleteCalls = 0;
    const url = await serve((req, res) => {
      if (req.method === "DELETE") {
        deleteCalls++;
        res.writeHead(200);
        res.end();
        return;
      }
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        res.writeHead(202);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    await expect(client.deleteSession(session)).resolves.toBeUndefined();
    expect(deleteCalls).toBe(0);
  });
});

describe("INVARIANT §18-C4: batched array responses gated by negotiated protocol version", () => {
  it("accepted under 2025-03-26", async () => {
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "sess-batch",
          });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-03-26").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify([
              { jsonrpc: "2.0", method: "notifications/other", params: {} },
              { jsonrpc: "2.0", id: parsed.id, result: { content: [] } },
            ]),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    expect(session.protocolVersion).toBe("2025-03-26");
    await expect(client.callTool(session, "demo", {})).resolves.toEqual({
      result: { content: [] },
      status: 200,
    });
  });

  it("rejected under 2025-06-18", async () => {
    const url = await serve((req, res) => {
      readBody(req).then(({ parsed }) => {
        if (parsed.method === "initialize") {
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "sess-batch2",
          });
          res.end(
            jsonRpcResponse(parsed.id as string, { result: initializeResult("2025-06-18").result }),
          );
          return;
        }
        if (parsed.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (parsed.method === "tools/call") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify([{ jsonrpc: "2.0", id: parsed.id, result: { content: [] } }]));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    const client = createMcpClient({ target: url, headers: {} }, budget());
    const session = await client.initialize();
    expect(session.protocolVersion).toBe("2025-06-18");
    await expect(client.callTool(session, "demo", {})).rejects.toMatchObject({ kind: "protocol" });
  });
});
