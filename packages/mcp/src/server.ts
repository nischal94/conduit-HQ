import { buildExecuteTool } from "@conduithq/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool as McpToolDefinition,
} from "@modelcontextprotocol/sdk/types.js";
import type { RpcRequest, RpcResponse } from "./daemon/rpc.js";
import {
  type CatalogListing,
  CHECK_EXECUTION_TOOL,
  type CheckPayload,
  type ExecutePayload,
  extendExecuteDefinition,
  toTextResult,
} from "./payloads.js";

/**
 * The daemon seam (D-B1). One call, one round trip, capability `serve`.
 *
 * The stdio server holds NO store: since Task 6 the daemon is the sole
 * opener of `~/.conduit/conduit.db`, and every read this server performs
 * is an RPC. That is the §9.2 payoff of the process split — credentials
 * resolve inside the daemon and never enter the process the agent talks
 * to — and it only holds because this seam is a fixed, narrow RPC
 * vocabulary rather than a store proxy (design §3.3).
 *
 * Injected rather than imported so ring-1 tests can drive the whole MCP
 * surface against a fake daemon with no sockets, exactly as they
 * previously drove it against an in-memory store.
 */
export type DaemonCall = (request: RpcRequest) => Promise<RpcResponse>;

export interface ConduitMcpServerOptions {
  /** Every store read and every execution goes through here. */
  daemon: DaemonCall;
  /**
   * Operator diagnostics. MUST write to stderr in the stdio server —
   * stdout carries protocol frames only (M8).
   *
   * There is deliberately no `now` seam any more: the one time-dependent
   * decision this surface made (presenting a `paused` execution past its
   * TTL as `expired`) is computed daemon-side on the daemon's clock, so
   * the serve process no longer reads a clock at all.
   */
  log?: (line: string) => void;
}

/**
 * How long the daemon may spend admitting one `execute` to its queue.
 *
 * Bounds ADMISSION only, never execution: §16's wall-clock budget stays
 * with the manager's own limits (Lane A ruling 2). Sized well above the
 * daemon's own queue behavior so an execute that is merely waiting its
 * turn behind the concurrency cap is not refused as `busy`, while a
 * genuinely wedged queue still yields a typed answer rather than hanging
 * the agent's tool call to its own client-side timeout.
 */
export const EXECUTE_ADMISSION_DEADLINE_MS = 60_000;

/**
 * Unwraps an `RpcResponse` into its payload, converting every non-result
 * into the McpError the agent should see.
 *
 * The three outcomes are genuinely different and must not collapse:
 * `result` is the answer; `error` is the daemon's own typed refusal,
 * whose message is already client-safe by construction (`connection.ts`
 * sends a fixed string for `internal` and echoes only the client's own
 * protocol faults); and `outcome-unknown` is §5's ambiguity, which is NOT
 * an error to retry but a verdict to report — the request may have run.
 */
function unwrap(response: RpcResponse, log: (line: string) => void, context: string): unknown {
  if (response.kind === "result") return response.payload;
  if (response.kind === "outcome-unknown") {
    // §5: never retried, never silently converted into a failure. The
    // agent is told the outcome is genuinely unknown so it looks the
    // execution up rather than re-issuing it — a replayed tool call is a
    // side effect the operator never authorized.
    log(
      `[ConduitMcp] ${context}: outcome unknown — the daemon connection was lost after the request was sent. Context: {requestId: ${response.requestId}}`,
    );
    throw new McpError(
      ErrorCode.InternalError,
      `[ConduitMcp] The outcome of this ${context} is UNKNOWN: the daemon connection was lost after the request was sent, so it may or may not have run (requestId ${response.requestId}). Do NOT retry it — look it up with check_execution instead.`,
    );
  }
  if (response.kind === "error") {
    log(
      `[ConduitMcp] ${context} refused by the daemon. Context: {code: ${response.code}, requestId: ${response.requestId}}`,
    );
    throw new McpError(
      ErrorCode.InternalError,
      `[ConduitMcp] ${context} failed (${response.code}): ${response.message}`,
    );
  }
  // `ready` / `handshake.ok` are protocol prefaces the client already
  // consumed; seeing one here means the response stream desynced.
  log(`[ConduitMcp] ${context} got an out-of-band frame. Context: {kind: ${response.kind}}`);
  throw new McpError(ErrorCode.InternalError, `[ConduitMcp] ${context} failed: protocol desync.`);
}

/**
 * Boundary cast (design note, mcp task 7): the sdk's `JsonSchema` is kept
 * structural (`Record<string, unknown>`, shared with OpenAPI/MCP ingestion —
 * types.ts), while the MCP SDK's `Tool.inputSchema` is a narrower zod-derived
 * shape (`{ type: "object", properties?, required?, [k: string]: unknown }`).
 * Every definition this server emits (`buildExecuteTool` + `extendExecuteDefinition`,
 * and `CHECK_EXECUTION_TOOL`) already produces `{ type: "object", ... }` — this
 * cast documents that structural equivalence at the one seam where the two
 * schema vocabularies meet, rather than widening either type with `any`.
 */
function toMcpTool(definition: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): McpToolDefinition {
  return definition as unknown as McpToolDefinition;
}

