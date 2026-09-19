/**
 * Core data model (spec §3):
 *
 *   Source ──defines──> Integration ──has many──> Connection(s)
 *                            │
 *                            └──contains──> Tool(s) ──governed by──> Policy
 *   Execution ──makes──> Tool calls ──recorded as──> Trace events
 */

/** A JSON Schema document. Kept structural: OpenAPI and MCP both emit these natively. */
export type JsonSchema = Record<string, unknown>;

export type SourceType = "openapi" | "graphql" | "mcp" | "custom_js";

export type Projection = "code" | "direct" | "discovery";
export const PROJECTIONS: readonly Projection[] = ["code", "direct", "discovery"];
export type ExecutionKind = "code" | "direct";
export type ResultState = "delivered" | "retained" | "discarded";

/**
 * §4.1: every row written by this build stores this program in `code`
 * (the real program moves to `program`). An OLDER build ignores the new
 * columns, reads `code`, and fails the row closed instead of resuming a
 * direct row as an empty program or a narrowed code row under the
 * unscoped invoker. Verbatim; the string is part of the downgrade contract.
 */
export const NEWER_BUILD_SENTINEL = 'throw new Error("conduit: row written by a newer build")';

/** Raw input to ingestion: where a catalog of tools comes from. */
export interface Source {
  id: string;
  type: SourceType;
  /** Groups and addresses this source's tools, e.g. "github" → `github.issues.create`. */
  namespace: string;
  /** Spec URL, GraphQL endpoint, or MCP server URL. */
  location: string;
  /** Required when an OpenAPI document has relative `servers` entries (spec §7). */
  baseUrl?: string;
  /**
   * §4.1a provenance, allocated by SQLite triggers. Present on every
   * hydrated row; `sources.upsert` and `provisionSource` IGNORE it on write
   * (the database owns it). Required, per the spec (F11): callers that
   * construct a Source for a write pass `generation: 0` — the value is
   * never written.
   */
  generation: number;
}

/** What a Source defines. Describes the tool catalog; not live or authenticated on its own. */
export interface Integration {
  id: string;
  sourceId: string;
  namespace: string;
}

/** A configured instance of an Integration. Many per Integration; auth optional (spec §9.1). */
export interface Connection {
  id: string;
  integrationId: string;
  /** Addressing prefix: `service.<org-slug>.<env>` (spec §3). */
  prefix: string;
  /** Reference into the credential store. Never the secret itself (spec §9.2). */
  credentialRef?: string;
}

export type RiskClass = "safe" | "review" | "destructive";

/** Protocol-specific signals the riskClass classifier derives from (spec §10.1). */
export type SourceSemantics =
  | { kind: "openapi"; method: string; path: string }
  | { kind: "graphql"; operation: "query" | "mutation" }
  | { kind: "mcp"; upstreamName?: string; readOnlyHint?: boolean; destructiveHint?: boolean }
  | { kind: "custom_js"; declaredRisk: RiskClass };

/** One callable operation, normalized to the one tool shape (spec §4.1, §7). */
export interface Tool {
  /** Fully-qualified name, e.g. `github.issues.create`. */
  name: string;
  namespace: string;
  description?: string;
  inputSchema: JsonSchema;
  /** Permissive passthrough schema when the source declares none (spec §7). */
  outputSchema: JsonSchema;
  riskClass: RiskClass;
  sourceSemantics: SourceSemantics;
}

export type PolicyAction = "allow" | "require_approval" | "block";

/**
 * Per-tool control, seeded from riskClass defaults (spec §10.2).
 * Keyed by tool name so it persists across source refreshes; manual overrides
 * are never silently reverted (spec §7).
 */
export interface Policy {
  toolName: string;
  action: PolicyAction;
  seededFrom: RiskClass;
  manualOverride: boolean;
  /**
   * §11 per-tool additions to the builtin sensitive-key list: key names
   * (normalized matching, pipeline/redact.ts) masked in this tool's audit
   * Trace rows. Operator data — respected independently of manualOverride.
   */
  redactFields: string[];
}

export type ExecutionStatus = "running" | "paused" | "completed" | "failed" | "expired";

/**
 * A guest error, reduced to data (spec §16 sandbox boundary — no handles or
 * engine objects escape). Structural duplicate of sandbox/sandbox.ts's
 * SandboxError: importing that type here would cycle (sandbox.ts imports
 * Execution from this file), so the shape is pinned independently and both
 * sides must stay in agreement.
 */
export interface ExecutionError {
  name: string;
  message: string;
}

/**
 * One invocation of the `execute` tool. Pause/resume works by deterministic
 * replay (spec §5.5): the journal of tool-call results is the resume state —
 * on resume the code re-runs from the top against memoized results.
 */
