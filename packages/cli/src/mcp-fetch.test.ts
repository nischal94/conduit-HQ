import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchToolsList, MAX_RESPONSE_BYTES, MAX_TOOLS } from "./mcp-fetch.js";

/**
 * Fix 1 (P1): a hostile upstream must not be able to force unbounded memory
 * use or unbounded provisioning work via `tools/list`. Both caps
 * (MAX_RESPONSE_BYTES, MAX_TOOLS) are exercised against a real loopback HTTP
 * server so the response actually flows through `fetch` and the streaming
 * reader — including proof of EARLY CANCELLATION: the connection is torn
 * down near the cap, not after the whole body has been buffered.
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
  it("cancels a chunked no-Content-Length stream near the cap — bounded ingestion, not buffer-then-check", async () => {
    // A hostile upstream streaming a 50MB body in 64KB chunks with NO
    // Content-Length header (chunked transfer encoding). The cap must fire
    // DURING ingestion: fetchToolsList rejects AND the server observes the
    // connection torn down long before the full body is written — proving
    // the reader was cancelled near MAX_RESPONSE_BYTES rather than the
    // whole 50MB being buffered and only then measured.
    const chunk = Buffer.alloc(64 * 1024, "x");
    const totalBytes = 50 * 1024 * 1024;
    let bytesWritten = 0;
    const url = await startServer((_req, res) => {
      // No content-length: res.write with no length header → chunked.
      res.writeHead(200, { "content-type": "application/json" });
      const writeMore = (): void => {
        while (bytesWritten < totalBytes) {
          bytesWritten += chunk.byteLength;
          if (!res.write(chunk)) {
            res.once("drain", writeMore);
            return;
          }
        }
        res.end();
      };
      res.on("error", () => {}); // cancelled connection → expected ECONNRESET
      writeMore();
    });

    await expect(fetchToolsList(url)).rejects.toThrow(
      /\[conduit add-mcp\].*exceeds the .*-byte cap/,
    );

    // The server must have sent FAR less than the 50MB total. 2× the cap
    // allows slack for socket/undici buffers between "client cancelled"
    // and "server noticed".
    expect(bytesWritten).toBeLessThan(2 * MAX_RESPONSE_BYTES);
    expect(bytesWritten).toBeLessThan(totalBytes);
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
