import {
  buildExecuteTool,
  type ConduitStore,
  type Execution,
  type ExecutionOutcome,
} from "@conduithq/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool as McpToolDefinition,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CHECK_EXECUTION_TOOL,
  executionToCheckPayload,
  extendExecuteDefinition,
  outcomeToPayload,
  toTextResult,
} from "./payloads.js";
import { createApprovalRuntime } from "./runtime.js";

export interface ConduitMcpServerOptions {
  store: ConduitStore;
  /** §9.3 opt-in (CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS). Default false — fail closed. */
  allowPrivateEgress?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * One line per namespace by construction — §18 v1: single connection per
 * namespace; the invoker FAILS CLOSED on multi-connection integrations, so an
 * integration with >1 connection is deliberately NOT advertised ("every
 * advertised connection is selectable" — design M6). Ambiguous namespaces get
 * one stderr line so the operator knows why they're absent.
 */
async function listConnections(
  store: ConduitStore,
  log: (line: string) => void,
): Promise<{ prefix: string; label: string }[]> {
  const [connections, integrations] = await Promise.all([
    store.connections.list(),
    store.integrations.list(),
  ]);
  const namespaceById = new Map(integrations.map((i) => [i.id, i.namespace]));
  const byIntegration = new Map<string, typeof connections>();
  for (const c of connections) {
    byIntegration.set(c.integrationId, [...(byIntegration.get(c.integrationId) ?? []), c]);
  }
  const listed: { prefix: string; label: string }[] = [];
  for (const [integrationId, group] of byIntegration) {
    const namespace = namespaceById.get(integrationId) ?? "unknown";
    if (group.length === 1 && group[0] !== undefined) {
      listed.push({ prefix: group[0].prefix, label: `${namespace} tools` });
    } else {
      log(
        `[ConduitMcp] namespace ${namespace} has ${group.length} connections — v1 addressing is single-connection per namespace (§18); not advertised.`,
      );
    }
  }
  return listed;
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
 * (store/hydrate/upstream) must never hand the client a raw cause — same
 * treatment `execute`'s manager.start catch already applied, now shared with
 * check_execution's store reads. Generates a fresh correlation id, logs the
 * raw cause to the operator log, and returns the generic client-facing error.
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
  const { store } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => Date.now());

  const server = new Server(
    { name: "conduit", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const definition = extendExecuteDefinition(
      buildExecuteTool({ connections: await listConnections(store, log) }),
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
      // M6: fresh catalog snapshot + fresh manager per call (sync makeToolHost
      // is fixed at manager creation; composing per-call is the recorded fix).
      const { manager } = await createApprovalRuntime({
        store,
        allowPrivateEgress: options.allowPrivateEgress === true,
        log,
      });
      let outcome: ExecutionOutcome;
      try {
        outcome = await manager.start(code, requestKey !== undefined ? { requestKey } : undefined);
      } catch (cause) {
        throw internalErrorFor(log, "execute", cause);
      }
      return toTextResult(outcomeToPayload(outcome));
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
      let execution: Execution | undefined;
      try {
        execution =
          typeof executionId === "string"
            ? await store.executions.get(executionId)
            : await store.executions.getByRequestKey(requestKey as string);
      } catch (cause) {
        throw internalErrorFor(log, "check_execution", cause);
      }
      return toTextResult(executionToCheckPayload(execution, now()));
    }
    throw new McpError(ErrorCode.InvalidParams, `[ConduitMcp] Unknown tool: ${name}`);
  });

  return server;
}
