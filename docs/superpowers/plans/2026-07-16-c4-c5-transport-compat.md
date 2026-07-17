# C4+C5 Upstream-Client Transport Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conduit can onboard and call real public MCP servers (Context7, GitHub) by speaking the MCP streamable-HTTP protocol — handshake, sessions, SSE framing, pagination, onboarding auth — and by storing the upstream tool name instead of deriving it.

**Architecture:** One hand-rolled minimal MCP client (`packages/sdk/src/pipeline/mcp-client.ts`) layered on the existing pinned-egress `node:http(s)` machinery, consumed by BOTH the serve-time upstream caller and the CLI onboarding fetch. Per-drive session scope threaded through `makeInvoker`. C5 rides in the already-persisted `sourceSemantics` JSON (no schema change).

**Tech Stack:** TypeScript/ESM, node:http(s) + node:crypto (no new dependencies), Vitest, zod (existing dep) for envelope validation.

**Authoritative design:** `docs/superpowers/specs/2026-07-16-c4-c5-transport-compat-design.md` (converged after a 4-pass codex cross-model review; D4 amended post-review). Where this plan and the design disagree, the design wins — STOP and flag it.

## Global Constraints

- ZERO new third-party dependencies. `node:crypto`, `node:http`, `node:https` only.
- Supported protocol versions, exactly: `"2025-06-18"`, `"2025-03-26"` (newest sent first; out-of-set counter-offer = handshake failure).
- Caller cap profiles are NOT unified: serve-time 1 MiB (`DEFAULT_MAX_RESPONSE_BYTES`, upstream.ts:40) + per-call `timeoutMs`; onboarding 5 MiB / 1,024 tools / 5s (`MAX_RESPONSE_BYTES`/`MAX_TOOLS`, mcp-fetch.ts). Changing ANY cap value is a STOP-and-ask design deviation.
- ONE logical-operation budget: a single absolute deadline + single cumulative byte counter across handshake + pagination + call + retry.
- ANY SQL schema change is a STOP-and-ask design deviation (D4 as amended needs none).
- `UpstreamCaller`'s public interface changes ONLY by adding the optional session scope to `UpstreamRequest`.
- Error text crossing to the agent stays ref-free and passes existing §9.2 sanitization (`sanitizeUpstreamText`).
- Invariant tests carry an `INVARIANT §…:` prefix in the test name and get a row in `INVARIANTS.md` in the same commit as the module they pin.
- Commit with the sandbox DISABLED (pre-commit hook needs mktemp + runs the full sdk suite); NEVER `--no-verify`. Do NOT use `git stash`.
- sdk tests: `cd packages/sdk && node_modules/.bin/vitest run <file>` (unsandboxed). After sdk source changes that mcp/cli consume: rebuild dist with `cd packages/sdk && node_modules/.bin/tsup`.
- Ship strategy: Tasks 1–8 are **Lane A** (one PR, full load-bearing gauntlet). Tasks 9–13 are **Lane B** (second PR on merged Lane A). Key rotation (delete `~/.conduit` demo db + key, mint fresh) is step 0 of Lane-B VERIFICATION, before any real PAT is stored.

---

### Task 1: SSE frame parser + JSON-RPC message correlation (pure functions)

**Files:**
- Create: `packages/sdk/src/pipeline/mcp-wire.ts`
- Test: `packages/sdk/src/pipeline/mcp-wire.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `createSseParser(): { push(chunk: string): string[]; flush(): string[] }` — incremental SSE parser; `push` returns the complete `data:` payloads terminated by a blank line inside this chunk (multi-`data:` lines per event joined with `\n`); `flush` returns a final unterminated payload if any.
  - `classifyJsonRpc(payload: string, expectedId: string, allowBatch: boolean): WireMessage[]` — parses one payload; returns `[{ kind: "response", message }]`, `[{ kind: "ping", id }]`, `[{ kind: "other" }]`, or several when `allowBatch` and the payload is an array; throws `Error` (message starts `malformed JSON-RPC payload`) on unparseable JSON or on an array when `allowBatch` is false.
  - `type WireMessage = { kind: "response"; message: { id: string; result?: unknown; error?: { code: number; message: string } } } | { kind: "ping"; id: string | number } | { kind: "other" }`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/sdk/src/pipeline/mcp-wire.test.ts
import { describe, expect, it } from "vitest";
import { classifyJsonRpc, createSseParser } from "./mcp-wire.js";

describe("createSseParser", () => {
  it("emits a data payload terminated by a blank line", () => {
    const p = createSseParser();
    expect(p.push('event: message\ndata: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });
  it("joins multi-data lines and handles chunk splits mid-line", () => {
    const p = createSseParser();
    expect(p.push("data: hel")).toEqual([]);
    expect(p.push("lo\ndata: world\n\n")).toEqual(["hello\nworld"]);
  });
  it("ignores comments, event names, id and retry fields", () => {
    const p = createSseParser();
    expect(p.push(': comment\nid: 7\nretry: 100\ndata: x\n\n')).toEqual(["x"]);
  });
  it("flush returns an unterminated trailing payload", () => {
    const p = createSseParser();
    p.push("data: tail");
    expect(p.flush()).toEqual(["tail"]);
  });
});

describe("classifyJsonRpc", () => {
  it("matches the response by id", () => {
    const [m] = classifyJsonRpc('{"jsonrpc":"2.0","id":"r1","result":{"ok":true}}', "r1", false);
    expect(m).toEqual({ kind: "response", message: { id: "r1", result: { ok: true } } });
  });
  it("classifies a server ping request", () => {
    const [m] = classifyJsonRpc('{"jsonrpc":"2.0","id":9,"method":"ping"}', "r1", false);
    expect(m).toEqual({ kind: "ping", id: 9 });
  });
  it("classifies notifications and unrelated responses as other", () => {
    expect(classifyJsonRpc('{"jsonrpc":"2.0","method":"notifications/progress"}', "r1", false)[0]).toEqual({ kind: "other" });
    expect(classifyJsonRpc('{"jsonrpc":"2.0","id":"zzz","result":1}', "r1", false)[0]).toEqual({ kind: "other" });
  });
  it("accepts batches only when allowed (2025-03-26)", () => {
    const batch = '[{"jsonrpc":"2.0","id":"r1","result":1},{"jsonrpc":"2.0","method":"x"}]';
    expect(classifyJsonRpc(batch, "r1", true).some((m) => m.kind === "response")).toBe(true);
    expect(() => classifyJsonRpc(batch, "r1", false)).toThrow(/malformed JSON-RPC payload/);
  });
  it("throws on unparseable JSON", () => {
    expect(() => classifyJsonRpc("{nope", "r1", false)).toThrow(/malformed JSON-RPC payload/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/pipeline/mcp-wire.test.ts`
Expected: FAIL — `Cannot find module './mcp-wire.js'`

- [ ] **Step 3: Implement `mcp-wire.ts`**

