import { lookup as lookupCb } from "node:dns";
import { lookup as lookupPromises } from "node:dns/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { normalizeMcp } from "../normalize/mcp.js";
import { SecretBox } from "../secrets.js";
import { openSqliteStore } from "../store/sqlite.js";
import type { Source, Tool } from "../types.js";
import { GUEST_ERROR_NAMES } from "./errors.js";
import { createMcpUpstreamCaller } from "./upstream.js";
import { createUpstreamSessionScope } from "./upstream-session.js";

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

const NEGOTIATED_VERSION = "2025-06-18";
const SESSION_ID = "sess-upstream-1";

/**
 * Streamable-HTTP MCP fixture. Owns the handshake bookkeeping — replies to
 * `initialize` (200 + session id + capabilities.tools + negotiated version)
 * and to `notifications/initialized` (202, empty body) — and delegates only
 * the `tools/call` request to the test's `onCall(request, res, parsed)`
 * handler, which sends the tools/call response however the test needs.
 *
 * `sessionless: true` suppresses the Mcp-Session-Id header (a stateless
 * streamable-HTTP server); the handshake still succeeds without a session id.
 */
function createStreamableFixture(
  onCall: (request: RecordedRequest, res: ServerResponse, parsed: { id: string }) => void,
  opts: { sessionless?: boolean } = {},
): (request: RecordedRequest, res: ServerResponse) => void {
  return (request, res) => {
    const parsed = JSON.parse(request.body || "{}") as { id?: string; method?: string };
    if (parsed.method === "initialize") {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.sessionless !== true) {
        headers["mcp-session-id"] = SESSION_ID;
      }
      res.writeHead(200, headers);
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
    // tools/call (or anything else the test drives) → the test's handler.
    onCall(request, res, { id: parsed.id ?? "1" });
  };
}

/** Convenience: a fixture whose tools/call replies with `result` as JSON-RPC. */
function respondingFixture(
  result: unknown,
  opts: { sessionless?: boolean } = {},
): (request: RecordedRequest, res: ServerResponse) => void {
  return createStreamableFixture((_request, res, parsed) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
  }, opts);
}

/** The tools/call request among all recorded requests (skips the handshake pair). */
function toolsCallRequest(requests: RecordedRequest[]): RecordedRequest | undefined {
  return requests.find((r) => {
    try {
      return (JSON.parse(r.body || "{}") as { method?: string }).method === "tools/call";
    } catch {
      return false;
    }
  });
}

const caller = createMcpUpstreamCaller({ egress: { allowPrivate: true } });

