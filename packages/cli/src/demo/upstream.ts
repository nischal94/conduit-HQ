// packages/cli/src/demo/upstream.ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const DEMO_NAMESPACE = "demo";
export const DEMO_TOOL = "create_note";

export interface DemoUpstreamCall {
  name: string;
  arguments: unknown;
}

export interface DemoUpstream {
  url: string;
  calls: readonly DemoUpstreamCall[];
  close(): Promise<void>;
}

/**
 * No annotations by default: an unannotated tool classifies as `review`,
 * and `review` requires approval under the default policy. The demo's
 * pause depends on that default, and `runDemo` fails loudly if it changes.
 * `readOnly` exists only so a test can make the real policy auto-allow.
 */
function toolsFor(readOnly: boolean): unknown[] {
  return [
    {
      name: DEMO_TOOL,
      description: "Create a note. Demo upstream: it records every call it receives.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
    },
  ];
}

const MAX_BODY_BYTES = 64 * 1024;

interface RpcPayload {
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: unknown };
}

export function startDemoUpstream(opts: { readOnly?: boolean } = {}): Promise<DemoUpstream> {
  const calls: DemoUpstreamCall[] = [];
  const tools = toolsFor(opts.readOnly === true);
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        res.writeHead(400);
        res.end();
        return;
      }
      const payload = parsed as RpcPayload;
      const reply = (result: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
      };
      switch (payload.method) {
        case "initialize":
          reply(
            {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "conduit-demo-upstream", version: "0" },
            },
            { "mcp-session-id": "conduit-demo" },
          );
          return;
        case "notifications/initialized":
          res.writeHead(202);
          res.end();
          return;
        case "tools/list":
          reply({ tools });
          return;
        case "tools/call":
          calls.push({ name: payload.params?.name ?? "", arguments: payload.params?.arguments });
          reply({ content: [{ type: "text", text: "note created" }] });
          return;
        default:
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              error: { code: -32601, message: "Method not found" },
            }),
          );
      }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
