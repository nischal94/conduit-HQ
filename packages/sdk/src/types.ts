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
export interface Execution {
  /** `exec_...` */
  id: string;
  code: string;
  status: ExecutionStatus;
  /** Recorded non-determinism, replayed verbatim on resume (spec §5.5). */
  seeds: { now: number; random: number };
  pausedOn?: PendingApproval;
  startedAt: number;
  endedAt?: number;
  /** Caller-generated correlation key (mcp design M1); unique, persisted before the sandbox runs. */
  requestKey?: string;
  /** Persisted settle-state (mcp design M4): completed → result. undefined normalized to null at the surface. */
  result?: unknown;
  /** Persisted settle-state (mcp design M4): failed → error, ALWAYS present on a stored failed row. */
  error?: ExecutionError;
}

/** A call waiting on a human (spec §10.2). Expires per CONDUIT_APPROVAL_TTL (spec §5.5). */
export interface PendingApproval {
  callId: string;
  toolName: string;
  input: unknown;
  reason: string;
  expiresAt: number;
}

/** One tool call as recorded for audit (spec §11). NOT the replay source —
 * that is the separate replay journal (§5.5 design D4). */
export interface TraceEvent {
  callId: string;
  executionId: string;
  /** `namespace.tool` */
  toolName: string;
  connectionPrefix: string;
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
