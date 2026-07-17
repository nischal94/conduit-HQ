import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpClientError } from "@conduithq/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { fetchToolsList, MAX_RESPONSE_BYTES, MAX_TOOLS } from "./mcp-fetch.js";

/**
 * Fix 1 (P1): a hostile upstream must not be able to force unbounded memory
 * use or unbounded provisioning work via `tools/list`. Both caps
 * (MAX_RESPONSE_BYTES, MAX_TOOLS) are exercised against a real loopback HTTP
 * server so the response actually flows through the shared streamable-HTTP
 * client and its capped reader — including proof of EARLY CANCELLATION: the
 * connection is torn down near the cap, not after the whole body is buffered.
 *
 * The fixture servers now speak the same minimal streamable-HTTP handshake
 * (`initialize` / `notifications/initialized` / `tools/list`) the real client
 * (packages/sdk/src/pipeline/mcp-client.ts) drives — `scripts/token-demo-
 * upstream.mjs` is the reference shape. The cap tests' MEANING is unchanged:
 * an oversized-declared body, a streamed overrun, and an over-count tool
 * list all fail loud; the caps now fire on the tools/list RESPONSE inside the
 * handshake rather than a bare single POST.
 */

const PROTOCOL_VERSION = "2025-06-18";

let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve) => {
    server?.listen(0, "127.0.0.1", () => {
      const port = (server?.address() as AddressInfo).port;
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

function readBody(req: IncomingMessage): Promise<{ id: unknown; method?: string }> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(raw);
        resolve({ id: parsed?.id ?? null, method: parsed?.method });
      } catch {
        resolve({ id: null });
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, sessionId?: string): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sessionId !== undefined) {
    headers["Mcp-Session-Id"] = sessionId;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/**
 * A minimal handshake-capable fixture. `onToolsList` renders the tools/list
 * HTTP response directly (so a test can stream an oversized body, declare a
 * huge Content-Length, or emit an over-count array). Everything before
 * tools/list is the standard streamable-HTTP handshake.
 */
function startHandshakeServer(
  onToolsList: (res: ServerResponse, id: unknown) => void,
  opts: { onAuth?: (authorization: string | undefined) => void } = {},
): Promise<string> {
  const sessionId = "sess-mcp-fetch-test";
  return startServer((req, res) => {
    void readBody(req).then(({ id, method }) => {
      opts.onAuth?.(
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      );
      if (method === "initialize") {
        sendJson(
          res,
          200,
          {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "0.1.0" },
            },
          },
          sessionId,
        );
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (method === "tools/list") {
        onToolsList(res, id);
        return;
      }
      sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
    });
  });
}

describe("fetchToolsList — hostile-upstream caps", () => {
  it("cancels a chunked no-Content-Length stream near the cap — bounded ingestion, not buffer-then-check", async () => {
    // A hostile upstream streaming a 50MB tools/list body in 64KB chunks with
    // NO Content-Length header (chunked). The cap must fire DURING ingestion:
    // fetchToolsList rejects AND the server observes the connection torn down
    // long before the full body is written — proving the reader early-stopped
    // near MAX_RESPONSE_BYTES rather than buffering the whole 50MB.
    const chunk = Buffer.alloc(64 * 1024, "x");
    const totalBytes = 50 * 1024 * 1024;
    let bytesWritten = 0;
    const url = await startHandshakeServer((res) => {
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

    await expect(fetchToolsList(url)).rejects.toMatchObject({ kind: "cap" });

    // The server must have sent FAR less than the 50MB total. 2× the cap
    // allows slack for socket buffers between "client cancelled" and "server
    // noticed".
    expect(bytesWritten).toBeLessThan(2 * MAX_RESPONSE_BYTES);
    expect(bytesWritten).toBeLessThan(totalBytes);
  });

  it("rejects an over-cap tools/list body declared with a matching Content-Length", async () => {
    // An honest-Content-Length upstream whose tools/list body is genuinely
    // over the cap. The shared client's reader counts real bytes off the wire
    // (never trusting Content-Length to ADMIT a body) and fires the cap as the
    // oversized bytes arrive — preserving the old "declared-length reject"
    // meaning against the streaming-cap client.
    const overCap = Buffer.alloc(MAX_RESPONSE_BYTES + 64 * 1024, "x");
    const url = await startHandshakeServer((res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(overCap.byteLength),
      });
      res.on("error", () => {}); // cancelled connection → expected ECONNRESET
      res.end(overCap);
    });

    await expect(fetchToolsList(url)).rejects.toMatchObject({ kind: "cap" });
  });

  it("rejects a tools array longer than MAX_TOOLS", async () => {
    const tools = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => ({
      name: `tool_${i}`,
      inputSchema: { type: "object" },
    }));
    const url = await startHandshakeServer((res, id) => {
      sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools } });
    });

    await expect(fetchToolsList(url)).rejects.toThrow(McpClientError);
    await expect(fetchToolsList(url)).rejects.toMatchObject({ kind: "cap" });
  });

  it("accepts a response at or under both caps", async () => {
    const tools = [{ name: "ok_tool", inputSchema: { type: "object" } }];
    const url = await startHandshakeServer((res, id) => {
      sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools } });
    });

    const result = await fetchToolsList(url);

    expect(result).toEqual(tools);
  });
});

describe("fetchToolsList — onboarding auth", () => {
  it("sends the Authorization header on every request when provided", async () => {
    const tools = [{ name: "ok_tool", inputSchema: { type: "object" } }];
    const seen: (string | undefined)[] = [];
    const url = await startHandshakeServer(
      (res, id) => {
        sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools } });
      },
      {
        onAuth: (authorization) => {
          seen.push(authorization);
        },
      },
    );

    const result = await fetchToolsList(url, { authorization: "Bearer tok_onboard" });

    expect(result).toEqual(tools);
    // Initialize + initialized + tools/list all carried the header.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((h) => h === "Bearer tok_onboard")).toBe(true);
  });

  it("surfaces a 401 as McpClientError{kind:'http_status',status:401}", async () => {
    const url = await startServer((_req, res) => {
      // Reject at the handshake with a 401 — an unauthenticated onboarding
      // fetch against an auth-requiring upstream.
      sendJson(res, 401, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "unauthorized" },
      });
    });

    await expect(fetchToolsList(url)).rejects.toMatchObject({
      kind: "http_status",
      status: 401,
    });
  });
});
