import type { Client, Row } from "@libsql/client";
import type { SecretBox } from "../secrets.js";
import type {
  Connection,
  Execution,
  ExecutionStatus,
  Integration,
  JsonSchema,
  PendingApproval,
  Policy,
  PolicyAction,
  RiskClass,
  Source,
  SourceSemantics,
  SourceType,
  Tool,
  TraceEvent,
} from "../types.js";
import type { ConduitStore } from "./store.js";

/**
 * libSQL/SQLite implementation of the ConduitStore seam. Single file
 * locally and in Docker (spec §13.4); schema is plain SQLite so a D1
 * implementation can share it.
 */

export interface SqliteStoreOptions {
  client: Client;
  /** Encrypts SecretRepository contents at rest (spec §9.2). */
  secretBox: SecretBox;
}

// The CHECK vocabularies below protect fresh schemas only: CREATE TABLE
// IF NOT EXISTS never retrofits an existing table, so for legacy
// databases the read-side vocabulary guards at the bottom of this file
// are the enforcement layer.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('openapi', 'graphql', 'mcp', 'custom_js')),
    namespace TEXT NOT NULL UNIQUE,
    location TEXT NOT NULL,
    base_url TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    namespace TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    integration_id TEXT NOT NULL,
    prefix TEXT NOT NULL UNIQUE,
    credential_ref TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tools (
    name TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    description TEXT,
    input_schema TEXT NOT NULL,
    output_schema TEXT NOT NULL,
    risk_class TEXT NOT NULL CHECK (risk_class IN ('safe', 'review', 'destructive')),
    source_semantics TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS tools_namespace ON tools (namespace)`,
  `CREATE TABLE IF NOT EXISTS policies (
    tool_name TEXT PRIMARY KEY,
    action TEXT NOT NULL CHECK (action IN ('allow', 'require_approval', 'block')),
    seeded_from TEXT NOT NULL CHECK (seeded_from IN ('safe', 'review', 'destructive')),
    manual_override INTEGER NOT NULL CHECK (manual_override IN (0, 1))
  )`,
  `CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed', 'expired')),
    seeds TEXT NOT NULL,
    paused_on TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS trace_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL UNIQUE,
    execution_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    connection_prefix TEXT NOT NULL,
    input TEXT NOT NULL,
    output_summary TEXT,
    upstream_status INTEGER,
    latency_ms INTEGER,
    policy_verdict TEXT NOT NULL CHECK (policy_verdict IN ('allow', 'require_approval', 'block')),
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS trace_execution ON trace_events (execution_id, seq)`,
  `CREATE TABLE IF NOT EXISTS secrets (
    ref TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

export async function openSqliteStore(options: SqliteStoreOptions): Promise<ConduitStore> {
  const { client, secretBox } = options;
  await client.batch(SCHEMA, "write");

  return {
    sources: {
      async upsert(source: Source): Promise<void> {
        await client.execute({
          sql: `INSERT INTO sources (id, type, namespace, location, base_url)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  type = excluded.type, namespace = excluded.namespace,
                  location = excluded.location, base_url = excluded.base_url`,
          args: [source.id, source.type, source.namespace, source.location, source.baseUrl ?? null],
        });
      },
      async get(id: string): Promise<Source | undefined> {
        const rs = await client.execute({ sql: "SELECT * FROM sources WHERE id = ?", args: [id] });
        return rs.rows[0] === undefined ? undefined : rowToSource(rs.rows[0]);
      },
      async getByNamespace(namespace: string): Promise<Source | undefined> {
        const rs = await client.execute({
          sql: "SELECT * FROM sources WHERE namespace = ?",
          args: [namespace],
        });
        return rs.rows[0] === undefined ? undefined : rowToSource(rs.rows[0]);
      },
      async list(): Promise<Source[]> {
        const rs = await client.execute("SELECT * FROM sources ORDER BY namespace");
        return rs.rows.map(rowToSource);
      },
      async remove(id: string): Promise<void> {
        await client.execute({ sql: "DELETE FROM sources WHERE id = ?", args: [id] });
      },
    },

    integrations: {
      async upsert(integration: Integration): Promise<void> {
        await client.execute({
          sql: `INSERT INTO integrations (id, source_id, namespace) VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  source_id = excluded.source_id, namespace = excluded.namespace`,
          args: [integration.id, integration.sourceId, integration.namespace],
        });
      },
      async getByNamespace(namespace: string): Promise<Integration | undefined> {
        const rs = await client.execute({
          sql: "SELECT * FROM integrations WHERE namespace = ?",
          args: [namespace],
        });
        const row = rs.rows[0];
        if (row === undefined) {
          return undefined;
        }
        return {
          id: text(row, "id"),
          sourceId: text(row, "source_id"),
          namespace: text(row, "namespace"),
        };
      },
      async list(): Promise<Integration[]> {
        const rs = await client.execute("SELECT * FROM integrations ORDER BY namespace");
        return rs.rows.map((row) => ({
          id: text(row, "id"),
          sourceId: text(row, "source_id"),
          namespace: text(row, "namespace"),
        }));
      },
    },

    connections: {
      async upsert(connection: Connection): Promise<void> {
        await client.execute({
          sql: `INSERT INTO connections (id, integration_id, prefix, credential_ref)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  integration_id = excluded.integration_id, prefix = excluded.prefix,
                  credential_ref = excluded.credential_ref`,
          args: [
            connection.id,
            connection.integrationId,
            connection.prefix,
            connection.credentialRef ?? null,
          ],
        });
      },
      async getByPrefix(prefix: string): Promise<Connection | undefined> {
        const rs = await client.execute({
          sql: "SELECT * FROM connections WHERE prefix = ?",
          args: [prefix],
        });
        return rs.rows[0] === undefined ? undefined : rowToConnection(rs.rows[0]);
      },
      async list(): Promise<Connection[]> {
        const rs = await client.execute("SELECT * FROM connections ORDER BY prefix");
        return rs.rows.map(rowToConnection);
      },
      async remove(id: string): Promise<void> {
        await client.execute({ sql: "DELETE FROM connections WHERE id = ?", args: [id] });
      },
    },

    tools: {
      async replaceNamespace(namespace: string, tools: readonly Tool[]): Promise<void> {
        // One transaction: refresh is all-or-nothing (spec §7).
        const statements = [
          { sql: "DELETE FROM tools WHERE namespace = ?", args: [namespace] },
          ...tools.map((tool) => ({
            sql: `INSERT INTO tools
                    (name, namespace, description, input_schema, output_schema, risk_class, source_semantics)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
              tool.name,
              tool.namespace,
              tool.description ?? null,
              JSON.stringify(tool.inputSchema),
              JSON.stringify(tool.outputSchema),
              tool.riskClass,
              JSON.stringify(tool.sourceSemantics),
            ],
          })),
        ];
        await client.batch(statements, "write");
      },
      async get(name: string): Promise<Tool | undefined> {
        const rs = await client.execute({
          sql: "SELECT * FROM tools WHERE name = ?",
          args: [name],
        });
        return rs.rows[0] === undefined ? undefined : rowToTool(rs.rows[0]);
      },
      async list(namespace?: string): Promise<Tool[]> {
        const rs =
          namespace === undefined
            ? await client.execute("SELECT * FROM tools ORDER BY name")
            : await client.execute({
                sql: "SELECT * FROM tools WHERE namespace = ? ORDER BY name",
                args: [namespace],
              });
        return rs.rows.map(rowToTool);
      },
    },

    policies: {
      async upsert(policy: Policy): Promise<void> {
        await client.execute({
          sql: `INSERT INTO policies (tool_name, action, seeded_from, manual_override)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(tool_name) DO UPDATE SET
                  action = excluded.action, seeded_from = excluded.seeded_from,
                  manual_override = excluded.manual_override`,
          args: [policy.toolName, policy.action, policy.seededFrom, policy.manualOverride ? 1 : 0],
        });
      },
      async get(toolName: string): Promise<Policy | undefined> {
        const rs = await client.execute({
          sql: "SELECT * FROM policies WHERE tool_name = ?",
          args: [toolName],
        });
        return rs.rows[0] === undefined ? undefined : rowToPolicy(rs.rows[0]);
      },
      async list(): Promise<Policy[]> {
        const rs = await client.execute("SELECT * FROM policies ORDER BY tool_name");
        return rs.rows.map(rowToPolicy);
      },
    },

    executions: {
      async put(execution: Execution): Promise<void> {
        await client.execute({
          sql: `INSERT INTO executions (id, code, status, seeds, paused_on, started_at, ended_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  code = excluded.code, status = excluded.status, seeds = excluded.seeds,
                  paused_on = excluded.paused_on, started_at = excluded.started_at,
                  ended_at = excluded.ended_at`,
          args: [
            execution.id,
            execution.code,
            execution.status,
            JSON.stringify(execution.seeds),
            execution.pausedOn === undefined ? null : JSON.stringify(execution.pausedOn),
            execution.startedAt,
            execution.endedAt ?? null,
          ],
        });
      },
      async get(id: string): Promise<Execution | undefined> {
        const rs = await client.execute({
          sql: "SELECT * FROM executions WHERE id = ?",
          args: [id],
        });
        const row = rs.rows[0];
        if (row === undefined) {
          return undefined;
        }
        const status = text(row, "status");
        if (!isOneOf(status, EXECUTION_STATUSES)) {
          // An impossible status must never reach §5.5 pause/resume
          // handling, where default-less switches would ignore it.
          throw new Error(
            `[SqliteStore] Failed to read execution: unrecognized status ${JSON.stringify(status)}. Context: { id: ${JSON.stringify(id)} }`,
          );
        }
        const execution: Execution = {
          id: text(row, "id"),
          code: text(row, "code"),
          status,
          seeds: JSON.parse(text(row, "seeds")) as Execution["seeds"],
          startedAt: integer(row, "started_at"),
        };
        const pausedOn = maybeText(row, "paused_on");
        if (pausedOn !== undefined) {
          execution.pausedOn = JSON.parse(pausedOn) as PendingApproval;
        }
        const endedAt = maybeInteger(row, "ended_at");
        if (endedAt !== undefined) {
          execution.endedAt = endedAt;
        }
        return execution;
      },
    },

    trace: {
      async append(event: TraceEvent): Promise<void> {
        await client.execute({
          sql: `INSERT INTO trace_events
                  (call_id, execution_id, tool_name, connection_prefix, input,
                   output_summary, upstream_status, latency_ms, policy_verdict, at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            event.callId,
            event.executionId,
            event.toolName,
            event.connectionPrefix,
            JSON.stringify(event.input ?? null),
            event.outputSummary === undefined ? null : JSON.stringify(event.outputSummary),
            event.upstreamStatus ?? null,
            event.latencyMs ?? null,
            event.policyVerdict,
            event.at,
          ],
        });
      },
      async listByExecution(executionId: string): Promise<TraceEvent[]> {
        const rs = await client.execute({
          sql: "SELECT * FROM trace_events WHERE execution_id = ? ORDER BY seq",
          args: [executionId],
        });
        return rs.rows.map(rowToTraceEvent);
      },
    },

    secrets: {
      async put(ref: string, secret: string): Promise<void> {
        const sealed = await secretBox.seal(secret);
        await client.execute({
          sql: `INSERT INTO secrets (ref, sealed, created_at) VALUES (?, ?, ?)
                ON CONFLICT(ref) DO UPDATE SET sealed = excluded.sealed`,
          args: [ref, sealed, Date.now()],
        });
      },
      async reveal(ref: string): Promise<string | undefined> {
        const rs = await client.execute({
          sql: "SELECT sealed FROM secrets WHERE ref = ?",
          args: [ref],
        });
        const row = rs.rows[0];
        return row === undefined ? undefined : secretBox.open(text(row, "sealed"));
      },
      async remove(ref: string): Promise<void> {
        await client.execute({ sql: "DELETE FROM secrets WHERE ref = ?", args: [ref] });
      },
    },
  };
}

// --- row mapping (exactOptionalPropertyTypes: NULL columns become absent keys) ---

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(
      `[SqliteStore] Failed to read row: expected text column. Context: { column: ${column}, got: ${typeof value} }`,
    );
  }
  return value;
}

function maybeText(row: Row, column: string): string | undefined {
  const value = row[column];
  return typeof value === "string" ? value : undefined;
}

function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(
      `[SqliteStore] Failed to read row: expected integer column. Context: { column: ${column}, got: ${typeof value} }`,
    );
  }
  return Number(value);
}

function maybeInteger(row: Row, column: string): number | undefined {
  const value = row[column];
  return typeof value === "number" || typeof value === "bigint" ? Number(value) : undefined;
}

// Vocabulary guards: column values arrive from untrusted storage — a
// divergent writer can hold any bytes, and TypeScript's unions stop at
// compile time. The policy engine (policy.ts) fails closed on bad values
// it SEES; this layer catches corruption the engine would never see (e.g.
// manual_override 2 reshaped into an inert row, handing an operator's
// manual block back to the derived default). Two independent layers —
// do not merge or deduplicate them.
const POLICY_ACTIONS: readonly PolicyAction[] = ["allow", "require_approval", "block"];
const RISK_CLASSES: readonly RiskClass[] = ["safe", "review", "destructive"];
const SOURCE_TYPES: readonly SourceType[] = ["openapi", "graphql", "mcp", "custom_js"];
const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "running",
  "paused",
  "completed",
  "failed",
  "expired",
];

