import type {
  Connection,
  Execution,
  Integration,
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
  readonly secrets: SecretRepository;
}

export interface SourceRepository {
  upsert(source: Source): Promise<void>;
  get(id: string): Promise<Source | undefined>;
  getByNamespace(namespace: string): Promise<Source | undefined>;
  list(): Promise<Source[]>;
  remove(id: string): Promise<void>;
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

export interface ExecutionRepository {
  put(execution: Execution): Promise<void>;
  get(id: string): Promise<Execution | undefined>;
}

export interface TraceRepository {
  append(event: TraceEvent): Promise<void>;
  /**
   * In insertion order — this listing IS the deterministic-replay journal
   * (spec §5.5), so ordering is a correctness requirement, not cosmetics.
   */
  listByExecution(executionId: string): Promise<TraceEvent[]>;
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