```typescript
// packages/sdk/src/pipeline/mcp-wire.ts
/**
 * Wire-level helpers for the MCP streamable-HTTP client (design D2):
 * an incremental SSE frame parser and JSON-RPC message classification.
 * Pure functions — no I/O, no caps (the caller's capped reader feeds them).
 */

export type WireMessage =
  | { kind: "response"; message: { id: string; result?: unknown; error?: { code: number; message: string } } }
  | { kind: "ping"; id: string | number }
  | { kind: "other" };

export function createSseParser(): { push(chunk: string): string[]; flush(): string[] } {
  let buffer = "";
  let dataLines: string[] = [];
  const complete: string[] = [];
  function consumeLine(line: string): void {
    if (line === "") {
      if (dataLines.length > 0) complete.push(dataLines.join("\n"));
      dataLines = [];
      return;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // comments (:), event:, id:, retry: — ignored (resumption is a D6 non-goal)
  }
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      let idx: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard line-scan loop
      while ((idx = buffer.indexOf("\n")) !== -1) {
        consumeLine(buffer.slice(0, idx).replace(/\r$/, ""));
        buffer = buffer.slice(idx + 1);
      }
      return complete.splice(0);
    },
    flush(): string[] {
      if (buffer !== "") consumeLine(buffer.replace(/\r$/, ""));
      if (dataLines.length > 0) {
        complete.push(dataLines.join("\n"));
        dataLines = [];
      }
      return complete.splice(0);
    },
  };
}

function classifyOne(msg: unknown, expectedId: string): WireMessage {
  if (typeof msg !== "object" || msg === null) return { kind: "other" };
  const m = msg as Record<string, unknown>;
  if (m.method === "ping" && (typeof m.id === "string" || typeof m.id === "number")) {
    return { kind: "ping", id: m.id };
  }
  if (m.id === expectedId && m.method === undefined) {
    return { kind: "response", message: m as WireMessage extends { message: infer T } ? T : never };
  }
  return { kind: "other" };
}

export function classifyJsonRpc(payload: string, expectedId: string, allowBatch: boolean): WireMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new Error("malformed JSON-RPC payload: not valid JSON", { cause });
  }
  if (Array.isArray(parsed)) {
    if (!allowBatch) throw new Error("malformed JSON-RPC payload: batch received but the negotiated protocol version forbids batching");
    return parsed.map((m) => classifyOne(m, expectedId));
  }
  return [classifyOne(parsed, expectedId)];
}
```

Note: the `classifyOne` response cast above is illustrative — implementer should type it plainly (`{ id: string; result?: unknown; error?: { code: number; message: string } }` via a small local interface), not with conditional-type gymnastics. tsc strict must pass.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/pipeline/mcp-wire.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/pipeline/mcp-wire.ts packages/sdk/src/pipeline/mcp-wire.test.ts
git commit -m "feat: SSE frame parser + JSON-RPC correlation for the MCP client (C4)"
```

---

### Task 2: MCP client — handshake (initialize / initialized) with budget + validation

**Files:**
- Create: `packages/sdk/src/pipeline/mcp-client.ts`
- Test: `packages/sdk/src/pipeline/mcp-client.test.ts` (uses a real local `node:http` server per test, the existing pattern in `upstream.test.ts`)

**Interfaces:**
- Consumes: Task 1's `createSseParser`, `classifyJsonRpc`; `createPinnedLookup`, `EgressOptions` from `./egress.js`.
- Produces (used by Tasks 3–5, 10):

```typescript
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;

export class McpClientError extends Error {
  readonly kind: "network" | "http_status" | "protocol" | "cap" | "timeout";
  readonly status?: number; // present for http_status
}

export interface McpBudget {
  /** Absolute whole-operation deadline: remaining ms; <=0 means exhausted. */
  deadline: () => number;
  /** Cumulative byte allowance across EVERY response in the operation. */
  maxBytes: number;
}

export interface McpEndpoint {
  target: URL;
  /** Auth and other fixed headers; content-type/accept/MCP-Protocol-Version/Mcp-Session-Id are managed internally. */
  headers: Record<string, string>;
  /** Pinned lookup for serve-time; omit for onboarding (plain DNS). */
  lookup?: import("node:net").LookupFunction;
}

export interface McpSession {
  protocolVersion: string;
  sessionId?: string;
}

export interface McpClient {
  initialize(): Promise<McpSession>;
  listTools(session: McpSession, maxTools: number): Promise<unknown[]>;      // Task 3
  callTool(session: McpSession, name: string, args: unknown): Promise<{ result: unknown; status: number }>; // Task 3
  deleteSession(session: McpSession): Promise<void>;                          // Task 3
}