function isOneOf<T extends string>(value: string, vocabulary: readonly T[]): value is T {
  return (vocabulary as readonly string[]).includes(value);
}

function rowToSource(row: Row): Source {
  const id = text(row, "id");
  const type = text(row, "type");
  if (!isOneOf(type, SOURCE_TYPES)) {
    throw new Error(
      `[SqliteStore] Failed to read source: unrecognized type ${JSON.stringify(type)}. Context: { id: ${JSON.stringify(id)} }`,
    );
  }
  const source: Source = {
    id,
    type,
    namespace: text(row, "namespace"),
    location: text(row, "location"),
  };
  const baseUrl = maybeText(row, "base_url");
  if (baseUrl !== undefined) {
    source.baseUrl = baseUrl;
  }
  return source;
}

function rowToConnection(row: Row): Connection {
  const connection: Connection = {
    id: text(row, "id"),
    integrationId: text(row, "integration_id"),
    prefix: text(row, "prefix"),
  };
  const credentialRef = maybeText(row, "credential_ref");
  if (credentialRef !== undefined) {
    connection.credentialRef = credentialRef;
  }
  return connection;
}

function rowToTool(row: Row): Tool {
  const name = text(row, "name");
  const riskClass = text(row, "risk_class");
  if (!isOneOf(riskClass, RISK_CLASSES)) {
    // Identifiers are stringified too: they come from the same untrusted
    // row as the bad value, and raw control characters are log injection.
    throw new Error(
      `[SqliteStore] Failed to read tool: unrecognized risk_class ${JSON.stringify(riskClass)}. Context: { name: ${JSON.stringify(name)} }`,
    );
  }
  const tool: Tool = {
    name,
    namespace: text(row, "namespace"),
    inputSchema: JSON.parse(text(row, "input_schema")) as JsonSchema,
    outputSchema: JSON.parse(text(row, "output_schema")) as JsonSchema,
    riskClass,
    sourceSemantics: JSON.parse(text(row, "source_semantics")) as SourceSemantics,
  };
  const description = maybeText(row, "description");
  if (description !== undefined) {
    tool.description = description;
  }
  return tool;
}

