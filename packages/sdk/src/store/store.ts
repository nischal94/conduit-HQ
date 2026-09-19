import type {
  Connection,
  Execution,
  ExecutionError,
  ExecutionKind,
  Integration,
  PendingApproval,
  Policy,
  Source,
  Tool,
  TraceEvent,
} from "../types.js";

/**
 * The storage seam (spec §5.2, §20): everything above this interface is
 * engine-agnostic. The libSQL/SQLite implementation serves local + Docker;
 * a D1-backed one must satisfy this same contract for Worker parity — SQL
 * never leaks past this boundary.
 *
 * Deliberately narrow: methods exist because a caller needs them, not for
 * repository-pattern completeness.
 */
export interface ConduitStore {
  readonly sources: SourceRepository;
  readonly integrations: IntegrationRepository;
  readonly connections: ConnectionRepository;
  readonly tools: ToolRepository;
  readonly policies: PolicyRepository;
  readonly executions: ExecutionRepository;
  readonly trace: TraceRepository;
  readonly replayJournal: ReplayJournalRepository;
  readonly secrets: SecretRepository;

  /**
   * Atomic §5.3 provisioning chain for the CLI's `add-mcp` command: writes
   * source, integration, connection — and, iff a NEW secret is being stored
   * this run, the secret; or, iff `removeSecretRef` is present, DELETEs that
   * sealed secret — plus the namespace's tools, all in one transaction.
   * All-or-nothing: a failure anywhere in the chain (e.g. a malformed tool
   * row) leaves zero rows behind, INCLUDING the secret delete. Writes NO
   * policy rows; policy seeding is a separate step the caller drives
   * explicitly.
   */
  provisionSource(input: {
    source: Source;
    integration: Integration;
    /** `connection.credentialRef` is already resolved by the CALLER — this
     * method does not read existing state. */
    connection: Connection;
    /** Present iff a NEW secret is stored this run. */
    secret?: { ref: string; value: string };
    /** When present, the sealed secret at this ref is DELETEd inside the
     * same atomic batch (the `--clear-credential` path); mutually exclusive
     * with `secret`. */
    removeSecretRef?: string;
    tools: readonly Tool[];
  }): Promise<{ generation: number }>;
}

export interface SourceRepository {
  upsert(source: Source): Promise<void>;
  get(id: string): Promise<Source | undefined>;
  getByNamespace(namespace: string): Promise<Source | undefined>;
  list(): Promise<Source[]>;
  remove(id: string): Promise<void>;
  /**
   * The namespace's current §4.1a generation, or `undefined` when no source
   * row exists. SQLite's triggers allocate the value — never the writer — so
   * this is the authoritative provenance §5.4's resume check compares a
   * pause's `sourceGeneration` against.
   */
  getGeneration(namespace: string): Promise<number | undefined>;
}

export interface IntegrationRepository {
  upsert(integration: Integration): Promise<void>;
  getByNamespace(namespace: string): Promise<Integration | undefined>;
  list(): Promise<Integration[]>;
}

export interface ConnectionRepository {
  upsert(connection: Connection): Promise<void>;
  /** Resolution path for tool calls (spec §5.3 step 1). */
  getByPrefix(prefix: string): Promise<Connection | undefined>;
  list(): Promise<Connection[]>;
  remove(id: string): Promise<void>;
}

export interface ToolRepository {
  /**
   * Source refresh (spec §7): atomically replace a namespace's tools.
   * Policies are intentionally untouched — they live in their own
   * repository, keyed by tool name, and survive refreshes.
   */
  replaceNamespace(namespace: string, tools: readonly Tool[]): Promise<void>;
  get(name: string): Promise<Tool | undefined>;
  list(namespace?: string): Promise<Tool[]>;
}

export interface PolicyRepository {
  upsert(policy: Policy): Promise<void>;
  get(toolName: string): Promise<Policy | undefined>;
  list(): Promise<Policy[]>;
}

/**
 * The ONE settle write a direct drive performs (§5.3). Each arm carries
 * exactly the columns that status permits, so an inconsistent pair — a
 * `delivered` row with a stored result, a `retained` row without one —
 * cannot be expressed at the call site.
 */
export type DirectSettle =
  | { status: "completed"; resultState: "delivered" | "discarded" }
  | { status: "completed"; resultState: "retained"; result: unknown }
  | { status: "failed"; error: ExecutionError }
  | { status: "paused"; pausedOn: PendingApproval }
  /** The direct resume TTL branch: terminal, no result, no pause. */
  | { status: "expired" };

