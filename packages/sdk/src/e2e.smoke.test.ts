import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryCatalog } from "./catalog.js";
import { createStoreCredentialResolver } from "./credentials.js";
import { buildExecuteTool, createCatalogToolHost, estimateTokens } from "./execute.js";
import { normalizeMcp } from "./normalize/mcp.js";
import { GUEST_ERROR_NAMES, NON_MEMOIZABLE_ERROR_NAMES } from "./pipeline/errors.js";
import { createToolInvoker } from "./pipeline/invoker.js";
import { createMcpUpstreamCaller } from "./pipeline/upstream.js";
import { createStorePolicyEngine } from "./policy.js";
import { QuickJSSandbox } from "./sandbox/quickjs.js";
import { SecretBox } from "./secrets.js";
import { openSqliteStore } from "./store/sqlite.js";
import type { ConduitStore } from "./store/store.js";

/**
 * END-TO-END SMOKE (verification pass, 2026-07-07 — not a unit suite).
 *
 * Composes every shipped module across its real seam, the way the product
 * will: normalize an MCP source → persist to SQLite on disk → reopen the
 * store (fresh process simulation) → rehydrate the catalog → policy engine
 * + credential resolver + QuickJS sandbox wired through the REAL §5.3
 * pipeline (createToolInvoker + createMcpUpstreamCaller) against a local
 * node:http MCP server. Nothing in the call path is a stand-in anymore;
 * PR #19's acceptance criterion — replace the inline stub, keep every
 * assertion green — is discharged here.
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

const ISSUES_RESULT = { issues: [{ id: 1, title: "Fix login bug" }] };

interface UpstreamCall {
  name: string;
  arguments: unknown;
  sawAuthHeader: boolean;
}

/**
 * A live MCP server on loopback. `/mcp` answers tools/call with the issues
 * fixture and records what it saw; `/echo401` plays a hostile upstream that
 * rejects auth AND echoes the Authorization header back in its body
 * (blindspot card 09 — the echoed secret must go nowhere).
 */
