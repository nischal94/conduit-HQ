import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { classifyJsonRpc, createSseParser, type WireMessage } from "./mcp-wire.js";

/**
 * MCP streamable-HTTP client (design D2, spec §18-C4/C5). This module owns the
 * hand-rolled wire transport (`openPost` + the buffered `postOnce` and the
 * incremental `postClassified`) and the handshake (`initialize`/`initialized`)
 * plus `listTools`/`callTool`/`deleteSession`. `postClassified` parses SSE
 * responses INCREMENTALLY and early-stops at the matching JSON-RPC id (design
 * D2), while `postOnce` reads short, single-body responses fully. This module
 * OWNS the wire transport: `upstream.ts` delegates to this client for
 * serve-time calls (pinned lookup, request-scoped auth headers, per-call
 * budget) rather than maintaining a parallel HTTP path.
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
  listTools(session: McpSession, maxTools: number): Promise<unknown[]>;
  callTool(
    session: McpSession,
    name: string,
    args: unknown,
  ): Promise<{ result: unknown; status: number }>;
  deleteSession(session: McpSession): Promise<void>;
}

interface PostResult {
  status: number;
  contentType: string;
  payloads: string[];
  headers: IncomingHttpHeaders;
}

/**
 * Classification context threaded into the read loop so a `text/event-stream`
 * response can be parsed INCREMENTALLY (design D2: "Reading stops as soon as
 * the matching response is parsed"): each completed SSE payload is classified
 * the instant it is framed, pings are answered live over their own POST while
 * the stream stays open, and the socket is destroyed the moment the matching
 * response is seen.
 */
interface ClassifyContext {
  expectedId: string;
  allowBatch: boolean;
  /** Undefined during `initialize` (no session yet); a ping then fails loud. */
  session?: McpSession;
}

/**
 * The awaited outcome of a classified POST. For an SSE response, `matched` is
 * the JSON-RPC response captured by early-stop (or `undefined` if the stream
 * ended with no match). For a non-SSE (`application/json`) response, the body
 * cannot early-stop, so `payloads` carries the single JSON body to classify.
 */
