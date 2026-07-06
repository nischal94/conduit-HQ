import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretBox } from "../secrets.js";
import type { Tool } from "../types.js";
import { openSqliteStore } from "./sqlite.js";
import type { ConduitStore } from "./store.js";

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
      });

      // Source refresh: tool re-ingested (schema changed upstream).
      await store.tools.replaceNamespace("github", [
        tool({ name: "github.issues.create", namespace: "github", riskClass: "safe" }),
      ]);

      const policy = await store.policies.get("github.issues.create");
      expect(policy?.action).toBe("block");
      expect(policy?.manualOverride).toBe(true);
    });
  });

  describe("executions", () => {
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
    it("preserves append order per execution (the replay journal contract, §5.5)", async () => {
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
      });
      // manual_override 0 is the other legal boundary value: it must read
      // back as false, never be rejected by the 0/1 guard.
      await insertPolicyRow("allow", "safe", 0, "github.issues.list");
      expect(await legacyStore.policies.get("github.issues.list")).toEqual({
        toolName: "github.issues.list",
        action: "allow",
        seededFrom: "safe",
        manualOverride: false,
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
      // unreadable (and, via rows.map, fail list() wholesale). Round-trip
      // each member through the fresh store so the constants and the CHECK
      // constraints both stay exhaustive.
      const actions = ["allow", "require_approval", "block"] as const;
      const riskClasses = ["safe", "review", "destructive"] as const;
      for (const [i, action] of actions.entries()) {
        for (const [j, seededFrom] of riskClasses.entries()) {
          const toolName = `vocab.a${i}s${j}`;
          await store.policies.upsert({ toolName, action, seededFrom, manualOverride: true });
          expect(await store.policies.get(toolName)).toEqual({
            toolName,
            action,
            seededFrom,
            manualOverride: true,
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
    });
  });
});
