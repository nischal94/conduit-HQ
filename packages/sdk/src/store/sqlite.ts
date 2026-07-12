import type { Client, Row } from "@libsql/client";
import { redactSensitiveFields } from "../pipeline/redact.js";
import type { SecretBox } from "../secrets.js";
import type {
  Connection,
  Execution,
  ExecutionError,
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
import type { ConduitStore, ReplayJournalRow } from "./store.js";

/**
 * libSQL/SQLite implementation of the ConduitStore seam. Single file
 * locally and in Docker (spec §13.4); schema is plain SQLite so a D1
 * implementation can share it.
 */

export interface SqliteStoreOptions {
  client: Client;
  /** Encrypts SecretRepository contents at rest (spec §9.2). */
  secretBox: SecretBox;
  /** Host-side sink for infra diagnostics (e.g. a WAL-pragma failure); NEVER guest-visible. */
  log?: (message: string) => void;
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
    manual_override INTEGER NOT NULL CHECK (manual_override IN (0, 1)),
    redact_fields TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed', 'expired')),
    seeds TEXT NOT NULL,
    paused_on TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    resume_attempt TEXT,
    result TEXT,
    error TEXT,
    request_key TEXT
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
  `CREATE TABLE IF NOT EXISTS replay_journal (
    execution_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('search', 'describe', 'call')),
    request TEXT NOT NULL,
    outcome TEXT NOT NULL,
    PRIMARY KEY (execution_id, ordinal)
  )`,
  `CREATE TABLE IF NOT EXISTS secrets (
    ref TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

/**
 * M5: the PRAGMA table_info → ALTER ladder is idempotent sequentially but
 * races across processes (two fresh servers at login both see the schema
 * delta pending; one ALTER loses). For ADD COLUMN the loser sees "duplicate
 * column name"; for DROP COLUMN it sees "no such column". Either way the
 * schema is already in the state the retrofit promises — SUCCESS, not failure.
 */
async function tolerateSchemaRace(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const text = String(error);
    if (!text.includes("duplicate column name") && !text.includes("no such column")) {
      throw error;
    }
  }
}

export async function openSqliteStore(options: SqliteStoreOptions): Promise<ConduitStore> {
  const { client, secretBox } = options;
  const log = options.log ?? ((message: string) => console.error(message));

  // M5: multi-process hygiene — BEFORE the first schema statement so the
  // migration itself benefits. WAL is a legitimate no-op on :memory: (SQLite
  // reports "memory" regardless of the PRAGMA), so a failure or a non-"wal"
  // result is only actionable when the mode ISN'T "memory" — i.e. a
  // file-backed DB where M5's multi-process safety silently doesn't apply.
  // Never throws: a WAL-less file DB still works single-process, just
  // without the cross-process guarantee, so this is a warning, not a fail.
  await client.execute("PRAGMA busy_timeout = 5000").catch(() => {});
  try {
    const result = await client.execute("PRAGMA journal_mode = WAL");
    const mode = String(Object.values(result.rows[0] ?? {})[0] ?? "").toLowerCase();
    if (mode !== "wal" && mode !== "memory") {
      log(
        `[SqliteStore] WARNING: PRAGMA journal_mode = WAL did not take effect (reported "${mode}") — ` +
          "M5 multi-process safety does NOT apply to this database; single-process use only.",
      );
    }
  } catch (cause) {
    log(
      `[SqliteStore] WARNING: PRAGMA journal_mode = WAL failed — M5 multi-process safety does NOT ` +
        `apply to this database; single-process use only. Context: { cause: ${String(cause)} }`,
    );
  }

  await client.batch(SCHEMA, "write");

  // executions.resume_attempt arrived after the first shipped schema; same
  // retrofit as trace_events.output below.
  const executionColumns = await client.execute("PRAGMA table_info(executions)");
  if (!executionColumns.rows.some((row) => row.name === "resume_attempt")) {
    await tolerateSchemaRace(() =>
      client.execute("ALTER TABLE executions ADD COLUMN resume_attempt TEXT"),
    );
  }

  // executions.result/error/request_key arrived with the mcp design (M1/M4);
  // same retrofit pattern. The unique index is created after the columns
  // exist on both fresh and legacy schemas (SQLite unique indexes ignore
  // NULLs, so multiple legacy rows with no request_key coexist fine).
  if (!executionColumns.rows.some((row) => row.name === "result")) {
    await tolerateSchemaRace(() => client.execute("ALTER TABLE executions ADD COLUMN result TEXT"));
  }
  if (!executionColumns.rows.some((row) => row.name === "error")) {
    await tolerateSchemaRace(() => client.execute("ALTER TABLE executions ADD COLUMN error TEXT"));
  }
  if (!executionColumns.rows.some((row) => row.name === "request_key")) {
    await tolerateSchemaRace(() =>
      client.execute("ALTER TABLE executions ADD COLUMN request_key TEXT"),
    );
  }
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_request_key ON executions(request_key)",
  );

  // policies.redact_fields arrived with §11 redaction; same retrofit
  // pattern as trace_events.output below. Must run BEFORE the trace_events
  // migration below, which SELECTs this column to build per-tool masking.
  const policyColumns = await client.execute("PRAGMA table_info(policies)");
  if (!policyColumns.rows.some((row) => row.name === "redact_fields")) {
    await tolerateSchemaRace(() =>
      client.execute("ALTER TABLE policies ADD COLUMN redact_fields TEXT NOT NULL DEFAULT '[]'"),
    );
  }

  // Pre-§11 schemas carried a full trace_events.output payload for replay;
  // after the D4 split replay reads only replay_journal, and §11 drops the
  // field (design R3). A DB that still has the column predates §11 entirely,
  // so its trace rows were written unredacted: mask them once (input via
  // the current builtin + per-tool keys; summaries are truncated raw
  // serializations — unscannable scalars — so they are replaced wholesale),
  // then DROP the column. The column's absence marks the migration done.
  // Runs AFTER the policies.redact_fields retrofit above (this block SELECTs
  // that column).
  //
  // M5: the whole detect→mask→drop sequence is ONE tolerateSchemaRace unit,
  // not per-statement wrapping. The masking UPDATEs race a concurrent
  // opener's completed DROP: a "no such column" from ANY inner statement
  // (including a masking UPDATE, not just the final DROP) means the other
  // process already finished the migration — stop immediately rather than
  // let a later statement run after the schema has moved on.
  const traceColumns = await client.execute("PRAGMA table_info(trace_events)");
  if (traceColumns.rows.some((row) => row.name === "output")) {
    await tolerateSchemaRace(async () => {
      const policyRows = await client.execute("SELECT tool_name, redact_fields FROM policies");
      const extrasByTool = new Map<string, string[]>();
      for (const row of policyRows.rows) {
        try {
          const parsed: unknown = JSON.parse(String(row.redact_fields));
          if (Array.isArray(parsed) && parsed.every((f): f is string => typeof f === "string")) {
            extrasByTool.set(String(row.tool_name), parsed);
          }
        } catch {
          // A malformed row fails the policy read path loudly elsewhere;
          // for the one-time migration, builtins-only is the fail-closed floor.
        }
      }
      const traceRows = await client.execute(
        "SELECT call_id, tool_name, input, output_summary FROM trace_events",
      );
      for (const row of traceRows.rows) {
        const extras = extrasByTool.get(String(row.tool_name)) ?? [];
        let input: string;
        try {
          input = JSON.stringify(redactSensitiveFields(JSON.parse(String(row.input)), extras));
        } catch {
          input = JSON.stringify("[redacted:pre-§11]"); // unparseable → fail closed
        }
        const summary = row.output_summary === null ? null : JSON.stringify("[redacted:pre-§11]");
        await client.execute({
          sql: "UPDATE trace_events SET input = ?, output_summary = ?, output = NULL WHERE call_id = ?",
          args: [input, summary, String(row.call_id)],
        });
      }
      await client.execute("ALTER TABLE trace_events DROP COLUMN output");
    });
  }

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
          sql: `INSERT INTO policies (tool_name, action, seeded_from, manual_override, redact_fields)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(tool_name) DO UPDATE SET
                  action = excluded.action, seeded_from = excluded.seeded_from,
                  manual_override = excluded.manual_override,
                  redact_fields = excluded.redact_fields`,
          args: [
            policy.toolName,
            policy.action,
            policy.seededFrom,
            policy.manualOverride ? 1 : 0,
            JSON.stringify(policy.redactFields),
          ],
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
          sql: `INSERT INTO executions
                  (id, code, status, seeds, paused_on, started_at, ended_at, result, error, request_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  code = excluded.code, status = excluded.status, seeds = excluded.seeds,
                  paused_on = excluded.paused_on, started_at = excluded.started_at,
                  ended_at = excluded.ended_at, result = excluded.result,
                  error = excluded.error, request_key = excluded.request_key`,
          args: [
            execution.id,
            execution.code,
            execution.status,
            JSON.stringify(execution.seeds),
            execution.pausedOn === undefined ? null : JSON.stringify(execution.pausedOn),
            execution.startedAt,
            execution.endedAt ?? null,
            execution.result === undefined ? null : JSON.stringify(execution.result),
            execution.error === undefined ? null : JSON.stringify(execution.error),
            execution.requestKey ?? null,
          ],
        });
      },
      async get(id: string): Promise<Execution | undefined> {
        const rs = await client.execute({
          sql: "SELECT * FROM executions WHERE id = ?",
          args: [id],
        });
        const row = rs.rows[0];
        return row === undefined ? undefined : hydrateExecutionRow(row, id);
      },
      async getByRequestKey(key: string): Promise<Execution | undefined> {
        const rs = await client.execute({
          sql: "SELECT * FROM executions WHERE request_key = ?",
          args: [key],
        });
        const row = rs.rows[0];
        return row === undefined ? undefined : hydrateExecutionRow(row, text(row, "id"));
      },
      async claimForResume(id: string, resumeAttemptId: string): Promise<boolean> {
        // Single guarded UPDATE: the WHERE status = 'paused' clause makes
        // this a compare-and-swap — SQLite serializes writes, so exactly
        // one concurrent caller's UPDATE matches the row and affects it.
        // A read-then-write would race here; this must stay one statement.
        const rs = await client.execute({
          sql: `UPDATE executions SET status = 'running', resume_attempt = ?
                WHERE id = ? AND status = 'paused'`,
          args: [resumeAttemptId, id],
        });
        return rs.rowsAffected === 1;
      },
      async failClaimedResume(id: string, reason: string): Promise<void> {
        // Guarded terminalizer for a row THIS resume claimed (design §8/F5).
        // The `WHERE status='running'` clause means it ONLY finalizes a row a
        // successful `claimForResume` left `running` — never a row another
        // actor already moved to a terminal or re-`paused` state. No parsed
        // Execution is needed (the fault may be corrupt stored JSON), so this
        // writes columns directly. `reason` becomes the stored error payload
        // (mcp design M4) so a caller reading the failed row sees why.
        await client.execute({
          sql: `UPDATE executions SET status = 'failed', ended_at = ?, paused_on = NULL, error = ?
                WHERE id = ? AND status = 'running'`,
          args: [Date.now(), JSON.stringify({ name: "ConduitInternalError", message: reason }), id],
        });
      },
      async listPaused(): Promise<Execution[]> {
        const rs = await client.execute(
          "SELECT * FROM executions WHERE status = 'paused' ORDER BY started_at ASC, id ASC",
        );
        return rs.rows.map((row) => hydrateExecutionRow(row, text(row, "id")));
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

    replayJournal: {
      async append(executionId: string, entry: ReplayJournalRow): Promise<void> {
        // Append is idempotent on (execution_id, ordinal): a legitimate
        // re-`perform` of the same segment re-appends byte-identical content,
        // which must stay a no-op (design D8). But a conflict whose STORED row
        // DIFFERS from the incoming one is corruption — a duplicate ordinal
        // carrying a different request/outcome would silently keep the stale
        // row and diverge replay. A bare `ON CONFLICT DO NOTHING` cannot tell
        // the two apart, so read the existing row first and reject a genuine
        // mismatch. Safe as a read-then-write because the manager is the sole
        // writer per execution (single-process MVP, one drive at a time).
        const outcomeJson = JSON.stringify(entry.outcome);
        const existing = await client.execute({
          sql: "SELECT op, request, outcome FROM replay_journal WHERE execution_id = ? AND ordinal = ?",
          args: [executionId, entry.ordinal],
        });
        const prior = existing.rows[0];
        if (prior !== undefined) {
          if (
            text(prior, "op") !== entry.op ||
            text(prior, "request") !== entry.request ||
            text(prior, "outcome") !== outcomeJson
          ) {
            throw new Error(
              `[SqliteStore] Replay-journal append conflict: ordinal ${entry.ordinal} already holds a DIFFERENT ` +
                `entry (corruption; not an idempotent retry). Context: { executionId: ${JSON.stringify(executionId)} }`,
            );
          }
          return; // identical content — idempotent no-op
        }
        await client.execute({
          sql: `INSERT INTO replay_journal (execution_id, ordinal, op, request, outcome)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(execution_id, ordinal) DO NOTHING`,
          args: [executionId, entry.ordinal, entry.op, entry.request, outcomeJson],
        });
      },
      async listByExecution(executionId: string): Promise<ReplayJournalRow[]> {
        const rs = await client.execute({
          sql: "SELECT ordinal, op, request, outcome FROM replay_journal WHERE execution_id = ? ORDER BY ordinal",
          args: [executionId],
        });
        return rs.rows.map((row) => {
          const op = text(row, "op");
          if (!isOneOf(op, REPLAY_OPS)) {
            throw new Error(
              `[SqliteStore] Failed to read replay_journal: unrecognized op ${JSON.stringify(op)}. Context: { executionId: ${JSON.stringify(executionId)} }`,
            );
          }
          return {
            ordinal: integer(row, "ordinal"),
            op,
            request: text(row, "request"),
            outcome: parseJson(
              text(row, "outcome"),
              (cause) =>
                new Error(
                  `[SqliteStore] Failed to read replay_journal outcome: not valid JSON. Context: { executionId: ${JSON.stringify(executionId)} }`,
                  { cause },
                ),
            ) as ReplayJournalRow["outcome"],
          };
        });
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

    async provisionSource(input: {
      source: Source;
      integration: Integration;
      connection: Connection;
      secret?: { ref: string; value: string };
      removeSecretRef?: string;
      tools: readonly Tool[];
    }): Promise<void> {
      if (input.secret !== undefined && input.removeSecretRef !== undefined) {
        throw new Error(
          "[ConduitStore] provisionSource: `secret` and `removeSecretRef` are mutually exclusive.",
        );
      }

      // The seal MUST happen before the batch is built — `client.batch`
      // takes a plain statement array, so nothing inside it can be awaited.
      const sealed =
        input.secret === undefined ? undefined : await secretBox.seal(input.secret.value);

      const { source, integration, connection, tools } = input;
      const statements = [
        {
          sql: `INSERT INTO sources (id, type, namespace, location, base_url)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  type = excluded.type, namespace = excluded.namespace,
                  location = excluded.location, base_url = excluded.base_url`,
          args: [source.id, source.type, source.namespace, source.location, source.baseUrl ?? null],
        },
        {
          sql: `INSERT INTO integrations (id, source_id, namespace) VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  source_id = excluded.source_id, namespace = excluded.namespace`,
          args: [integration.id, integration.sourceId, integration.namespace],
        },
        {
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
        },
        ...(input.secret === undefined
          ? []
          : [
              {
                sql: `INSERT INTO secrets (ref, sealed, created_at) VALUES (?, ?, ?)
                      ON CONFLICT(ref) DO UPDATE SET sealed = excluded.sealed`,
                args: [input.secret.ref, sealed as string, Date.now()],
              },
            ]),
        ...(input.removeSecretRef === undefined
          ? []
          : [{ sql: "DELETE FROM secrets WHERE ref = ?", args: [input.removeSecretRef] }]),
        { sql: "DELETE FROM tools WHERE namespace = ?", args: [integration.namespace] },
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

const REPLAY_OPS: readonly ReplayJournalRow["op"][] = ["search", "describe", "call"];
const GRAPHQL_OPERATIONS: readonly ("query" | "mutation")[] = ["query", "mutation"];
const SEMANTICS_KINDS: readonly SourceSemantics["kind"][] = [
  "openapi",
  "graphql",
  "mcp",
  "custom_js",
];

function isOneOf<T extends string>(value: string, vocabulary: readonly T[]): value is T {
  return (vocabulary as readonly string[]).includes(value);
}

/** A bare SyntaxError carries neither the entity nor the row identity —
 * every JSON column parse routes through here so corruption fails with
 * the same [SqliteStore] error format as the vocabulary guards. The
 * original error travels as `cause`: its parse position is what locates
 * the corruption inside a large blob. */
function parseJson(raw: string, onError: (cause: unknown) => Error): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw onError(cause);
  }
}

// Identifiers are stringified too: they come from the same untrusted
// row as the bad value, and raw control characters are log injection.
function toolReadError(name: string, detail: string, cause?: unknown): Error {
  return new Error(
    `[SqliteStore] Failed to read tool: ${detail}. Context: { name: ${JSON.stringify(name)} }`,
    cause === undefined ? undefined : { cause },
  );
}

type McpSemantics = Extract<SourceSemantics, { kind: "mcp" }>;

/**
 * source_semantics is the one vocabulary-bearing column without a CHECK
 * twin — a JSON blob is opaque to SQLite — so this read-side guard is the
 * only enforcement layer even on fresh schemas. It rebuilds the value
 * field-by-field (unknown keys are dropped), and the three vocabularies
 * nested in the blob — kind, graphql operation, custom_js declaredRisk —
 * fail like their column counterparts: loudly at deserialization, never
 * loaded as a silently-reshaped SourceSemantics.
 */
function parseSourceSemantics(raw: string, name: string): SourceSemantics {
  const value = parseJson(raw, (cause) =>
    toolReadError(name, "source_semantics is not valid JSON", cause),
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw toolReadError(name, `source_semantics is not an object: ${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !isOneOf(kind, SEMANTICS_KINDS)) {
    throw toolReadError(name, `unrecognized source_semantics kind ${JSON.stringify(kind)}`);
  }
  switch (kind) {
    case "openapi": {
      const { method, path } = record;
      if (typeof method !== "string" || typeof path !== "string") {
        throw toolReadError(name, `malformed openapi source_semantics: ${JSON.stringify(value)}`);
      }
      return { kind, method, path };
    }
    case "graphql": {
      const operation = record.operation;
      if (typeof operation !== "string" || !isOneOf(operation, GRAPHQL_OPERATIONS)) {
        throw toolReadError(
          name,
          `unrecognized source_semantics operation ${JSON.stringify(operation)}`,
        );
      }
      return { kind, operation };
    }
    case "mcp": {
      const semantics: McpSemantics = { kind };
      const { readOnlyHint, destructiveHint } = record;
      if (readOnlyHint !== undefined) {
        if (typeof readOnlyHint !== "boolean") {
          throw toolReadError(name, `malformed mcp source_semantics: ${JSON.stringify(value)}`);
        }
        semantics.readOnlyHint = readOnlyHint;
      }
      if (destructiveHint !== undefined) {
        if (typeof destructiveHint !== "boolean") {
          throw toolReadError(name, `malformed mcp source_semantics: ${JSON.stringify(value)}`);
        }
        semantics.destructiveHint = destructiveHint;
      }
      return semantics;
    }
    case "custom_js": {
      const declaredRisk = record.declaredRisk;
      if (typeof declaredRisk !== "string" || !isOneOf(declaredRisk, RISK_CLASSES)) {
        throw toolReadError(
          name,
          `unrecognized source_semantics declaredRisk ${JSON.stringify(declaredRisk)}`,
        );
      }
      return { kind, declaredRisk };
    }
  }
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
    throw toolReadError(name, `unrecognized risk_class ${JSON.stringify(riskClass)}`);
  }
  const tool: Tool = {
    name,
    namespace: text(row, "namespace"),
    inputSchema: parseJson(text(row, "input_schema"), (cause) =>
      toolReadError(name, "input_schema is not valid JSON", cause),
    ) as JsonSchema,
    outputSchema: parseJson(text(row, "output_schema"), (cause) =>
      toolReadError(name, "output_schema is not valid JSON", cause),
    ) as JsonSchema,
    riskClass,
    sourceSemantics: parseSourceSemantics(text(row, "source_semantics"), name),
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
  const redactFieldsText = text(row, "redact_fields");
  let redactFieldsParsed: unknown;
  try {
    redactFieldsParsed = JSON.parse(redactFieldsText);
  } catch (cause) {
    throw new Error(
      `[SqliteStore] Failed to read policy: redact_fields is not valid JSON. Context: { toolName: ${JSON.stringify(toolName)} }`,
      { cause },
    );
  }
  if (
    !Array.isArray(redactFieldsParsed) ||
    !redactFieldsParsed.every((field): field is string => typeof field === "string")
  ) {
    throw new Error(
      `[SqliteStore] Failed to read policy: redact_fields must be a JSON array of strings. Context: { toolName: ${JSON.stringify(toolName)} }`,
    );
  }
  return {
    toolName,
    action,
    seededFrom,
    manualOverride: manualOverride === 1,
    redactFields: redactFieldsParsed,
  };
}

/** Shared row→Execution hydration for `get` and `getByRequestKey`. */
function hydrateExecutionRow(row: Row, id: string): Execution {
  const status = text(row, "status");
  if (!isOneOf(status, EXECUTION_STATUSES)) {
    // An impossible status must never reach §5.5 pause/resume
    // handling, where default-less switches would ignore it.
    throw new Error(
      `[SqliteStore] Failed to read execution: unrecognized status ${JSON.stringify(status)}. Context: { id: ${JSON.stringify(id)} }`,
    );
  }
  const executionReadError = (detail: string, cause?: unknown) =>
    new Error(
      `[SqliteStore] Failed to read execution: ${detail}. Context: { id: ${JSON.stringify(id)} }`,
      cause === undefined ? undefined : { cause },
    );
  const execution: Execution = {
    id: text(row, "id"),
    code: text(row, "code"),
    status,
    seeds: parseJson(text(row, "seeds"), (cause) =>
      executionReadError("seeds is not valid JSON", cause),
    ) as Execution["seeds"],
    startedAt: integer(row, "started_at"),
  };
  const pausedOn = maybeText(row, "paused_on");
  if (pausedOn !== undefined) {
    execution.pausedOn = parseJson(pausedOn, (cause) =>
      executionReadError("paused_on is not valid JSON", cause),
    ) as PendingApproval;
  }
  const endedAt = maybeInteger(row, "ended_at");
  if (endedAt !== undefined) {
    execution.endedAt = endedAt;
  }
  const result = maybeText(row, "result");
  if (result !== undefined) {
    execution.result = parseJson(result, (cause) =>
      executionReadError("result is not valid JSON", cause),
    );
  }
  const error = maybeText(row, "error");
  if (error !== undefined) {
    execution.error = parseJson(error, (cause) =>
      executionReadError("error is not valid JSON", cause),
    ) as ExecutionError;
  }
  const requestKey = maybeText(row, "request_key");
  if (requestKey !== undefined) {
    execution.requestKey = requestKey;
  }
  return execution;
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
  const traceReadError = (detail: string, cause?: unknown) =>
    new Error(
      `[SqliteStore] Failed to read trace event: ${detail}. Context: { callId: ${JSON.stringify(callId)} }`,
      cause === undefined ? undefined : { cause },
    );
  const event: TraceEvent = {
    callId,
    executionId: text(row, "execution_id"),
    toolName: text(row, "tool_name"),
    connectionPrefix: text(row, "connection_prefix"),
    input: parseJson(text(row, "input"), (cause) =>
      traceReadError("input is not valid JSON", cause),
    ),
    policyVerdict,
    at: integer(row, "at"),
  };
  const outputSummary = maybeText(row, "output_summary");
  if (outputSummary !== undefined) {
    const parsed = parseJson(outputSummary, (cause) =>
      traceReadError("output_summary is not valid JSON", cause),
    );
    if (typeof parsed !== "string") {
      throw traceReadError("output_summary is not a string");
    }
    event.outputSummary = parsed;
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
