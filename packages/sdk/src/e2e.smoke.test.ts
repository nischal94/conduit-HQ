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
import { createInMemoryApprovalDecisions } from "./execution/decisions.js";
import { createExecutionManager, type ExecutionManagerDeps } from "./execution/manager.js";
import { normalizeMcp } from "./normalize/mcp.js";
import { GUEST_ERROR_NAMES } from "./pipeline/errors.js";
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
      if (req.url === "/echoInBody") {
        // A hostile-but-200 upstream: instead of rejecting auth (like
        // /echo401), it ACCEPTS the call and echoes the credential back
        // inside a successful JSON-RPC *result* body (Task 12 — the M4
        // falsification probe). Any 200 response still passes through the
        // §9.2 containsCredential tripwire (upstream.ts), so this exercises
        // the same defense-in-depth on the success path, one step earlier
        // than /echo401's error-body path.
        const payload = JSON.parse(body) as { id: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { leaked: SECRET },
          }),
        );
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

/**
 * §9.2 at-rest sweep: dump every table's every row/column into one string.
 * Generic over the schema — new tables/columns (e.g. Task 1's
 * `executions.result`/`error`) are picked up automatically via
 * `sqlite_master`, no helper changes needed when the schema grows.
 */
async function dumpAllTablesRaw(client: ReturnType<typeof createClient>): Promise<string> {
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
  let rawDump = "";
  for (const row of tables.rows) {
    const dump = await client.execute(`SELECT * FROM ${String(row.name)}`);
    for (const r of dump.rows) {
      for (const value of Object.values(r)) {
        rawDump +=
          value instanceof ArrayBuffer ? Buffer.from(value).toString("latin1") : String(value);
      }
    }
  }
  return rawDump;
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
    const rawDump = await dumpAllTablesRaw(first.client);
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

    // ── Phase 6: a require_approval call PAUSES the execution (design D2) ─
    //
    // BEHAVIOR CHANGE (§5.5 design D2 — the Phase-6 latent-bug fix, intended).
    // The pre-§5.5 smoke test drove the RAW sandbox here and asserted that a
    // require_approval call (delete_repo) was *caught by the guest, which
    // returned the error* — so the execution COMPLETED with the denial as its
    // value and the agent's `catch` decided what happened next. That put the
    // untrusted agent in charge of the approval flow (a design inversion for a
    // security product) and made require_approval indistinguishable from a hard
    // denial. Under the correct §5.5 model, when the SAME call is driven THROUGH
    // THE EXECUTION MANAGER (whose journaling ToolHost wrapper suspends on the
    // invoker's require_approval verdict), it PAUSES instead — a human, not the
    // agent, decides. This phase asserts the pause, then the full
    // pause → approve → resume: the approved call runs live EXACTLY once and the
    // execution completes.
    //
    // (The low-level catchable behavior still legitimately exists on the RAW
    // sandbox with a bare ToolHost — no pause wrapper, no ApprovalDecisions — as
    // Phase 9/10 exercise for `block`/upstream errors; that low-level path is not
    // the bug. The bug was surfacing an APPROVAL to the agent as a catchable
    // error at all. The manager is the only correct driver for require_approval.)
    const managerDeps: ExecutionManagerDeps = {
      store,
      sandbox,
      // Each invoker binds its own executionId (the manager mints one per
      // `start`), so Phase-6 Trace rows land under the manager's execution, NOT
      // `exec_smoke` — Phase 8 asserts both projections separately. On resume
      // the manager passes the staged `decisions` seam so the approved call
      // resolves live (design D6); absent it, the invoker behaves as today.
      makeInvoker: ({ executionId, decisions }) =>
        createToolInvoker(
          {
            store,
            policy: policyEngine,
            credentials: resolver,
            upstream: createMcpUpstreamCaller({ egress: { allowPrivate: true } }),
            ...(decisions !== undefined ? { decisions } : {}),
          },
          { executionId, log: (message) => hostLog.push(message) },
        ),
      makeToolHost: (invoke) => createCatalogToolHost(catalog, invoke),
      makeDecisions: () => createInMemoryApprovalDecisions(),
    };
    const manager = createExecutionManager(managerDeps);

    const paused = await manager.start(`
      const deleted = await tools.github.delete_repo({ repo: "site" });
      return { deleted };
    `);
    // The destructive call SUSPENDS the execution — it is NOT caught by the
    // guest, and it did NOT reach upstream.
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") {
      return;
    }
    const managerExecId = paused.executionId;
    expect(paused.pending.toolName).toBe("github.delete_repo");
    expect(paused.pending.input).toEqual({ repo: "site" });
    expect(paused.pending.reason).toContain("requires approval");
    expect(paused.pending.callId).toBeTruthy();
    expect(upstreamCalls).toHaveLength(1); // upstream still only saw the Phase-5 call

    // Persisted as paused; the replay journal holds ONLY the finalized prefix
    // (here: empty — the approval was the first call), never the require_approval.
    const pausedRow = await manager.get(managerExecId);
    expect(pausedRow?.status).toBe("paused");
    const pausedJournal = await store.replayJournal.listByExecution(managerExecId);
    expect(pausedJournal).toHaveLength(0);

    // Resume with approve → the approved call runs LIVE and completes.
    const resumed = await manager.resume(managerExecId, { kind: "approve" });
    expect(resumed.status).toBe("completed");
    if (resumed.status === "completed") {
      expect(resumed.value).toEqual({ deleted: ISSUES_RESULT });
    }
    // EXACTLY ONCE: the approved delete_repo reached the loopback upstream a
    // single time on resume (the Phase-5 list_issues + this one = 2 total).
    expect(upstreamCalls).toEqual([
      { name: "list_issues", arguments: { owner: "acme", repo: "site" }, sawAuthHeader: true },
      { name: "delete_repo", arguments: { repo: "site" }, sawAuthHeader: true },
    ]);
    const completedRow = await manager.get(managerExecId);
    expect(completedRow?.status).toBe("completed");

    // §9.2 leak sweep extended across the PAUSE and the RESUME: no secret in any
    // guest-visible value, the persisted replay journal, or the Trace display
    // projection of the resumed run.
    const resumedJournal = await store.replayJournal.listByExecution(managerExecId);
    // The approved call is now a finalized replay-journal `call` entry.
    expect(resumedJournal.map((r) => r.op)).toEqual(["call"]);
    const managerTrace = await store.trace.listByExecution(managerExecId);
    const acrossResume = JSON.stringify({
      paused,
      resumed,
      pendingApproval: paused.pending,
      replayJournal: resumedJournal,
      trace: managerTrace,
    });
    expect(acrossResume).not.toContain(SECRET);
    expect(acrossResume).not.toContain("ghp_smoke");
    expect(acrossResume).not.toContain("cred_gh");

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
      redactFields: [],
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
      // The manager-driven pause/resume replaces the old raw-sandbox `blocked`
      // value: both the pause payload and the resumed value are guest-visible.
      paused,
      resumed,
      unknown,
      overridden,
      searchHits: catalog.search({ query: "issues" }),
      described: catalog.describe("github.list_issues", { includeSchemas: true }),
    });
    expect(everythingGuestVisible).not.toContain(SECRET);
    expect(everythingGuestVisible).not.toContain("ghp_smoke");
    expect(everythingGuestVisible).not.toContain("cred_gh"); // even the ref stays host-side

    // Trace persisted in call order — the §5.3 pipeline audits refusals too
    // (decision A3). The delete_repo require_approval/allow rows now belong to
    // the MANAGER's execution (Phase 6 drives it through createExecutionManager,
    // which mints its own executionId), so `exec_smoke`'s trace no longer holds
    // them — this is the D2 behavior change visible in the audit projection.
    const persistedTrace = await store.trace.listByExecution("exec_smoke");
    expect(persistedTrace.map((e) => [e.toolName, e.policyVerdict])).toEqual([
      ["github.list_issues", "allow"],
      ["github.no_such_tool", "block"],
      ["github.list_issues", "block"],
    ]);
    expect(persistedTrace[0]?.connectionPrefix).toBe(PREFIX);
    expect(persistedTrace[0]?.upstreamStatus).toBe(200);
    expect(JSON.stringify(persistedTrace)).not.toContain("ghp_smoke");

    // The require_approval → (approved) allow pair lives under the manager's
    // execution: the pause was audited as a refusal (F1 — the audit Trace records
    // it even though the replay journal does NOT), and the resumed run audited the
    // approved call as an allow that reached upstream (status present, prefix set).
    const managerAudit = await store.trace.listByExecution(managerExecId);
    expect(managerAudit.map((e) => [e.toolName, e.policyVerdict])).toEqual([
      ["github.delete_repo", "require_approval"],
      ["github.delete_repo", "allow"],
    ]);
    expect(managerAudit[1]?.connectionPrefix).toBe(PREFIX);
    expect(managerAudit[1]?.upstreamStatus).toBe(200);
    expect(JSON.stringify(managerAudit)).not.toContain("ghp_smoke");

    // ── Phase 9: §9.3 default — the same pipeline WITHOUT the opt-in flag
    // refuses the loopback upstream before a single byte leaves the host ──
    await store.policies.upsert({
      toolName: "github.list_issues",
      action: "allow",
      seededFrom: "safe",
      manualOverride: true, // operator re-allows; change is live immediately
      redactFields: [],
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
    // The egress guard refused before any byte left the host, so the count is
    // unchanged from Phase 6: the Phase-5 list_issues + the approved delete_repo.
    expect(upstreamCalls).toHaveLength(2);

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
    // 4 rows: P5 allow, P6b no_such_tool block, P7 block, + this upstream
    // failure. (The delete_repo require_approval/allow pair belongs to the
    // manager's execution now — the D2 behavior change.)
    expect(traceAfter401).toHaveLength(4); // A3: allowed + upstream-failure traces
    const failureRow = traceAfter401[3];
    expect(failureRow?.policyVerdict).toBe("allow");
    expect(failureRow && "output" in failureRow).toBe(false);
    expect(JSON.stringify(traceAfter401)).not.toContain(SECRET);
    expect(JSON.stringify(traceAfter401)).not.toContain("ghp_smoke");
    // The host-side log never saw it either: the secret lived only in the
    // fetch argument scope (spec §9.2).
    expect(hostLog.join("\n")).not.toContain(SECRET);

    // ── Phase 11: INVARIANT M4 — a hostile upstream that ACCEPTS the call
    // and echoes the credential inside a successful result body must not
    // leak it into the newly persisted outcome columns (executions.result/
    // error, Task 1). Phase 10 proved the echo goes nowhere for a REJECTED
    // (401) call surfaced as a guest-catchable error; this phase drives the
    // SAME echo through a managed, PERSISTED execution (manager.start) so
    // the assertion lands on the actual on-disk row, not just the in-memory
    // return value — the upstream caller's §9.2 containsCredential tripwire
    // is the same code path either way (upstream.ts), but this pins that its
    // protection extends all the way to the store, matching the journal's
    // existing guarantee (Phase 6/8's replayJournal/Trace sweeps).
    await store.sources.upsert({
      id: "src_gh",
      type: "mcp",
      namespace: "github",
      location: `http://127.0.0.1:${port}/echoInBody`,
    });
    const echoOutcome = await manager.start(`
      try {
        await tools.github.list_issues({ owner: "acme", repo: "site" });
        return "UNREACHABLE";
      } catch (error) {
        return { name: error.name, message: String(error.message ?? error) };
      }
    `);
    expect(echoOutcome.status).toBe("completed");
    if (echoOutcome.status === "completed") {
      const value = echoOutcome.value as { name: string; message: string };
      // The §9.2 best-effort tripwire (upstream.ts containsCredential) fires
      // on the echoed credential in the 200 result body, refusing to deliver
      // it — the call surfaces as an upstream error, not a completed value
      // carrying the secret.
      expect(value.name).toBe(GUEST_ERROR_NAMES.upstream);
      expect(value.message).toContain("echoed the connection's credential");
    }
    expect(JSON.stringify(echoOutcome)).not.toContain(SECRET);
    expect(JSON.stringify(echoOutcome)).not.toContain("ghp_smoke");

    // The persisted `executions` row for this run — whichever settle path
    // fired — must not carry the secret in its `result` or `error` column.
    const echoRow = await manager.get(echoOutcome.executionId);
    expect(echoRow?.status).toBe("completed");
    expect(JSON.stringify(echoRow)).not.toContain(SECRET);
    expect(JSON.stringify(echoRow)).not.toContain("ghp_smoke");

    // The falsification probe itself: re-run the full raw-table dump (now
    // covering the populated executions.result/error columns) and assert
    // the secret is nowhere on disk — the upstream sanitize layer protects
    // the new outcome columns exactly as it protects the journal.
    const rawDumpAfterEcho = await dumpAllTablesRaw(client);
    expect(rawDumpAfterEcho).not.toContain(SECRET);
    expect(rawDumpAfterEcho).not.toContain("ghp_smoke");
  });
});