export function createMcpClient(endpoint: McpEndpoint, budget: McpBudget): McpClient;
```

Internal single POST helper (shared by all methods; adapted from `sendPinnedRequest` + `readCapped` in upstream.ts — move/copy the transport mechanics here so upstream.ts can later delegate):
`postOnce(body: object, session?: McpSession): Promise<{ status: number; contentType: string; payloads: string[]; headers: IncomingHttpHeaders }>` — sends the POST with managed headers (`content-type: application/json`, `accept: application/json, text/event-stream`, `MCP-Protocol-Version` when `session` given, `Mcp-Session-Id` when `session.sessionId` present, plus `endpoint.headers`), enforces the pre-response deadline from `budget.deadline()`, reads the body through the cumulative capped reader (decrementing the shared byte allowance), splits SSE frames via `createSseParser` or returns the whole JSON body as one payload.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/sdk/src/pipeline/mcp-client.test.ts
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpClient, McpClientError, SUPPORTED_PROTOCOL_VERSIONS } from "./mcp-client.js";

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function serve(handler: Parameters<typeof createServer>[1]): Promise<URL> {
  return new Promise((resolve) => {
    server = createServer(handler).listen(0, "127.0.0.1", () => {
      const addr = server?.address();
      if (addr === null || addr === undefined || typeof addr === "string") throw new Error("no port");
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
    const session = await createMcpClient({ target: url, headers: { authorization: "Bearer t" } }, budget()).initialize();
    expect(session).toEqual({ protocolVersion: "2025-06-18", sessionId: "sess-1" });
    // initialize carried the FULL shape
    const init = JSON.parse(seen[0].body);
    expect(init.params.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(init.params.clientInfo.name).toBe("conduit");
    expect(init.params.capabilities).toEqual({});
    // initialized carried session + negotiated-version headers + auth
    expect(seen[1].headers["mcp-session-id"]).toBe("sess-1");
    expect(seen[1].headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(seen[1].headers.authorization).toBe("Bearer t");
  });

  it("INVARIANT §18-C4: rejects a counter-offer outside the allowlist, naming both sides", async () => {
    const url = await serve((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(initializeResult("1999-01-01")));
      });
    });
    await expect(createMcpClient({ target: url, headers: {} }, budget()).initialize()).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringContaining("1999-01-01"),
    });
  });

  it("rejects a server that does not advertise capabilities.tools", async () => {
    const url = await serve((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(initializeResult("2025-06-18", { capabilities: {} })));
      });
    });
    await expect(createMcpClient({ target: url, headers: {} }, budget()).initialize()).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringContaining("tools"),
    });
  });

  it("INVARIANT §18-C4: Mcp-Session-Id validation matrix — empty and non-visible-ASCII rejected; visible-ASCII boundary accepted", async () => {
    for (const [sid, ok] of [["", false], ["a b", false], ["sid", false], ["!~ok-id", true]] as const) {
      const url = await serve((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const parsed = JSON.parse(raw);
          if (parsed.method === "initialize") {
            res.writeHead(200, { "content-type": "application/json", ...(sid === "" ? { "mcp-session-id": "" } : { "mcp-session-id": sid }) });
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
          res.end(`event: message\ndata: ${JSON.stringify({ ...initializeResult("2025-06-18"), id: parsed.id })}\n\n`);
        } else {
          res.writeHead(202);
          res.end();
        }
      });
    });
    await expect(createMcpClient({ target: url, headers: {} }, budget()).initialize()).resolves.toMatchObject({ sessionId: "s2" });
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
    await expect(createMcpClient({ target: url, headers: {} }, budget()).initialize()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("INVARIANT §18-C4: handshake responses are capped — a huge initialize body is a cap error, and the budget is cumulative", async () => {
    const url = await serve((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"jsonrpc":"2.0","id":"init","result":{"pad":"${"x".repeat(2048)}"}}`);
      });
    });
    const tiny = createMcpClient({ target: url, headers: {} }, { deadline: () => 5_000, maxBytes: 512 });
    await expect(tiny.initialize()).rejects.toMatchObject({ kind: "cap" });
  });

  it("an exhausted deadline fails as timeout before any request", async () => {
    const url = await serve((_req, res) => res.end());
    const spent = createMcpClient({ target: url, headers: {} }, { deadline: () => 0, maxBytes: 1024 });
    await expect(spent.initialize()).rejects.toMatchObject({ kind: "timeout" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/pipeline/mcp-client.test.ts`
Expected: FAIL — `Cannot find module './mcp-client.js'`

- [ ] **Step 3: Implement `mcp-client.ts` (initialize + postOnce; listTools/callTool/deleteSession as throwing stubs for Task 3)**

Implementation requirements (write real code, no placeholders except the three Task-3 method stubs which throw `new McpClientError("protocol", "not implemented")`):

```typescript
// Core shapes (complete the file around these):
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
const CLIENT_INFO = { name: "conduit", version: "0.1.0" };
const VISIBLE_ASCII_SESSION_ID = /^[\x21-\x7e]+$/;

export class McpClientError extends Error {
  readonly kind: "network" | "http_status" | "protocol" | "cap" | "timeout";
  readonly status?: number;
  constructor(kind: McpClientError["kind"], message: string, opts?: { status?: number; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "McpClientError";
    this.kind = kind;
    if (opts?.status !== undefined) this.status = opts.status;
  }
}
```

- `postOnce(body, session?)` sends via `node:http(s).request` with `endpoint.lookup` when present (same mechanics as `sendPinnedRequest`, upstream.ts:335-371 — pre-response deadline via `req.setTimeout(remaining)`, TimeoutError-named destroy, disarm on headers). Body read is capped against the REMAINING shared byte allowance (a mutable `bytesLeft` in the client closure — every response decrements it; breach → `McpClientError("cap", ...)`). Redirect statuses (3xx) → `McpClientError("http_status", "redirect refused", { status })`. Non-2xx → drain capped, throw `http_status` with status. `text/event-stream` content-type → run chunks through `createSseParser` (Task 1) INCREMENTALLY while reading, stop reading as soon as a payload classifies (Task 1 `classifyJsonRpc`) as the matching response; other content-type containing `application/json` → whole body is one payload; anything else → `McpClientError("protocol", ...)`.
- `initialize()`: check `budget.deadline() > 0` first (`timeout` error otherwise); POST `{jsonrpc:"2.0", id:<uuid>, method:"initialize", params:{ protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO }}` WITHOUT session headers; validate with zod: result has string `protocolVersion` ∈ SUPPORTED_PROTOCOL_VERSIONS (else `protocol` error naming offered + supported), object `capabilities` with a `tools` key (else `protocol` error naming tools), object `serverInfo`. Session id header: absent → sessionless; present → must match `VISIBLE_ASCII_SESSION_ID` (else `protocol` error). Then POST `{jsonrpc:"2.0", method:"notifications/initialized"}` WITH the new session's headers; require status exactly 202 AND zero body bytes (else `protocol` error). Return the session.
- Ping frames encountered while waiting for any response: POST `{jsonrpc:"2.0", id:<ping id>, result:{}}` with session headers (fire within the budget; a ping-answer response must also be 202-empty; failure of the ping answer is a `protocol` error).
- Errors: never include `endpoint.headers` values in messages.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/pipeline/mcp-client.test.ts src/pipeline/mcp-wire.test.ts`
Expected: PASS

- [ ] **Step 5: Run tsc + biome, add INVARIANTS.md rows, commit**

Run: `cd packages/sdk && node_modules/.bin/tsc --noEmit && cd ../.. && node_modules/.bin/biome check packages/sdk/src/pipeline`
Add rows to `INVARIANTS.md` (§18-C4 section): version-allowlist rejection; session-id validation; handshake caps cumulative; initialized 202-empty.

```bash
git add packages/sdk/src/pipeline/mcp-client.ts packages/sdk/src/pipeline/mcp-client.test.ts INVARIANTS.md
git commit -m "feat: MCP streamable-HTTP client handshake with logical budget (C4)"
```

---

### Task 3: MCP client — tools/list pagination, tools/call, DELETE, scoped 404 retry

**Files:**
- Modify: `packages/sdk/src/pipeline/mcp-client.ts` (replace Task-2 stubs)
- Test: `packages/sdk/src/pipeline/mcp-client.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `postOnce`, session shape.
- Produces: working `listTools(session, maxTools)`, `callTool(session, name, args)`, `deleteSession(session)` per the Task-2 signatures. NOTE: the 404-session-expiry retry is implemented HERE for single operations (one re-`initialize` + one retry of the operation when the failed request CARRIED a session id); the cross-call cache/generation logic lives in Task 4's scope, not the client.

- [ ] **Step 1: Write the failing tests** (extend the Task-2 fixture-server pattern; each test builds a handler switch on `parsed.method`)

Required test cases (write them all, full bodies, same style as Task 2):

1. `INVARIANT §18-C4: tools/list follows nextCursor to completion and the tool-count cap spans ALL pages` — server returns 2 pages (600 + 600 tools with `nextCursor: "p2"` on page 1); `listTools(session, 1024)` rejects `{ kind: "cap" }`; with 2 pages of 2+2 and cap 1024 it resolves to 4 tools in order.
2. `INVARIANT §18-C4: the byte budget is cumulative across pages` — two pages each ~700 bytes, `maxBytes: 1000` → `{ kind: "cap" }`.
3. `tools/call returns the JSON-RPC result verbatim with the HTTP status` — SSE-framed CallToolResult with an interleaved notification event before the response; expect result matches and the notification was ignored.
4. `INVARIANT §18-C4: a server ping mid-stream is answered and the response still arrives` — server emits a ping request event, expects a `{"id":<ping id>,"result":{}}` POST back (assert it), then emits the response.
5. `INVARIANT §18-C4: 404 retry fires ONLY when the request carried a session id, at most once` — (a) sessioned `tools/call` gets 404 once → client re-initializes → retry succeeds → total initialize count is 2; (b) second consecutive 404 → rejects `{ kind: "http_status", status: 404 }`; (c) a SESSIONLESS call getting 404 → rejects immediately, initialize count stays 1.
6. `INVARIANT §18-C4: a 404 mid-pagination restarts from page one, discarding the stale cursor, keeping the cumulative budget` — page 1 OK, page 2 → 404 → re-handshake → both pages refetched (server asserts page-1 fetched twice), byte budget still cumulative across ALL five responses.
7. `deleteSession sends DELETE with session + version headers; 404/405 resolve (non-fatal)`.
8. `batched array response accepted under 2025-03-26 and rejected under 2025-06-18` (server negotiates the respective version; response body is a JSON array containing the matching response).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/pipeline/mcp-client.test.ts`
Expected: new tests FAIL (`not implemented`), Task-2 tests PASS.

- [ ] **Step 3: Implement listTools / callTool / deleteSession**

- `listTools(session, maxTools)`: loop POST `{jsonrpc, id:<uuid>, method:"tools/list", params: cursor ? { cursor } : {}}`; validate `result.tools` is an array (zod), accumulate; running count > `maxTools` → `McpClientError("cap", …names the cap…)`; `result.nextCursor` string → continue, absent → done. 404-with-session → ONE re-initialize (replacing the session's id/version via a mutable box the caller passed — see note) and restart from page one with `cursor = undefined`, accumulated tools discarded, byte budget NOT reset; second 404 → throw.
- Session renewal on retry (stale-generation guard, spec D3 precision note): the retry re-initializes into a LOCAL fresh session used for the retried operation. It then updates the caller's session IN PLACE **only if the caller's session still holds the exact sessionId that 404'd** (generation check by sessionId equality) — a delayed 404 from an old generation therefore completes its own retry without clobbering a session someone else already renewed. Document this on the type. Add test: `INVARIANT §18-C4: a delayed 404 from an old session cannot invalidate a newly established session` — mutate the shared session to a new id before the retry path would publish; assert it is left untouched while the operation still succeeds via its local session.
- `callTool(session, name, args)`: POST `{jsonrpc, id:<uuid>, method:"tools/call", params:{ name, arguments: args ?? {} }}`; JSON-RPC-level `error` member → return it as `{ result: { error } , status }`? NO — preserve upstream.ts semantics: return `{ result: <the result member>, status }` on success; a JSON-RPC `error` member throws `McpClientError("protocol", "upstream returned JSON-RPC error <code>: <message>")` — upstream.ts (Task 5) maps it into `upstreamError` exactly like today's error-member handling (read upstream.ts:140-300 for the current mapping and keep parity; MCP tool-level failures arrive as `result.content[].isError` and are NOT errors — pass through).
- `deleteSession(session)`: only when `session.sessionId` present; `postOnce`-style DELETE (method DELETE, no body); 2xx/404/405 resolve; other statuses throw `http_status` (Task 4 swallows into diagnostics).
- One retry TOTAL per logical operation (a counter in the operation frame, not per page).

- [ ] **Step 4: Run the full client suite**

Run: `cd packages/sdk && node_modules/.bin/vitest run src/pipeline/mcp-client.test.ts`
Expected: PASS

- [ ] **Step 5: tsc + biome + INVARIANTS rows (pagination caps; 404-retry scoping; mid-pagination restart; ping answered) + commit**

```bash
git add packages/sdk/src/pipeline/mcp-client.ts packages/sdk/src/pipeline/mcp-client.test.ts INVARIANTS.md
git commit -m "feat: MCP client pagination, tools/call, teardown, scoped session-expiry retry (C4)"
```

---

### Task 4: Per-drive upstream session scope (cache binding + single-flight + disposal)

**Files:**
- Create: `packages/sdk/src/pipeline/upstream-session.ts`
- Test: `packages/sdk/src/pipeline/upstream-session.test.ts`

**Interfaces:**
- Consumes: `McpClient`, `McpSession`, `createMcpClient` (Tasks 2–3).
- Produces (used by Tasks 5 and 7):

```typescript
export interface UpstreamSessionScope {
  /**
   * Returns the cached (client, session) for this exact (url, auth) binding,
   * creating it via `make` (single-flighted) on first use or after a key change.
   */
  acquire(args: {
    url: string;
    authHeaders: Record<string, string>;
    make: () => Promise<{ client: McpClient; session: McpSession }>;
  }): Promise<{ client: McpClient; session: McpSession }>;
  /** Best-effort teardown of every cached session. NEVER throws. */
  dispose(): Promise<void>;
}

export function createUpstreamSessionScope(log?: (line: string) => void): UpstreamSessionScope;
```

Key = `${url}\n${hmacSha256(salt, canonical(authHeaders))}` where `salt = randomBytes(16)` minted at scope creation and `canonical` is the length-prefixed, name-lowercased, sorted serialization from the design (D3 precision note), with the literal `"<no-auth>"` when the record is empty. Auth material itself is NEVER stored on the scope — only the digest.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/sdk/src/pipeline/upstream-session.test.ts
import { describe, expect, it } from "vitest";
import type { McpClient, McpSession } from "./mcp-client.js";
import { createUpstreamSessionScope } from "./upstream-session.js";

function fakeMake(label: string, made: string[], deleted: string[]) {
  return async (): Promise<{ client: McpClient; session: McpSession }> => {
    made.push(label);
    return {
      session: { protocolVersion: "2025-06-18", sessionId: `sid-${label}-${made.length}` },
      client: {
        initialize: async () => { throw new Error("unused"); },
        listTools: async () => [],
        callTool: async () => ({ result: null, status: 200 }),
        deleteSession: async (s) => { deleted.push(s.sessionId ?? "none"); },
      },
    };
  };
}

describe("INVARIANT §18-C4: per-drive session scope", () => {
  it("caches by url+auth and single-flights concurrent first acquires", async () => {
    const made: string[] = [];
    const scope = createUpstreamSessionScope();
    const args = { url: "http://u/mcp", authHeaders: { authorization: "Bearer a" }, make: fakeMake("a", made, []) };
    const [one, two] = await Promise.all([scope.acquire(args), scope.acquire(args)]);
    expect(one.session).toBe(two.session);
    expect(made).toEqual(["a"]);
  });

  it("INVARIANT §18-C4: same-url same-ref secret rotation forces a new session (auth digest key)", async () => {
    const made: string[] = [];
    const scope = createUpstreamSessionScope();
    await scope.acquire({ url: "http://u/mcp", authHeaders: { authorization: "Bearer old" }, make: fakeMake("old", made, []) });
    await scope.acquire({ url: "http://u/mcp", authHeaders: { authorization: "Bearer NEW" }, make: fakeMake("new", made, []) });
    expect(made).toEqual(["old", "new"]);
  });

  it("a url change invalidates; unchanged binding reuses", async () => {
    const made: string[] = [];
    const scope = createUpstreamSessionScope();
    const auth = { authorization: "Bearer a" };
    await scope.acquire({ url: "http://u1/mcp", authHeaders: auth, make: fakeMake("u1", made, []) });
    await scope.acquire({ url: "http://u1/mcp", authHeaders: auth, make: fakeMake("u1b", made, []) });
    await scope.acquire({ url: "http://u2/mcp", authHeaders: auth, make: fakeMake("u2", made, []) });
    expect(made).toEqual(["u1", "u2"]);
  });

  it("INVARIANT §18-C4: dispose deletes every cached session and never throws", async () => {
    const made: string[] = [];
    const deleted: string[] = [];
    const scope = createUpstreamSessionScope();
    await scope.acquire({ url: "http://u/mcp", authHeaders: {}, make: fakeMake("x", made, deleted) });
    await scope.dispose();
    expect(deleted).toHaveLength(1);
    // second dispose is a no-op, still resolves
    await expect(scope.dispose()).resolves.toBeUndefined();
  });

  it("dispose swallows a throwing deleteSession into the log", async () => {
    const lines: string[] = [];
    const scope = createUpstreamSessionScope((l) => lines.push(l));
    await scope.acquire({
      url: "http://u/mcp", authHeaders: {},
      make: async () => ({
        session: { protocolVersion: "2025-06-18", sessionId: "sid" },
        client: { initialize: async () => { throw new Error("x"); }, listTools: async () => [], callTool: async () => ({ result: null, status: 200 }), deleteSession: async () => { throw new Error("boom"); } },
      }),
    });
    await expect(scope.dispose()).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes("boom"))).toBe(true);
  });

  it("a failed make is not cached (next acquire retries)", async () => {
    let calls = 0;
    const scope = createUpstreamSessionScope();
    const make = async () => {
      calls++;
      if (calls === 1) throw new Error("first fails");
      return (await fakeMake("ok", [], [])());
    };
    await expect(scope.acquire({ url: "http://u/mcp", authHeaders: {}, make })).rejects.toThrow("first fails");
    await expect(scope.acquire({ url: "http://u/mcp", authHeaders: {}, make })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd packages/sdk && node_modules/.bin/vitest run src/pipeline/upstream-session.test.ts` → FAIL (module missing)

- [ ] **Step 3: Implement `upstream-session.ts`**

```typescript
import { createHmac, randomBytes } from "node:crypto";
import type { McpClient, McpSession } from "./mcp-client.js";

function canonicalAuth(headers: Record<string, string>): string {
  const names = Object.keys(headers).map((n) => n.toLowerCase()).sort();
  if (names.length === 0) return "<no-auth>";
  return names.map((n) => `${n.length}:${n}${headers[n] === undefined ? 0 : String(headers[n]).length}:${headers[n] ?? ""}`).join("|");
}

export function createUpstreamSessionScope(log?: (line: string) => void) {
  const salt = randomBytes(16);
  const entries = new Map<string, Promise<{ client: McpClient; session: McpSession }>>();
  let disposed = false;
  return {
    async acquire(args) {
      const digest = createHmac("sha256", salt).update(canonicalAuth(args.authHeaders)).digest("hex");
      const key = `${args.url}\n${digest}`;
      const existing = entries.get(key);
      if (existing !== undefined) return existing;
      const pending = args.make();
      entries.set(key, pending);
      try {
        return await pending;
      } catch (cause) {
        entries.delete(key); // failed handshakes are not cached
        throw cause;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const pending of entries.values()) {
        try {
          const { client, session } = await pending;
          if (session.sessionId !== undefined) await client.deleteSession(session);
        } catch (cause) {
          log?.(`[UpstreamSessionScope] teardown failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      entries.clear();
    },
  };
}
```

(Implementer: type the return as `UpstreamSessionScope`, keep the header-value lookup case-insensitive-correct — build `canonicalAuth` from lowercased-name → original-value pairs, not `headers[n]` after lowercasing the name. Fix that bug from this sketch.)

- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: tsc + biome + INVARIANTS rows (auth-digest rotation; single-flight; dispose-never-throws) + commit**

```bash
git add packages/sdk/src/pipeline/upstream-session.ts packages/sdk/src/pipeline/upstream-session.test.ts INVARIANTS.md
git commit -m "feat: per-drive upstream session scope with auth-digest cache binding (C4)"
```

---

### Task 5: C5 in the normalizer + types (`sourceSemantics.upstreamName`)

**Files:**
- Modify: `packages/sdk/src/types.ts:47-51` (SourceSemantics mcp variant)
- Modify: `packages/sdk/src/normalize/mcp.ts` (record the wire name)
- Test: `packages/sdk/src/normalize/mcp.test.ts` (extend)

**Interfaces:**
- Produces: `SourceSemantics` mcp variant becomes `{ kind: "mcp"; upstreamName?: string; readOnlyHint?: boolean; destructiveHint?: boolean }`. `normalizeMcp` ALWAYS sets `upstreamName` to the raw `entry.name`. (Optional in the TYPE because legacy persisted rows lack it — D4 amended.)

- [ ] **Step 1: Write the failing test**

```typescript
// append to packages/sdk/src/normalize/mcp.test.ts
it("INVARIANT §18-C5: records the raw upstream name so hyphenated names round-trip", () => {
  const tools = normalizeMcp({
    namespace: "context7",
    tools: [{ name: "resolve-library-id", inputSchema: { type: "object" } }],
  });
  expect(tools[0].name).toBe("context7.resolve_library_id");
  expect(tools[0].sourceSemantics).toMatchObject({ kind: "mcp", upstreamName: "resolve-library-id" });
});
```

- [ ] **Step 2: Run to verify failure** — `cd packages/sdk && node_modules/.bin/vitest run src/normalize/mcp.test.ts` → FAIL (upstreamName undefined)

- [ ] **Step 3: Implement** — types.ts: add `upstreamName?: string` to the mcp variant. normalize/mcp.ts: in the semantics construction add `upstreamName: entry.name` (before the hint fields; `deriveRiskClass` ignores unknown fields — verify `risk.ts` only reads hints; if it switches exhaustively on fields, adjust nothing — it takes the whole object).

- [ ] **Step 4: Run the full sdk suite** (types ripple): `cd packages/sdk && node_modules/.bin/vitest run` → all green; `node_modules/.bin/tsc --noEmit` → clean.

- [ ] **Step 5: Commit** — `git add packages/sdk/src/types.ts packages/sdk/src/normalize/mcp.ts packages/sdk/src/normalize/mcp.test.ts && git commit -m "feat: store the raw upstream tool name in sourceSemantics (C5)"`

---

### Task 6: Rewire the serve-time upstream caller onto the client (+ C5 usage)

**Files:**
- Modify: `packages/sdk/src/pipeline/upstream.ts` (createMcpUpstreamCaller internals; `UpstreamRequest` gains `session?: UpstreamSessionScope`)
- Test: `packages/sdk/src/pipeline/upstream.test.ts` (rewrite the wire-level tests to streamable HTTP; keep every existing invariant's MEANING)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: `UpstreamRequest` gains optional `session?: UpstreamSessionScope`. `createMcpUpstreamCaller(options)` unchanged signature; internally: egress pre-flight + pinned lookup EXACTLY as today, then `session.acquire({ url: source.location, authHeaders: request.auth.headers, make: handshake-via-createMcpClient })` (an ephemeral scope per call when `request.session` is absent — used by tests and any legacy caller), then `client.callTool(session, upstreamName, request.input ?? {})` where `upstreamName = tool.sourceSemantics.kind === "mcp" && tool.sourceSemantics.upstreamName !== undefined ? tool.sourceSemantics.upstreamName : <today's prefix-strip fallback>` (legacy-row fallback, D4 amended — keep the existing A5 comment, updated).
- Budget mapping: `createMcpClient` gets `{ deadline: () => <remaining of request.timeoutMs measured from call start>, maxBytes: options.maxResponseBytes ?? 1 MiB }` — the WHOLE logical operation (handshake + call + one retry) shares `request.timeoutMs`, preserving F1 semantics.
- Error mapping parity (read the current upstream.ts:140-300 first): `McpClientError` kinds map — `cap` → the existing response-cap upstreamError text; `timeout` → "timed out after {timeoutMs}ms"; `http_status` 3xx → the redirect-refused text; other `http_status`/`protocol` → upstreamError carrying status + sanitized detail via `sanitizeUpstreamText`; `network` + egress-blocked → exactly today's classification (`isEgressBlockedError` structural check preserved). §9.2: auth material still never appears in any error/trace (the client already never echoes headers; keep `credentialTokens` redaction on body-derived text).

- [ ] **Step 1: Rewrite the wire-level tests.** Read `upstream.test.ts` fully first. Every existing test that spins a bare-JSON-RPC fixture server gets its fixture upgraded to the streamable-HTTP handshake (factor ONE local `createStreamableFixture(handlers)` helper inside the test file: handles initialize/initialized bookkeeping, then delegates tools/call to the test's handler; support a `sessionless: true` flag). Existing invariants that MUST survive with identical meaning: egress pre-flight refusal text; pinned-lookup DNS-rebinding block; redirect refusal; non-JSON/SSE content-type handling (now: SSE accepted, `text/plain` still refused); response byte cap; timeout classification; §9.2 no-token-in-error. NEW tests: `INVARIANT §18-C5: a hyphenated upstreamName from sourceSemantics is sent on the wire` — and this test goes THROUGH THE STORE, not an in-memory Tool: `normalizeMcp` the hyphenated fixture → `store.tools.replaceNamespace` into a real in-memory sqlite store → `store.tools.get` → hand the HYDRATED tool to the caller → fixture asserts `params.name === "resolve-library-id"` (pins that `upstreamName` survives the source_semantics JSON round-trip, spec Testing: "normalize → store → call"); legacy-row fallback (a tool whose stored source_semantics JSON lacks upstreamName → prefix-strip used — write the row with raw SQL or a semantics object without the field); `handshake+call share request.timeoutMs` (fixture stalls initialize past the budget → timeout error, no call ever received).

- [ ] **Step 2: Run to verify the new/updated tests fail** — `cd packages/sdk && node_modules/.bin/vitest run src/pipeline/upstream.test.ts` → FAIL (old wire code).

- [ ] **Step 3: Implement the rewire** per the Interfaces block. Delete `sendPinnedRequest`/`readCapped`/SSE-absent parsing from upstream.ts ONLY after confirming mcp-client.ts owns equivalents (the transport mechanics move; the egress/pinning/error-mapping stay).

- [ ] **Step 4: Run the FULL sdk suite** — `cd packages/sdk && node_modules/.bin/vitest run` → all 333+ green (e2e.smoke + invoker mocks the UpstreamCaller seam, so only wire-level suites change).

- [ ] **Step 5: tsc + biome + INVARIANTS rows (C5 wire name; shared budget) + rebuild dist (`node_modules/.bin/tsup`) + commit**

```bash
git add packages/sdk/src/pipeline/upstream.ts packages/sdk/src/pipeline/upstream.test.ts INVARIANTS.md
git commit -m "feat: serve-time upstream caller speaks streamable HTTP and sends the stored upstream name (C4+C5)"
```

---

### Task 7: Thread the session scope through the manager (per-drive create + finally dispose)

**Files:**
- Modify: `packages/sdk/src/execution/manager.ts` (deps + both drive sites, :608 and :717)
- Modify: `packages/sdk/src/pipeline/invoker.ts` (options gain the scope; pass on UpstreamRequest)
- Modify: `packages/mcp/src/runtime.ts` (wire the factory)
- Test: `packages/sdk/src/execution/manager.test.ts` (extend)

**Interfaces:**
- `ExecutionManagerDeps` gains `makeUpstreamSession?: () => UpstreamSessionScope` (default `createUpstreamSessionScope`).
- `makeInvoker` args gain `upstreamSession?: UpstreamSessionScope` — this is the design's "equivalent disposer registration": the MANAGER owns the scope (creates before `makeInvoker`, disposes in a `finally` wrapping every drive exit — success, failure, pause).
- `CreateToolInvokerOptions` gains `upstreamSession?: UpstreamSessionScope`; `runCall` puts it on the `UpstreamRequest` it builds.
- runtime.ts `makeInvoker` closure threads `upstreamSession` into `createToolInvoker` options.

- [ ] **Step 1: Write the failing tests** (manager.test.ts style — it drives a real manager with fake deps):

1. `INVARIANT §18-C4: the manager disposes the upstream session scope on every drive exit — success, failure, AND pause` — inject `makeUpstreamSession` returning a recording fake; run a completing execution, a failing one, and one that pauses on approval; expect 3 scopes created, 3 disposed.
2. `INVARIANT §18-C4: a resumed drive gets a FRESH scope` — pause → resume(approve); expect the resume path created scope #2 (no reuse of #1) and disposed it.
3. `a throwing dispose does not change the drive outcome` — fake dispose throws; the execution still reports its own outcome.

- [ ] **Step 2: Run to verify failure** — the deps field doesn't exist yet → tsc/test FAIL.

- [ ] **Step 3: Implement** — manager: create scope, `try { …existing drive body… } finally { try { await scope.dispose() } catch (cause) { /* route to the existing diagnostics sink; never rethrow */ } }` at BOTH drive sites; invoker: accept + forward; runtime: pass through.

- [ ] **Step 4: Full sdk suite + tsc** — green.

- [ ] **Step 5: Rebuild dist + commit**

```bash
git add packages/sdk/src/execution/manager.ts packages/sdk/src/pipeline/invoker.ts packages/mcp/src/runtime.ts packages/sdk/src/execution/manager.test.ts INVARIANTS.md
git commit -m "feat: per-drive upstream session scope owned and disposed by the execution manager (C4)"
```

---

### Task 8: Lane A closure — mcp-package fixtures + whole-suite verification

**Files:**
- Modify: any `packages/mcp` test fixture that speaks the bare dialect to an upstream (grep first — see Step 1)
- Test: existing suites.

- [ ] **Step 1: Find every bare-dialect fixture left**

Run: `grep -rn "tools/list\|tools/call\|jsonrpc" packages/mcp/src packages/sdk/src --include="*.ts" -l | sort`
For each hit that ISN'T mcp-client/mcp-wire/upstream (e.g. `packages/mcp/src/integration.test.ts`'s upstream fixture, server.test.ts fixtures): upgrade the fixture to the Task-6 `createStreamableFixture` pattern (copy the helper local to each test file — test files don't share exports across packages; note in a comment it mirrors Task 6's helper).

- [ ] **Step 2: Run every suite unsandboxed**

Run: `cd packages/sdk && node_modules/.bin/vitest run && cd ../mcp && node_modules/.bin/vitest run && cd ../cli && node_modules/.bin/vitest run`
Expected: sdk + mcp green. cli MAY fail on mcp-fetch tests — that is Lane B territory: if cli fails, STOP and check the failures are ONLY in `mcp-fetch.test.ts`/`add-mcp.test.ts` fetch-shape expectations; anything else is a Lane A regression to fix now. (Lane A must not merge with cli broken — if cli breaks here, the fetch swap of Task 10 moves INTO Lane A. Flag it in the PR either way.)

- [ ] **Step 3: Biome + tsc across the workspace** — `node_modules/.bin/biome check packages && cd packages/sdk && node_modules/.bin/tsc --noEmit && cd ../mcp && node_modules/.bin/tsc --noEmit && cd ../cli && node_modules/.bin/tsc --noEmit`

- [ ] **Step 4: Commit + Lane A finish**

```bash
git add -A packages
git commit -m "test: streamable-HTTP fixtures across mcp package suites (C4)"
```
Then follow `superpowers:finishing-a-development-branch`: whole-branch review → Lane A PR (branch `feat/c4-c5-lane-a-sdk` cut from this work; the design doc + this plan ride with it) → full load-bearing gauntlet (Tier 2 + /security-review + real codex exec with correctness framing + /explain-diff quiz) → HUMAN-NAMED merge.

---

### Task 9 (Lane B starts — branch `feat/c4-c5-lane-b-cli` from MERGED main): demo upstream speaks streamable HTTP

**Files:**
- Modify: `scripts/token-demo-upstream.mjs`
- Test: manual run + Task 13's byte-identical check (the script has no vitest suite; it IS a fixture).

- [ ] **Step 1: Read the script fully.** It currently answers bare `tools/list` POSTs from its in-file template tables and prints `PORT=<n>` on stderr.

- [ ] **Step 2: Upgrade it**: implement minimal streamable HTTP — `initialize` (respond `2025-06-18`, `capabilities: { tools: {} }`, mint `Mcp-Session-Id`), require the session header + `MCP-Protocol-Version` on subsequent requests (400 otherwise — the fixture is deliberately strict so conduit's client is exercised honestly), `notifications/initialized` → 202 empty, `tools/list` → same 800-tool payload (unpaginated is fine — pagination is pinned by unit fixtures), NEW `tools/call` → echo `{ content: [{ type: "text", text: JSON.stringify({ tool: name, echo: args }) }] }` (discharges the call-capable-demo carry-over). Keep: deterministic output, PORT on stderr, stdout never.

- [ ] **Step 3: Manual verification** (sandbox disabled): start it, run the Task-2/3 handshake against it with a 30-line probe (or `node scripts/token-demo.mjs` after Task 10 exists). Expected: handshake + list + call all succeed.

- [ ] **Step 4: Commit** — `git add scripts/token-demo-upstream.mjs && git commit -m "feat: demo upstream speaks streamable HTTP and serves tools/call (C4, D1)"`

---

### Task 10: Onboarding fetch through the shared client + auth + retarget refusal + error mapping

**Files:**
- Modify: `packages/cli/src/mcp-fetch.ts` (thin adapter over `createMcpClient`)
- Modify: `packages/cli/src/commands/add-mcp.ts` (auth resolution order; retarget refusal; error mapping replacing the :127 catch)
- Test: `packages/cli/src/mcp-fetch.test.ts`, `packages/cli/src/add-mcp.test.ts`

**Interfaces:**
- `fetchToolsList(url: string, opts?: { authorization?: string }): Promise<unknown[]>` — keeps `MAX_RESPONSE_BYTES = 5 MiB` / `MAX_TOOLS = 1024` exports; internally `createMcpClient({ target, headers: opts.authorization ? { authorization } : {} }, { deadline: <5s absolute whole-op>, maxBytes: MAX_RESPONSE_BYTES })` → initialize → listTools(session, MAX_TOOLS) → best-effort deleteSession → return tools. NO egress pinning (operator-typed URL; documented in a comment referencing the design).
- `AddMcpDeps.fetchTools` becomes `(url: string, opts?: { authorization?: string }) => Promise<unknown[]>`.
- add-mcp flow changes (runAddMcp): (1) REORDER — open store and read the existing row BEFORE fetching (today the fetch happens first, :119-132; the design's auth order requires read-first). (2) Resolve onboarding auth: `env.CONDUIT_ADD_SECRET` wins; else a stored credentialRef is reused ONLY if the stored row exists AND its url === `--url`; else no auth. Reuse means resolving the sealed secret via the store's secret reader — mirror how `createStoreCredentialResolver` reads it; never log it. (3) RETARGET REFUSAL: `--replace` + url differs + stored credentialRef exists + no `CONDUIT_ADD_SECRET` + no `--clear-credential` → stderr `[conduit add-mcp] refusing to retarget "<ns>" to a new url while a stored credential exists: pass CONDUIT_ADD_SECRET for the new upstream or --clear-credential to drop it. Nothing was written.` exit 1. (4) ERROR MAPPING replaces the discard-all catch: `McpClientError` → `[conduit add-mcp] <kind-specific line>; nothing was written.` — `http_status` 401/403: `upstream requires authorization (HTTP <status>): set CONDUIT_ADD_SECRET`; `cap`: the client's cap message verbatim; `timeout`: `upstream did not complete within the onboarding budget`; `protocol`: the client's message; `network` (and only network): today's `upstream unreachable ... Re-run when reachable.` All exit 1, nothing written.

- [ ] **Step 1: Write the failing tests.** mcp-fetch.test.ts: rebuild its fixture servers (they're real local http servers already) onto the handshake; keep the three cap tests' MEANING (declared-length reject, streamed overrun cancel, tool-count cap — now via handshake-capable fixtures); add: auth header sent when provided; 401 surfaces as `McpClientError{kind:"http_status",status:401}`. add-mcp.test.ts (store-backed, fetch injected): retarget-refusal matrix — (replace+newUrl+storedCred+noEnv+noClear → exit 1, zero writes, old cred intact); (same + CONDUIT_ADD_SECRET → proceeds, new secret sealed); (same + --clear-credential → proceeds, cred deleted in-batch — existing T-I2 machinery); same-url re-sync keeps C2 preserve (existing test stays green); error-mapping cases per kind (fetch stub throws each `McpClientError` kind → assert exact stderr line + exit 1); stored-cred reuse only on unchanged url (fetch stub asserts the authorization option it received).

- [ ] **Step 2: Run to verify failures** — `cd packages/cli && node_modules/.bin/vitest run src/mcp-fetch.test.ts src/add-mcp.test.ts`

- [ ] **Step 3: Implement** per the Interfaces block. REMEMBER: rebuild sdk dist first if Lane A's dist is stale (`cd packages/sdk && node_modules/.bin/tsup`).

- [ ] **Step 4: Run the cli suite** — green; the secret-never-echoed tests must still pass (they assert captured stdout/stderr contain no token).

- [ ] **Step 5: Commit** — `git add packages/cli/src && git commit -m "feat: onboarding speaks streamable HTTP with auth, retarget refusal, and specific errors (C4, D5)"`

---

### Task 11: `add-mcp --help` + collected flag validation

**Files:**
- Modify: `packages/cli/src/dispatch.ts` (route `add-mcp --help`), `packages/cli/src/commands/add-mcp.ts` (usage text + collect-all validation)
- Test: `packages/cli/src/add-mcp.test.ts`, `packages/cli/src/dispatch.test.ts`

- [ ] **Step 1: Failing tests** — `add-mcp --help` → exit 0, stdout contains every flag (`--url`, `--namespace`, `--prefix`, `--replace`, `--clear-credential`, `--json`) and `CONDUIT_ADD_SECRET`; running with NO flags → ONE stderr line naming ALL missing required flags (`--namespace`, `--url`, `--prefix`), exit 1; top-level `conduit --help` mentions `add-mcp` flags one-liner.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — a `USAGE` string constant in add-mcp.ts; `parseAddMcpArgs` unchanged; `runAddMcp` validates namespace/url/prefix together, collecting `missing: string[]` and erroring once. dispatch.ts: `add-mcp` + `--help` in argv → print usage, exit 0 (mirror how serve/approvals handle help if they do; read dispatch.ts first).
- [ ] **Step 4: Run cli suite** — green.
- [ ] **Step 5: Commit** — `git commit -m "feat: add-mcp --help and single-pass flag validation (D5)"`

---

### Task 12: `approvals deny` exit code tracks the verb

**Files:**
- Modify: `packages/cli/src/commands/approvals.ts:182-192`
- Test: `packages/cli/src/approvals.test.ts`

- [ ] **Step 1: Failing test** — a deny whose resume outcome is `failed` with `error.name === "ConduitPolicyBlocked"` prints `denied` on stdout, exit 0; a deny failing with any OTHER error name keeps `deny failed: …` + exit 1; approve outcomes unchanged (existing tests pin them).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — in the `failed` branch: `if (kind === "deny" && outcome.error.name === "ConduitPolicyBlocked") { deps.stdout("denied\n"); return { exitCode: 0 }; }` before the generic failed handling.
- [ ] **Step 4: Run cli suite** — green.
- [ ] **Step 5: Commit** — `git commit -m "fix: approvals deny exits 0 when the deny itself succeeded (D5; LEARNINGS 2026-07-16 #2)"`

---

### Task 13: Retire seed-demo.mjs, README updates, token-demo byte-identical check

**Files:**
- Delete: `scripts/seed-demo.mjs` (superseded by `conduit add-mcp`; carries its own bare-dialect copy — D1)
- Modify: `packages/cli/README.md`, `packages/mcp/README.md` (remove seed-demo references; fix the gate-one prefix-vs-namespace wording carry-over: tool names are `<namespace>.<tool>`, `--prefix` is not the tool path; document CONDUIT_ADD_SECRET onboarding + the retarget refusal + the pre-C5 re-sync note from D4)
- Verify: `demo/token-demo.json`, `demo/token-demo.html` byte-identical.

- [ ] **Step 1: Grep for seed-demo references** — `grep -rn "seed-demo" packages scripts docs *.md` → update/remove each (integration tests should be on add-mcp already; if a test still imports it, STOP — that migration is the tracked approve-demo carry-over's sibling, flag before deleting).
- [ ] **Step 2: Delete the script + update READMEs** per Files.
- [ ] **Step 3: Byte-identical demo check** (sandbox disabled): `node scripts/token-demo.mjs && git diff --stat demo/` → expected: NO diff (tool surface unchanged). A diff = STOP, investigate before committing.
- [ ] **Step 4: Full workspace suites + biome + tsc** — all green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "docs+chore: retire seed-demo, README onboarding truthful re prefix/auth; token demo verified byte-identical (D1, D5)"`
Then `superpowers:finishing-a-development-branch` → Lane B PR → its own load-bearing gauntlet → HUMAN-NAMED merge.
**Lane-B verification step 0 (BEFORE any real PAT is used in dogfooding the merged result):** rotate the demo key — delete `~/.conduit/conduit.db*` + `gate-one-key`, mint a fresh key, update `~/.conduit/claude-desktop-snippet.json` + any Claude Code MCP config (HANDOFF housekeeping entry).

---

## Real-upstream acceptance matrix (Lane B verification — the definition of "transport support complete")

Fixtures prove determinism for CI; **transport support is complete only when
this matrix passes against independent third-party servers** (LEARNINGS
2026-07-16 #1). Run AFTER the key rotation (step 0) with a freshly minted
`~/.conduit`; record results in the Lane B PR description.

| # | Endpoint | Action (real CLI / real client, NO shim) | Expected outcome |
|---|----------|------------------------------------------|------------------|
| 1 | Context7 `https://mcp.context7.com/mcp` | `conduit add-mcp --url … --namespace context7 --prefix context7` (no credential) | Exit 0; 2 tools seeded, both safe |
| 2 | Context7 | From a real MCP client via `conduit serve`: search → describe → `resolve-library-id` call with valid args | Completed execution; real library results; trace rows present |
| 3 | Context7 | Chained workflow in ONE execution (resolve → parse → query-docs) | Completed; 2 trace rows under one execution_id; hyphenated names called correctly (C5 live) |
| 4 | Context7 | Kill and restart `conduit serve` between onboarding and calling | Calls still work (fresh drive = fresh handshake; no stale-session dependence) |
| 5 | GitHub `https://api.githubcopilot.com/mcp/` | `CONDUIT_ADD_SECRET="Bearer <PAT>" conduit add-mcp …` | Exit 0; ~44 tools seeded across safe/review/destructive |
| 6 | GitHub | A safe read call (e.g. `get_me`) through the real client | Completed with real data (PAT sent serve-time, SSE parsed) |
| 7 | GitHub | `add-mcp` WITHOUT the secret | Exit 1; error names authorization + CONDUIT_ADD_SECRET (NOT "unreachable") |
| 8 | Vercel `https://mcp.vercel.com` | `add-mcp` (no static secret possible) | Exit 1; truthful auth error. DOCUMENTED expected failure — OAuth is out of scope (spec §18); this row pins that the failure is honest, not that it succeeds |
| 9 | Any | Byte/tool-cap and timeout errors still name the cap/budget precisely (spot-check via fixture if no real trigger) | Specific error text, never generic "unreachable" |

A matrix row failing = Lane B is NOT done, regardless of green suites.

## Deviations log

Keep `.superpowers/sdd/` notes per task (what forced a deviation, the conservative call, what to fold into attempt #2); summarize under "Deviations" in each PR description.
