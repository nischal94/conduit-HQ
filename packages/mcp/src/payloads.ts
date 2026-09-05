import type {
  ConduitStore,
  ExecuteToolDefinition,
  Execution,
  ExecutionOutcome,
  JsonSchema,
  PendingApproval,
  ResumeOutcome,
} from "@conduithq/sdk";
import type { ProvisionPayload } from "./daemon/provision.js";
import type { RpcRequest } from "./daemon/rpc.js";

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

/**
 * The legal `status` value-sets, in ONE place and DERIVED-FROM rather than
 * merely checked-against (Codex ARC F6). Every payload union's status field
 * is `typeof <CONST>[number]`, so the constant is the single source of truth
 * that BOTH ends read: the daemon's projections build these members and the
 * client's guard (`client.ts`, via the `is*PayloadShape` predicates below)
 * validates them. Adding a member to the union now means adding it to the
 * constant, which the guard reads automatically — there is no second list to
 * forget. Removing this indirection (re-inlining the literals in the
 * interface) is what let a sender grow a new status the guard silently
 * accepted; the `satisfies` bindings on the projection functions below make
 * the reverse — a sender emitting a status NOT in the set — a compile error.
 */
export const EXECUTE_STATUSES = ["completed", "failed", "paused", "expired", "conflict"] as const;
export type ExecuteStatus = (typeof EXECUTE_STATUSES)[number];

export const CHECK_BODY_STATUSES = ["running", "completed", "failed", "paused", "expired"] as const;
export type CheckBodyStatus = (typeof CHECK_BODY_STATUSES)[number];

