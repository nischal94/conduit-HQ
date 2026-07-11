import type {
  ExecuteToolDefinition,
  Execution,
  ExecutionOutcome,
  JsonSchema,
  PendingApproval,
} from "@conduithq/sdk";

/** Shared agent-visible error envelope (design M8). */
export interface ErrorEnvelope {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
}

export interface PendingView {
  toolName: string;
  reason: string;
  expiresAt: number;
}

export interface ExecutePayload {
  status: "completed" | "failed" | "paused" | "expired" | "conflict";
  executionId: string;
  result?: unknown;
  error?: ErrorEnvelope;
  pending?: PendingView;
  message?: string;
}

/** Independent of ExecutePayload — check adds "running"/"not_found" states. */
export interface CheckPayloadBody {
  status: "running" | "completed" | "failed" | "paused" | "expired";
  executionId: string;
  result?: unknown;
  error?: ErrorEnvelope;
  pending?: PendingView;
  message?: string;
}
export type CheckPayload = { status: "not_found" } | CheckPayloadBody;

/** ~4 chars/token heuristic, same shape as the sdk's estimateTokens. */
export function estimateDefinitionTokens(definition: unknown): number {
  return Math.ceil(JSON.stringify(definition).length / 4);
}

const PAUSE_MESSAGE =
  "A human must approve this call out-of-band. Report the pending approval and this " +
  "executionId to the user, then STOP — do not poll in a loop; approval may take hours. " +
  "When the user says it is approved, call check_execution with this executionId (or your requestKey).";

const EXPIRED_MESSAGE =
  "The approval expired before a human decided (TTL lapsed). You may re-issue execute to retry.";

const CONFLICT_MESSAGE =
  "This requestKey was already used by an earlier execute call. Call check_execution with the " +
  "requestKey to retrieve that execution's outcome instead of re-running.";

export const CHECK_EXECUTION_TOOL: {
  name: "check_execution";
  description: string;
  inputSchema: JsonSchema;
} = {
  name: "check_execution",
  description:
    "Check a Conduit execution started by the execute tool. Identify it by executionId or by the " +
    "requestKey you passed to execute. Returns status plus: pending (paused), result (completed — " +
    "a null result can be legitimate), or error (failed). Note: under the single-process runtime, " +
    "'running' can also mean the host that ran it crashed.",
  inputSchema: {
    type: "object",
    properties: {
      executionId: { type: "string", description: "The exec_… id returned by execute." },
      requestKey: { type: "string", description: "The correlation key you passed to execute." },
    },
    additionalProperties: false,
  },
};

/** Adds the optional requestKey input (design M1) to the sdk's canonical definition. */
export function extendExecuteDefinition(def: ExecuteToolDefinition): ExecuteToolDefinition {
  const properties = {
    ...(def.inputSchema.properties as Record<string, unknown>),
    requestKey: {
      type: "string",
      description:
        "Optional correlation key you generate. Persisted before the run starts, so if this " +
        "response is lost you can recover the outcome via check_execution({ requestKey }). " +
        "Reuse of a key never starts a second execution.",
    },
  };
  return { ...def, inputSchema: { ...def.inputSchema, properties } };
}

/** Known-cause hints keyed on error text (bounded, documented — not a denylist). */
function hintFor(message: string): string | undefined {
  if (/egress/i.test(message)) {
    return (
      "Blocked by the §9.3 egress policy (private address). A deliberate operator-level " +
      "override exists — see the Conduit server log and troubleshooting docs."
    );
  }
  return undefined;
}

export function toErrorEnvelope(error: { name: string; message: string }): ErrorEnvelope {
  const hint = hintFor(error.message);
  return {
    code: error.name,
    message: error.message,
    ...(hint !== undefined ? { hint } : {}),
    retryable: false,
  };
}

function toPendingView(pending: PendingApproval): PendingView {
  return { toolName: pending.toolName, reason: pending.reason, expiresAt: pending.expiresAt };
}

export function outcomeToPayload(outcome: ExecutionOutcome): ExecutePayload {
  switch (outcome.status) {
    case "completed":
      return {
        status: "completed",
        executionId: outcome.executionId,
        result: outcome.value ?? null,
      };
    case "failed":
      return {
        status: "failed",
        executionId: outcome.executionId,
        error: toErrorEnvelope(outcome.error),
      };
    case "paused":
      return {
        status: "paused",
        executionId: outcome.executionId,
        pending: toPendingView(outcome.pending),
        message: PAUSE_MESSAGE,
      };
    case "expired":
      return { status: "expired", executionId: outcome.executionId, message: EXPIRED_MESSAGE };
    case "conflict":
      return { status: "conflict", executionId: outcome.executionId, message: CONFLICT_MESSAGE };
  }
}

export function executionToCheckPayload(
  execution: Execution | undefined,
  now: number,
): CheckPayload {
  if (execution === undefined) {
    return { status: "not_found" };
  }
  switch (execution.status) {
    case "running":
      return { status: "running", executionId: execution.id };
    case "paused": {
      const pending = execution.pausedOn;
      if (pending !== undefined && now > pending.expiresAt) {
        // Read-only expired presentation (design M1): the durable lazy
        // expiry-on-resume transition is untouched; we only present.
        return { status: "expired", executionId: execution.id, message: EXPIRED_MESSAGE };
      }
      return {
        status: "paused",
        executionId: execution.id,
        ...(pending !== undefined
          ? { pending: toPendingView(pending), message: PAUSE_MESSAGE }
          : {}),
      };
    }
    case "completed":
      return { status: "completed", executionId: execution.id, result: execution.result ?? null };
    case "failed":
      return {
        status: "failed",
        executionId: execution.id,
        error: toErrorEnvelope(
          execution.error ?? {
            name: "ConduitUnknownError",
            message: "failed with no recorded error (legacy row)",
          },
        ),
      };
    case "expired":
      return { status: "expired", executionId: execution.id, message: EXPIRED_MESSAGE };
  }
}

export function toTextResult(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}
