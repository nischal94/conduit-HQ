import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { z } from "zod";
import { classifyJsonRpc, createSseParser, type WireMessage } from "./mcp-wire.js";

/**
 * MCP streamable-HTTP client (design D2, spec §18-C4/C5). This module owns
 * the hand-rolled wire transport (`postOnce`) and the handshake
 * (`initialize`/`initialized`); Task 3 fills in `listTools`/`callTool`/
 * `deleteSession` on top of the same `postOnce` helper. Everything here
 * mirrors the transport mechanics in `upstream.ts`'s `sendPinnedRequest` +
 * `readCapped` — this is deliberately the same shape so upstream.ts can
 * later delegate to this client instead of maintaining a parallel path.
 */

/** Newest-first: sent as the client's offer; also the counter-offer allowlist. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;

const CLIENT_INFO = { name: "conduit", version: "0.1.0" };

/** MCP session ids are visible-ASCII per the spec (no space/control chars, non-empty). */
const VISIBLE_ASCII_SESSION_ID = /^[\x21-\x7e]+$/;

export class McpClientError extends Error {
  readonly kind: "network" | "http_status" | "protocol" | "cap" | "timeout";
  readonly status?: number;

  constructor(
    kind: McpClientError["kind"],
    message: string,
    opts?: { status?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "McpClientError";
    this.kind = kind;
    if (opts?.status !== undefined) {
      this.status = opts.status;
    }
  }
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
  lookup?: LookupFunction;
}

/**
 * A caller-owned, mutable session handle. `listTools`/`callTool` may replace
 * `sessionId` in place on a scoped 404-expiry retry (design D3) — but ONLY
 * when, at the moment the retry is about to publish, this object's
 * `sessionId` still strictly equals the id that 404'd. If some other
 * operation already renewed the session (a newer generation), the retry's
 * freshly-initialized session is used LOCALLY to complete this operation and
 * the caller's object is left untouched, so a delayed 404 from an old
 * generation can never clobber a newer session.
 */
export interface McpSession {
  protocolVersion: string;
  sessionId?: string;
}

export interface McpClient {
  initialize(): Promise<McpSession>;
  listTools(session: McpSession, maxTools: number): Promise<unknown[]>; // Task 3
  callTool(
    session: McpSession,
    name: string,
    args: unknown,
  ): Promise<{ result: unknown; status: number }>; // Task 3
  deleteSession(session: McpSession): Promise<void>; // Task 3
}

interface PostResult {
  status: number;
  contentType: string;
  payloads: string[];
  headers: IncomingHttpHeaders;
}

const initializeResultSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.record(z.unknown()),
  serverInfo: z.record(z.unknown()),
});

const toolsListResultSchema = z.object({
  tools: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});

/**
 * Safely extracts `{code, message}` from a JSON-RPC `error` member that
 * `classifyJsonRpc` casts unchecked (Task-1 review carry-over): a malformed
 * member (a bare string, missing fields, wrong types) never produces
 * "undefined" in the rendered message — it falls back to a safe generic
 * code/message instead.
 */
function safeRpcError(error: unknown): { code: number | "unknown"; message: string } {
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    return {
      code: typeof e.code === "number" ? e.code : "unknown",
      message: typeof e.message === "string" ? e.message : "unknown error",
    };
  }
  return { code: "unknown", message: "unknown error (malformed error member)" };
}

/** `"<message> (code <code>)"` rendering, used by initialize/tools-list rejections. */
function describeRpcError(error: unknown): string {
  const { code, message } = safeRpcError(error);
  return `${message} (code ${code})`;
}