/**
 * Shared infra-fault redaction (finding 1, PR #29 review): an internal fault
 * (transport/daemon-unavailable) must never hand the client a raw cause —
 * `DaemonUnavailable` messages carry the state-directory path and the daemon
 * log location, which is operator information, not agent information.
 * Generates a fresh correlation id, logs the raw cause to the operator log,
 * and returns the generic client-facing error.
 */
function internalErrorFor(log: (line: string) => void, context: string, cause: unknown): McpError {
  const correlationId = `mcp_${Math.random().toString(36).slice(2, 10)}`;
  log(
    `[ConduitMcp] ${context} failed with an infra fault. Context: { correlationId: ${correlationId}, cause: ${String(cause)} }`,
  );
  return new McpError(
    ErrorCode.InternalError,
    `[ConduitMcp] Internal error (correlation ${correlationId}).`,
  );
}

export function createConduitMcpServer(options: ConduitMcpServerOptions): Server {
  const { daemon } = options;
  const log = options.log ?? ((line: string) => console.error(line));

  /**
   * One daemon round trip with uniform fault handling.
   *
   * An McpError thrown by `unwrap` is already the agent-facing verdict
   * and passes through untouched; anything else is a transport-level
   * fault (no daemon reachable, rotation in progress, a socket error) and
   * gets the redacted correlation-id treatment, because those messages
   * name paths and daemon internals the agent has no business seeing.
   */
  async function call(request: RpcRequest, context: string): Promise<unknown> {
    let response: RpcResponse;
    try {
      response = await daemon(request);
    } catch (cause) {
      throw internalErrorFor(log, context, cause);
    }
    return unwrap(response, log, context);
  }

  // NOTE: sandbox module-recovery diagnostics are registered by the
  // DAEMON now (`conduitd.ts`), not here. Since D-B1 this process runs no
  // sandbox at all, so a sink installed here could never fire.

  const server = new Server(
    { name: "conduit", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Fetched per tools/list, never cached: the daemon is the only
    // writer, so a source added by `add-mcp` through a DIFFERENT client
    // is visible on the very next listing with no restart. That is the
    // §17 startup-reload caveat closing (design §4) — and it is why the
    // M6 per-call snapshot workaround is no longer this process's
    // problem.
    const listing = (await call({ kind: "catalog.listing" }, "tools/list")) as CatalogListing;
    const definition = extendExecuteDefinition(
      buildExecuteTool({ connections: listing.connections }),
    );
    return { tools: [toMcpTool(definition), toMcpTool(CHECK_EXECUTION_TOOL)] };
  });

  /** M2: the low-level API validates nothing — the handler owns it, including
   * unknown-key rejection (`additionalProperties: false` is advertisement,
   * not enforcement). */
  function assertOnlyKeys(
    args: unknown,
    allowed: readonly string[],
    tool: string,
  ): Record<string, unknown> {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `[ConduitMcp] ${tool}: arguments must be an object.`,
      );
    }
    const record = args as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `[ConduitMcp] ${tool}: unknown argument ${JSON.stringify(key)}.`,
        );
      }
    }
    return record;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "execute") {
      const record = assertOnlyKeys(args ?? {}, ["code", "requestKey"], "execute");
      const code = record.code;
      const requestKey = record.requestKey;
      if (typeof code !== "string" || code === "") {
        throw new McpError(
          ErrorCode.InvalidParams,
          "[ConduitMcp] execute requires a non-empty string `code`.",
        );
      }
      if (requestKey !== undefined && typeof requestKey !== "string") {
        throw new McpError(
          ErrorCode.InvalidParams,
          "[ConduitMcp] `requestKey` must be a string when present.",
        );
      }
      // The execution runs in the DAEMON: its sandbox, its catalog, its
      // credentials. Nothing about this call resolves a secret in this
      // process, which is the §9.2 strengthening the process split buys.
      // The daemon returns the already-built ExecutePayload.
      const payload = await call(
        {
          kind: "execute",
          code,
          deadlineMs: EXECUTE_ADMISSION_DEADLINE_MS,
          ...(requestKey !== undefined ? { requestKey } : {}),
        },
        "execute",
      );
      return toTextResult(payload as ExecutePayload);
    }
    if (name === "check_execution") {
      const a = assertOnlyKeys(args ?? {}, ["executionId", "requestKey"], "check_execution");
      const executionId = a.executionId;
      const requestKey = a.requestKey;
      if (typeof executionId !== "string" && typeof requestKey !== "string") {
        throw new McpError(
          ErrorCode.InvalidParams,
          "[ConduitMcp] check_execution requires `executionId` or `requestKey` (exactly one; strings).",
        );
      }
      if (typeof executionId === "string" && typeof requestKey === "string") {
        throw new McpError(
          ErrorCode.InvalidParams,
          "[ConduitMcp] check_execution takes `executionId` OR `requestKey`, not both.",
        );
      }
      // The CheckPayload is computed daemon-side on the DAEMON's clock
      // (controller ruling): the `paused`-past-TTL → `expired` comparison
      // belongs to the process that owns the row, so a serve process with
      // a skewed clock cannot present a live approval as expired.
      const payload = await call(
        typeof executionId === "string"
          ? { kind: "execution.get", executionId }
          : { kind: "execution.getByRequestKey", requestKey: requestKey as string },
        "check_execution",
      );
      return toTextResult(payload as CheckPayload);
    }
    throw new McpError(ErrorCode.InvalidParams, `[ConduitMcp] Unknown tool: ${name}`);
  });

  return server;
}
