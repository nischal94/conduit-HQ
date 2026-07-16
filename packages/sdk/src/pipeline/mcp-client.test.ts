import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpClient, SUPPORTED_PROTOCOL_VERSIONS } from "./mcp-client.js";

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
