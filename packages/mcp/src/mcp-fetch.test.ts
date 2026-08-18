import { lookup as lookupCb } from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpClientError } from "@conduithq/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchToolsList, MAX_RESPONSE_BYTES, MAX_TOOLS } from "./mcp-fetch.js";

// The sdk's `createPinnedLookup` calls the callback-form `dns.lookup`; the
// built sdk bundle imports it as bare "dns". Wrapping that one export in a spy
// (delegating to the real resolver) lets the pinning test observe the seam
// end-to-end without changing any behavior.
vi.mock("dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return { ...actual, default: actual, lookup: vi.fn(actual.lookup) };
});

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

  it("still resolves the tools when the session-teardown DELETE fails (500)", async () => {
    // The tools are already in hand once tools/list returns; the best-effort
    // DELETE teardown (mcp-fetch.ts's `.catch(() => {})`) must not turn an
    // otherwise-good onboarding fetch into a failure. This pins that swallow:
    // the fixture answers the DELETE with a 500, and fetchToolsList still
    // resolves the tools list.
    const tools = [{ name: "ok_tool", inputSchema: { type: "object" } }];
    const sessionId = "sess-mcp-fetch-delete-500";
    const url = await startServer((req, res) => {
      if (req.method === "DELETE") {
        sendJson(res, 500, { error: "teardown boom" });
        return;
      }
      void readBody(req).then(({ id, method }) => {
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
          sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools } });
          return;
        }
        sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
      });
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

describe("fetchToolsList — §9.3 pinned egress (design §18-C4 D2, §3.3.1)", () => {
  it("resolves the onboarding host through the PINNED lookup, not the socket's own DNS", async () => {
    // The pinning guarantee is that the address the §9.3 guard vetted IS the
    // address connected to — which only holds if a pinned `lookup` is actually
    // handed to the request. `createPinnedLookup` always resolves with
    // `all: true` (so every candidate address is vetted) regardless of what the
    // socket asked for; observing that call shape at the dns seam is therefore
    // proof the pinned lookup ran, and not node's default resolution path.
    const tools = [{ name: "ok_tool", inputSchema: { type: "object" } }];
    const spy = vi.mocked(lookupCb);
    spy.mockClear();
    const url = await startHandshakeServer((res, id) => {
      sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools } });
    });
    // A hostname, not a literal: an IP literal never reaches dns.lookup at all,
    // so it could not distinguish a pinned path from an unpinned one.
    const hostUrl = url.replace("127.0.0.1", "localhost");

    const result = await fetchToolsList(hostUrl);

    expect(result).toEqual(tools);
    const pinnedCalls = spy.mock.calls.filter(
      ([host, opts]) =>
        host === "localhost" &&
        typeof opts === "object" &&
        opts !== null &&
        (opts as { all?: boolean }).all === true,
    );
    expect(pinnedCalls.length).toBeGreaterThan(0);
  });

  it("allowPrivate keeps a loopback upstream reachable — the filter is waived, the pinning is not", async () => {
    // §18-C4 D2: `add-mcp` passes `allowPrivate: true`, because a local MCP
    // server is a legitimate onboarding target. Without the waiver the pinned
    // lookup would fail closed on `localhost` (every resolved address private)
    // and onboarding a loopback upstream would be impossible. This pins the
    // waiver as deliberate, so a future tightening cannot silently break it.
    const tools = [{ name: "ok_tool", inputSchema: { type: "object" } }];
    const url = await startHandshakeServer((res, id) => {
      sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools } });
    });

    const result = await fetchToolsList(url.replace("127.0.0.1", "localhost"));

    expect(result).toEqual(tools);
  });
});