export interface ExecutePayload {
  status: ExecuteStatus;
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
  status: CheckBodyStatus;
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

/**
 * The `daemon.status` projection (§3.1): a snapshot computed daemon-side,
 * with defined metric semantics, and no credential-adjacent material —
 * the same §3.3 boundary `CatalogListing` draws. `logPath`/`logSizeBytes`
 * are `null` when the daemon logs to a TTY rather than a file.
 */
export interface DaemonStatusPayload {
  pid: number;
  agentVersion: string;
  /** Epoch ms the daemon's serve loop started. */
  startedAt: number;
  dbPath: string;
  /** READY-granted open sockets, the asking connection included. */
  connections: number;
  /** Queue entries currently running. */
  executionsInFlight: number;
  /** Queue entries admitted and waiting. */
  queueDepth: number;
  logPath: string | null;
  logSizeBytes: number | null;
}

export interface DaemonStopPayload {
  stopping: true;
}

/**
 * The `approvals.list` projection — one row per paused execution.
 *
 * A PROJECTION for the same §3.3 reason as `ResumePayload`: the stored
 * `Execution.pausedOn` is a raw `PendingApproval`, and `PendingApproval.input`
 * is the paused call's ARGUMENTS — agent-supplied values that can carry
 * whatever the tool call was given. The operator-facing `conduit approvals
 * list` reads only the tool name and the expiry, so shipping the raw row would
 * put sensitive call arguments on the socket to buy nothing. The field list
 * here IS the boundary and stays explicit.
 *
 * `reason` is included because it is the approval's human-facing WHY — the
 * one thing an operator deciding on a paused call needs beyond its name — and
 * it is authored by the policy layer, not by the agent's arguments.
 */
export interface PausedListRow {
  executionId: string;
  /** The pending call this row is waiting on; `approvals.resume` must name it. */
  callId: string;
  startedAt: number;
  toolName: string;
  reason: string;
  expiresAt: number;
}

/**
 * The request-kind → result-payload correspondence, in ONE place.
 *
 * Before this map the correspondence existed only in the heads of the
 * people writing call sites: `RpcResponse`'s `result` arm types `payload`
 * as `unknown` (correctly — the daemon's decoder cannot know which kind it
 * is answering), and every caller recovered the shape with a bare `as`.
 * Six of those casts existed, and two of them DISAGREED about the same
 * wire kind, which is the tell that a cast is not a substitute for a
 * relationship the type system can check.
 *
 * Making it a mapped type rather than six annotations means the daemon's
 * senders and the clients' readers are checked against the SAME row: a
 * change to `PausedListRow` now breaks `approvals.ts` at compile time
 * instead of at an operator's terminal. Kinds whose payload is not a
 * defined projection (`handshake`, and the two whose answers the daemon
 * composes ad hoc) map to `unknown`, so nothing is silently claimed to be
 * typed that isn't.
 *
 * Compile-time ONLY. This buys inference at the call sites and nothing at
 * runtime — a daemon can still put anything on the wire, which is why the
 * seam in `client.ts` validates the dangerous shapes rather than trusting
 * this map. Types describe intent; the guard defends against the wire.
 */
export type RpcPayloadFor<K extends RpcRequest["kind"]> = K extends "catalog.listing"
  ? CatalogListing
  : K extends "execute"
    ? ExecutePayload
    : K extends "execution.get" | "execution.getByRequestKey"
      ? CheckPayload
      : K extends "approvals.list"
        ? PausedListRow[]
        : K extends "approvals.resume"
          ? ResumePayload
          : K extends "source.provision" | "source.revalidate"
            ? ProvisionPayload
            : K extends "daemon.status"
              ? DaemonStatusPayload
              : K extends "daemon.stop"
                ? DaemonStopPayload
                : unknown;

/**
 * Projects one paused `Execution` for the `approvals.list` response.
 *
 * Returns `undefined` for a row with no `pausedOn`. The daemon lists only
 * `status: "paused"` rows, which always carry it (manager.ts invariant), so
 * this is defensive — but dropping such a row silently would tell an operator
 * that nothing awaits them, so the caller logs it rather than swallowing it.
 */
export function pausedToListRow(execution: Execution): PausedListRow | undefined {
  const pausedOn = execution.pausedOn;
  if (pausedOn === undefined) return undefined;
  return {
    executionId: execution.id,
    callId: pausedOn.callId,
    startedAt: execution.startedAt,
    toolName: pausedOn.toolName,
    reason: pausedOn.reason,
    expiresAt: pausedOn.expiresAt,
  };
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

/**
 * The runtime half of "single source of truth" (Codex ARC F6): each sender
 * projection asserts its own output against the SAME predicate the client
 * guard uses before returning it. The type system already makes an illegal
 * `status` literal a compile error (the status fields derive from the
 * constants, so a projection cannot even name a member outside the set), but
 * that is a claim about the STATIC code; this is the dynamic invariant that
 * the value the sender actually built passes the shape the receiver actually
 * checks. If a future projection arm drops `executionId` or is otherwise
 * malformed, this fails LOUDLY here — inside the daemon, at construction —
 * rather than silently on the wire as a client-side refusal an operator must
 * diagnose. It is a real internal-error-if-violated, never a silent pass.
 *
 * `guard` is passed rather than closed-over so this helper is agnostic to
 * which predicate binds which projection; the call sites name the pairing,
 * which is the thing under test.
 */
export function assertProjection<T>(
  payload: T,
  guard: (value: unknown) => value is T,
  projection: string,
): T {
  if (!guard(payload)) {
    throw new Error(
      `[payloads] ${projection} produced a payload its own shape predicate rejects. ` +
        `Context: {payload: ${JSON.stringify(payload)?.slice(0, 200)}} — this is an internal ` +
        "sender/predicate drift, not a client fault.",
    );
  }
  return payload;
}

export function outcomeToPayload(outcome: ExecutionOutcome): ExecutePayload {
  const payload = ((): ExecutePayload => {
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
  })();
  return assertProjection(payload, isExecutePayloadShape, "outcomeToPayload");
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
  const payload = { ...outcomeToPayload(outcome), decisionApplied: outcome.decisionApplied };
  return assertProjection(payload, isResumePayloadShape, "resumeToPayload");
}

export function executionToCheckPayload(
  execution: Execution | undefined,
  now: number,
): CheckPayload {
  const payload = ((): CheckPayload => {
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
  })();
  return assertProjection(payload, isCheckPayloadShape, "executionToCheckPayload");
}

export function toTextResult(payload: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // `!Array.isArray` matches `rpc.ts`'s reading: an array is an object, so
  // without it `[]` passes every shape guard's first hurdle and the field
  // checks below decide the answer on a value that was never a payload.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True iff `payload` is a well-formed `ExecutePayload`: a LEGAL `status`
 * member (not merely a string) and the fields every arm carries. The
 * per-arm mandatory field is `executionId` — a string on every arm, and the
 * one thing `check_execution` needs to look the execution up — so a
 * `completed`/`failed`/`paused` payload missing it is rejected here rather
 * than handed to the agent as a settled outcome it cannot act on.
 *
 * `result`/`error`/`pending`/`message` are deliberately NOT validated: they
 * are handed to the agent verbatim (JSON-stringified), so no client field
 * access can throw on them, and validating them here would be the drifting
 * second copy of the projection the guard's docblock rules out. The status
 * membership + `executionId` are the STRUCTURAL floor a consumer relies on.
 */
export function isExecutePayloadShape(payload: unknown): payload is ExecutePayload {
  if (!isRecord(payload)) return false;
  if (!(EXECUTE_STATUSES as readonly string[]).includes(payload.status as string)) return false;
  return typeof payload.executionId === "string";
}

/**
 * True iff `payload` is a well-formed `ResumePayload`: an `ExecutePayload`
 * plus a boolean `decisionApplied`. Both axes are load-bearing — `status`
 * selects the CLI's entire output path and `decisionApplied` carries the
 * operator's verb truth (see `ResumePayload`) — so a break in either is a
 * false answer, and both are required here.
 */
export function isResumePayloadShape(payload: unknown): payload is ResumePayload {
  if (!isRecord(payload)) return false;
  const hasDecision = typeof payload.decisionApplied === "boolean";
  return hasDecision && isExecutePayloadShape(payload);
}

/**
 * True iff `payload` is a well-formed `CheckPayload`: either the bare
 * `{status: "not_found"}` (which carries no `executionId` — there is no
 * execution to name), or a body with a LEGAL body status and an
 * `executionId` string. Same membership-not-just-string reasoning as
 * `isExecutePayloadShape`.
 */
export function isCheckPayloadShape(payload: unknown): payload is CheckPayload {
  if (!isRecord(payload)) return false;
  if (payload.status === "not_found") return true;
  if (!(CHECK_BODY_STATUSES as readonly string[]).includes(payload.status as string)) return false;
  return typeof payload.executionId === "string";
}

/**
 * True iff `payload` is a well-formed `DaemonStatusPayload`.
 *
 * EVERY field is checked, because `conduit daemon status` interpolates every
 * one of them into the operator's report — this is the `isPausedRowShape`
 * situation, not the `isExecutePayloadShape` one: nothing here is handed
 * onward verbatim, so there is no field whose malformation is harmless.
 *
 * `startedAt` is checked as a non-negative SAFE INTEGER WITHIN THE VALID DATE
 * RANGE (CX6): it reaches `new Date(...).toISOString()`, which throws a
 * `RangeError` for any value outside ±8.64e15 ms — and `1e20` is finite, so a
 * plain finite check let a protocol fault through to a CLI-fatal stack trace
 * instead of the typed refusal it is. The remaining counters (`pid`,
 * `connections`, `executionsInFlight`, `queueDepth`) and `logSizeBytes` are
 * rendered and/or counted, so they are held to the same non-negative
 * safe-integer floor: a negative, fractional, or 2^53-imprecise count is a
 * malformed projection, not a value to print.
 *
 * `logPath`/`logSizeBytes` are NULLABLE by contract (the daemon logs to a
 * TTY when hand-started), so `null` is accepted and `undefined` is not: the
 * renderer's `?? "stderr (hand-started)"` would turn an ABSENT field into a
 * confident claim that the daemon is hand-started, which is a different
 * fact from "the daemon told us it has no log file".
 */
/** The maximum epoch-ms a JS `Date` can represent (±8.64e15). */
const MAX_DATE_MS = 8.64e15;

/** A non-negative integer safely representable and exactly rendered. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isDaemonStatusShape(payload: unknown): payload is DaemonStatusPayload {
  if (!isRecord(payload)) return false;
  if (typeof payload.agentVersion !== "string") return false;
  if (typeof payload.dbPath !== "string") return false;
  // `startedAt` must survive `new Date(v).toISOString()` AND render exactly:
  // an out-of-range value (e.g. 1e20) passes a finite check yet throws
  // RangeError, and a fractional value (e.g. 1.5) renders as a silently wrong
  // epoch-ms instant. It is a non-negative safe integer within the Date range.
  if (!isNonNegativeSafeInteger(payload.startedAt) || payload.startedAt > MAX_DATE_MS) {
    return false;
  }
  for (const field of ["pid", "connections", "executionsInFlight", "queueDepth"] as const) {
    if (!isNonNegativeSafeInteger(payload[field])) return false;
  }
  if (payload.logPath !== null && typeof payload.logPath !== "string") return false;
  if (payload.logSizeBytes !== null && !isNonNegativeSafeInteger(payload.logSizeBytes)) {
    return false;
  }
  return true;
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
