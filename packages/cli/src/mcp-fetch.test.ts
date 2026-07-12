import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchToolsList, MAX_RESPONSE_BYTES, MAX_TOOLS } from "./mcp-fetch.js";

/**
 * Fix 1 (P1): a hostile upstream must not be able to force unbounded memory
 * use or unbounded provisioning work via `tools/list`. Both caps
 * (MAX_RESPONSE_BYTES, MAX_TOOLS) are exercised against a real loopback HTTP
 * server so the response actually flows through `fetch`/`response.text()`.
 */

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

function startServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server?.listen(0, "127.0.0.1", () => {
      const port = (server?.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

describe("fetchToolsList — hostile-upstream caps", () => {
  it("rejects a body over MAX_RESPONSE_BYTES without JSON.parse ever seeing it", async () => {
    // Oversized body: a huge padding string inside an otherwise-valid
    // envelope. If the cap were bypassed, JSON.parse would succeed and the
    // (garbage) tools array would flow through — the assertion on the thrown
    // message confirms the size check fired, not a parse failure.
    const oversized = "x".repeat(MAX_RESPONSE_BYTES + 1024);
    const url = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [], padding: oversized } }));
    });

    await expect(fetchToolsList(url)).rejects.toThrow(
      /\[conduit add-mcp\].*exceeds the .*-byte cap/,
    );
  });

  it("rejects via the cheap Content-Length precheck when the upstream declares an oversized body", async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(MAX_RESPONSE_BYTES + 1),
      });
      // Body itself can be tiny/short — the Content-Length header alone
      // must be enough to reject before the body is even read.
      res.end("{}");
    });

    await expect(fetchToolsList(url)).rejects.toThrow(
      /\[conduit add-mcp\].*exceeds the .*-byte cap.*Content-Length/,
    );
  });

  it("rejects a tools array longer than MAX_TOOLS", async () => {
    const tools = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => ({
      name: `tool_${i}`,
      inputSchema: { type: "object" },
    }));
    const url = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }));
    });

    await expect(fetchToolsList(url)).rejects.toThrow(
      /\[conduit add-mcp\].*exceeds the .*-tool cap/,
    );
  });

  it("accepts a response at or under both caps", async () => {
    const tools = [{ name: "ok_tool", inputSchema: { type: "object" } }];
    const url = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }));
    });

    const result = await fetchToolsList(url);

    expect(result).toEqual(tools);
  });
});