export interface ExecutionRepository {
  /**
   * Persist a NEW execution (start/startDirect). A plain INSERT — a
   * duplicate id or, for a named client, a duplicate `(client_id, key)` in
   * `request_keys` throws (the manager maps the UNIQUE failure to
   * `conflict`). `attempt` seeds `resume_attempt` so a direct drive's settle
   * writes can be fenced from the first write (§5.3).
   */
  create(execution: Execution, opts?: { attempt?: string }): Promise<void>;
  /** Settle upsert. Never writes `request_keys`; never changes `resume_attempt`. */
  put(execution: Execution): Promise<void>;
  get(id: string): Promise<Execution | undefined>;
  /**
   * The stored `kind` alone, with no hydration (§5.4). A corrupt direct row
   * — unparseable `seeds`, malformed `direct_call` — must still be routable
   * through the bounded fenced settle, and `get` cannot answer for it.
   * `undefined` for a missing row or an unrecognized stored value.
   */
  kindOf(id: string): Promise<ExecutionKind | undefined>;
  /** Default profile (`null`): the legacy column. Named client: `request_keys` (§4.1). */
  getByRequestKey(key: string, clientId: string | null): Promise<Execution | undefined>;
  /**
   * Atomic paused→running for a single resume. Returns true iff THIS caller
   * won (design F4). `callId` names the pending call the human approved: the
   * claim succeeds only while the execution is paused on THAT call, so a
   * queued duplicate approval of an earlier pause can never claim a later
   * pause of the same program (spec §5.5 — an approval binds to one call).
   * A corrupt pause (NULL, non-JSON, or callId-less `paused_on`) is still
   * claimable so the manager can terminalize it rather than strand it.
   */
  claimForResume(id: string, resumeAttemptId: string, callId: string): Promise<boolean>;
  /**
   * The pending call id AS THE CLAIM SEES IT: `json_extract(paused_on,
   * '$.callId')` when it is JSON text, else undefined. SQLite's extractor
   * and `JSON.parse` can disagree on the same bytes (duplicate keys: SQLite
   * keeps the first, JS the last), so the manager decides on THIS identity
   * — the one `claimForResume` compared — never only on the hydrated one.
   */
  claimCallId(id: string): Promise<string | undefined>;
  /**
   * Terminalize a row THIS resume claimed but could not finish preparing
   * (design §8/F5, the stranded-running guard). A guarded
   * `UPDATE ... status='failed', ended_at, paused_on=NULL WHERE id=? AND
   * status='running'` — it only fires on a row currently `running`, so it can
   * never stomp a row another actor already moved on. Unlike `put`, it needs
   * NO parsed `Execution`: the very failure it recovers from can be that
   * `get` returned corrupt/unparseable JSON, so there may be no Execution to
   * spread. Returns nothing; a no-op (0 rows) means the row was already
   * terminal or re-claimed, which is fine.
   *
   * `errorName` classifies the stored failure for a later reader and
   * defaults to the resume-path's `ConduitInternalError`. The
   * crash-terminal sweep (mcp design §3.5) passes its own name: a row
   * failed because a daemon died mid-flight has a genuinely UNKNOWN
   * outcome — its upstream calls may have landed — and a reader must be
   * able to tell that apart from an execution that simply threw.
   */
  failClaimedResume(id: string, reason: string, errorName?: string): Promise<void>;
  /**
   * The ONE settle write for a direct row (§5.3 exactly-once): fenced
   * `WHERE status = 'running' AND resume_attempt = ?`. Returns true iff this
   * write changed the row. A late continuation after the timer, or a
   * duplicate settle, returns false and changes nothing.
   */
  settleDirect(id: string, attempt: string, settle: DirectSettle): Promise<boolean>;
  /**
   * D3 housekeeping sweep (§4.1): every `paused` row of EITHER kind whose
   * `pausedOn.namespace` EQUALS `namespace` becomes `failed` with
   * `ConduitCatalogChanged`. Returns the count. Not the authority — the
   * generation check on resume is.
   */
  invalidatePaused(namespace: string): Promise<number>;
  /** Paused executions awaiting a human, oldest-first (spec §10.2 approval queue). */
  listPaused(): Promise<Execution[]>;
  /**
   * Executions still durably `running`, oldest-first (mcp design §3.5,
   * the crash-terminal sweep). Only meaningful to a caller that knows no
   * execution can be live — the daemon at startup, holding both locks,
   * where single-daemon plus kernel-enforced stop-first makes every such
   * row provably owned by a process that is gone. Any other caller would
   * be reading rows that are legitimately in flight.
   *
   * Returns ids rather than parsed `Execution`s on purpose: the crash
   * this recovers from can itself be what left a row's JSON columns
   * unparseable, and a sweep that throws while hydrating a corrupt row
   * would strand exactly the rows it exists to terminalize.
   */
  listRunningIds(): Promise<string[]>;
}

export interface TraceRepository {
  append(event: TraceEvent): Promise<void>;
  /**
   * In insertion order — the §11 AUDIT trail for an execution. After the D4
   * split this is NOT the deterministic-replay journal (that is
   * `ReplayJournalRepository`, below): the audit Trace records refusals and
   * allowed calls alike, whereas replay reads the clean prefix. Ordering is
   * still a correctness requirement — the audit trail must read chronologically
   * — but it is an audit projection, not a replay source.
   */
  listByExecution(executionId: string): Promise<TraceEvent[]>;
}

export interface ReplayJournalRow {
  ordinal: number;
  op: "search" | "describe" | "call";
  request: string;
  outcome: { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } };
}

export interface ReplayJournalRepository {
  append(executionId: string, entry: ReplayJournalRow): Promise<void>;
  listByExecution(executionId: string): Promise<ReplayJournalRow[]>;
}

export interface SecretRepository {
  /** Plaintext in, ciphertext at rest (spec §9.2). */
  put(ref: string, secret: string): Promise<void>;
  /**
   * Plaintext out — the host-side credential resolver is the only intended
   * caller. Nothing that touches sandbox, agent, or model may hold this.
   */
  reveal(ref: string): Promise<string | undefined>;
  remove(ref: string): Promise<void>;
}