interface ClassifiedResult {
  matched?: {
    id: string;
    result?: unknown;
    error?: { code: number; message: string };
  };
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

/**
 * Renders a `classifyJsonRpc` throw into the protocol-error message, keeping
 * the wire layer's specific reason (e.g. "carried neither a result nor an
 * error", batch-forbidden) visible instead of a generic wrapper line.
 */
function describeWireError(cause: unknown): string {
  return cause instanceof Error && cause.message !== ""
    ? `MCP response was not valid JSON-RPC: ${cause.message}`
    : "MCP response was not valid JSON-RPC";
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

  /** Builds the fixed POST header set (§9.2: `endpoint.headers` verbatim, never interpolated). */
  function postHeaders(session?: McpSession): Record<string, string> {
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
    return headers;
  }

  /**
   * Opens one JSON-RPC POST and hands the live response to `onResponse` once
   * headers arrive. Owns the two-phase deadline handoff — one timer covers the
   * connect/headers phase and is disarmed the instant headers arrive; the body
   * reader that `onResponse` builds arms its own timer from the remaining
   * budget, so the two phases can never race each other. Pre-response failures
   * (timeout / socket error) reject.
   */
  function openPost<T>(
    body: object,
    session: McpSession | undefined,
    onResponse: (res: IncomingMessage, req: ReturnType<typeof httpRequest>) => Promise<T>,
  ): Promise<T> {
    const remaining = budget.deadline();
    if (remaining <= 0) {
      return Promise.reject(
        new McpClientError("timeout", "MCP operation budget already exhausted"),
      );
    }
    const payload = JSON.stringify(body);
    const send = endpoint.target.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise<T>((resolve, reject) => {
      const req = send(
        endpoint.target,
        {
          method: "POST",
          headers: {
            ...postHeaders(session),
            "content-length": String(Buffer.byteLength(payload)),
          },
          ...(endpoint.lookup !== undefined ? { lookup: endpoint.lookup } : {}),
        },
        (res) => {
          // Headers arrived: disarm the pre-response deadline so it cannot
          // race the body-read phase, which arms its own timer from the
          // remaining budget.
          req.setTimeout(0);
          onResponse(res, req).then(resolve, reject);
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

  /**
   * Sends one JSON-RPC POST and reads the WHOLE response body, returning every
   * JSON-RPC payload found (SSE frames, or the one JSON body). Used by the
   * fully-buffered callers — `initialize`, `notifications/initialized`, and
   * ping-answer posts — which have no matching id to early-stop on (their
   * bodies are empty 202s or a single validated result). The byte cap here is
   * CUMULATIVE across every call in the operation via the closure's
   * `bytesLeft`, not per-response.
   */
  function postOnce(body: object, session?: McpSession): Promise<PostResult> {
    return openPost(body, session, (res) => handleBufferedResponse(res));
  }

  function handleBufferedResponse(res: IncomingMessage): Promise<PostResult> {
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
          // After a cap breach this client is single-shot: `bytesLeft` stays
          // negative so any further postOnce on the same client fails the cap
          // immediately. Callers wanting a fresh byte budget build a fresh
          // client (see upstream.ts's per-call client), which upstream.ts does.
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
   * Answers a ping frame encountered while waiting for a real response, over
   * its own POST while the outer stream stays open. The answer must itself
   * land as 202-empty, matching `initialized`'s contract.
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
   * Sends one classified POST and awaits the matching JSON-RPC response by id.
   * For a `text/event-stream` response the body is parsed INCREMENTALLY during
   * `data` events (design D2): each completed payload is classified the instant
   * it is framed, a matching response destroys the socket and early-stops the
   * read, a `ping` is answered live over its own POST while the stream stays
   * open, and other payloads / notifications are ignored. A non-SSE
   * (`application/json`) body cannot early-stop, so it is read fully and
   * returned as a single payload for the caller to classify. Preserves the
   * two-phase deadline, cumulative `bytesLeft`, redirect refusal, non-2xx
   * drain-then-throw, and unsupported-content-type contracts.
   */
  function postClassified(body: object, ctx: ClassifyContext): Promise<ClassifiedResult> {
    return openPost(body, ctx.session, (res) => readClassified(res, ctx));
  }

  function readClassified(res: IncomingMessage, ctx: ClassifyContext): Promise<ClassifiedResult> {
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      res.destroy();
      return Promise.reject(new McpClientError("http_status", "MCP redirect refused", { status }));
    }
    const contentType = res.headers["content-type"] ?? "";
    if (status < 200 || status >= 300 || !contentType.includes("text/event-stream")) {
      // Non-2xx (whatever its content-type — a 404 dressed as SSE must still
      // classify http_status so the session-expiry retry and credential-error
      // mapping fire) or non-SSE: read fully via the buffered path, which
      // drains capped and throws http_status on a non-2xx. A single JSON body
      // cannot early-stop, so nothing is lost on the 2xx non-SSE path either.
      return handleBufferedResponse(res).then((r) => ({
        payloads: r.payloads,
        headers: r.headers,
      }));
    }
    return new Promise<ClassifiedResult>((resolve, reject) => {
      const parser = createSseParser();
      // Decode across chunk boundaries: a multi-byte UTF-8 char split between
      // two chunks must not corrupt (byte counting stays off-the-wire below).
      const decoder = new StringDecoder("utf8");
      const remaining = budget.deadline();
      // `done` guards single-settlement AND stops the read loop from doing more
      // work after a match / error. `pendingPings` chains every live ping
      // answer; a match awaits it before resolving so a ping-then-response body
      // still POSTs its answer, and a ping-answer failure still surfaces.
      let done = false;
      let pingError: unknown;
      let pendingPings: Promise<void> = Promise.resolve();
      const timer = setTimeout(
        () => {
          if (done) return;
          done = true;
          res.destroy();
          reject(new McpClientError("timeout", "MCP response body read timed out"));
        },
        Math.max(0, remaining),
      );
      const rejectOnce = (err: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res.destroy();
        reject(err);
      };
      const resolveMatch = (matched: NonNullable<ClassifiedResult["matched"]>): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res.destroy();
        // Await any queued ping answers first (a ping-then-response body must
        // still POST its answer). A ping-answer failure surfaces as the outer
        // rejection, matching the pre-restructure sequential contract.
        pendingPings.then(() => {
          if (pingError !== undefined) reject(pingError);
          else resolve({ matched, payloads: [], headers: res.headers });
        });
      };

      const consume = (payload: string): boolean => {
        let messages: WireMessage[];
        try {
          messages = classifyJsonRpc(payload, ctx.expectedId, ctx.allowBatch);
        } catch (cause) {
          rejectOnce(new McpClientError("protocol", describeWireError(cause), { cause }));
          return true;
        }
        for (const msg of messages) {
          if (msg.kind === "response") {
            resolveMatch({
              id: msg.message.id,
              result: msg.message.result,
              ...(msg.message.error !== undefined ? { error: msg.message.error } : {}),
            });
            return true;
          }
          if (msg.kind === "ping") {
            const pingSession = ctx.session;
            if (pingSession === undefined) {
              rejectOnce(
                new McpClientError(
                  "protocol",
                  "MCP server sent a ping before a session was established",
                ),
              );
              return true;
            }
            // Answer live over a separate POST without blocking further data
            // events. A ping-answer failure settle-rejects the outer wait.
            pendingPings = pendingPings.then(() =>
              answerPing(msg.id, pingSession).catch((err: unknown) => {
                // Record so a match already awaiting `pendingPings` rejects with
                // it; also settle-reject directly if nothing has matched yet.
                if (pingError === undefined) pingError = err;
                rejectOnce(err);
              }),
            );
          }
          // "other": ignored — not the response we're waiting for.
        }
        return false;
      };

      res.on("data", (chunk: Buffer) => {
        if (done) return;
        bytesLeft -= chunk.byteLength;
        if (bytesLeft < 0) {
          rejectOnce(new McpClientError("cap", "MCP response exceeded the cumulative byte budget"));
          return;
        }
        for (const payload of parser.push(decoder.write(chunk))) {
          if (consume(payload)) return;
        }
      });
      res.on("end", () => {
        if (done) return;
        const tail = decoder.end();
        if (tail !== "") {
          for (const payload of parser.push(tail)) {
            if (consume(payload)) return;
          }
          if (done) return;
        }
        for (const payload of parser.flush()) {
          if (consume(payload)) return;
        }
        if (done) return;
        // Stream ended with no match: wait for any in-flight ping answer to
        // settle (it may still fail the outer op) before reporting no-match.
        pendingPings.then(() =>
          rejectOnce(new McpClientError("protocol", "MCP response never carried the expected id")),
        );
      });
      res.on("error", (err) => {
        rejectOnce(new McpClientError("network", "MCP response stream failed", { cause: err }));
      });
    });
  }

  /**
   * Sends one request and awaits the matching JSON-RPC response by id. For an
   * SSE response the read early-stops at the match (design D2); pings seen
   * along the way are answered live. A non-SSE body is classified here from the
   * single returned payload.
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
    const { matched, payloads, headers } = await postClassified(body, {
      expectedId,
      allowBatch,
      ...(session !== undefined ? { session } : {}),
    });
    if (matched !== undefined) {
      return {
        result: matched.result,
        headers,
        ...(matched.error !== undefined ? { error: matched.error } : {}),
      };
    }
    // Non-SSE path: classify the buffered payloads here. A ping in a
    // fully-buffered body is answered before continuing.
    for (const payload of payloads) {
      let messages: WireMessage[];
      try {
        messages = classifyJsonRpc(payload, expectedId, allowBatch);
      } catch (cause) {
        throw new McpClientError("protocol", describeWireError(cause), { cause });
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
        // "other": ignored.
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
          // Headers arrived: disarm the pre-response timer, then arm a
          // SEPARATE drain deadline from the remaining budget. Without it, a
          // server that sends headers but never ends the body would leave this
          // promise pending forever — and dispose() awaits it in a `finally`,
          // so one broken upstream would hang every execution that opened a
          // session to it (design D2: a capped, deadline-bounded DELETE).
          req.setTimeout(0);
          const status = res.statusCode ?? 0;
          const drainTimer = setTimeout(
            () => {
              res.destroy();
              reject(new McpClientError("timeout", "MCP session DELETE body drain timed out"));
            },
            Math.max(0, budget.deadline()),
          );
          const settle = (fn: () => void): void => {
            clearTimeout(drainTimer);
            fn();
          };
          res.resume(); // drain, no body needed
          res.on("end", () => {
            settle(() => {
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
          });
          res.on("error", (err) => {
            settle(() =>
              reject(
                new McpClientError("network", "MCP session DELETE response stream failed", {
                  cause: err,
                }),
              ),
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