function startMcpServer(): Promise<{
  server: Server;
  port: number;
  upstreamCalls: UpstreamCall[];
}> {
  const upstreamCalls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (req.url === "/echo401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad token", echoed: req.headers.authorization }));
        return;
      }
      const payload = JSON.parse(body) as {
        id: string;
        params: { name: string; arguments: unknown };
      };
      upstreamCalls.push({
        name: payload.params.name,
        arguments: payload.params.arguments,
        sawAuthHeader: req.headers.authorization === SECRET,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: ISSUES_RESULT }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, upstreamCalls });
    });
  });
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
  let mcpServer: Server | undefined;
  afterAll(async () => {
    for (const c of clients) {
      c.close();
    }
    await new Promise<void>((resolve) => {
      if (mcpServer === undefined) {
        resolve();
        return;
      }
      mcpServer.close(() => resolve());
    });
  });

  it("runs the whole prototype flow with no secret leakage", async () => {
    const { server, port, upstreamCalls } = await startMcpServer();
    mcpServer = server;
    const mcpLocation = `http://127.0.0.1:${port}/mcp`;

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
      location: mcpLocation,
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

    // ── Phase 4: the REAL §5.3 pipeline mounted at the ToolInvoker seam ──
    const policyEngine = createStorePolicyEngine(store.policies);
    const resolver = createStoreCredentialResolver(store.secrets);
    const hostLog: string[] = [];

    const invoke = createToolInvoker(
      {
        store,
        policy: policyEngine,
        credentials: resolver,
        // The test upstream lives on loopback, so the trusted-code opt-in
        // applies here; Phase 9 proves the default blocks it.
        upstream: createMcpUpstreamCaller({ egress: { allowPrivate: true } }),
      },
      { executionId: "exec_smoke", log: (message) => hostLog.push(message) },
    );

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
        result: ISSUES_RESULT,
      });
    }
    // The wire request the upstream actually saw: prefix-stripped name
    // (decision A5), original arguments, authenticated.
    expect(upstreamCalls).toEqual([
      { name: "list_issues", arguments: { owner: "acme", repo: "site" }, sawAuthHeader: true },
    ]);

    // ── Phase 6: policy stops a destructive call inside the sandbox ─────
    const blocked = await sandbox.execute({
      code: `
        try {
          await tools.github.delete_repo({ repo: "site" });
          return "UNREACHABLE";
        } catch (error) {
          return { name: error.name, message: String(error.message ?? error) };
        }
      `,
      tools: host,
    });
    expect(blocked.status).toBe("completed");
    if (blocked.status === "completed") {
      const value = blocked.value as { name: string; message: string };
      expect(value.name).toBe(GUEST_ERROR_NAMES.policyDenied);
      expect(value.message).toContain("requires approval");
    }
    expect(upstreamCalls).toHaveLength(1); // upstream never touched

    // The journal entry pins the §5.5 contract end-to-end: the denial is
    // recorded under its non-memoizable name, so the execution manager can
    // strip it before replay (an approved call must re-execute live).
    expect(blocked.journal).toHaveLength(1);
    const deniedEntry = blocked.journal[0];
    expect(deniedEntry?.op).toBe("call");
    expect(deniedEntry?.outcome.ok).toBe(false);
    if (deniedEntry && deniedEntry.outcome.ok === false) {
      expect(deniedEntry.outcome.error.name).toBe(GUEST_ERROR_NAMES.policyDenied);
      expect(NON_MEMOIZABLE_ERROR_NAMES).toContain(deniedEntry.outcome.error.name);
    }

    // Unknown tool fails closed with the catalog-miss vocabulary.
    const unknown = await sandbox.execute({
      code: `
        try {
          await tools.github.no_such_tool({});
          return "UNREACHABLE";
        } catch (error) {
          return { name: error.name, message: String(error.message ?? error) };
        }
      `,
      tools: host,
    });
    expect(unknown.status).toBe("completed");
    if (unknown.status === "completed") {
      const value = unknown.value as { name: string; message: string };
      expect(value.name).toBe(GUEST_ERROR_NAMES.policyBlocked);
      expect(value.message).toContain("blocked");
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
          return { name: error.name, message: String(error.message ?? error) };
        }
      `,
      tools: host,
    });
    expect(overridden.status).toBe("completed");
    if (overridden.status === "completed") {
      const value = overridden.value as { name: string; message: string };
      expect(value.name).toBe(GUEST_ERROR_NAMES.policyBlocked);
      expect(value.message).toContain("operator blocked");
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

    // Trace persisted in call order — the §5.3 pipeline audits refusals
    // too (decision A3), so the journal-of-record now carries them all.
    const persistedTrace = await store.trace.listByExecution("exec_smoke");
    expect(persistedTrace.map((e) => [e.toolName, e.policyVerdict])).toEqual([
      ["github.list_issues", "allow"],
      ["github.delete_repo", "require_approval"],
      ["github.no_such_tool", "block"],
      ["github.list_issues", "block"],
    ]);
    expect(persistedTrace[0]?.connectionPrefix).toBe(PREFIX);
    expect(persistedTrace[0]?.output).toEqual(ISSUES_RESULT); // §5.5 replay payload
    expect(persistedTrace[0]?.upstreamStatus).toBe(200);
    expect(JSON.stringify(persistedTrace)).not.toContain("ghp_smoke");

    // ── Phase 9: §9.3 default — the same pipeline WITHOUT the opt-in flag
    // refuses the loopback upstream before a single byte leaves the host ──
    await store.policies.upsert({
      toolName: "github.list_issues",
      action: "allow",
      seededFrom: "safe",
      manualOverride: true, // operator re-allows; change is live immediately
    });
    const guardedInvoke = createToolInvoker(
      {
        store,
        policy: policyEngine,
        credentials: resolver,
        upstream: createMcpUpstreamCaller(), // §9.3 defaults: no allowPrivate
      },
      { executionId: "exec_egress", log: (message) => hostLog.push(message) },
    );
    const guardedHost = createCatalogToolHost(catalog, guardedInvoke);
    const egressBlocked = await sandbox.execute({
      code: `
        try {
          await tools.github.list_issues({ owner: "acme", repo: "site" });
          return "UNREACHABLE";
        } catch (error) {
          return { name: error.name, message: String(error.message ?? error) };
        }
      `,
      tools: guardedHost,
    });
    expect(egressBlocked.status).toBe("completed");
    if (egressBlocked.status === "completed") {
      const value = egressBlocked.value as { name: string; message: string };
      expect(value.name).toBe(GUEST_ERROR_NAMES.upstream);
      expect(value.message).toContain("loopback/private egress is off by default");
    }
    expect(upstreamCalls).toHaveLength(1); // still only the Phase-5 call

    // ── Phase 10: hostile upstream echoes the secret back (card 09) —
    // the echo goes nowhere: not the error, not the journal, not Trace ──
    await store.sources.upsert({
      id: "src_gh",
      type: "mcp",
      namespace: "github",
      location: `http://127.0.0.1:${port}/echo401`,
    });
    const rejected = await sandbox.execute({
      code: `
        try {
          await tools.github.list_issues({ owner: "acme", repo: "site" });
          return "UNREACHABLE";
        } catch (error) {
          return { name: error.name, message: String(error.message ?? error) };
        }
      `,
      tools: host, // the exec_smoke invoker: allowPrivate, live source lookup
    });
    expect(rejected.status).toBe("completed");
    if (rejected.status === "completed") {
      const value = rejected.value as { name: string; message: string };
      expect(value.name).toBe(GUEST_ERROR_NAMES.upstream);
      expect(value.message).toContain("401");
    }
    expect(JSON.stringify(rejected)).not.toContain(SECRET); // result + journal
    const traceAfter401 = await store.trace.listByExecution("exec_smoke");
    expect(traceAfter401).toHaveLength(5); // A3: allowed + upstream-failure traces
    const failureRow = traceAfter401[4];
    expect(failureRow?.policyVerdict).toBe("allow");
    expect(failureRow && "output" in failureRow).toBe(false);
    expect(JSON.stringify(traceAfter401)).not.toContain(SECRET);
    expect(JSON.stringify(traceAfter401)).not.toContain("ghp_smoke");
    // The host-side log never saw it either: the secret lived only in the
    // fetch argument scope (spec §9.2).
    expect(hostLog.join("\n")).not.toContain(SECRET);
  });
});