export interface ExecutionBase {
  /** `exec_...` */
  id: string;
  status: ExecutionStatus;
  /**
   * The UNION, never bare `PendingApproval`: the hydrator casts parsed JSON
   * without validating; readers narrow through `isPendingApproval`, then
   * `hasProvenance` for the legacy arm (§4.1, rev 13).
   */
  pausedOn?: StoredPendingApproval;
  startedAt: number;
  endedAt?: number;
  /** Caller-generated correlation key (mcp design M1). Default profile: the
   * legacy column. Named client: the `request_keys` row (§4.1). */
  requestKey?: string;
  /** null = default profile (§4.1). Written for BOTH kinds at start. */
  clientId: string | null;
  /** Which profile FLAG this execution runs under; re-checked on every call. */
  projection: Projection;
  /** Persisted settle-state (mcp design M4): completed → result. undefined normalized to null at the surface. */
  result?: unknown;
  /** Persisted settle-state (mcp design M4): failed → error, ALWAYS present on a stored failed row. */
  error?: ExecutionError;
}

/** A direct row's stored canonical call. Provenance does NOT live here. */
export interface DirectCall {
  toolName: string;
  namespace: string;
  /** `JSON.stringify(input)` as the invoker computes it — the decisions-seam identity. */
  request: string;
}

// The valid (kind, projection) pairs are exactly three (§9.2): ("code","code"),
// ("direct","direct"), ("direct","discovery"). The pair is enforced in the TYPE
// (below), in fresh DDL (a CHECK), and read-side in hydration: independent
// guards would let {kind:"direct", projection:"code"} be authorized under the
// Code flag and dispatched through the direct arm.
export type Execution =
  | (Omit<ExecutionBase, "projection"> & {
      kind: "code";
      projection: "code";
      code: string;
      /** Recorded non-determinism, replayed verbatim on resume (spec §5.5). */
      seeds: { now: number; random: number };
    })
  | (Omit<ExecutionBase, "projection"> & {
      kind: "direct";
      projection: "direct" | "discovery";
      call: DirectCall;
      /** Set iff status is `completed` (§4.1 status table, rev 16). */
      resultState?: ResultState;
    });

export function isValidProjectionForKind(kind: ExecutionKind, projection: Projection): boolean {
  return kind === "code" ? projection === "code" : projection !== "code";
}

/**
 * A call waiting on a human (spec §10.2), as written by R1: provenance
 * included (§4.1). Expires per CONDUIT_APPROVAL_TTL (spec §5.5).
 */
export interface PendingApproval {
  callId: string;
  toolName: string;
  namespace: string;
  sourceGeneration: number;
  input: unknown;
  reason: string;
  expiresAt: number;
}

/** A pause written before R1: NO provenance. Resume fails it closed (§5.4 step 3). */
export type LegacyPendingApproval = Omit<PendingApproval, "namespace" | "sourceGeneration">;

export type StoredPendingApproval = PendingApproval | LegacyPendingApproval;

export function hasProvenance(pause: StoredPendingApproval): pause is PendingApproval {
  return "sourceGeneration" in pause;
}

/**
 * A call id no operator could have read off `approvals list`: empty or
 * ASCII whitespace only. ONE set, shared by the store's claim (SQL `trim`
 * over the same six characters), the wire decoder, the CLI argument check,
 * and the manager's entry check — deliberately not `trim()`, which is
 * Unicode-aware. Change all or none.
 */
export const NOT_NAMEABLE_CALL_ID = /^[ \t\n\v\f\r]*$/;

/**
 * The ONE definition of a well-formed stored pause (spec §5.5). The store
 * hydrates `paused_on` without validating it and the resume claim admits
 * any corrupt pause on purpose, so every reader that acts on a pending
 * approval — the manager before it stages a decision, the daemon's
 * `approvals.list` projection — must agree on what "corrupt" means, or a
 * row can be listed as decidable and then refused, or the reverse. A
 * corrupt pause is terminalized on resume and listed as a recovery row.
 */
export function isPendingApproval(value: unknown): value is StoredPendingApproval {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const baseOk =
    typeof v.callId === "string" &&
    !NOT_NAMEABLE_CALL_ID.test(v.callId) &&
    typeof v.toolName === "string" &&
    "input" in v &&
    typeof v.reason === "string" &&
    typeof v.expiresAt === "number" &&
    Number.isFinite(v.expiresAt);
  if (!baseOk) return false;
  const hasNamespace = "namespace" in v;
  const hasGeneration = "sourceGeneration" in v;
  if (!hasNamespace && !hasGeneration) return true; // legacy arm
  return (
    hasNamespace &&
    hasGeneration &&
    typeof v.namespace === "string" &&
    typeof v.sourceGeneration === "number" &&
    Number.isFinite(v.sourceGeneration)
  );
}

/** One tool call as recorded for audit (spec §11). NOT the replay source —
 * that is the separate replay journal (§5.5 design D4). */
export interface TraceEvent {
  callId: string;
  executionId: string;
  /** `namespace.tool` */
  toolName: string;
  connectionPrefix: string;
  /** §4.3 (D4): attribution lands at append time; audit rows are write-once. */
  projection: Projection;
  clientId: string | null;
  /** Redacted at append time (§11): builtin sensitive keys + the tool
   * policy's redactFields are masked before the row is written. */
  input: unknown;
  /** Display projection: redact-then-slice of the upstream result (§11),
   * always a serialized string. The full result lives only in the replay
   * journal (D4/D7). */
  outputSummary?: string;
  upstreamStatus?: number;
  latencyMs?: number;
  policyVerdict: PolicyAction;
  at: number;
}