export function createMcpClient(endpoint: McpEndpoint, budget: McpBudget): McpClient {
  // Cumulative across every response in the operation — every postOnce call
  // decrements this shared counter; a breach anywhere throws a cap error.
  let bytesLeft = budget.maxBytes;

  /**
   * Sends one JSON-RPC POST and returns every JSON-RPC payload found in the
   * response (SSE frames split incrementally, or the one JSON body). Adapted
   * from `sendPinnedRequest` + `readCapped` in upstream.ts: same two-phase
   * deadline handoff (pre-response timer disarmed the instant headers
   * arrive; the body reader owns the remaining deadline), same off-the-wire
   * byte counting (never content-length) — but the byte cap here is
   * CUMULATIVE across every call in the operation via the closure's
   * `bytesLeft`, not per-response.
   */
  function postOnce(body: object, session?: McpSession): Promise<PostResult> {
    const remaining = budget.deadline();
    if (remaining <= 0) {
      return Promise.reject(
        new McpClientError("timeout", "MCP operation budget already exhausted"),
      );
    }
    const headers: Record<string, string> = {
      ...endpoint.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (session !== undefined) {
      headers["mcp-protocol-version"] = session.protocolVersion;
      if (session.sessionId !== undefined) {
        headers["mcp-session-id"] = session.sessionId;
      }
    }
    const payload = JSON.stringify(body);
    const send = endpoint.target.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<PostResult>((resolve, reject) => {
      const req = send(
        endpoint.target,
        {
          method: "POST",
          headers: { ...headers, "content-length": String(Buffer.byteLength(payload)) },
          ...(endpoint.lookup !== undefined ? { lookup: endpoint.lookup } : {}),
        },
        (res) => {
          // Headers arrived: disarm the pre-response deadline so it cannot
          // race the body-read phase (see upstream.ts sendPinnedRequest).
          req.setTimeout(0);
          handleResponse(res).then(resolve, reject);
        },
      );
      req.setTimeout(remaining, () => {
        req.destroy(Object.assign(new Error("MCP request timed out"), { name: "TimeoutError" }));
      });
      req.on("error", (err) => {
        if (err instanceof Error && err.name === "TimeoutError") {
          reject(new McpClientError("timeout", "MCP request timed out before a response arrived"));
          return;
        }
        reject(
          new McpClientError("network", "MCP request failed before a response arrived", {
            cause: err,
          }),
        );
      });
      req.end(payload);
    });
  }

  function handleResponse(res: IncomingMessage): Promise<PostResult> {
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      res.destroy();
      return Promise.reject(new McpClientError("http_status", "MCP redirect refused", { status }));
    }
    const contentType = res.headers["content-type"] ?? "";
    return readCapped(res).then((raw) => {
      if (status < 200 || status >= 300) {
        throw new McpClientError("http_status", `MCP endpoint returned HTTP ${status}`, { status });
      }
      if (raw === "") {
        return { status, contentType, payloads: [], headers: res.headers };
      }
      if (contentType.includes("text/event-stream")) {
        const parser = createSseParser();
        const payloads = [...parser.push(raw), ...parser.flush()];
        return { status, contentType, payloads, headers: res.headers };
      }
      if (contentType.includes("application/json")) {
        return { status, contentType, payloads: [raw], headers: res.headers };
      }
      throw new McpClientError(
        "protocol",
        `MCP endpoint returned an unsupported content-type: ${contentType || "(none)"}`,
      );
    });
  }

  /**
   * Reads the response body, decrementing the shared cumulative byte
   * allowance as bytes arrive off the wire (never trusting content-length),
   * and racing the remaining whole-operation deadline. A cap breach or
   * deadline breach destroys the socket and rejects pre-classified.
   */
  function readCapped(res: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const remaining = budget.deadline();
      const timer = setTimeout(
        () => {
          res.destroy();
          reject(new McpClientError("timeout", "MCP response body read timed out"));
        },
        Math.max(0, remaining),
      );
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      res.on("data", (chunk: Buffer) => {
        bytesLeft -= chunk.byteLength;
        if (bytesLeft < 0) {
          res.destroy();
          settle(() =>
            reject(new McpClientError("cap", "MCP response exceeded the cumulative byte budget")),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        settle(() => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      res.on("error", (err) => {
        settle(() =>
          reject(new McpClientError("network", "MCP response stream failed", { cause: err })),
        );
      });
    });
  }

  /**
   * Answers a ping frame encountered while waiting for a real response.
   * Fire-and-forget within the budget; the answer must itself land as
   * 202-empty, matching `initialized`'s contract.
   */
  async function answerPing(id: string | number, session: McpSession): Promise<void> {
    const result = await postOnce({ jsonrpc: "2.0", id, result: {} }, session);
    if (result.status !== 202 || result.payloads.length > 0) {
      throw new McpClientError(
        "protocol",
        "MCP ping answer was not accepted (expected 202, empty body)",
      );
    }
  }

  /**
   * Sends one request and waits for the matching JSON-RPC response by id,
   * answering any ping frames seen along the way. `postOnce` already
   * collects every payload in a single response; a streamable-HTTP server
   * that spreads a response across a ping notification followed by the
   * real answer will surface as multiple payloads in the same call.
   */
  async function requestAndAwait(
    body: { jsonrpc: "2.0"; id: string; method: string; params?: unknown },
    session: McpSession | undefined,
    expectedId: string,
    allowBatch: boolean,
  ): Promise<{
    result: unknown;
    error?: { code: number; message: string };
    headers: IncomingHttpHeaders;
  }> {
    const { payloads, headers } = await postOnce(body, session);
    for (const payload of payloads) {
      let messages: WireMessage[];
      try {
        messages = classifyJsonRpc(payload, expectedId, allowBatch);
      } catch (cause) {
        throw new McpClientError("protocol", "MCP response was not valid JSON-RPC", { cause });
      }
      for (const msg of messages) {
        if (msg.kind === "response") {
          return {
            result: msg.message.result,
            headers,
            ...(msg.message.error !== undefined ? { error: msg.message.error } : {}),
          };
        }
        if (msg.kind === "ping") {
          if (session === undefined) {
            throw new McpClientError(
              "protocol",
              "MCP server sent a ping before a session was established",
            );
          }
          await answerPing(msg.id, session);
        }
        // "other": ignored — not the response we're waiting for.
      }
    }
    throw new McpClientError("protocol", "MCP response never carried the expected id");
  }

  async function initialize(): Promise<McpSession> {
    if (budget.deadline() <= 0) {
      throw new McpClientError("timeout", "MCP operation budget already exhausted");
    }
    const id = randomUUID();
    const { result, error, headers } = await requestAndAwait(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
      },
      undefined,
      id,
      false,
    );
    if (error !== undefined) {
      // The server's own JSON-RPC rejection: surface its code and message
      // rather than a generic shape-validation failure. The message text is
      // upstream-controlled but stays within the client; serve-time
      // sanitization happens in upstream.ts's mapping. Nothing from
      // endpoint.headers is interpolated (§9.2).
      throw new McpClientError(
        "protocol",
        `MCP server rejected initialize: ${error.message} (code ${error.code})`,
      );
    }
    const parsed = initializeResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new McpClientError(
        "protocol",
        `MCP initialize result did not match the expected shape: ${parsed.error.message}`,
      );
    }
    const { protocolVersion, capabilities } = parsed.data;
    if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) {
      throw new McpClientError(
        "protocol",
        `MCP server offered unsupported protocol version ${protocolVersion}; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
      );
    }
    if (!("tools" in capabilities)) {
      throw new McpClientError(
        "protocol",
        "MCP server did not advertise capabilities.tools in the initialize result",
      );
    }

    const rawSessionId = headers["mcp-session-id"];
    let sessionId: string | undefined;
    if (rawSessionId !== undefined) {
      // A streamable-HTTP server always sends this header as a single value;
      // an array (repeated header) is itself malformed.
      if (typeof rawSessionId !== "string" || !VISIBLE_ASCII_SESSION_ID.test(rawSessionId)) {
        throw new McpClientError(
          "protocol",
          "MCP server sent an Mcp-Session-Id that is not visible-ASCII and non-empty",
        );
      }
      sessionId = rawSessionId;
    }

    const session: McpSession =
      sessionId === undefined ? { protocolVersion } : { protocolVersion, sessionId };

    const initialized = await postOnce(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      session,
    );
    if (initialized.status !== 202 || initialized.payloads.length > 0) {
      throw new McpClientError(
        "protocol",
        "MCP server did not accept notifications/initialized (expected 202, empty body)",
      );
    }

    return session;
  }

  /**
   * Runs `op` against `session`. If it fails with a 404 that carried a
   * session id, re-initializes ONCE into a fresh LOCAL session and retries
   * `op` against that fresh session — never a second retry (a counter in
   * this call frame, not per page: `op` itself may issue many requests, e.g.
   * pagination, but only the FIRST 404 anywhere in the operation triggers a
   * retry). On success of the retried `op`, the caller's `session` object is
   * updated in place ONLY if it still holds the exact sessionId that 404'd —
   * see the `McpSession` doc comment for the generation-guard rationale.
   */
  async function withSessionExpiryRetry<T>(
    session: McpSession,
    op: (activeSession: McpSession) => Promise<T>,
  ): Promise<T> {
    const sessionIdAtEntry = session.sessionId;
    try {
      return await op(session);
    } catch (err) {
      const is404 =
        err instanceof McpClientError && err.kind === "http_status" && err.status === 404;
      if (!is404 || sessionIdAtEntry === undefined) {
        // Only a session-carrying request's 404 is eligible for the retry;
        // a sessionless 404 (or any non-404 failure) surfaces immediately.
        throw err;
      }
      const freshSession = await initialize();
      const result = await op(freshSession);
      if (session.sessionId === sessionIdAtEntry) {
        session.protocolVersion = freshSession.protocolVersion;
        if (freshSession.sessionId === undefined) {
          delete session.sessionId;
        } else {
          session.sessionId = freshSession.sessionId;
        }
      }
      return result;
    }
  }

  async function listToolsOnce(session: McpSession, maxTools: number): Promise<unknown[]> {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      const id = randomUUID();
      const { result, error } = await requestAndAwait(
        {
          jsonrpc: "2.0",
          id,
          method: "tools/list",
          params: cursor === undefined ? {} : { cursor },
        },
        session,
        id,
        session.protocolVersion !== "2025-06-18",
      );
      if (error !== undefined) {
        throw new McpClientError(
          "protocol",
          `MCP server rejected tools/list: ${describeRpcError(error)}`,
        );
      }
      const parsed = toolsListResultSchema.safeParse(result);
      if (!parsed.success) {
        throw new McpClientError(
          "protocol",
          `MCP tools/list result did not match the expected shape: ${parsed.error.message}`,
        );
      }
      tools.push(...parsed.data.tools);
      if (tools.length > maxTools) {
        throw new McpClientError("cap", `MCP tools/list exceeded the maxTools cap (${maxTools})`);
      }
      if (parsed.data.nextCursor === undefined) {
        return tools;
      }
      cursor = parsed.data.nextCursor;
    }
  }

  async function callToolOnce(
    session: McpSession,
    name: string,
    args: unknown,
  ): Promise<{ result: unknown; status: number }> {
    const id = randomUUID();
    const { result, error } = await requestAndAwait(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args ?? {} },
      },
      session,
      id,
      session.protocolVersion !== "2025-06-18",
    );
    if (error !== undefined) {
      // Parity with upstream.ts's error-member mapping: a JSON-RPC `error`
      // member is a protocol failure. MCP tool-level failures instead arrive
      // as `result.content[].isError` and are NOT errors — passed through
      // verbatim below.
      const { code, message } = safeRpcError(error);
      throw new McpClientError("protocol", `upstream returned JSON-RPC error ${code}: ${message}`);
    }
    return { result, status: 200 };
  }

  function deleteSession(session: McpSession): Promise<void> {
    if (session.sessionId === undefined) {
      return Promise.resolve();
    }
    const remaining = budget.deadline();
    if (remaining <= 0) {
      return Promise.reject(
        new McpClientError("timeout", "MCP operation budget already exhausted"),
      );
    }
    const headers: Record<string, string> = {
      ...endpoint.headers,
      "mcp-protocol-version": session.protocolVersion,
      "mcp-session-id": session.sessionId,
    };
    const send = endpoint.target.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<void>((resolve, reject) => {
      const req = send(
        endpoint.target,
        {
          method: "DELETE",
          headers,
          ...(endpoint.lookup !== undefined ? { lookup: endpoint.lookup } : {}),
        },
        (res) => {
          req.setTimeout(0);
          const status = res.statusCode ?? 0;
          res.resume(); // drain, no body needed
          res.on("end", () => {
            if (status >= 200 && status < 300) {
              resolve();
              return;
            }
            if (status === 404 || status === 405) {
              resolve();
              return;
            }
            reject(
              new McpClientError("http_status", `MCP session DELETE returned HTTP ${status}`, {
                status,
              }),
            );
          });
          res.on("error", (err) => {
            reject(
              new McpClientError("network", "MCP session DELETE response stream failed", {
                cause: err,
              }),
            );
          });
        },
      );
      req.setTimeout(remaining, () => {
        req.destroy(Object.assign(new Error("MCP request timed out"), { name: "TimeoutError" }));
      });
      req.on("error", (err) => {
        if (err instanceof Error && err.name === "TimeoutError") {
          reject(new McpClientError("timeout", "MCP request timed out before a response arrived"));
          return;
        }
        reject(
          new McpClientError("network", "MCP request failed before a response arrived", {
            cause: err,
          }),
        );
      });
      req.end();
    });
  }

  return {
    initialize,
    listTools(session: McpSession, maxTools: number): Promise<unknown[]> {
      return withSessionExpiryRetry(session, (activeSession) =>
        listToolsOnce(activeSession, maxTools),
      );
    },
    callTool(
      session: McpSession,
      name: string,
      args: unknown,
    ): Promise<{ result: unknown; status: number }> {
      return withSessionExpiryRetry(session, (activeSession) =>
        callToolOnce(activeSession, name, args),
      );
    },
    deleteSession,
  };
}