describe("MCP upstream caller (spec §5.3 step 4)", () => {
  it("POSTs JSON-RPC tools/call with the prefix-stripped tool name and auth header", async () => {
    const mcpResult = { content: [{ type: "text", text: "3 issues" }] };
    const { port, requests } = await serve(respondingFixture(mcpResult));

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

    const call = toolsCallRequest(requests);
    expect(call).toBeDefined();
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe(SECRET);
    expect(call?.headers["content-type"]).toBe("application/json");
    // Handshake carried the auth header too (session established under it).
    expect(requests[0]?.headers.authorization).toBe(SECRET);
    const payload = JSON.parse(call?.body ?? "{}");
    expect(payload.method).toBe("tools/call");
    expect(payload.params).toEqual({
      name: "list_issues", // namespace prefix stripped (decision A5)
      arguments: { owner: "acme", repo: "site" },
    });
  });

  it("accepts an SSE-framed tools/call response (streamable HTTP)", async () => {
    const mcpResult = { content: [{ type: "text", text: "via SSE" }] };
    const { port } = await serve(
      createStreamableFixture((_request, res, parsed) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: mcpResult })}\n\n`,
        );
      }),
    );

    const outcome = await caller.call({
      tool,
      source: sourceAt(port),
      input: {},
      auth: { headers: { Authorization: SECRET } },
      timeoutMs: 2_000,
    });
    expect(outcome.result).toEqual(mcpResult);
    expect(outcome.status).toBe(200);
  });

  it("INVARIANT §9.3: the egress guard runs inside the caller (loopback blocked without the flag)", async () => {
    const { port, requests } = await serve(respondingFixture({}));
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
    const { port, requests } = await serve(respondingFixture({}));
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

  it("refuses redirects (3xx → ConduitUpstreamError, no tools/call)", async () => {
    // The redirect fires on the handshake's very first POST (initialize); the
    // whole logical operation is refused before any tools/call is attempted.
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
    expect(toolsCallRequest(requests)).toBeUndefined(); // never followed, never called
  });

  it("times out and surfaces ConduitUpstreamError", async () => {
    // The handshake completes fast; the tools/call response stalls past the
    // shared budget.
    const { port } = await serve(
      createStreamableFixture((_request, res, parsed) => {
        setTimeout(
          () => res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: {} })),
          1_000,
        );
      }),
    );

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

  it("rejects a text/plain content type on tools/call (SSE accepted, text/plain refused)", async () => {
    const { port } = await serve(
      createStreamableFixture((_request, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("surprise");
      }),
    );

    await expect(
      caller.call({
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: {} },
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/unsupported content-type.*text\/plain/s);
  });

  it("caps the streamed response body at maxResponseBytes even when content-length lies", async () => {
    // Chunked transfer: no content-length at all — the cap must count bytes
    // off the wire, not trust any header. The oversized body arrives on the
    // tools/call response.
    const { port } = await serve(
      createStreamableFixture((_request, res, parsed) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write(`{"jsonrpc":"2.0","id":"${parsed.id}","result":"`);
        res.write("x".repeat(8 * 1024));
        res.end('"}');
      }),
    );
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

  it("maps a JSON-RPC error member on tools/call to ConduitUpstreamError", async () => {
    const { port } = await serve(
      createStreamableFixture((_request, res, parsed) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32602, message: "Invalid params" },
          }),
        );
      }),
    );

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

  it("redacts auth echoed through a JSON-RPC error message (hostile tools/call response)", async () => {
    // The upstream echoes the Authorization header inside a well-formed
    // JSON-RPC error object on tools/call.
    const { port } = await serve(
      createStreamableFixture((request, res, parsed) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32000, message: `denied for ${request.headers.authorization}` },
          }),
        );
      }),
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
    expect(error.message).not.toContain(SECRET);
  });

  it("classifies a timeout during body streaming as upstream (slow-loris after headers)", async () => {
    // The tools/call headers arrive fast; the body trickles past the deadline.
    const { port } = await serve(
      createStreamableFixture((_request, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"jsonrpc":'); // never ends
      }),
    );

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

  it("INVARIANT §9.2: a 200 result echoing the credential is refused, not delivered", async () => {
    // The success-path twin of the hostile-echo cases: a compromised or
    // header-reflecting upstream returns the Authorization header inside a
    // well-formed result. Delivering it would put the secret in the sandbox
    // heap, the journal, and Trace — the call must fail closed instead.
    const { port } = await serve(
      createStreamableFixture((request, res, parsed) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: { echoed: request.headers.authorization },
          }),
        );
      }),
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
    const { port } = await serve(
      createStreamableFixture((_request, res, parsed) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"jsonrpc":"2.0","id":"${parsed.id}","result":{"text":"${escaped}"}}`);
      }),
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
    expect(JSON.stringify(error)).not.toContain("ghp_invoker_secret");
  });

  it("INVARIANT §9.2: refuses a short bare-token echo below the old 8-char floor (codex re-pass)", async () => {
    // Adversarial (codex): a 7-char token echoed alone slipped the >=8 segment
    // floor. The floor is now 5 (scheme words excluded), so a short bare token
    // is caught.
    const shortSecret = "Bearer abc1234"; // bare token is 7 chars
    const { port } = await serve(respondingFixture({ token: "abc1234" }));
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
    const { port } = await serve(
      respondingFixture({ note: "Use a Bearer token to authenticate." }),
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

  it("never serializes auth headers into the thrown error (hostile HTTP-error body)", async () => {
    // Hostile upstream: the tools/call POST returns a 500 echoing the
    // Authorization header in the body. The body never reaches the error.
    const { port } = await serve(
      createStreamableFixture((request, res) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ echo: request.headers.authorization }));
      }),
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
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.name).toBe(GUEST_ERROR_NAMES.upstream);
    expect(error.message).toContain("500");
    expect(
      JSON.stringify({ name: error.name, message: error.message, stack: error.stack }),
    ).not.toContain(SECRET);
  });

  it("uses a caller-supplied session scope when provided (no ephemeral handshake per call)", async () => {
    // With a shared scope, two calls to the same url+auth handshake ONCE.
    const { port, requests } = await serve(respondingFixture({ ok: true }));
    const scope = createUpstreamSessionScope();
    try {
      const req = {
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: { Authorization: SECRET } },
        timeoutMs: 2_000,
        session: scope,
      };
      await caller.call(req);
      await caller.call(req);
    } finally {
      await scope.dispose();
    }
    const initializeCount = requests.filter((r) => {
      try {
        return (JSON.parse(r.body || "{}") as { method?: string }).method === "initialize";
      } catch {
        return false;
      }
    }).length;
    expect(initializeCount).toBe(1); // single shared handshake across both calls
  });

  it("INVARIANT §18-C4: chained calls in one drive each get a fresh per-call budget while reusing the session", async () => {
    // Two sequential calls share ONE scope (session reused, initialize once),
    // but each must run under its OWN F1 budget — a fresh deadline AND a fresh
    // cumulative byte allowance. Before the fix, the cached handshake client
    // (bound to call #1's budget) was used for every call, so call #2 inherited
    // call #1's already-elapsed deadline (→ spurious timeout) and drained the
    // same 1 MiB byte counter (→ spurious cap). Both sides are exercised here.

    // (b) Byte side: shrink the cap so each response is well under one budget
    // but two together exceed a SINGLE budget. With a fresh per-call byte
    // allowance, neither call breaches; with the stale shared client, call #2's
    // bytes push the shared counter negative → a cap error.
    const bodyPadding = "x".repeat(4096);
    const { port, requests } = await serve(respondingFixture({ pad: bodyPadding }));
    // Cap just above one response (handshake + one tools/call body), far below
    // two. 6 KiB comfortably fits one ~4 KiB response but not two.
    const budgetCaller = createMcpUpstreamCaller({
      egress: { allowPrivate: true },
      maxResponseBytes: 6 * 1024,
    });
    const scope = createUpstreamSessionScope();
    try {
      const req = {
        tool,
        source: sourceAt(port),
        input: {},
        auth: { headers: { Authorization: SECRET } },
        // (a) Deadline side: a small per-call budget. The gap between the two
        // calls (below) exceeds it, so call #2 under the STALE cached budget
        // sees deadline() <= 0 and fails immediately; under a FRESH per-call
        // budget it has the full window again.
        timeoutMs: 150,
        session: scope,
      };
      const first = await budgetCaller.call(req);
      expect(first.result).toEqual({ pad: bodyPadding });

      // Elapse the whole of call #1's budget window before call #2 starts.
      await new Promise((r) => setTimeout(r, 200));

      // With the fix: fresh deadline + fresh byte allowance → success, and the
      // session is still reused (no second handshake).
      const second = await budgetCaller.call(req);
      expect(second.result).toEqual({ pad: bodyPadding });
      expect(second.status).toBe(200);
    } finally {
      await scope.dispose();
    }

    const initializeCount = requests.filter((r) => {
      try {
        return (JSON.parse(r.body || "{}") as { method?: string }).method === "initialize";
      } catch {
        return false;
      }
    }).length;
    expect(initializeCount).toBe(1); // session reused across both calls
  });
});

describe("INVARIANT §18-C5: the stored upstream name is sent on the wire", () => {
  async function openStore() {
    return openSqliteStore({
      client: createClient({ url: ":memory:" }),
      secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
    });
  }

  it("sends a hyphenated upstreamName from sourceSemantics, hydrated through the store", async () => {
    // The full C5 chain: normalize a hyphenated upstream tool → persist via the
    // store → read it back (source_semantics JSON round-trip) → hand the
    // HYDRATED tool to the caller → the raw hyphenated name lands on the wire.
    const store = await openStore();
    const normalized = normalizeMcp({
      namespace: "context7",
      tools: [{ name: "resolve-library-id", inputSchema: { type: "object" } }],
    });
    await store.tools.replaceNamespace("context7", normalized);
    const hydrated = await store.tools.get("context7.resolve_library_id");
    expect(hydrated).toBeDefined();
    // Sanity: the round-trip preserved the raw wire name.
    expect(hydrated?.sourceSemantics).toMatchObject({
      kind: "mcp",
      upstreamName: "resolve-library-id",
    });

    const { port, requests } = await serve(respondingFixture({ content: [] }));
    await caller.call({
      tool: hydrated as Tool,
      source: {
        id: "src_c7",
        type: "mcp",
        namespace: "context7",
        location: `http://127.0.0.1:${port}/mcp`,
      },
      input: {},
      auth: { headers: {} },
      timeoutMs: 2_000,
    });

    const call = toolsCallRequest(requests);
    const payload = JSON.parse(call?.body ?? "{}");
    // The hyphen survived — NOT the qualified name, NOT the underscore rewrite.
    expect(payload.params.name).toBe("resolve-library-id");
  });

  it("falls back to prefix-strip for a legacy row whose source_semantics lacks upstreamName", async () => {
    // A pre-C5 stored tool: source_semantics JSON has no upstreamName. Serve-time
    // must fall back to today's prefix-strip (D4 documented-lossy).
    const store = await openStore();
    // A tool object without upstreamName → the stored JSON lacks the field.
    const legacyTool: Tool = {
      name: "context7.get_docs",
      namespace: "context7",
      inputSchema: { type: "object" },
      outputSchema: {},
      riskClass: "safe",
      sourceSemantics: { kind: "mcp", readOnlyHint: true },
    };
    await store.tools.replaceNamespace("context7", [legacyTool]);
    const hydrated = await store.tools.get("context7.get_docs");
    expect(hydrated).toBeDefined();
    expect((hydrated?.sourceSemantics as { upstreamName?: string }).upstreamName).toBeUndefined();

    const { port, requests } = await serve(respondingFixture({ content: [] }));
    await caller.call({
      tool: hydrated as Tool,
      source: {
        id: "src_c7",
        type: "mcp",
        namespace: "context7",
        location: `http://127.0.0.1:${port}/mcp`,
      },
      input: {},
      auth: { headers: {} },
      timeoutMs: 2_000,
    });

    const call = toolsCallRequest(requests);
    const payload = JSON.parse(call?.body ?? "{}");
    expect(payload.params.name).toBe("get_docs"); // namespace prefix stripped
  });
});

describe("INVARIANT F1: handshake + call share request.timeoutMs", () => {
  it("times out during the handshake before any tools/call is sent", async () => {
    // The whole logical operation (handshake + call + one retry) shares the
    // single request.timeoutMs. If initialize stalls past the budget, the call
    // times out and tools/call is never reached.
    const { port, requests } = await serve((request, res) => {
      const parsed = JSON.parse(request.body || "{}") as { method?: string };
      if (parsed.method === "initialize") {
        // Stall the handshake forever — the shared budget must fire.
        return;
      }
      res.writeHead(202);
      res.end();
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
    expect(toolsCallRequest(requests)).toBeUndefined(); // never reached tools/call
  });
});
