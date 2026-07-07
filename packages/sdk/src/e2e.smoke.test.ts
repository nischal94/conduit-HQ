import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryCatalog } from "./catalog.js";
import { createStoreCredentialResolver } from "./credentials.js";
import type { ToolInvoker } from "./execute.js";
import { buildExecuteTool, createCatalogToolHost, estimateTokens } from "./execute.js";
import { normalizeMcp } from "./normalize/mcp.js";
import { createStorePolicyEngine } from "./policy.js";
import { QuickJSSandbox } from "./sandbox/quickjs.js";
import { SecretBox } from "./secrets.js";
import { openSqliteStore } from "./store/sqlite.js";
import type { ConduitStore } from "./store/store.js";
import type { TraceEvent } from "./types.js";

/**
 * END-TO-END SMOKE (verification pass, 2026-07-07 — not a unit suite).
 *
 * Composes every shipped module across its real seam, the way the product
 * will: normalize an MCP source → persist to SQLite on disk → reopen the
 * store (fresh process simulation) → rehydrate the catalog → policy engine
 * + credential resolver + QuickJS sandbox wired through a ToolInvoker.
 *
 * The ONLY stand-in is the invoker itself: §5.3 is unbuilt, so a minimal
 * inline pipeline (policy → credentials → stubbed upstream → trace) mounts
 * at the seam the real one will occupy. Everything else is shipped code.
 */

const SECRET = "Bearer ghp_smoke_secret_do_not_leak_9f2c";
const PREFIX = "github.acme.prod";

const scratch = mkdtempSync(join(tmpdir(), "conduit-smoke-"));
const dbUrl = `file:${join(scratch, "smoke.db")}`;
const keyBytes = SecretBox.generateKeyBytes();

// Fixture: what a real MCP server's tools/list would return.
const mcpToolsList = [
  {
    name: "list_issues",
    description: "List open issues in a repository",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_issue",
    description: "Create a new issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "delete_repo",
    description: "Permanently delete a repository",
    inputSchema: { type: "object", properties: { repo: { type: "string" } } },
    annotations: { destructiveHint: true },
  },
];

interface UpstreamCall {
  path: string;
  input: unknown;
  sawAuthHeader: boolean;
}

async function openStore(): Promise<{
  store: ConduitStore;
  client: ReturnType<typeof createClient>;
}> {
  const client = createClient({ url: dbUrl });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(keyBytes),
  });
  return { store, client };
}

