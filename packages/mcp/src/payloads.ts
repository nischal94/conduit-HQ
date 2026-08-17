import type {
  ConduitStore,
  ExecuteToolDefinition,
  Execution,
  ExecutionOutcome,
  JsonSchema,
  PendingApproval,
  ResumeOutcome,
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

/**
 * The `approvals.resume` projection — `ExecutePayload` plus the one field
 * the operator-facing verb contract cannot be honored without.
 *
 * **Why `decisionApplied` is on the wire.** `conduit approvals` reports the
 * OPERATOR'S VERB, and the verb's success is whether the staged decision was
 * consumed by the pending call — host-side truth the invoker records (sdk
 * D6). It is deliberately NOT derivable from anything else here: an applied
 * deny can present as `completed` (the guest caught the block) and an
 * unapplied one as `failed` with a guest-forged `ConduitPolicyBlocked` name,
 * so a client keying on status or error name gets the answer wrong in both
 * directions. Dropping the field would silently degrade the daemon path to
 * exactly the name-matching PR #40 removed.
 *
 * **Why it is still a projection, not the raw `ResumeOutcome`.** The raw
 * outcome carries `SandboxError` and `PendingApproval` straight off the
 * pipeline, and `PendingApproval.input` is the paused call's ARGUMENTS.
 * Widening the RESPONSE of an existing kind with one boolean is not a
 * capability widening — `approvals` could already call `approvals.resume`
 * and already learned the drive's fate — but shipping the raw row would be
 * a shape regression against the §3.3 rule that the socket carries service
 * operations, never database access. Nothing here is credential-bearing.
 */
export type ResumePayload = ExecutePayload & { decisionApplied: boolean };

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

/**
 * The `catalog.listing` projection (D-B1): everything the stdio server
 * needs to build `tools/list` and its startup diagnostics, and nothing
 * else.
 *
 * Deliberately a PROJECTION rather than the repository rows it derives
 * from. `store.connections.list()` returns rows carrying `credentialRef`,
 * and putting that shape on the socket would hand an agent-facing client
 * a handle to stored credential material — precisely the §3.3.1 failure
 * mode the capability split exists to prevent. Here the daemon decides
 * what is advertisable and sends only that: an addressing prefix and a
 * human label.
 */
export interface CatalogListing {
  connections: ConnectionListingView[];
  /** Drives the "0 sources — onboard one" startup hint; a count, never the rows. */
  sourceCount: number;
}

export interface ConnectionListingView {
  /** Addressing prefix, e.g. `github.acme.prod`. */
  prefix: string;
  /** Human label, e.g. `github tools`. */
  label: string;
}

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

/**
 * Projects a `ResumeOutcome` for the `approvals.resume` response.
 *
 * Reuses `outcomeToPayload` for the drive-outcome half rather than
 * re-deriving it, so the two answers can never disagree about how a given
 * status presents, and attaches the independent `decisionApplied` axis. See
 * `ResumePayload` for why that field is on the wire.
 */
export function resumeToPayload(outcome: ResumeOutcome): ResumePayload {
  return { ...outcomeToPayload(outcome), decisionApplied: outcome.decisionApplied };
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

/**
 * Builds the `catalog.listing` projection from a live store. Runs
 * DAEMON-SIDE (D-B1) — it moved here from `server.ts` when the stdio
 * server stopped holding a store of its own, and this is now the only
 * place the connection rows are read.
 *
 * One line per namespace by construction — §18 v1: single connection per
 * namespace; the invoker FAILS CLOSED on multi-connection integrations, so
 * an integration with >1 connection is deliberately NOT advertised ("every
 * advertised connection is selectable" — design M6). Ambiguous namespaces
 * get one log line so the operator knows why they're absent; that line now
 * lands in the daemon's log rather than the serve process's stderr, which
 * is where the store it describes actually lives.
 */
export async function buildCatalogListing(
  store: ConduitStore,
  log: (line: string) => void,
): Promise<CatalogListing> {
  const [connections, integrations, sources] = await Promise.all([
    store.connections.list(),
    store.integrations.list(),
    store.sources.list(),
  ]);
  const namespaceById = new Map(integrations.map((i) => [i.id, i.namespace]));
  const byIntegration = new Map<string, typeof connections>();
  for (const c of connections) {
    byIntegration.set(c.integrationId, [...(byIntegration.get(c.integrationId) ?? []), c]);
  }
  const listed: ConnectionListingView[] = [];
  for (const [integrationId, group] of byIntegration) {
    const namespace = namespaceById.get(integrationId) ?? "unknown";
    const only = group[0];
    if (group.length === 1 && only !== undefined) {
      // ONLY prefix and label cross the socket. `only` also carries
      // `credentialRef`; spreading the row here instead of naming two
      // fields is how a credential handle would reach an agent-facing
      // client, so the field list is the boundary and stays explicit.
      listed.push({ prefix: only.prefix, label: `${namespace} tools` });
    } else {
      log(
        `[ConduitMcp] namespace ${namespace} has ${group.length} connections — v1 addressing is single-connection per namespace (§18); not advertised.`,
      );
    }
  }
  return { connections: listed, sourceCount: sources.length };
}