function rowToPolicy(row: Row): Policy {
  const toolName = text(row, "tool_name");
  const action = text(row, "action");
  if (!isOneOf(action, POLICY_ACTIONS)) {
    throw new Error(
      `[SqliteStore] Failed to read policy: unrecognized action ${JSON.stringify(action)}. Context: { toolName: ${JSON.stringify(toolName)} }`,
    );
  }
  const seededFrom = text(row, "seeded_from");
  if (!isOneOf(seededFrom, RISK_CLASSES)) {
    throw new Error(
      `[SqliteStore] Failed to read policy: unrecognized seeded_from ${JSON.stringify(seededFrom)}. Context: { toolName: ${JSON.stringify(toolName)} }`,
    );
  }
  const manualOverride = integer(row, "manual_override");
  if (manualOverride !== 0 && manualOverride !== 1) {
    throw new Error(
      `[SqliteStore] Failed to read policy: manual_override must be 0 or 1. Context: { toolName: ${JSON.stringify(toolName)}, got: ${manualOverride} }`,
    );
  }
  return { toolName, action, seededFrom, manualOverride: manualOverride === 1 };
}

function rowToTraceEvent(row: Row): TraceEvent {
  const callId = text(row, "call_id");
  const policyVerdict = text(row, "policy_verdict");
  if (!isOneOf(policyVerdict, POLICY_ACTIONS)) {
    // The audit trail (spec §11): a corrupt verdict must fail the read,
    // not surface in Trace views as a legitimate policy decision.
    throw new Error(
      `[SqliteStore] Failed to read trace event: unrecognized policy_verdict ${JSON.stringify(policyVerdict)}. Context: { callId: ${JSON.stringify(callId)} }`,
    );
  }
  const event: TraceEvent = {
    callId,
    executionId: text(row, "execution_id"),
    toolName: text(row, "tool_name"),
    connectionPrefix: text(row, "connection_prefix"),
    input: JSON.parse(text(row, "input")),
    policyVerdict,
    at: integer(row, "at"),
  };
  const outputSummary = maybeText(row, "output_summary");
  if (outputSummary !== undefined) {
    event.outputSummary = JSON.parse(outputSummary);
  }
  const upstreamStatus = maybeInteger(row, "upstream_status");
  if (upstreamStatus !== undefined) {
    event.upstreamStatus = upstreamStatus;
  }
  const latencyMs = maybeInteger(row, "latency_ms");
  if (latencyMs !== undefined) {
    event.latencyMs = latencyMs;
  }
  return event;
}