describe("e2e smoke: ingest → persist → reopen → policy → sandbox → invoke", () => {
  const clients: ReturnType<typeof createClient>[] = [];
  afterAll(() => {
    for (const c of clients) {
      c.close();
    }
  });

  it("runs the whole prototype flow with no secret leakage", async () => {
    // ── Phase 1: ingest and persist (first "process") ──────────────────
    const first = await openStore();
    clients.push(first.client);

    const tools = normalizeMcp({ namespace: "github", tools: mcpToolsList });
    expect(tools.map((t) => [t.name, t.riskClass])).toEqual([
      ["github.list_issues", "safe"],
      ["github.create_issue", "review"],
      ["github.delete_repo", "destructive"],
    ]);

    await first.store.sources.upsert({
      id: "src_gh",
      type: "mcp",
      namespace: "github",
      location: "https://mcp.example.com/github",
    });
    await first.store.integrations.upsert({
      id: "int_gh",
      sourceId: "src_gh",
      namespace: "github",
    });
    await first.store.connections.upsert({
      id: "conn_gh",
      integrationId: "int_gh",
      prefix: PREFIX,
      credentialRef: "cred_gh",
    });
    await first.store.secrets.put("cred_gh", SECRET);
    await first.store.tools.replaceNamespace("github", tools);

    // §9.2 at rest: dump every table raw; plaintext must appear nowhere.
    const tables = await first.client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    let rawDump = "";
    for (const row of tables.rows) {
      const dump = await first.client.execute(`SELECT * FROM ${String(row.name)}`);
      for (const r of dump.rows) {
        for (const value of Object.values(r)) {
          rawDump +=
            value instanceof ArrayBuffer ? Buffer.from(value).toString("latin1") : String(value);
        }
      }
    }
    expect(rawDump).not.toContain(SECRET);
    expect(rawDump).not.toContain("ghp_smoke");

    // ── Phase 2: reopen from disk (second "process") ────────────────────
    const { store, client } = await openStore();
    clients.push(client);

    const rehydrated = await store.tools.list("github");
    expect(rehydrated).toHaveLength(3);
    // The read-side guard (PR #18) rebuilt sourceSemantics field-by-field.
    const safeTool = rehydrated.find((t) => t.name === "github.list_issues");
    expect(safeTool?.sourceSemantics).toEqual({ kind: "mcp", readOnlyHint: true });

    const catalog = new InMemoryCatalog();
    catalog.upsert(rehydrated);

    // ── Phase 3: the execute surface ────────────────────────────────────
    const connections = await store.connections.list();
    const definition = buildExecuteTool({
      connections: connections.map((c) => ({ prefix: c.prefix, label: "Acme GitHub" })),
    });
    expect(estimateTokens(definition)).toBeLessThanOrEqual(1044);

    // ── Phase 4: minimal §5.3 stand-in mounted at the ToolInvoker seam ──
    const policyEngine = createStorePolicyEngine(store.policies);
    const resolver = createStoreCredentialResolver(store.secrets);
    const upstreamCalls: UpstreamCall[] = [];
    const traceRows: TraceEvent[] = [];

    const invoke: ToolInvoker = async (path, input) => {
      const tool = await store.tools.get(path);
      const verdict = await policyEngine.evaluate({
        target: tool ? { kind: "known", tool } : { kind: "unknown", toolName: path },
        input,
      });
      // Allow-list discipline (policy.ts): proceed ONLY on "allow".
      if (verdict.action !== "allow") {
        throw new Error(verdict.reason);
      }
      const connection = await store.connections.getByPrefix(PREFIX);
      if (connection === undefined) {
        throw new Error("smoke: connection missing");
      }
      const auth = await resolver.resolve(connection);
      upstreamCalls.push({
        path,
        input,
        sawAuthHeader: auth.headers.Authorization === SECRET,
      });
      const event: TraceEvent = {
        callId: `call_${upstreamCalls.length}`,
        executionId: "exec_smoke",
        toolName: path,
        connectionPrefix: PREFIX,
        input,
        policyVerdict: verdict.action,
        at: Date.now(),
      };
      await store.trace.append(event);
      traceRows.push(event);
      return { issues: [{ id: 1, title: "Fix login bug" }] };
    };

    const host = createCatalogToolHost(catalog, invoke);
    const sandbox = new QuickJSSandbox();

    // ── Phase 5: agent-style execution — the §6 documented workflow ─────
    const happy = await sandbox.execute({
      code: `
        const { items } = await tools.search({ query: "list issues" });
        const path = items[0].path;
        const details = await tools.describe.tool({ path, includeSchemas: true });
        const result = await tools.github.list_issues({ owner: "acme", repo: "site" });
        return { path, gotSchema: details.inputSchema !== undefined, result };
      `,
      tools: host,
    });
    expect(happy.status).toBe("completed");
    if (happy.status === "completed") {
      expect(happy.value).toEqual({
        path: "github.list_issues",
        gotSchema: true,
        result: { issues: [{ id: 1, title: "Fix login bug" }] },
      });
    }
    expect(upstreamCalls).toEqual([
      { path: "github.list_issues", input: { owner: "acme", repo: "site" }, sawAuthHeader: true },
    ]);

    // ── Phase 6: policy stops a destructive call inside the sandbox ─────
    const blocked = await sandbox.execute({
      code: `
        try {
          await tools.github.delete_repo({ repo: "site" });
          return "UNREACHABLE";
        } catch (error) {
          return String(error.message ?? error);
        }
      `,
      tools: host,
    });
    expect(blocked.status).toBe("completed");
    if (blocked.status === "completed") {
      expect(String(blocked.value)).toContain("requires approval");
    }
    expect(upstreamCalls).toHaveLength(1); // upstream never touched

    // Unknown tool fails closed with the catalog-miss vocabulary.
    const unknown = await sandbox.execute({
      code: `
        try {
          await tools.github.no_such_tool({});
          return "UNREACHABLE";
        } catch (error) {
          return String(error.message ?? error);
        }
      `,
      tools: host,
    });
    expect(unknown.status).toBe("completed");
    if (unknown.status === "completed") {
      expect(String(unknown.value)).toContain("blocked");
    }

    // ── Phase 7: operator override is live on the next call (no cache) ──
    await store.policies.upsert({
      toolName: "github.list_issues",
      action: "block",
      seededFrom: "safe",
      manualOverride: true,
    });
    const overridden = await sandbox.execute({
      code: `
        try {
          await tools.github.list_issues({ owner: "acme", repo: "site" });
          return "UNREACHABLE";
        } catch (error) {
          return String(error.message ?? error);
        }
      `,
      tools: host,
    });
    expect(overridden.status).toBe("completed");
    if (overridden.status === "completed") {
      expect(String(overridden.value)).toContain("operator blocked");
    }

    // ── Phase 8: §9.2 — nothing sandbox-visible ever carried the secret ─
    const everythingGuestVisible = JSON.stringify({
      definition,
      happy,
      blocked,
      unknown,
      overridden,
      searchHits: catalog.search({ query: "issues" }),
      described: catalog.describe("github.list_issues", { includeSchemas: true }),
    });
    expect(everythingGuestVisible).not.toContain(SECRET);
    expect(everythingGuestVisible).not.toContain("ghp_smoke");
    expect(everythingGuestVisible).not.toContain("cred_gh"); // even the ref stays host-side

    // Trace persisted in call order.
    const persistedTrace = await store.trace.listByExecution("exec_smoke");
    expect(persistedTrace).toHaveLength(1);
    expect(persistedTrace[0]?.toolName).toBe("github.list_issues");
    expect(persistedTrace[0]?.policyVerdict).toBe("allow");
    expect(JSON.stringify(persistedTrace)).not.toContain("ghp_smoke");
  });
});
