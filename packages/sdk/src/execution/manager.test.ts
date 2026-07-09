import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCatalog } from "../catalog.js";
import { createStoreCredentialResolver } from "../credentials.js";
import { createCatalogToolHost } from "../execute.js";
import { normalizeMcp } from "../normalize/mcp.js";
import { createToolInvoker } from "../pipeline/invoker.js";
import { createMcpUpstreamCaller } from "../pipeline/upstream.js";
import { createStorePolicyEngine } from "../policy.js";
import { QuickJSSandbox } from "../sandbox/quickjs.js";
import { SecretBox } from "../secrets.js";
import { openSqliteStore } from "../store/sqlite.js";
import type { ConduitStore } from "../store/store.js";
import { createInMemoryApprovalDecisions } from "./decisions.js";
import { createExecutionManager, type ExecutionManagerDeps } from "./manager.js";

/**
 * §5.5 execution-manager invariant + behavior suite. Composes the REAL stack
 * across its seams the way the product will (mirrors e2e.smoke.test.ts): an
 * MCP source normalized → persisted to SQLite → catalog rehydrated → policy +
 * credential resolver + QuickJS sandbox wired through the real §5.3 pipeline
 * against a loopback node:http MCP server. Nothing in the call path is a
 * stand-in — pause/resume is exercised end to end.
 *
 * NOTE: these tests use a loopback server and HANG under the Bash-tool
 * sandbox; the authoritative pass is the (unsandboxed) pre-commit hook run.
 */

const SECRET = "Bearer ghp_manager_secret_do_not_leak_7b3d";
const PREFIX = "github.acme.prod";

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
  name: string;
  arguments: unknown;
}

/**
 * A live MCP server on loopback. Records every tools/call it sees (so a test
 * can assert an approved side effect fired EXACTLY once) and echoes a
 * per-tool result. `/echo401` plays the hostile credential-echo upstream.
 */
function startMcpServer(): Promise<{ server: Server; port: number; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
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
      calls.push({ name: payload.params.name, arguments: payload.params.arguments });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { ok: true, tool: payload.params.name },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, calls });
    });
  });
}

interface Harness {
  store: ConduitStore;
  deps: ExecutionManagerDeps;
  calls: UpstreamCall[];
  cleanup: () => Promise<void>;
  reopen: () => Promise<ConduitStore>;
}

/**
 * Stand up the full stack against a fresh on-disk store + a fresh loopback
 * MCP server, ingest the three-tool GitHub namespace, and return the manager
 * deps wired to the real invoker/sandbox. The invoker upstream opts into
 * loopback egress (trusted-code path) exactly as the e2e smoke does.
 */
