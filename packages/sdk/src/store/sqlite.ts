import type { Client, Row } from "@libsql/client";
import { redactSensitiveFields } from "../pipeline/redact.js";
import type { SecretBox } from "../secrets.js";
import type {
  Connection,
  DirectCall,
  Execution,
  ExecutionBase,
  ExecutionError,
  ExecutionKind,
  ExecutionStatus,
  Integration,
  JsonSchema,
  PendingApproval,
  Policy,
  PolicyAction,
  Projection,
  ResultState,
  RiskClass,
  Source,
  SourceSemantics,
  SourceType,
  StoredPendingApproval,
  Tool,
  TraceEvent,
} from "../types.js";
import { isValidProjectionForKind, NEWER_BUILD_SENTINEL, PROJECTIONS } from "../types.js";
import { CANARY_REF, ensureKeyCanary, type StoreKeyContext } from "./key-lifecycle.js";
import type { ConduitStore, DirectSettle, ReplayJournalRow } from "./store.js";

/**
 * libSQL/SQLite implementation of the ConduitStore seam. Single file
 * locally and in Docker (spec §13.4); schema is plain SQLite so a D1
 * implementation can share it.
 */

export interface SqliteStoreOptions {
  client: Client;
  /** Encrypts SecretRepository contents at rest (spec §9.2). */
  secretBox: SecretBox;
  /** Sanitized provenance for canary errors (db path + key source; design §2). NEVER key material. */
  keyContext?: StoreKeyContext;
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
    base_url TEXT,
    generation INTEGER NOT NULL DEFAULT 0
  )`,
  // §4.1a: the generation ledger. AUTOINCREMENT, so a removed-then-re-added
  // namespace never reuses a value a pause may still carry (row #17).
  `CREATE TABLE IF NOT EXISTS source_generations (
    gen INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    at INTEGER NOT NULL
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
    request_key TEXT,
    kind TEXT NOT NULL DEFAULT 'code' CHECK (kind IN ('code', 'direct')),
    projection TEXT NOT NULL DEFAULT 'code' CHECK (projection IN ('code', 'direct', 'discovery')),
    direct_call TEXT,
    client_id TEXT,
    program TEXT,
    result_state TEXT CHECK (result_state IN ('delivered', 'retained', 'discarded')),
    CHECK ((kind = 'code' AND projection = 'code') OR (kind = 'direct' AND projection IN ('direct', 'discovery')))
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
    at INTEGER NOT NULL,
    projection TEXT NOT NULL DEFAULT 'code' CHECK (projection IN ('code', 'direct', 'discovery')),
    client_id TEXT
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
  // §4.1: a named client's request key lives here, never in
  // executions.request_key — the PK namespaces the key by client, so two
  // clients may reuse one key string and a default-profile (NULL client)
  // key can never collide with a named one. The index on execution_id below
  // serves the LEFT JOIN every execution read performs (eng review D9);
  // without it that join scans this append-only table.
  `CREATE TABLE IF NOT EXISTS request_keys (
    client_id TEXT NOT NULL,
    key TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    PRIMARY KEY (client_id, key)
  )`,
  // UNIQUE: one execution has at most ONE request key. The PK already
  // stops two executions sharing a (client, key); this stops one execution
  // collecting two keys, which the LEFT JOIN above would fan out into
  // duplicate rows for a single execution read. It also still serves that
  // join, so the D9 index requirement holds. A database created before this
  // carries the same NAME as a PLAIN index — and `CREATE UNIQUE INDEX IF NOT
  // EXISTS` silently does nothing when a name exists — so the ladder below
  // drops and recreates it rather than relying on this statement.
  `CREATE UNIQUE INDEX IF NOT EXISTS request_keys_execution ON request_keys (execution_id)`,
  `CREATE TABLE IF NOT EXISTS secrets (
    ref TEXT PRIMARY KEY,
    sealed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

/**
 * §4.1a: generation advancement lives INSIDE SQLite, not in the R1 writer.
 * An older daemon run after R1 provisions through the shipped statements,
 * which leave `generation` untouched; the R1 daemon would then accept the
 * obsolete provenance on resume. These triggers close that for every writer
 * version, so any INSERT or UPDATE of a source row — and any tool INSERT —
 * allocates a fresh sequence value.
 *
 * `sources_gen_on_update` is guarded `WHEN NEW.generation = OLD.generation`
 * so its own write does not recurse; the same guard keeps the generation
 * writes of the other two triggers from firing it a second time.
 *
 * Created separately from SCHEMA: they reference `sources.generation`, so on
 * a legacy database they may only run after the ALTER in the ladder below.
 */
const GENERATION_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS sources_gen_on_update AFTER UPDATE ON sources
   WHEN NEW.generation = OLD.generation
   BEGIN
     INSERT INTO source_generations (namespace, at) VALUES (NEW.namespace, strftime('%s','now')*1000);
     UPDATE sources SET generation = last_insert_rowid() WHERE id = NEW.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS sources_gen_on_insert AFTER INSERT ON sources
   BEGIN
     INSERT INTO source_generations (namespace, at) VALUES (NEW.namespace, strftime('%s','now')*1000);
     UPDATE sources SET generation = last_insert_rowid() WHERE id = NEW.id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS sources_gen_on_tools AFTER INSERT ON tools
   BEGIN
     INSERT INTO source_generations (namespace, at) VALUES (NEW.namespace, strftime('%s','now')*1000);
     UPDATE sources SET generation = last_insert_rowid() WHERE namespace = NEW.namespace;
   END`,
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

/**
 * The one execution read shape (§4.1): every hydrating read LEFT JOINs
 * `request_keys` so a named row's key arrives as `named_request_key`, which
 * `hydrateExecutionRow` folds into `requestKey`. `e.*` first — the join
 * column must not shadow a real column.
 */
const EXECUTION_SELECT = `SELECT e.*, rk.key AS named_request_key
  FROM executions e LEFT JOIN request_keys rk ON rk.execution_id = e.id`;

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

  // `request_keys_execution` shipped PLAIN and is now UNIQUE. The
  // statement above cannot perform that upgrade — `CREATE UNIQUE INDEX IF NOT
  // EXISTS` is a silent no-op when an index of that NAME already exists,
  // whatever its uniqueness — so an R1 database created before this change
  // would keep the plain index and the constraint would never take effect
  // (the check reports green while enforcing nothing). Read the actual
  // uniqueness from the catalog and rebuild only when it is missing.
  // Nothing is published yet, so the only legacy database is a dev/dogfood
  // one — but that one is real, and silently leaving it unconstrained is the
  // failure this guards.
  const keyIndexes = await client.execute("PRAGMA index_list(request_keys)");
  const existing = keyIndexes.rows.find((row) => String(row.name) === "request_keys_execution");
  if (existing !== undefined && Number(existing.unique) !== 1) {
    // CHECK BEFORE DROPPING. The DROP and the CREATE UNIQUE ran as one batch,
    // so a duplicate in the table failed the CREATE after the DROP had already
    // landed — leaving NO index of that name at all, and every subsequent open
    // failing the same way with no path back. Verified by probe.
    //
    // So: look for the duplicate first. If one exists, touch nothing. The
    // database is left exactly as it was (the plain index intact) and the
    // operator can repair the rows and reopen. No automatic de-duplication —
    // silently deleting idempotency keys would be guessing which one the
    // caller meant.
    const dupes = await client.execute(
      `SELECT COUNT(*) AS n FROM (
         SELECT execution_id FROM request_keys GROUP BY execution_id HAVING COUNT(*) > 1
       )`,
    );
    const duplicated = Number(Object.values(dupes.rows[0] ?? {})[0] ?? 0);
    if (duplicated > 0) {
      // Count only: no execution ids and no key values, which are caller
      // secrets, and no database path.
      throw new Error(
        `[SqliteStore] Open failed: request_keys holds more than one key for an execution; the unique index cannot be built. Context: { executions: ${duplicated} }`,
      );
    }
    await client.batch(
      [
        "DROP INDEX IF EXISTS request_keys_execution",
        "CREATE UNIQUE INDEX IF NOT EXISTS request_keys_execution ON request_keys (execution_id)",
      ],
      "write",
    );
  }

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

  // R1 §4.1: kind / projection / direct_call / client_id / program /
  // result_state. Same PRAGMA-then-ALTER retrofit; the CHECKs in SCHEMA
  // protect fresh schemas only — hydrateExecutionRow guards legacy rows
  // read-side.
  const r1ExecutionColumns: readonly (readonly [string, string])[] = [
    ["kind", "kind TEXT NOT NULL DEFAULT 'code'"],
    ["projection", "projection TEXT NOT NULL DEFAULT 'code'"],
    ["direct_call", "direct_call TEXT"],
    ["client_id", "client_id TEXT"],
    ["program", "program TEXT"],
    ["result_state", "result_state TEXT"],
  ];
  for (const [name, ddl] of r1ExecutionColumns) {
    if (!executionColumns.rows.some((row) => row.name === name)) {
      await tolerateSchemaRace(() => client.execute(`ALTER TABLE executions ADD COLUMN ${ddl}`));
    }
  }

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

  // R1 §4.3: attribution columns on trace_events. Re-read the PRAGMA — the
  // block above may have reshaped the table since the first read.
  const traceColumnsAfter = await client.execute("PRAGMA table_info(trace_events)");
  for (const [name, ddl] of [
    ["projection", "projection TEXT NOT NULL DEFAULT 'code'"],
    ["client_id", "client_id TEXT"],
  ] as const) {
    if (!traceColumnsAfter.rows.some((row) => row.name === name)) {
      await tolerateSchemaRace(() => client.execute(`ALTER TABLE trace_events ADD COLUMN ${ddl}`));
    }
  }

  // R1 §4.1a: sources.generation, then the three triggers. The triggers
  // reference the column, so they are created only after the ALTER on a
  // legacy database. CREATE TRIGGER IF NOT EXISTS is idempotent and lives
  // in the database file: a pre-R1 build's ladder knows no triggers and
  // drops none (row #47, trigger survival).
  const sourceColumns = await client.execute("PRAGMA table_info(sources)");
  if (!sourceColumns.rows.some((row) => row.name === "generation")) {
    await tolerateSchemaRace(() =>
      client.execute("ALTER TABLE sources ADD COLUMN generation INTEGER NOT NULL DEFAULT 0"),
    );
  }
  await client.batch(GENERATION_TRIGGERS, "write");

  // Design §2 (2026-07-19): wrong master key fails loud HERE, at open —
  // not at the first secret decrypt. Every product bin routes through this.
  await ensureKeyCanary(client, secretBox, options.keyContext);

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
      async getGeneration(namespace: string): Promise<number | undefined> {
        const rs = await client.execute({
          sql: "SELECT generation FROM sources WHERE namespace = ?",
          args: [namespace],
        });
        // `integer`, not `maybeInteger`: absence of a row is `undefined`, but a
        // row holding a non-integer generation is corruption, and this value is
        // an authorization input (§5.4). Fail loud rather than read as "no source".
        const row = rs.rows[0];
        return row === undefined ? undefined : integer(row, "generation");
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
      async create(execution: Execution, opts?: { attempt?: string }): Promise<void> {
        const c = executionWriteColumns(execution);
        const namedKey =
          execution.clientId !== null && execution.requestKey !== undefined
            ? { clientId: execution.clientId, key: execution.requestKey }
            : undefined;
        const named = namedKey !== undefined;
        const insert = {
          sql: `INSERT INTO executions
                  (id, code, status, seeds, paused_on, started_at, ended_at, result, error, request_key,
                   kind, projection, direct_call, client_id, program, result_state, resume_attempt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            execution.id,
            c.code,
            execution.status,
            c.seeds,
            execution.pausedOn === undefined ? null : JSON.stringify(execution.pausedOn),
            execution.startedAt,
            execution.endedAt ?? null,
            execution.result === undefined ? null : JSON.stringify(execution.result),
            execution.error === undefined ? null : JSON.stringify(execution.error),
            named ? null : (execution.requestKey ?? null),
            c.kind,
            c.projection,
            c.directCall,
            c.clientId,
            c.program,
            c.resultState,
            opts?.attempt ?? null,
          ],
        };
        if (!named) {
          await client.execute(insert);
          return;
        }
        // ONE batch, so a duplicate key rolls the execution row back with
        // it: libSQL surfaces the SQLite message verbatim, and the manager
        // matches that text to raise the client-visible conflict.
        await client.batch(
          [
            insert,
            {
              sql: "INSERT INTO request_keys (client_id, key, execution_id) VALUES (?, ?, ?)",
              args: [namedKey.clientId, namedKey.key, execution.id],
            },
          ],
          "write",
        );
      },
      async put(execution: Execution): Promise<void> {
        const c = executionWriteColumns(execution);
        await client.execute({
          sql: `INSERT INTO executions
                  (id, code, status, seeds, paused_on, started_at, ended_at, result, error, request_key,
                   kind, projection, direct_call, client_id, program, result_state)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  code = excluded.code, status = excluded.status, seeds = excluded.seeds,
                  paused_on = excluded.paused_on, started_at = excluded.started_at,
                  ended_at = excluded.ended_at, result = excluded.result,
                  error = excluded.error, request_key = excluded.request_key,
                  kind = excluded.kind, projection = excluded.projection,
                  direct_call = excluded.direct_call, client_id = excluded.client_id,
                  program = excluded.program, result_state = excluded.result_state`,
          args: [
            execution.id,
            c.code,
            execution.status,
            c.seeds,
            execution.pausedOn === undefined ? null : JSON.stringify(execution.pausedOn),
            execution.startedAt,
            execution.endedAt ?? null,
            execution.result === undefined ? null : JSON.stringify(execution.result),
            execution.error === undefined ? null : JSON.stringify(execution.error),
            // A named row's key lives in `request_keys` (§4.1), never here.
            execution.clientId === null ? (execution.requestKey ?? null) : null,
            c.kind,
            c.projection,
            c.directCall,
            c.clientId,
            c.program,
            c.resultState,
          ],
        });
      },
      async get(id: string): Promise<Execution | undefined> {
        const rs = await client.execute({
          sql: `${EXECUTION_SELECT} WHERE e.id = ?`,
          args: [id],
        });
        const row = rs.rows[0];
        return row === undefined ? undefined : hydrateExecutionRow(row, id);
      },
      async kindOf(id: string): Promise<ExecutionKind | undefined> {
        // Deliberately unhydrated (§5.4): the caller needs the routing
        // discriminator for a row whose other columns may be corrupt.
        const rs = await client.execute({
          sql: "SELECT kind FROM executions WHERE id = ?",
          args: [id],
        });
        const row = rs.rows[0];
        if (row === undefined) {
          return undefined;
        }
        const kind = maybeText(row, "kind");
        return kind !== undefined && isOneOf(kind, EXECUTION_KINDS) ? kind : undefined;
      },
      async getByRequestKey(key: string, clientId: string | null): Promise<Execution | undefined> {
        // Two disjoint key spaces (§4.1): a named client's key is only ever
        // in `request_keys`, the default profile's only ever in the legacy
        // column. Neither lookup can reach the other's rows, so a key that
        // collides across the two — including one holding U+0000 — stays
        // two distinct executions.
        const rs = await client.execute(
          clientId === null
            ? { sql: `${EXECUTION_SELECT} WHERE e.request_key = ?`, args: [key] }
            : {
                sql: `${EXECUTION_SELECT} WHERE rk.client_id = ? AND rk.key = ?`,
                args: [clientId, key],
              },
        );
        const row = rs.rows[0];
        return row === undefined ? undefined : hydrateExecutionRow(row, text(row, "id"));
      },
      async claimForResume(id: string, resumeAttemptId: string, callId: string): Promise<boolean> {
        // Single guarded UPDATE: the WHERE status = 'paused' clause makes
        // this a compare-and-swap — SQLite serializes writes, so exactly
        // one concurrent caller's UPDATE matches the row and affects it.
        // A read-then-write would race here; this must stay one statement.
        //
        // The callId predicate joins the same statement so the identity
        // check is part of the compare-and-swap rather than a separate
        // read: an approval is for ONE pending call. A program that is
        // approved, runs on, and pauses again is `paused` once more — but
        // on a different call — and a queued duplicate of the first
        // approval must lose here, not win and approve a call no human saw.
        //
        // A CORRUPT pause stays claimable on purpose. A pause no operator
        // can ever name — `paused_on` NULL, not JSON, or a callId that is
        // absent, not text, or blank — can never be legitimately approved,
        // and refusing it here would leave the row `paused` forever with
        // no path to a terminal state. Letting the claim win hands it to
        // the manager's corrupt-state branch, which terminalizes it
        // `failed` — the self-healing the resume path had before the
        // callId predicate existed.
        //
        // "Un-nameable" is exactly what the wire decoder refuses (mcp
        // rpc.ts: not a string, or blank), and "blank" is ASCII whitespace
        // — deliberately not `trim()`, which is Unicode-aware. The set is
        // defined ONCE as `NOT_NAMEABLE_CALL_ID` in sdk types.ts (used by
        // the manager's entry check and `isPendingApproval`); this SQL
        // `trim` set, the mcp rpc.ts decoder literal, and the cli
        // commands/approvals.ts literal MUST stay identical to it, or a
        // stored callId becomes one no request can match and no claim will
        // admit. A present-but-
        // unmatchable callId (a JSON number, `""`) would otherwise fall
        // through to the equality arm, never match, and strand the row
        // listed-but-undecidable.
        //
        // A CASE, not an OR chain: SQLite documents lazy evaluation for
        // CASE only, and `json_extract` on invalid JSON throws — so the
        // extraction arms are reached only after `json_valid` has said it
        // is safe. `json_type` is NULL for a missing path and 'null' for a
        // JSON null. `IS NOT`, never `!=`: `!=` against that NULL is NULL,
        // not true, so a missing callId would fall through to the equality
        // arm — the exact strand this arm prevents.
        const rs = await client.execute({
          sql: `UPDATE executions SET status = 'running', resume_attempt = ?
                WHERE id = ? AND status = 'paused'
                  AND CASE
                        WHEN paused_on IS NULL THEN 1
                        WHEN json_valid(paused_on) = 0 THEN 1
                        WHEN json_type(paused_on, '$.callId') IS NOT 'text' THEN 1
                        WHEN trim(json_extract(paused_on, '$.callId'), ' ' || char(9, 10, 11, 12, 13)) = '' THEN 1
                        ELSE json_extract(paused_on, '$.callId') = ?
                      END`,
          args: [resumeAttemptId, id, callId],
        });
        return rs.rowsAffected === 1;
      },
      async claimCallId(id: string): Promise<string | undefined> {
        // The same extraction the claim's equality arm performs, guarded the
        // same way (`json_extract` throws on invalid JSON). Text only: a
        // non-text value is one the claim admitted through a corrupt arm,
        // and the manager must treat it as such regardless of what
        // `JSON.parse` made of the same bytes.
        const rs = await client.execute({
          sql: `SELECT CASE WHEN json_valid(paused_on) AND json_type(paused_on, '$.callId') = 'text'
                       THEN json_extract(paused_on, '$.callId') END AS claim_call_id
                FROM executions WHERE id = ?`,
          args: [id],
        });
        const row = rs.rows[0];
        return row === undefined ? undefined : maybeText(row, "claim_call_id");
      },
      async failClaimedResume(
        id: string,
        reason: string,
        errorName = "ConduitInternalError",
      ): Promise<void> {
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
          args: [Date.now(), JSON.stringify({ name: errorName, message: reason }), id],
        });
      },
      async settleDirect(id: string, attempt: string, settle: DirectSettle): Promise<boolean> {
        // §5.3 exactly-once: ONE guarded UPDATE. The fence is three-part —
        // the row must still be `running`, must belong to THIS attempt, and
        // must be a direct row. A late continuation whose timer already
        // terminalized the row, or a duplicate settle, matches nothing.
        const endedAt = settle.status === "paused" ? null : Date.now();
        const rs = await client.execute({
          sql: `UPDATE executions SET status = ?, ended_at = ?, paused_on = ?, result = ?, error = ?, result_state = ?
                WHERE id = ? AND status = 'running' AND resume_attempt = ? AND kind = 'direct'`,
          args: [
            settle.status,
            endedAt,
            settle.status === "paused" ? JSON.stringify(settle.pausedOn) : null,
            settle.status === "completed" && settle.resultState === "retained"
              ? JSON.stringify(settle.result ?? null)
              : null,
            settle.status === "failed" ? JSON.stringify(settle.error) : null,
            settle.status === "completed" ? settle.resultState : null,
            id,
            attempt,
          ],
        });
        return rs.rowsAffected === 1;
      },
      async invalidatePaused(namespace: string): Promise<number> {
        // Namespace EQUALITY, never LIKE: `_` is a legal namespace
        // character and a LIKE wildcard, so `github` would sweep
        // `github_x`. The json_valid/json_type arms come first because
        // `json_extract` throws on invalid JSON — a legacy pause (no
        // namespace) and a corrupt one are both skipped, not failed.
        const rs = await client.execute({
          sql: `UPDATE executions SET status = 'failed', ended_at = ?, paused_on = NULL, error = ?
                WHERE status = 'paused'
                  AND json_valid(paused_on)
                  AND json_type(paused_on, '$.namespace') = 'text'
                  AND json_extract(paused_on, '$.namespace') = ?`,
          args: [
            Date.now(),
            JSON.stringify({
              name: "ConduitCatalogChanged",
              message: "catalog changed — re-approve",
            }),
            namespace,
          ],
        });
        return rs.rowsAffected;
      },
      async listPaused(): Promise<Execution[]> {
        // `claim_call_id` is the call id THE CLAIM SEES: `claimForResume`
        // compares `json_extract(paused_on, '$.callId')`, and SQLite's
        // extractor keeps the FIRST of duplicate JSON keys where
        // `JSON.parse` keeps the LAST. The list must advertise the id the
        // claim accepts, so when the two disagree the SQL value wins here
        // and the manager's post-claim strict check then terminalizes the
        // row as corrupt. Guarded: `json_extract` throws on invalid JSON.
        const rs = await client.execute(
          `SELECT e.*, CASE WHEN json_valid(e.paused_on) THEN json_extract(e.paused_on, '$.callId') END AS claim_call_id,
                  rk.key AS named_request_key
           FROM executions e LEFT JOIN request_keys rk ON rk.execution_id = e.id
           WHERE e.status = 'paused' ORDER BY e.started_at ASC, e.id ASC`,
        );
        // One row whose JSON will not parse must not hide the whole queue:
        // the resume claim admits such a pause so an operator can
        // terminalize it, and they can only do that if they can SEE its id.
        // A row that fails hydration is returned with no `pausedOn` (the
        // list projection renders it as a recovery row) and logged here.
        return rs.rows.map((row) => {
          const id = text(row, "id");
          try {
            const execution = hydrateExecutionRow(row, id);
            const claimCallId = maybeText(row, "claim_call_id");
            const pausedOn: unknown = execution.pausedOn;
            if (
              claimCallId !== undefined &&
              typeof pausedOn === "object" &&
              pausedOn !== null &&
              (pausedOn as { callId?: unknown }).callId !== claimCallId
            ) {
              log(
                `[SqliteStore] listPaused: stored pause carries a call id the claim would not accept (duplicate JSON key); listing the claimable one. Context: { id: ${JSON.stringify(id)} }`,
              );
              (pausedOn as { callId?: unknown }).callId = claimCallId;
            }
            return execution;
          } catch (cause) {
            log(
              `[SqliteStore] listPaused: row failed to hydrate; listed as an unreadable pause. Context: { id: ${JSON.stringify(id)}, cause: ${String(cause)} }`,
            );
            // Hydration may have failed on a SIBLING column (`seeds`) while
            // `paused_on` holds a nameable call id — and the claim admits
            // that row only by its exact id. Carry the SQL-side id so the
            // list can advertise it; the partial pause fails the shared
            // validator, so it still projects as a recovery row.
            const claimCallId = maybeText(row, "claim_call_id");
            return {
              id,
              kind: "code",
              code: "",
              status: "paused",
              seeds: { now: 0, random: 0 },
              startedAt: maybeInteger(row, "started_at") ?? 0,
              clientId: null,
              projection: "code",
              ...(claimCallId === undefined
                ? {}
                : { pausedOn: { callId: claimCallId } as PendingApproval }),
            };
          }
        });
      },
      async listRunningIds(): Promise<string[]> {
        // Ids only, never hydrated: the crash-terminal sweep's whole job
        // is to recover rows a dead process left behind, and one of those
        // rows having corrupt JSON is a realistic outcome of that same
        // crash. Selecting the id column alone means no row can throw on
        // the way out and strand its siblings.
        const rs = await client.execute(
          "SELECT id FROM executions WHERE status = 'running' ORDER BY started_at ASC, id ASC",
        );
        return rs.rows.map((row) => text(row, "id"));
      },
    },

    trace: {
      async append(event: TraceEvent): Promise<void> {
        await client.execute({
          sql: `INSERT INTO trace_events
                  (call_id, execution_id, tool_name, connection_prefix, input,
                   output_summary, upstream_status, latency_ms, policy_verdict, at,
                   projection, client_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            event.projection,
            event.clientId,
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
        if (ref === CANARY_REF) {
          throw new Error(
            `[SqliteStore] Secret ref "${ref}" is reserved for the key canary. Context: { ref: ${JSON.stringify(ref)} }`,
          );
        }
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
        if (ref === CANARY_REF) {
          throw new Error(
            `[SqliteStore] Secret ref "${ref}" is reserved for the key canary. Context: { ref: ${JSON.stringify(ref)} }`,
          );
        }
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
    }): Promise<{ generation: number }> {
      if (input.secret !== undefined && input.removeSecretRef !== undefined) {
        throw new Error(
          "[ConduitStore] provisionSource: `secret` and `removeSecretRef` are mutually exclusive.",
        );
      }
      // INVARIANT §16.3: the canary ref is reserved for key-lifecycle's own
      // raw-SQL access — same guard as secrets.put/remove, applied here too
      // since provisionSource upserts/deletes secrets rows directly rather
      // than going through the secrets repository.
      if (input.secret?.ref === CANARY_REF) {
        throw new Error(
          `[ConduitStore] Secret ref "${CANARY_REF}" is reserved for the key canary. Context: { ref: ${JSON.stringify(CANARY_REF)} }`,
        );
      }
      if (input.removeSecretRef === CANARY_REF) {
        throw new Error(
          `[ConduitStore] Secret ref "${CANARY_REF}" is reserved for the key canary. Context: { ref: ${JSON.stringify(CANARY_REF)} }`,
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
      // §4.1a rev 11: no explicit ledger insert — the triggers have already
      // allocated every bump this batch earned. Read back what they stored.
      const rs = await client.execute({
        sql: "SELECT generation FROM sources WHERE id = ?",
        args: [source.id],
      });
      const row = rs.rows[0];
      if (row === undefined) {
        throw new Error(
          `[SqliteStore] provisionSource failed: the provisioned source row is missing after commit. Context: { id: ${JSON.stringify(source.id)} }`,
        );
      }
      return { generation: integer(row, "generation") };
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

const EXECUTION_KINDS: readonly ExecutionKind[] = ["code", "direct"];
const RESULT_STATES: readonly ResultState[] = ["delivered", "retained", "discarded"];

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
      const { upstreamName, readOnlyHint, destructiveHint } = record;
      // C5 (design D4): the raw upstream wire name recorded at normalize time.
      // Absent on legacy rows — serve-time falls back to prefix-strip.
      if (upstreamName !== undefined) {
        if (typeof upstreamName !== "string") {
          throw toolReadError(name, `malformed mcp source_semantics: ${JSON.stringify(value)}`);
        }
        semantics.upstreamName = upstreamName;
      }
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
    // §4.1a: the database allocates this; a caller's value on write is ignored.
    generation: integer(row, "generation"),
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

/**
 * The R1 row shape for INSERT/UPSERT (§4.1): the sentinel goes in `code`,
 * the real program in `program`. An older build reads `code` only, so it
 * gets a program that throws rather than resuming a direct row as an empty
 * program or a narrowed code row under the unscoped invoker.
 */
function executionWriteColumns(execution: Execution): {
  code: string;
  seeds: string;
  program: string | null;
  directCall: string | null;
  kind: Execution["kind"];
  projection: string;
  clientId: string | null;
  resultState: string | null;
} {
  return execution.kind === "code"
    ? {
        code: NEWER_BUILD_SENTINEL,
        seeds: JSON.stringify(execution.seeds),
        program: execution.code,
        directCall: null,
        kind: "code",
        projection: execution.projection,
        clientId: execution.clientId,
        resultState: null,
      }
    : {
        code: NEWER_BUILD_SENTINEL,
        // FILLER for a NOT NULL column. A direct row has no seeds — there is
        // no program to replay — and this value is never read back: hydration
        // parses `seeds` only on the code arm.
        seeds: "{}",
        program: null,
        directCall: JSON.stringify(execution.call),
        kind: "direct",
        projection: execution.projection,
        clientId: execution.clientId,
        resultState: execution.resultState ?? null,
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
  // The (kind, projection) pair is enforced in three independent places
  // (§9.2): the TYPE, the fresh DDL CHECK, and here. Legacy tables carry no
  // CHECK, so this read-side guard is their only layer — without it a
  // {kind:"direct", projection:"code"} row would be authorized under the
  // Code flag and dispatched through the direct arm.
  const kind = maybeText(row, "kind") ?? "code";
  if (!isOneOf(kind, EXECUTION_KINDS)) {
    throw executionReadError(`unrecognized kind ${JSON.stringify(kind)}`);
  }
  const projection = maybeText(row, "projection") ?? "code";
  if (!isOneOf(projection, PROJECTIONS)) {
    throw executionReadError(`unrecognized projection ${JSON.stringify(projection)}`);
  }
  if (!isValidProjectionForKind(kind, projection)) {
    throw executionReadError(`kind '${kind}' cannot carry projection '${projection}'`);
  }
  const directCall = maybeText(row, "direct_call");
  if (kind === "direct" && directCall === undefined) {
    throw executionReadError("kind = 'direct' requires direct_call");
  }
  if (kind === "code" && directCall !== undefined) {
    throw executionReadError("kind = 'code' forbids direct_call");
  }
  const resultStateRaw = maybeText(row, "result_state");
  const resultRaw = maybeText(row, "result");
  if (kind === "code" && resultStateRaw !== undefined) {
    throw executionReadError("result_state is set on a code row");
  }
  if (kind === "direct" && status === "completed") {
    if (resultStateRaw === undefined || !isOneOf(resultStateRaw, RESULT_STATES)) {
      throw executionReadError(
        `completed direct row has result_state ${JSON.stringify(resultStateRaw)}`,
      );
    }
    if (resultStateRaw === "retained" && resultRaw === undefined) {
      throw executionReadError("result_state 'retained' with no result");
    }
    if (resultStateRaw !== "retained" && resultRaw !== undefined) {
      throw executionReadError(`result_state '${resultStateRaw}' with a stored result`);
    }
  }
  if (kind === "direct" && status !== "completed" && resultStateRaw !== undefined) {
    throw executionReadError("result_state on a non-completed direct row");
  }

  const base: Omit<ExecutionBase, "projection"> & { projection: Projection } = {
    id: text(row, "id"),
    status,
    startedAt: integer(row, "started_at"),
    clientId: maybeText(row, "client_id") ?? null,
    projection,
  };
  const pausedOn = maybeText(row, "paused_on");
  if (pausedOn !== undefined) {
    base.pausedOn = parseJson(pausedOn, (cause) =>
      executionReadError("paused_on is not valid JSON", cause),
    ) as StoredPendingApproval;
  }
  const endedAt = maybeInteger(row, "ended_at");
  if (endedAt !== undefined) {
    base.endedAt = endedAt;
  }
  if (resultRaw !== undefined) {
    base.result = parseJson(resultRaw, (cause) =>
      executionReadError("result is not valid JSON", cause),
    );
  }
  const error = maybeText(row, "error");
  if (error !== undefined) {
    base.error = parseJson(error, (cause) =>
      executionReadError("error is not valid JSON", cause),
    ) as ExecutionError;
  }
  // The legacy column first, then the named join column.
  const requestKey = maybeText(row, "request_key") ?? maybeText(row, "named_request_key");
  if (requestKey !== undefined) {
    base.requestKey = requestKey;
  }

  if (kind === "code") {
    // A legacy row has no `program`: its real program is still in `code`.
    const program = maybeText(row, "program");
    return {
      ...base,
      kind,
      projection: "code",
      code: program ?? text(row, "code"),
      seeds: parseJson(text(row, "seeds"), (cause) =>
        executionReadError("seeds is not valid JSON", cause),
      ) as Extract<Execution, { kind: "code" }>["seeds"],
    };
  }
  const call = parseJson(directCall as string, (cause) =>
    executionReadError("direct_call is not valid JSON", cause),
  );
  if (
    typeof call !== "object" ||
    call === null ||
    typeof (call as DirectCall).toolName !== "string" ||
    typeof (call as DirectCall).namespace !== "string" ||
    typeof (call as DirectCall).request !== "string"
  ) {
    throw executionReadError("direct_call is malformed");
  }
  // `request` holds a JSON-encoded value, so a STRING check is not enough: a
  // row whose request is not parseable JSON would pass every guard here and
  // every guard downstream, and only fail deep inside the drive where the
  // throw has nowhere truthful to go. Fail the READ instead, in the same
  // fail-loud style as the guards above.
  parseJson((call as DirectCall).request, (cause) =>
    executionReadError("direct_call request is not valid JSON", cause),
  );
  const direct: Extract<Execution, { kind: "direct" }> = {
    ...base,
    kind,
    projection: projection as "direct" | "discovery",
    call: call as DirectCall,
  };
  if (resultStateRaw !== undefined) {
    direct.resultState = resultStateRaw as ResultState;
  }
  return direct;
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
  // Absent on a legacy table (the column post-dates those rows): default to
  // the only projection that existed then.
  const projection = maybeText(row, "projection") ?? "code";
  if (!isOneOf(projection, PROJECTIONS)) {
    throw new Error(
      `[SqliteStore] Failed to read trace event: unrecognized projection ${JSON.stringify(projection)}. Context: { callId: ${JSON.stringify(callId)} }`,
    );
  }
  const event: TraceEvent = {
    callId,
    executionId: text(row, "execution_id"),
    toolName: text(row, "tool_name"),
    connectionPrefix: text(row, "connection_prefix"),
    projection,
    clientId: maybeText(row, "client_id") ?? null,
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
