import { lookup as lookupCb } from "node:dns";
import { lookup as lookupPromises } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Source, Tool } from "../types.js";
import { GUEST_ERROR_NAMES } from "./errors.js";
import { createMcpUpstreamCaller } from "./upstream.js";

// Real by default; the rebinding test overrides both DNS entry points to make
// the pre-flight (node:dns/promises) and the pinned lookup (node:dns) disagree.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

const SECRET = "Bearer ghp_upstream_secret_1a2b";

const tool: Tool = {
  name: "github.list_issues",
  namespace: "github",
  inputSchema: { type: "object" },
  outputSchema: {},
  riskClass: "safe",
  sourceSemantics: { kind: "mcp", readOnlyHint: true },
};

function sourceAt(port: number): Source {
  return {
    id: "src_gh",
    type: "mcp",
    namespace: "github",
    location: `http://127.0.0.1:${port}/mcp`,
  };
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: string;
}

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(
    servers.map((server) => {
      server.closeAllConnections(); // the slow-loris server never ends its response
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

/** Local MCP stand-in: records every request, delegates the response. */
async function serve(
  handler: (request: RecordedRequest, res: ServerResponse) => void,
): Promise<{ port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const recorded: RecordedRequest = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

function jsonRpcResult(res: ServerResponse, result: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result }));
}

const caller = createMcpUpstreamCaller({ egress: { allowPrivate: true } });

describe("MCP upstream caller (spec §5.3 step 4)", () => {
  it("POSTs JSON-RPC tools/call with the prefix-stripped tool name and auth header", async () => {
    const mcpResult = { content: [{ type: "text", text: "3 issues" }] };
    const { port, requests } = await serve((_request, res) => jsonRpcResult(res, mcpResult));

    const outcome = await caller.call({
      tool,
      source: sourceAt(port),
      input: { owner: "acme", repo: "site" },
      auth: { headers: { Authorization: SECRET } },
      timeoutMs: 2_000,
    });

    expect(outcome.result).toEqual(mcpResult);
    expect(outcome.status).toBe(200);
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.headers.authorization).toBe(SECRET);
    expect(request?.headers["content-type"]).toBe("application/json");
    const payload = JSON.parse(request?.body ?? "{}");
    expect(payload.method).toBe("tools/call");
    expect(payload.params).toEqual({
      name: "list_issues", // namespace prefix stripped (decision A5)
      arguments: { owner: "acme", repo: "site" },
    });
  });

  it("INVARIANT §9.3: the egress guard runs inside the caller (loopback blocked without the flag)", async () => {
    const { port, requests } = await serve((_request, res) => jsonRpcResult(res, {}));
    const guarded = createMcpUpstreamCaller();

    await expect(
      guarded.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: {} },
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/loopback\/private egress/);
    expect(requests).toHaveLength(0); // blocked before any bytes left the host
  });

  it("INVARIANT §9.3: the pinned lookup blocks a hostname that rebinds public→private at connect time", async () => {
    // The authoritative TOCTOU-free path, end-to-end through the caller: the
    // pre-flight (node:dns/promises) sees a PUBLIC address and passes, but the
    // connect-time pinned lookup (node:dns) resolves the same host to a PRIVATE
    // address — the classic DNS-rebinding window. The pinned lookup must fail
    // closed so no socket ever connects to the private address.
    const { port, requests } = await serve((_request, res) => jsonRpcResult(res, {}));
    const rebindSource: Source = {
      id: "src_rebind",
      type: "mcp",
      namespace: "github",
      location: `http://rebind.example:${port}/mcp`,
    };
    // Pre-flight resolves public → passes.
    vi.mocked(lookupPromises).mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
    ] as never);
    // Connect-time pinned lookup resolves private → must be refused.
    vi.mocked(lookupCb).mockImplementationOnce(((_host: string, _opts: unknown, cb: unknown) => {
      (cb as (e: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void)(
        null,
        [{ address: "127.0.0.1", family: 4 }],
      );
    }) as never);

    await expect(
      createMcpUpstreamCaller().call({
        tool,
        source: rebindSource,
        input: {},
        auth: { headers: {} },
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/loopback\/private/);
    expect(requests).toHaveLength(0); // the socket never reached the server
  });

  it("refuses redirects (3xx → ConduitUpstreamError, no second request)", async () => {
    const { port, requests } = await serve((_request, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" });
      res.end();
    });

    const attempt = caller.call({
      tool,
      source: sourceAt(port),
      input: {},
      auth: { headers: { Authorization: SECRET } },
      timeoutMs: 2_000,
    });
    await expect(attempt).rejects.toThrow(/redirect refused/i);
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream });
    expect(requests).toHaveLength(1); // the redirect target was never followed
  });

  it("times out via AbortSignal and surfaces ConduitUpstreamError", async () => {
    const { port } = await serve((_request, res) => {
      setTimeout(() => jsonRpcResult(res, {}), 1_000);
    });

    const attempt = caller.call({
      tool,
      source: sourceAt(port),
      input: {},
      auth: { headers: {} },
      timeoutMs: 50,
    });
    await expect(attempt).rejects.toThrow(/timed out after 50ms/);
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream });
  });

  it("rejects non-JSON content types, naming the type", async () => {
    const { port } = await serve((_request, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>surprise</html>");
    });

    await expect(
      caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: {} },
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/non-JSON response.*text\/html/s);
  });

  it("caps the streamed response body at maxResponseBytes even when content-length lies", async () => {
    // Chunked transfer: no content-length at all — the cap must count bytes
    // off the wire, not trust any header.
    const { port } = await serve((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"jsonrpc":"2.0","id":"1","result":"');
      res.write("x".repeat(8 * 1024));
      res.end('"}');
    });
    const capped = createMcpUpstreamCaller({
      maxResponseBytes: 1024,
      egress: { allowPrivate: true },
    });

    const attempt = capped.call({
      tool,
      source: sourceAt(port),
      input: {},
      auth: { headers: {} },
      timeoutMs: 2_000,
    });
    await expect(attempt).rejects.toThrow(/size cap/);
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream });
  });

  it("rejects a well-formed but non-JSON-RPC 200 body (no result, no error)", async () => {
    for (const shape of ["42", "[]", "{}", "null", '"ok"']) {
      const { port } = await serve((_request, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(shape);
      });
      const attempt = caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: {} },
        timeoutMs: 2_000,
      });
      // Never a { result: null } success, never a raw TypeError-as-infra.
      await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream });
    }
  });

  it("treats a null JSON-RPC error as no error, then requires a result", async () => {
    const { port } = await serve((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "1", error: null }));
    });
    await expect(
      caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: {} },
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/neither a result nor an error/);
  });

  it("redacts a bare-token echo through sanitizeUpstreamText (secret without its Bearer scheme)", async () => {
    const bareToken = SECRET.split(" ")[1] ?? SECRET;
    const { port } = await serve((_request, res) => {
      // Non-JSON content type carrying the bare token → sanitizer runs on it.
      res.writeHead(200, { "content-type": `text/plain; token=${bareToken}` });
      res.end("nope");
    });
    let thrown: unknown;
    try {
      await caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: { Authorization: SECRET } },
        timeoutMs: 2_000,
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error;
    expect(error.message).toMatch(/non-JSON response/);
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(bareToken);
  });

  it("maps JSON-RPC error objects to ConduitUpstreamError", async () => {
    const { port } = await serve((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          error: { code: -32602, message: "Invalid params" },
        }),
      );
    });

    const attempt = caller.call({
      tool,
      source: sourceAt(port),
      input: {},
      auth: { headers: {} },
      timeoutMs: 2_000,
    });
    await expect(attempt).rejects.toThrow(/Invalid params/);
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream });
  });

  it("redacts auth echoed through a JSON-RPC error message (hostile 200 response)", async () => {
    // Card-09, one branch over from the 401 case: the upstream echoes the
    // Authorization header inside a well-formed JSON-RPC error object.
    const { port } = await serve((request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          error: { code: -32000, message: `denied for ${request.headers.authorization}` },
        }),
      );
    });

    let thrown: unknown;
    try {
      await caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: { Authorization: SECRET } },
        timeoutMs: 2_000,
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error;
    expect(error.name).toBe(GUEST_ERROR_NAMES.upstream);
    // The full-body credential scan fires first and fails the call closed —
    // stronger than redact-and-deliver. The secret reaches nothing.
    expect(error.message).toMatch(/echoed the connection's credential/);
    expect(error.message).not.toContain(SECRET);
  });

  it("redacts auth echoed through the content-type header", async () => {
    const { port } = await serve((request, res) => {
      res.writeHead(200, { "content-type": String(request.headers.authorization) });
      res.end("{}");
    });

    let thrown: unknown;
    try {
      await caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: { Authorization: SECRET } },
        timeoutMs: 2_000,
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error;
    expect(error.name).toBe(GUEST_ERROR_NAMES.upstream);
    expect(error.message).toMatch(/non-JSON response/);
    expect(error.message).not.toContain(SECRET);
  });

  it("classifies a timeout during body streaming as upstream (slow-loris after headers)", async () => {
    // Headers arrive fast; the body trickles past the AbortSignal deadline.
    const { port } = await serve((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"jsonrpc":'); // never ends
    });

    const attempt = caller.call({
      tool,
      source: sourceAt(port),
      input: {},
      auth: { headers: {} },
      timeoutMs: 50,
    });
    await expect(attempt).rejects.toThrow(/timed out after 50ms while reading the response/);
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream });
  });

  it("INVARIANT §9.2: a 200 result echoing the credential is refused, not delivered", async () => {
    // The success-path twin of the hostile-echo cases: a compromised or
    // header-reflecting upstream returns the Authorization header inside a
    // well-formed result. Delivering it would put the secret in the sandbox
    // heap, the journal, and Trace — the call must fail closed instead.
    const { port } = await serve((request, res) =>
      jsonRpcResult(res, { echoed: request.headers.authorization }),
    );

    let thrown: unknown;
    try {
      await caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: { Authorization: SECRET } },
        timeoutMs: 2_000,
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error;
    expect(error.name).toBe(GUEST_ERROR_NAMES.upstream);
    expect(error.message).toMatch(/echoed the connection's credential/);
    expect(error.message).not.toContain(SECRET);
  });

  it("INVARIANT §9.2: refuses a JSON-escaped credential echo (raw-bytes scan bypass)", async () => {
    // Adversarial (codex): a hostile server JSON-escapes the credential so
    // the raw wire bytes miss the token, but JSON.parse decodes it to
    // plaintext. The scan must run on the parsed structure, not the body.
    const escaped = SECRET.replace(/_/g, "\\u005f"); // Bearer ghp_...
    const { port } = await serve((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"jsonrpc":"2.0","id":"1","result":{"text":"${escaped}"}}`);
    });

    let thrown: unknown;
    try {
      await caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: { Authorization: SECRET } },
        timeoutMs: 2_000,
      });
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error;
    expect(error.name).toBe(GUEST_ERROR_NAMES.upstream);
    expect(error.message).toMatch(/echoed the connection's credential/);
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain("ghp_invoker_secret");
  });

  it("INVARIANT §9.2: refuses a short bare-token echo below the old 8-char floor (codex re-pass)", async () => {
    // Adversarial (codex): a 7-char token echoed alone slipped the >=8 segment
    // floor. The floor is now 5 (scheme words excluded), so a short bare token
    // is caught.
    const shortSecret = "Bearer abc1234"; // bare token is 7 chars
    const { port } = await serve((_request, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { token: "abc1234" } }));
    });
    await expect(
      caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: { Authorization: shortSecret } },
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/echoed the connection's credential/);
  });

  it("does not treat the auth scheme word alone as a credential (no over-redaction)", async () => {
    // "Bearer" appearing in benign response text must not trip the scan.
    const { port } = await serve((_request, res) =>
      jsonRpcResult(res, { note: "Use a Bearer token to authenticate." }),
    );
    const outcome = await caller.call({
      tool,
      source: sourceAt(port),
      input: {},
      auth: { headers: { Authorization: "Bearer ghp_long_enough_secret_9z" } },
      timeoutMs: 2_000,
    });
    expect(outcome.result).toEqual({ note: "Use a Bearer token to authenticate." });
  });

  it("never serializes auth headers into the thrown error", async () => {
    // Hostile upstream: echoes the Authorization header back in a 401 body.
    const { port } = await serve((request, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ echo: request.headers.authorization }));
    });

    let thrown: unknown;
    try {
      await caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: { Authorization: SECRET } },
        timeoutMs: 2_000,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.name).toBe(GUEST_ERROR_NAMES.upstream);
    expect(error.message).toContain("401");
    expect(
      JSON.stringify({ name: error.name, message: error.message, stack: error.stack }),
    ).not.toContain(SECRET);
  });
});