async function makeHarness(options?: { location?: string }): Promise<Harness> {
  const scratch = mkdtempSync(join(tmpdir(), "conduit-mgr-"));
  const dbUrl = `file:${join(scratch, "mgr.db")}`;
  const keyBytes = SecretBox.generateKeyBytes();
  const clients: ReturnType<typeof createClient>[] = [];

  const open = async (): Promise<ConduitStore> => {
    const client = createClient({ url: dbUrl });
    clients.push(client);
    return openSqliteStore({ client, secretBox: await SecretBox.fromKeyBytes(keyBytes) });
  };

  const { server, port, calls } = await startMcpServer();
  const location = options?.location ?? `http://127.0.0.1:${port}/mcp`;

  const store = await open();
  const tools = normalizeMcp({ namespace: "github", tools: mcpToolsList });
  await store.sources.upsert({ id: "src_gh", type: "mcp", namespace: "github", location });
  await store.integrations.upsert({ id: "int_gh", sourceId: "src_gh", namespace: "github" });
  await store.connections.upsert({
    id: "conn_gh",
    integrationId: "int_gh",
    prefix: PREFIX,
    credentialRef: "cred_gh",
  });
  await store.secrets.put("cred_gh", SECRET);
  await store.tools.replaceNamespace("github", tools);

  const catalog = new InMemoryCatalog();
  catalog.upsert(await store.tools.list("github"));

  const policy = createStorePolicyEngine(store.policies);
  const credentials = createStoreCredentialResolver(store.secrets);
  const upstream = createMcpUpstreamCaller({ egress: { allowPrivate: true } });
  const sandbox = new QuickJSSandbox();

  const deps: ExecutionManagerDeps = {
    store,
    sandbox,
    makeInvoker: ({ executionId, decisions }) =>
      createToolInvoker(
        { store, policy, credentials, upstream, ...(decisions !== undefined ? { decisions } : {}) },
        { executionId },
      ),
    makeToolHost: (invoke) => createCatalogToolHost(catalog, invoke),
    makeDecisions: () => createInMemoryApprovalDecisions(),
  };

  return {
    store,
    deps,
    calls,
    reopen: open,
    cleanup: async () => {
      for (const c of clients) {
        c.close();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("§5.5 execution manager — pause/resume via deterministic replay", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
  });

  it("INVARIANT §5.5: pause/resume via deterministic replay — approve resumes and runs the approved call live exactly once", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // A safe read (auto-allowed) then a review-class write (require_approval).
    const code = `
      const before = await tools.github.list_issues({ owner: "acme", repo: "site" });
      const created = await tools.github.create_issue({ title: "from agent" });
      return { before, created };
    `;

    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;
    // Host-side pause payload is fully populated (design C3).
    expect(first.pending.toolName).toBe("github.create_issue");
    expect(first.pending.input).toEqual({ title: "from agent" });
    expect(first.pending.reason).toContain("requires approval");
    expect(first.pending.callId).toBeTruthy();
    expect(first.pending.expiresAt).toBeGreaterThan(Date.now());

    // The safe read reached upstream once; the paused call did NOT.
    expect(h.calls.map((c) => c.name)).toEqual(["list_issues"]);

    // The persisted execution is paused with pausedOn; the replay journal
    // holds ONLY the finalized prefix (the safe read) — no require_approval.
    const paused = await manager.get(id);
    expect(paused?.status).toBe("paused");
    const journalRows = await h.store.replayJournal.listByExecution(id);
    expect(journalRows.map((r) => r.op)).toEqual(["call"]);
    expect(journalRows).toHaveLength(1);
    expect(JSON.parse(journalRows[0]?.request ?? "{}").path).toBe("github.list_issues");

    // Resume with approve → the paused call runs live, execution completes.
    const outcome = await manager.resume(id, { kind: "approve" });
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.value).toEqual({
        before: { ok: true, tool: "list_issues" },
        created: { ok: true, tool: "create_issue" },
      });
    }

    // EXACTLY ONCE: the approved create_issue reached upstream a single time;
    // the replayed list_issues was memoized (not re-called).
    expect(h.calls.map((c) => c.name)).toEqual(["list_issues", "create_issue"]);
    const done = await manager.get(id);
    expect(done?.status).toBe("completed");
  });

  it("INVARIANT §5.5: deny resolves the pending call as blocked", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // Guest catches the denial and reports it — execution completes with the
    // denial as its value (deny reuses ConduitPolicyBlocked, design D1/M3).
    const code = `
      try {
        await tools.github.create_issue({ title: "nope" });
        return { blocked: false };
      } catch (error) {
        return { blocked: true, name: error.name };
      }
    `;
    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }

    const outcome = await manager.resume(first.executionId, { kind: "deny" });
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.value).toEqual({ blocked: true, name: "ConduitPolicyBlocked" });
    }
    // The denied call never reached upstream.
    expect(h.calls.map((c) => c.name)).toEqual([]);
  });

  it("§5.5: concurrent resume — exactly one drives, the other returns conflict", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    const code = `
      const created = await tools.github.create_issue({ title: "race" });
      return created;
    `;
    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;

    // Two concurrent approve-resumes: the atomic claim (F4) guarantees exactly
    // one drives; the other is a no-op conflict.
    const [a, b] = await Promise.all([
      manager.resume(id, { kind: "approve" }),
      manager.resume(id, { kind: "approve" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["completed", "conflict"]);

    // The approved side effect executed EXACTLY once despite two resumes.
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);
  });

  it("§5.5: catalog change between pause and resume does not diverge replay (search/describe journaled)", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // The guest branches on search/describe results BEFORE the approval gate.
    // Journaling those reads (design D5) makes replay stable even if the
    // catalog is mutated during the approval window.
    const code = `
      const { items } = await tools.search({ query: "issue" });
      const first = items[0]?.path ?? "none";
      const details = await tools.describe.tool({ path: "github.create_issue", includeSchemas: true });
      const created = await tools.github.create_issue({ title: "branch on " + first });
      return { first, hasSchema: details?.inputSchema !== undefined, created };
    `;
    const started = await manager.start(code);
    expect(started.status).toBe("paused");
    if (started.status !== "paused") {
      return;
    }
    const id = started.executionId;
    // The pre-gate reads are journaled as a clean prefix.
    const rows = await h.store.replayJournal.listByExecution(id);
    expect(rows.map((r) => r.op)).toEqual(["search", "describe"]);
    const firstPathBeforeMutation = started.pending.input;

    // MUTATE the catalog underneath: refresh the namespace with a DIFFERENT
    // tool set. Live re-reads would return different search results and the
    // divergence guard would fail the run; journaled reads keep replay stable.
    await h.store.tools.replaceNamespace(
      "github",
      normalizeMcp({
        namespace: "github",
        tools: [
          { name: "create_issue", inputSchema: { type: "object" } },
          { name: "unrelated_new_tool", inputSchema: { type: "object" } },
        ],
      }),
    );

    const outcome = await manager.resume(id, { kind: "approve" });
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      const value = outcome.value as { first: string; created: unknown };
      // The title was built from the JOURNALED search result, unchanged by the
      // mutation — replay is stable.
      expect((firstPathBeforeMutation as { title: string }).title).toBe(`branch on ${value.first}`);
    }
  });

  it("§5.5: resume-path re-pause — two sequential approvals (design D3)", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // Two review-class writes: approving #1 resumes into #2, which pauses
    // again. Approving #2 completes. (Task-3 deferred follow-up.)
    const code = `
      const a = await tools.github.create_issue({ title: "one" });
      const b = await tools.github.create_issue({ title: "two" });
      return { a, b };
    `;
    const p1 = await manager.start(code);
    expect(p1.status).toBe("paused");
    if (p1.status !== "paused") {
      return;
    }
    expect(p1.pending.input).toEqual({ title: "one" });
    const id = p1.executionId;

    const p2 = await manager.resume(id, { kind: "approve" });
    expect(p2.status).toBe("paused");
    if (p2.status !== "paused") {
      return;
    }
    // Re-paused on the SECOND call; the first side effect fired exactly once.
    expect(p2.pending.input).toEqual({ title: "two" });
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);
    // The prefix now holds the first (approved, live) call as a finalized row.
    const rows = await h.store.replayJournal.listByExecution(id);
    expect(rows.map((r) => r.op)).toEqual(["call"]);

    const done = await manager.resume(id, { kind: "approve" });
    expect(done.status).toBe("completed");
    if (done.status === "completed") {
      expect(done.value).toEqual({
        a: { ok: true, tool: "create_issue" },
        b: { ok: true, tool: "create_issue" },
      });
    }
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(2);
  });

  it("§5.5: expired pending approval resumes as expired, not completed", async () => {
    const h = await makeHarness();
    active = h;
    // Inject a clock we can advance past the TTL.
    let clock = 1_000_000;
    const deps: ExecutionManagerDeps = { ...h.deps, now: () => clock };
    const manager = createExecutionManager(deps);

    const first = await manager.start(`
      const created = await tools.github.create_issue({ title: "stale" });
      return created;
    `);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    // Advance the clock beyond expiresAt.
    clock = first.pending.expiresAt + 1;
    const outcome = await manager.resume(first.executionId, { kind: "approve" });
    expect(outcome.status).toBe("expired");
    // The approved call was never made — expiry short-circuits before re-drive.
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(0);
    const persisted = await manager.get(first.executionId);
    expect(persisted?.status).toBe("expired");
  });

  it("§5.5: no secret survives into the persisted replay journal or the outcome (F6, structural §9.2 guarantee)", async () => {
    // Point the source at the hostile echo endpoint so an upstream 200-body
    // echo of the credential would land in the journal if unscrubbed. The
    // list_issues read fails (401) but is caught by the guest; the point is
    // that NO secret material survives into the journal or the resumed value.
    const h = await makeHarness();
    active = h;
    // Repoint the source to the echo endpoint (live source lookup at call
    // time) so a 200/401 body echoing the credential would land in the
    // journal if unscrubbed.
    const src = await h.store.sources.get("src_gh");
    if (src !== undefined) {
      await h.store.sources.upsert({ ...src, location: src.location.replace("/mcp", "/echo401") });
    }
    const manager = createExecutionManager(h.deps);
    const outcome = await manager.start(`
      try {
        await tools.github.list_issues({ owner: "acme", repo: "site" });
        return { reached: true };
      } catch (error) {
        return { reached: false, name: error.name };
      }
    `);
    // The read fails upstream (401) but is journaled as a failed outcome; the
    // execution completes with the guest's catch value.
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      return;
    }
    const journal = await h.store.replayJournal.listByExecution(outcome.executionId);
    expect(JSON.stringify(journal)).not.toContain("ghp_manager");
    expect(JSON.stringify(outcome)).not.toContain("ghp_manager");
  });
});
