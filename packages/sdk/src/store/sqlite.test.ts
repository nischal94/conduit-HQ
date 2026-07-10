import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretBox } from "../secrets.js";
import type {
  ExecutionStatus,
  PolicyAction,
  RiskClass,
  SourceSemantics,
  SourceType,
  Tool,
} from "../types.js";
import { openSqliteStore } from "./sqlite.js";
import type { ConduitStore } from "./store.js";

/**
 * Compiler-pinned vocabulary list: Record<T, true> demands every union
 * member as a key, so growing a union in types.ts fails this file's
 * compilation until the pin tests cover the new member too.
 */
function vocabulary<T extends string>(members: Record<T, true>): T[] {
  return Object.keys(members) as T[];
}

function tool(overrides: Partial<Tool> & Pick<Tool, "name" | "namespace">): Tool {
  return {
    inputSchema: { type: "object" },
    outputSchema: {},
    riskClass: "safe",
    sourceSemantics: { kind: "mcp" },
    ...overrides,
  };
}

let store: ConduitStore;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
  });
});

describe("SqliteStore", () => {
  describe("sources", () => {
    it("round-trips a source, omitting absent optionals", async () => {
      await store.sources.upsert({
        id: "src_1",
        type: "openapi",
        namespace: "petstore",
        location: "https://example.com/openapi.json",
      });
      const loaded = await store.sources.getByNamespace("petstore");
      expect(loaded?.id).toBe("src_1");
      expect(loaded && "baseUrl" in loaded).toBe(false);
    });

    it("upserts on conflict and removes", async () => {
      const base = {
        id: "src_1",
        type: "openapi" as const,
        namespace: "petstore",
        location: "https://a",
      };
      await store.sources.upsert(base);
      await store.sources.upsert({ ...base, location: "https://b", baseUrl: "https://api" });
      const loaded = await store.sources.get("src_1");
      expect(loaded?.location).toBe("https://b");
      expect(loaded?.baseUrl).toBe("https://api");
      await store.sources.remove("src_1");
      expect(await store.sources.get("src_1")).toBeUndefined();
    });
  });

  describe("connections", () => {
    it("resolves by prefix (the §5.3 step-1 lookup)", async () => {
      await store.connections.upsert({
        id: "conn_1",
        integrationId: "int_1",
        prefix: "github.org.main",
        credentialRef: "cred_github_main",
      });
      const loaded = await store.connections.getByPrefix("github.org.main");
      expect(loaded?.credentialRef).toBe("cred_github_main");
    });
  });

  describe("tools", () => {
    it("replaces a namespace atomically and preserves other namespaces", async () => {
      await store.tools.replaceNamespace("github", [
        tool({ name: "github.issues.create", namespace: "github" }),
        tool({ name: "github.issues.list", namespace: "github" }),
      ]);
      await store.tools.replaceNamespace("linear", [
        tool({ name: "linear.search", namespace: "linear" }),
      ]);
      await store.tools.replaceNamespace("github", [
        tool({ name: "github.issues.create", namespace: "github", riskClass: "review" }),
      ]);

      expect(await store.tools.list("github")).toHaveLength(1);
      expect((await store.tools.get("github.issues.create"))?.riskClass).toBe("review");
      expect(await store.tools.get("github.issues.list")).toBeUndefined();
      expect(await store.tools.list()).toHaveLength(2);
    });

    it("round-trips schemas and semantics as structured data", async () => {
      const schema = { type: "object", properties: { q: { type: "string" } } };
      await store.tools.replaceNamespace("x", [
        tool({
          name: "x.search",
          namespace: "x",
          description: "Search",
          inputSchema: schema,
          sourceSemantics: { kind: "openapi", method: "GET", path: "/search" },
        }),
      ]);
      const loaded = await store.tools.get("x.search");
      expect(loaded?.inputSchema).toEqual(schema);
      expect(loaded?.sourceSemantics).toEqual({ kind: "openapi", method: "GET", path: "/search" });
    });
  });

  describe("policies", () => {
    it("INVARIANT §7: policies persist across source refresh; manual overrides never silently reverted", async () => {
      await store.tools.replaceNamespace("github", [
        tool({ name: "github.issues.create", namespace: "github", riskClass: "review" }),
      ]);
      // A human tightened this tool's policy by hand.
      await store.policies.upsert({
        toolName: "github.issues.create",
        action: "block",
        seededFrom: "review",
        manualOverride: true,
        redactFields: [],
      });

      // Source refresh: tool re-ingested (schema changed upstream).
      await store.tools.replaceNamespace("github", [
        tool({ name: "github.issues.create", namespace: "github", riskClass: "safe" }),
      ]);

      const policy = await store.policies.get("github.issues.create");
      expect(policy?.action).toBe("block");
      expect(policy?.manualOverride).toBe(true);
    });

    it("§11: policies round-trip redactFields, and a pre-§11 DB is retrofitted with the column", async () => {
      // Round-trip on a fresh store.
      await store.policies.upsert({
        toolName: "github.list_issues",
        action: "allow",
        seededFrom: "safe",
        manualOverride: false,
        redactFields: ["customer_email"],
      });
      const row = await store.policies.get("github.list_issues");
      expect(row?.redactFields).toEqual(["customer_email"]);

      // Legacy DB: create a policies table WITHOUT redact_fields, then reopen.
      const legacy = createClient({ url: ":memory:" });
      await legacy.execute(`CREATE TABLE policies (
        tool_name TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('allow', 'require_approval', 'block')),
        seeded_from TEXT NOT NULL CHECK (seeded_from IN ('safe', 'review', 'destructive')),
        manual_override INTEGER NOT NULL CHECK (manual_override IN (0, 1))
      )`);
      await legacy.execute({
        sql: "INSERT INTO policies (tool_name, action, seeded_from, manual_override) VALUES (?, ?, ?, ?)",
        args: ["github.delete_repo", "block", "destructive", 1],
      });
      const reopened = await openSqliteStore({
        client: legacy,
        secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
      });
      const migrated = await reopened.policies.get("github.delete_repo");
      expect(migrated?.redactFields).toEqual([]);
      expect(migrated?.manualOverride).toBe(true);
    });
  });

  describe("executions", () => {
    it("claimForResume: exactly one caller wins the paused→running transition", async () => {
      await store.executions.put({
        id: "e",
        code: "",
        status: "paused",
        seeds: { now: 0, random: 0 },
        startedAt: 0,
      });
      const [a, b] = await Promise.all([
        store.executions.claimForResume("e", "attempt-A"),
        store.executions.claimForResume("e", "attempt-B"),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one won
      expect((await store.executions.get("e"))?.status).toBe("running");
    });

    it("claimForResume: returns false when not paused", async () => {
      await store.executions.put({
        id: "e2",
        code: "",
        status: "running",
        seeds: { now: 0, random: 0 },
        startedAt: 0,
      });
      expect(await store.executions.claimForResume("e2", "x")).toBe(false);
    });

    it("round-trips executions including pause state and seeds", async () => {
      await store.executions.put({
        id: "exec_1",
        code: "await tools.github.issues.list({})",
        status: "paused",
        seeds: { now: 1751400000000, random: 0.42 },
        pausedOn: {
          callId: "call_2",
          toolName: "github.issues.create",
          input: { title: "hi" },
          reason: "Policy requires approval",
          expiresAt: 1751659200000,
        },
        startedAt: 1751400000000,
      });
      const loaded = await store.executions.get("exec_1");
      expect(loaded?.status).toBe("paused");
      expect(loaded?.seeds.random).toBe(0.42);
      expect(loaded?.pausedOn?.reason).toBe("Policy requires approval");
      expect(loaded && "endedAt" in loaded).toBe(false);
    });
  });

  describe("trace", () => {
    it("preserves append order per execution (the audit Trace ordering contract, §11)", async () => {
      for (const [i, toolName] of ["a.first", "a.second", "a.third"].entries()) {
        await store.trace.append({
          callId: `call_${i}`,
          executionId: "exec_1",
          toolName,
          connectionPrefix: "a.org.main",
          input: { step: i },
          policyVerdict: "allow",
          at: 1751400000000, // identical timestamps: order must not depend on `at`
        });
      }
      await store.trace.append({
        callId: "other",
        executionId: "exec_2",
        toolName: "b.x",
        connectionPrefix: "b.org.main",
        input: null,
        policyVerdict: "allow",
        at: 0,
      });

      const events = await store.trace.listByExecution("exec_1");
      expect(events.map((e) => e.toolName)).toEqual(["a.first", "a.second", "a.third"]);
    });

    it("round-trips TraceEvent.outputSummary through the trace table", async () => {
      await store.trace.append({
        callId: "call_out",
        executionId: "exec_out",
        toolName: "a.tool",
        connectionPrefix: "a.org.main",
        input: { q: 1 },
        outputSummary: { truncated: true },
        upstreamStatus: 200,
        latencyMs: 12,
        policyVerdict: "allow",
        at: 1,
      });
      const [event] = await store.trace.listByExecution("exec_out");
      expect(event?.outputSummary).toEqual({ truncated: true });
    });

    it("omits output on rows that never had one (denied/failed calls)", async () => {
      await store.trace.append({
        callId: "call_denied",
        executionId: "exec_denied",
        toolName: "a.tool",
        connectionPrefix: "a.org.main",
        input: null,
        policyVerdict: "require_approval",
        at: 1,
      });
      const [event] = await store.trace.listByExecution("exec_denied");
      expect(event && "output" in event).toBe(false);
    });

    it("§11: a legacy trace_events.output column is purged on open, and new writes never populate it", async () => {
      // Legacy DB with a populated output column (pre-§11 schema).
      const legacy = createClient({ url: ":memory:" });
      await legacy.execute(`CREATE TABLE trace_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL UNIQUE,
        execution_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        connection_prefix TEXT NOT NULL,
        input TEXT NOT NULL,
        output_summary TEXT,
        output TEXT,
        upstream_status INTEGER,
        latency_ms INTEGER,
        policy_verdict TEXT NOT NULL CHECK (policy_verdict IN ('allow', 'require_approval', 'block')),
        at INTEGER NOT NULL
      )`);
      await legacy.execute({
        sql: `INSERT INTO trace_events
                (call_id, execution_id, tool_name, connection_prefix, input,
                 output_summary, output, policy_verdict, at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "c1",
          "e1",
          "github.list_issues",
          "p",
          '{"a":1}',
          '"s"',
          '{"password":"leak"}',
          "allow",
          1,
        ],
      });
      const reopened = await openSqliteStore({
        client: legacy,
        secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
      });
      const purged = await legacy.execute("SELECT output FROM trace_events WHERE call_id = 'c1'");
      expect(purged.rows[0]?.output).toBeNull();

      // New writes carry no output; reads return events without the field.
      await reopened.trace.append({
        callId: "c2",
        executionId: "e1",
        toolName: "github.list_issues",
        connectionPrefix: "p",
        input: { a: 1 },
        policyVerdict: "allow",
        at: 2,
      });
      const events = await reopened.trace.listByExecution("e1");
      expect(events).toHaveLength(2);
      expect(events.every((event) => !("output" in event))).toBe(true);
    });
  });

  describe("replayJournal", () => {
    it("append + listByExecution returns rows in ordinal order", async () => {
      await store.replayJournal.append("exec_1", {
        ordinal: 0,
        op: "search",
        request: '{"query":"x"}',
        outcome: { ok: true, value: [{ path: "a" }] },
      });
      await store.replayJournal.append("exec_1", {
        ordinal: 1,
        op: "call",
        request: '{"path":"a","input":null}',
        outcome: { ok: true, value: { done: true } },
      });
      const rows = await store.replayJournal.listByExecution("exec_1");
      expect(rows.map((r) => [r.ordinal, r.op])).toEqual([
        [0, "search"],
        [1, "call"],
      ]);
      expect(rows[1]?.outcome).toEqual({ ok: true, value: { done: true } });
    });

    it("append is idempotent on (executionId, ordinal)", async () => {
      const row = {
        ordinal: 0,
        op: "call" as const,
        request: "{}",
        outcome: { ok: true as const, value: 1 },
      };
      await store.replayJournal.append("exec_2", row);
      await store.replayJournal.append("exec_2", row); // second write must not duplicate or throw
      expect(await store.replayJournal.listByExecution("exec_2")).toHaveLength(1);
    });

    it("append REJECTS a conflicting ordinal that carries DIFFERENT content (corruption, not idempotent retry)", async () => {
      // (F5) `ON CONFLICT DO NOTHING` silently kept the stale row even when the
      // incoming row differed — diverging replay. A duplicate ordinal whose
      // request/outcome differs is corruption and must fail loudly; the
      // identical-content retry above must stay a no-op.
      await store.replayJournal.append("exec_conflict", {
        ordinal: 0,
        op: "call",
        request: '{"path":"a","input":null}',
        outcome: { ok: true, value: { done: true } },
      });
      await expect(
        store.replayJournal.append("exec_conflict", {
          ordinal: 0,
          op: "call",
          request: '{"path":"b","input":null}', // different request at the same ordinal
          outcome: { ok: true, value: { done: true } },
        }),
      ).rejects.toThrow(/append conflict/i);
      // The original row is untouched — the mismatch did not overwrite it.
      const rows = await store.replayJournal.listByExecution("exec_conflict");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.request).toBe('{"path":"a","input":null}');
    });
  });

  describe("secrets", () => {
    it("INVARIANT §9.2: secrets are encrypted at rest — plaintext never touches the database", async () => {
      await store.secrets.put("cred_github_main", "ghp_SuperSecretToken123");

      // Read the raw row, beneath the repository abstraction.
      const raw = await client.execute("SELECT ref, sealed FROM secrets");
      const dump = JSON.stringify(raw.rows);
      expect(dump).not.toContain("ghp_SuperSecretToken123");
      expect(dump).not.toContain("SuperSecret");

      expect(await store.secrets.reveal("cred_github_main")).toBe("ghp_SuperSecretToken123");
    });

    it("returns undefined for unknown refs and removes cleanly", async () => {
      expect(await store.secrets.reveal("nope")).toBeUndefined();
      await store.secrets.put("cred_x", "value");
      await store.secrets.remove("cred_x");
      expect(await store.secrets.reveal("cred_x")).toBeUndefined();
    });

    it("re-putting a ref replaces the sealed value", async () => {
      await store.secrets.put("cred_x", "old");
      await store.secrets.put("cred_x", "new");
      expect(await store.secrets.reveal("cred_x")).toBe("new");
    });
  });

  describe("stored-vocabulary validation", () => {
    // Second defense layer beneath the policy engine's fail-closed reads:
    // rows written by a divergent writer (or a pre-CHECK schema) must fail
    // loudly at deserialization, never load as silently-reshaped Policy/Tool
    // values. Tables are pre-created WITHOUT constraints so CREATE TABLE IF
    // NOT EXISTS leaves them — the legacy-database reality.
    let legacy: ReturnType<typeof createClient>;
    let legacyStore: ConduitStore;

    beforeEach(async () => {
      legacy = createClient({ url: ":memory:" });
      await legacy.batch(
        [
          `CREATE TABLE tools (
            name TEXT PRIMARY KEY,
            namespace TEXT NOT NULL,
            description TEXT,
            input_schema TEXT NOT NULL,
            output_schema TEXT NOT NULL,
            risk_class TEXT NOT NULL,
            source_semantics TEXT NOT NULL
          )`,
          `CREATE TABLE policies (
            tool_name TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            seeded_from TEXT NOT NULL,
            manual_override INTEGER NOT NULL
          )`,
          `CREATE TABLE sources (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            namespace TEXT NOT NULL UNIQUE,
            location TEXT NOT NULL,
            base_url TEXT
          )`,
          `CREATE TABLE executions (
            id TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            status TEXT NOT NULL,
            seeds TEXT NOT NULL,
            paused_on TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER
          )`,
          `CREATE TABLE trace_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            call_id TEXT NOT NULL UNIQUE,
            execution_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            connection_prefix TEXT NOT NULL,
            input TEXT NOT NULL,
            output_summary TEXT,
            upstream_status INTEGER,
            latency_ms INTEGER,
            policy_verdict TEXT NOT NULL,
            at INTEGER NOT NULL
          )`,
        ],
        "write",
      );
      legacyStore = await openSqliteStore({
        client: legacy,
        secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
      });
    });

    async function insertPolicyRow(
      action: string,
      seededFrom: string,
      manualOverride: number,
      toolName = "github.issues.create",
    ) {
      await legacy.execute({
        sql: `INSERT INTO policies (tool_name, action, seeded_from, manual_override)
              VALUES (?, ?, ?, ?)`,
        args: [toolName, action, seededFrom, manualOverride],
      });
    }

    it("rejects a policy row with an unrecognized action", async () => {
      await insertPolicyRow("permit", "review", 1);
      await expect(legacyStore.policies.get("github.issues.create")).rejects.toThrow(
        'unrecognized action "permit"',
      );
    });

    it("rejects a policy row with an unrecognized seeded_from", async () => {
      await insertPolicyRow("block", "moderate", 1);
      await expect(legacyStore.policies.get("github.issues.create")).rejects.toThrow(
        'unrecognized seeded_from "moderate"',
      );
    });

    it("never demotes a policy row with manual_override outside 0/1 to inert", async () => {
      // manualOverride: false would hand the verdict back to the derived
      // default — an operator's manual block silently fails open.
      await insertPolicyRow("block", "safe", 2);
      await expect(legacyStore.policies.get("github.issues.create")).rejects.toThrow(
        "manual_override must be 0 or 1",
      );
      await expect(legacyStore.policies.list()).rejects.toThrow("manual_override must be 0 or 1");
    });

    it("still reads valid policy rows from a legacy schema", async () => {
      await insertPolicyRow("block", "review", 1);
      const policy = await legacyStore.policies.get("github.issues.create");
      expect(policy).toEqual({
        toolName: "github.issues.create",
        action: "block",
        seededFrom: "review",
        manualOverride: true,
        redactFields: [],
      });
      // manual_override 0 is the other legal boundary value: it must read
      // back as false, never be rejected by the 0/1 guard.
      await insertPolicyRow("allow", "safe", 0, "github.issues.list");
      expect(await legacyStore.policies.get("github.issues.list")).toEqual({
        toolName: "github.issues.list",
        action: "allow",
        seededFrom: "safe",
        manualOverride: false,
        redactFields: [],
      });
    });

    it("escapes untrusted identifiers in read-error context (no log injection)", async () => {
      // tool_name comes from the same untrusted row as the bad value: a
      // control character must reach logs escaped, not raw.
      await insertPolicyRow("permit", "review", 1, "bad\u0007name");
      await expect(legacyStore.policies.get("bad\u0007name")).rejects.toThrow(
        'toolName: "bad\\u0007name"',
      );
    });

    it("accepts every vocabulary member end to end (exhaustiveness pin)", async () => {
      // POLICY_ACTIONS/RISK_CLASSES are compile-checked against out-of-union
      // members but not against MISSING ones — deleting "require_approval"
      // from the array would still compile and make every such row
      // unreadable (and, via rows.map, fail list() wholesale). The
      // vocabulary() lists are compiler-pinned to the unions; round-tripping
      // them keeps the production constants and CHECK constraints in
      // agreement with the unions.
      const actions = vocabulary<PolicyAction>({
        allow: true,
        require_approval: true,
        block: true,
      });
      const riskClasses = vocabulary<RiskClass>({ safe: true, review: true, destructive: true });
      for (const [i, action] of actions.entries()) {
        for (const [j, seededFrom] of riskClasses.entries()) {
          const toolName = `vocab.a${i}s${j}`;
          await store.policies.upsert({
            toolName,
            action,
            seededFrom,
            manualOverride: true,
            redactFields: [],
          });
          expect(await store.policies.get(toolName)).toEqual({
            toolName,
            action,
            seededFrom,
            manualOverride: true,
            redactFields: [],
          });
        }
      }
      for (const [i, riskClass] of riskClasses.entries()) {
        const namespace = `vocab${i}`;
        const name = `${namespace}.tool`;
        await store.tools.replaceNamespace(namespace, [tool({ name, namespace, riskClass })]);
        expect((await store.tools.get(name))?.riskClass).toBe(riskClass);
      }
    });

    it("rejects a source row with an unrecognized type", async () => {
      await legacy.execute({
        sql: "INSERT INTO sources (id, type, namespace, location) VALUES (?, ?, ?, ?)",
        args: ["src_1", "grpc", "petstore", "https://example.com/openapi.json"],
      });
      await expect(legacyStore.sources.get("src_1")).rejects.toThrow('unrecognized type "grpc"');
      await expect(legacyStore.sources.list()).rejects.toThrow('unrecognized type "grpc"');
    });

    it("rejects an execution row with an unrecognized status", async () => {
      // "pased" is one corrupt byte from "paused": deserialized as-is it
      // reaches §5.5 pause/resume handling as an impossible status that
      // default-less switches silently ignore.
      await legacy.execute({
        sql: `INSERT INTO executions (id, code, status, seeds, started_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: ["exec_1", "return 1", "pased", '{"now":1,"random":0.5}', 1000],
      });
      await expect(legacyStore.executions.get("exec_1")).rejects.toThrow(
        'unrecognized status "pased"',
      );
    });

    it("rejects a trace event row with an unrecognized policy_verdict", async () => {
      // The audit-trail surface: a corrupt verdict must never flow into
      // Trace views looking like a legitimate policy decision.
      await legacy.execute({
        sql: `INSERT INTO trace_events
                (call_id, execution_id, tool_name, connection_prefix, input, policy_verdict, at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: ["call_1", "exec_1", "x.search", "x.acme.prod", "null", "permit", 1000],
      });
      await expect(legacyStore.trace.listByExecution("exec_1")).rejects.toThrow(
        'unrecognized policy_verdict "permit"',
      );
    });

    it("opens a legacy database that never had an output column without error", async () => {
      // The legacy fixture's trace_events predates the (now-removed) output
      // column entirely; the purge-if-present migration is a no-op here.
      await legacy.execute({
        sql: `INSERT INTO trace_events
                (call_id, execution_id, tool_name, connection_prefix, input, policy_verdict, at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: ["call_legacy", "exec_legacy", "x.search", "x.acme.prod", "null", "allow", 1000],
      });
      const [event] = await legacyStore.trace.listByExecution("exec_legacy");
      expect(event?.callId).toBe("call_legacy");
      expect(event && "output" in event).toBe(false);
    });

    it("accepts every source type, execution status, and trace verdict (exhaustiveness pin)", async () => {
      // Same rationale as the policy/tool pin above: the vocabulary()
      // lists are compiler-pinned to the unions; round-tripping them keeps
      // the production constants and CHECK constraints in agreement.
      const sourceTypes = vocabulary<SourceType>({
        openapi: true,
        graphql: true,
        mcp: true,
        custom_js: true,
      });
      for (const [i, type] of sourceTypes.entries()) {
        const id = `src_vocab_${i}`;
        await store.sources.upsert({ id, type, namespace: `vocab${i}`, location: "https://x" });
        expect((await store.sources.get(id))?.type).toBe(type);
      }
      const statuses = vocabulary<ExecutionStatus>({
        running: true,
        paused: true,
        completed: true,
        failed: true,
        expired: true,
      });
      for (const [i, status] of statuses.entries()) {
        const id = `exec_vocab_${i}`;
        await store.executions.put({
          id,
          code: "return 1",
          status,
          seeds: { now: 1, random: 0.5 },
          startedAt: 1000,
        });
        expect((await store.executions.get(id))?.status).toBe(status);
      }
      const verdicts = vocabulary<PolicyAction>({
        allow: true,
        require_approval: true,
        block: true,
      });
      for (const [i, policyVerdict] of verdicts.entries()) {
        await store.trace.append({
          callId: `call_vocab_${i}`,
          executionId: "exec_vocab_0",
          toolName: "x.search",
          connectionPrefix: "x.acme.prod",
          input: null,
          policyVerdict,
          at: 1000 + i,
        });
      }
      const events = await store.trace.listByExecution("exec_vocab_0");
      expect(events.map((event) => event.policyVerdict)).toEqual(verdicts);
    });

    it("rejects a tool row with an unrecognized risk_class", async () => {
      await legacy.execute({
        sql: `INSERT INTO tools (name, namespace, input_schema, output_schema, risk_class, source_semantics)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: ["x.search", "x", "{}", "{}", "extreme", '{"kind":"mcp"}'],
      });
      await expect(legacyStore.tools.get("x.search")).rejects.toThrow(
        'unrecognized risk_class "extreme"',
      );
      await expect(legacyStore.tools.list()).rejects.toThrow('unrecognized risk_class "extreme"');
    });

    describe("source_semantics validation", () => {
      // A JSON blob has no CHECK-constraint twin: even on a fresh schema
      // the column is opaque TEXT, so this read-side guard is the ONLY
      // enforcement layer. The blob smuggles three vocabularies past the
      // column guards above — kind, graphql operation, and declaredRisk —
      // and feeds deriveRiskClass, whose switch has no arm for an
      // impossible kind.
      async function insertToolRow(sourceSemantics: string, name = "x.search") {
        await legacy.execute({
          sql: `INSERT INTO tools (name, namespace, input_schema, output_schema, risk_class, source_semantics)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [name, "x", "{}", "{}", "safe", sourceSemantics],
        });
      }

      it("rejects semantics with an unrecognized kind", async () => {
        await insertToolRow('{"kind":"soap","method":"GET","path":"/x"}');
        await expect(legacyStore.tools.get("x.search")).rejects.toThrow(
          'unrecognized source_semantics kind "soap"',
        );
        await expect(legacyStore.tools.list()).rejects.toThrow(
          'unrecognized source_semantics kind "soap"',
        );
      });

      it("rejects graphql semantics with an unrecognized operation", async () => {
        // "subscription" is one plausible upstream addition away; loaded
        // as-is it reaches deriveRiskClass's binary query/mutation branch.
        await insertToolRow('{"kind":"graphql","operation":"subscription"}');
        await expect(legacyStore.tools.get("x.search")).rejects.toThrow(
          'unrecognized source_semantics operation "subscription"',
        );
      });

      it("rejects custom_js semantics with an unrecognized declaredRisk", async () => {
        // declaredRisk is a RiskClass inside the blob — the same vocabulary
        // the risk_class column guard checks, one level deeper.
        await insertToolRow('{"kind":"custom_js","declaredRisk":"extreme"}');
        await expect(legacyStore.tools.get("x.search")).rejects.toThrow(
          'unrecognized source_semantics declaredRisk "extreme"',
        );
      });

      it("rejects openapi semantics missing method or path", async () => {
        await insertToolRow('{"kind":"openapi","path":"/x"}');
        await expect(legacyStore.tools.get("x.search")).rejects.toThrow(
          "malformed openapi source_semantics",
        );
      });

      it("rejects mcp semantics with non-boolean hints", async () => {
        await insertToolRow('{"kind":"mcp","readOnlyHint":"yes"}');
        await expect(legacyStore.tools.get("x.search")).rejects.toThrow(
          "malformed mcp source_semantics",
        );
        // destructiveHint is guarded independently of readOnlyHint: a
        // truthy string here would over-classify via deriveRiskClass, but
        // any other consumer of Tool.sourceSemantics gets a type lie.
        await insertToolRow('{"kind":"mcp","destructiveHint":"yes"}', "x.search2");
        await expect(legacyStore.tools.get("x.search2")).rejects.toThrow(
          "malformed mcp source_semantics",
        );
      });

      it("drops unknown keys instead of carrying them into the typed object", async () => {
        // The validator rebuilds field-by-field; a passthrough regression
        // would let attacker-controlled extra keys ride into Tool.
        await insertToolRow('{"kind":"mcp","extra":1}');
        expect((await legacyStore.tools.get("x.search"))?.sourceSemantics).toStrictEqual({
          kind: "mcp",
        });
      });

      it("escapes untrusted identifiers in semantics read errors (no log injection)", async () => {
        // Same pin as the policies path: the tool name travels from the
        // same untrusted row as the bad blob and must reach logs escaped.
        await insertToolRow('{"kind":"soap"}', "bad\u0007name");
        await expect(legacyStore.tools.get("bad\u0007name")).rejects.toThrow(
          'name: "bad\\u0007name"',
        );
      });

      it("rejects semantics that parse to a non-object", async () => {
        await insertToolRow('"mcp"');
        await expect(legacyStore.tools.get("x.search")).rejects.toThrow(
          "source_semantics is not an object",
        );
      });

      it("rejects unparseable semantics with store context, not a bare SyntaxError", async () => {
        await insertToolRow("{kind:");
        await expect(legacyStore.tools.get("x.search")).rejects.toThrow(
          "[SqliteStore] Failed to read tool: source_semantics is not valid JSON",
        );
      });

      it("still reads valid semantics from a legacy schema", async () => {
        await insertToolRow('{"kind":"graphql","operation":"mutation"}');
        expect((await legacyStore.tools.get("x.search"))?.sourceSemantics).toEqual({
          kind: "graphql",
          operation: "mutation",
        });
      });

      it("accepts every semantics variant end to end (exhaustiveness pin)", async () => {
        // Same rationale as the vocabulary pins above, one level into the
        // blob: kinds are compiler-pinned, and each variant round-trips
        // with its boundary values. toStrictEqual pins that absent
        // optional hints stay absent (exactOptionalPropertyTypes).
        const kinds = vocabulary<SourceSemantics["kind"]>({
          openapi: true,
          graphql: true,
          mcp: true,
          custom_js: true,
        });
        const variants: SourceSemantics[] = [
          { kind: "openapi", method: "GET", path: "/x" },
          { kind: "graphql", operation: "query" },
          { kind: "graphql", operation: "mutation" },
          { kind: "mcp" },
          { kind: "mcp", readOnlyHint: true },
          { kind: "mcp", readOnlyHint: false, destructiveHint: true },
          { kind: "custom_js", declaredRisk: "safe" },
          { kind: "custom_js", declaredRisk: "review" },
          { kind: "custom_js", declaredRisk: "destructive" },
        ];
        for (const kind of kinds) {
          expect(variants.some((variant) => variant.kind === kind)).toBe(true);
        }
        for (const [i, sourceSemantics] of variants.entries()) {
          const namespace = `sem${i}`;
          const name = `${namespace}.tool`;
          await store.tools.replaceNamespace(namespace, [
            tool({ name, namespace, sourceSemantics }),
          ]);
          expect((await store.tools.get(name))?.sourceSemantics).toStrictEqual(sourceSemantics);
        }
      });
    });

    describe("JSON column integrity (a bare SyntaxError never escapes)", () => {
      // Corrupt JSON anywhere in a row must fail with the same
      // [SqliteStore] error format as the vocabulary guards — a bare
      // SyntaxError carries neither the entity nor the row identity.
      it("wraps invalid JSON in tool schema columns", async () => {
        await legacy.execute({
          sql: `INSERT INTO tools (name, namespace, input_schema, output_schema, risk_class, source_semantics)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: ["x.search", "x", "{oops", "{}", "safe", '{"kind":"mcp"}'],
        });
        // The wrap must keep the original SyntaxError as `cause`: the
        // parse position is what locates corruption inside a large blob.
        const error: unknown = await legacyStore.tools.get("x.search").then(
          () => undefined,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "[SqliteStore] Failed to read tool: input_schema is not valid JSON",
        );
        expect((error as Error).cause).toBeInstanceOf(SyntaxError);
        // output_schema is a separate parse one line below — it can
        // regress independently of input_schema.
        await legacy.execute({
          sql: `INSERT INTO tools (name, namespace, input_schema, output_schema, risk_class, source_semantics)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: ["x.search2", "x", "{}", "{oops", "safe", '{"kind":"mcp"}'],
        });
        await expect(legacyStore.tools.get("x.search2")).rejects.toThrow(
          "[SqliteStore] Failed to read tool: output_schema is not valid JSON",
        );
      });

      it("wraps invalid JSON in execution seeds", async () => {
        await legacy.execute({
          sql: `INSERT INTO executions (id, code, status, seeds, started_at)
                VALUES (?, ?, ?, ?, ?)`,
          args: ["exec_1", "return 1", "running", "{oops", 1000],
        });
        await expect(legacyStore.executions.get("exec_1")).rejects.toThrow(
          "[SqliteStore] Failed to read execution: seeds is not valid JSON",
        );
      });

      it("wraps invalid JSON in execution paused_on", async () => {
        await legacy.execute({
          sql: `INSERT INTO executions (id, code, status, seeds, paused_on, started_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: ["exec_1", "return 1", "paused", '{"now":1,"random":0.5}', "{oops", 1000],
        });
        await expect(legacyStore.executions.get("exec_1")).rejects.toThrow(
          "[SqliteStore] Failed to read execution: paused_on is not valid JSON",
        );
      });

      it("wraps invalid JSON in trace event input", async () => {
        await legacy.execute({
          sql: `INSERT INTO trace_events
                  (call_id, execution_id, tool_name, connection_prefix, input, policy_verdict, at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: ["call_1", "exec_1", "x.search", "x.acme.prod", "{oops", "allow", 1000],
        });
        await expect(legacyStore.trace.listByExecution("exec_1")).rejects.toThrow(
          "[SqliteStore] Failed to read trace event: input is not valid JSON",
        );
      });

      it("wraps invalid JSON in trace event output_summary", async () => {
        // A separate code path from input: it only runs when the nullable
        // column is present, so it can regress while the input test stays
        // green.
        await legacy.execute({
          sql: `INSERT INTO trace_events
                  (call_id, execution_id, tool_name, connection_prefix, input,
                   output_summary, policy_verdict, at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: ["call_1", "exec_1", "x.search", "x.acme.prod", "null", "{oops", "allow", 1000],
        });
        await expect(legacyStore.trace.listByExecution("exec_1")).rejects.toThrow(
          "[SqliteStore] Failed to read trace event: output_summary is not valid JSON",
        );
      });
    });

    describe("CHECK constraints (fresh databases)", () => {
      // Write-side twin of the read-side guards: a fresh schema refuses the
      // bad row at INSERT time, beneath even the repository layer.
      it("rejects writing an out-of-vocabulary policy action", async () => {
        await expect(
          client.execute({
            sql: `INSERT INTO policies (tool_name, action, seeded_from, manual_override)
                  VALUES (?, ?, ?, ?)`,
            args: ["t", "permit", "safe", 0],
          }),
        ).rejects.toThrow(/check/i);
      });

      it("rejects writing an out-of-vocabulary seeded_from", async () => {
        await expect(
          client.execute({
            sql: `INSERT INTO policies (tool_name, action, seeded_from, manual_override)
                  VALUES (?, ?, ?, ?)`,
            args: ["t", "block", "moderate", 0],
          }),
        ).rejects.toThrow(/check/i);
      });

      it("rejects writing manual_override outside 0/1", async () => {
        await expect(
          client.execute({
            sql: `INSERT INTO policies (tool_name, action, seeded_from, manual_override)
                  VALUES (?, ?, ?, ?)`,
            args: ["t", "block", "safe", 2],
          }),
        ).rejects.toThrow(/check/i);
      });

      it("rejects writing an out-of-vocabulary risk_class", async () => {
        await expect(
          client.execute({
            sql: `INSERT INTO tools (name, namespace, input_schema, output_schema, risk_class, source_semantics)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: ["t", "x", "{}", "{}", "extreme", '{"kind":"mcp"}'],
          }),
        ).rejects.toThrow(/check/i);
      });

      it("rejects writing an out-of-vocabulary source type", async () => {
        await expect(
          client.execute({
            sql: "INSERT INTO sources (id, type, namespace, location) VALUES (?, ?, ?, ?)",
            args: ["s", "grpc", "n", "https://x"],
          }),
        ).rejects.toThrow(/check/i);
      });

      it("rejects writing an out-of-vocabulary execution status", async () => {
        await expect(
          client.execute({
            sql: `INSERT INTO executions (id, code, status, seeds, started_at)
                  VALUES (?, ?, ?, ?, ?)`,
            args: ["e", "return 1", "pased", "{}", 1000],
          }),
        ).rejects.toThrow(/check/i);
      });

      it("rejects writing an out-of-vocabulary trace policy_verdict", async () => {
        await expect(
          client.execute({
            sql: `INSERT INTO trace_events
                    (call_id, execution_id, tool_name, connection_prefix, input, policy_verdict, at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: ["c", "e", "x.search", "x.acme.prod", "null", "permit", 1000],
          }),
        ).rejects.toThrow(/check/i);
      });
    });
  });
});
