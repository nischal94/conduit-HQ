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
});
