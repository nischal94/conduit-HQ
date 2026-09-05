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
import type { UpstreamSessionScope } from "../pipeline/upstream-session.js";
import { createStorePolicyEngine } from "../policy.js";
import { QuickJSSandbox } from "../sandbox/quickjs.js";
import { generateSeeds, type Sandbox } from "../sandbox/sandbox.js";
import { SecretBox } from "../secrets.js";
import { openSqliteStore } from "../store/sqlite.js";
import type { ConduitStore } from "../store/store.js";
import type { Execution } from "../types.js";
import { createInMemoryApprovalDecisions } from "./decisions.js";
import { createExecutionManager, type ExecutionManagerDeps } from "./manager.js";

/**
 * The callId a resume must name (spec §5.5: an approval binds to ONE pending
 * call). Read from the persisted row — the same value the CLI gets from the
 * approvals list, via a shorter path. Throws when nothing is pending, so a
 * regression that lost `pausedOn` cannot hide behind a sentinel id. Tests
 * that break `get`, or that build the paused row by hand, pass the id
 * directly.
 */
async function pendingCallOf(
  manager: { get(id: string): Promise<Execution | undefined> },
  executionId: string,
): Promise<string> {
  const callId = (await manager.get(executionId))?.pausedOn?.callId;
  if (callId === undefined) {
    throw new Error(`[manager.test] ${executionId} has no pending call to resume`);
  }
  return callId;
}

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
      // The hostile upstream fails EVERY POST (the handshake's initialize
      // included) with a 401 echoing the credential — same meaning as before,
      // now surfacing on the first streamable-HTTP request.
      if (req.url === "/echo401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad token", echoed: req.headers.authorization }));
        return;
      }
      // Session teardown (ephemeral scope dispose): a bodyless DELETE — ack it.
      if (req.method === "DELETE" || body === "") {
        res.writeHead(200);
        res.end();
        return;
      }
      const payload = JSON.parse(body) as {
        id: string;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      // Streamable-HTTP handshake bookkeeping — the caller now speaks the full
      // MCP client protocol (initialize → initialized → tools/call).
      if (payload.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "mgr-session-1",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "mgr-fixture", version: "0" },
            },
          }),
        );
        return;
      }
      if (payload.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      calls.push({ name: payload.params?.name ?? "", arguments: payload.params?.arguments });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { ok: true, tool: payload.params?.name },
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
async function makeHarness(options?: {
  location?: string;
  /** Records the timeoutMs the invoker hands each upstream call (F1 clamp test). */
  recordTimeout?: (timeoutMs: number) => void;
}): Promise<Harness> {
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
  const realUpstream = createMcpUpstreamCaller({ egress: { allowPrivate: true } });
  // Optionally record the per-call timeout the invoker computes, to prove the
  // §16 wall-clock budget actually clamps it (F1) — not just that a deadline
  // was supplied.
  const upstream: typeof realUpstream = options?.recordTimeout
    ? {
        call: (args) => {
          options.recordTimeout?.(args.timeoutMs);
          return realUpstream.call(args);
        },
      }
    : realUpstream;
  const sandbox = new QuickJSSandbox();

  const deps: ExecutionManagerDeps = {
    store,
    sandbox,
    // Forward the manager-supplied deadline exactly as production runtime.ts
    // does, so the wall-clock budget reaches the invoker's min(ceiling, remaining).
    makeInvoker: ({ executionId, decisions, deadline }) =>
      createToolInvoker(
        { store, policy, credentials, upstream, ...(decisions !== undefined ? { decisions } : {}) },
        { executionId, ...(deadline !== undefined ? { deadline } : {}) },
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

/**
 * A fresh, empty on-disk store with NO source/loopback wiring. Used by the
 * stub-Sandbox tests (I-1), which drive the manager state machine directly and
 * never reach upstream — so they run under the Bash-tool sandbox without EPERM.
 */
async function makeBareStore(): Promise<ConduitStore> {
  const scratch = mkdtempSync(join(tmpdir(), "conduit-bare-"));
  const client = createClient({ url: `file:${join(scratch, "bare.db")}` });
  bareClients.push(client);
  return openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
  });
}
const bareClients: ReturnType<typeof createClient>[] = [];

/**
 * Manager deps wired to a stub Sandbox. The invoker/host/decisions seams are
 * present but never exercised in the I-1 tests, because the stub sandbox throws
 * before it performs any tool call. `overrides` lets a test pin `newId` so the
 * `start`-minted execution id is inspectable.
 */
function makeStubDeps(
  store: ConduitStore,
  sandbox: Sandbox,
  overrides?: Partial<Pick<ExecutionManagerDeps, "newId" | "now">>,
): ExecutionManagerDeps {
  const unusedHost = {
    search: () => Promise.reject(new Error("host must not be called when sandbox throws")),
    describe: () => Promise.reject(new Error("host must not be called when sandbox throws")),
    call: () => Promise.reject(new Error("host must not be called when sandbox throws")),
  };
  return {
    store,
    sandbox,
    makeInvoker: () => () =>
      Promise.reject(new Error("invoker must not be called when sandbox throws")),
    makeToolHost: () => unusedHost,
    makeDecisions: () => createInMemoryApprovalDecisions(),
    ...(overrides?.newId !== undefined ? { newId: overrides.newId } : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
  };
}

describe("§5.5 execution manager — pause/resume via deterministic replay", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
    for (const c of bareClients.splice(0)) {
      c.close();
    }
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
    const outcome = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
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

    const outcome = await manager.resume(
      first.executionId,
      { kind: "deny" },
      await pendingCallOf(manager, first.executionId),
    );
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
    // Read the id ONCE and launch both resumes from the same tick: an
    // `await` inside the array literal would start the first resume before
    // the second even began, weakening the interleaving F4 is about.
    const callId = await pendingCallOf(manager, id);
    const [a, b] = await Promise.all([
      manager.resume(id, { kind: "approve" }, callId),
      manager.resume(id, { kind: "approve" }, callId),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["completed", "conflict"]);

    // The approved side effect executed EXACTLY once despite two resumes.
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);
  });

  it("INVARIANT §5.5: an approval binds to ONE pending call — a stale duplicate approval cannot approve a LATER pause of the same program", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // Two approval gates in one program: approving the first pause drives the
    // program straight into the second.
    const code = `
      await tools.github.create_issue({ title: "first" });
      await tools.github.create_issue({ title: "second" });
      return "done";
    `;
    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;
    const firstCallId = first.pending.callId;

    // The operator approves pause A; the program reaches pause B.
    const afterFirst = await manager.resume(id, { kind: "approve" }, firstCallId);
    expect(afterFirst.status).toBe("paused");
    if (afterFirst.status !== "paused") {
      return;
    }
    expect(afterFirst.pending.callId).not.toBe(firstCallId);

    // A queued DUPLICATE approval of pause A arrives now. It must NOT approve
    // pause B: the execution is paused, but not on the call that was approved.
    const stale = await manager.resume(id, { kind: "approve" }, firstCallId);
    expect(stale.status).toBe("conflict");
    expect(stale.decisionApplied).toBe(false);

    // Pause B is still waiting on a human, and only the first call ran upstream.
    expect((await h.deps.store.executions.get(id))?.pausedOn?.callId).toBe(
      afterFirst.pending.callId,
    );
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

    const outcome = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      const value = outcome.value as { first: string; created: unknown };
      // The title was built from the JOURNALED search result, unchanged by the
      // mutation — replay is stable.
      expect((firstPathBeforeMutation as { title: string }).title).toBe(`branch on ${value.first}`);
    }
  });

  it("§5.5: describe WITHOUT includeSchemas journals the guest's bytes → resume completes (no spurious divergence)", async () => {
    // Regression: the journaling wrapper used to RECONSTRUCT the describe
    // request as JSON.stringify({ path, includeSchemas: options?.includeSchemas
    // === true }). The guest bridge emits JSON.stringify(options) verbatim, so
    // `tools.describe.tool({ path })` (the natural lazy-describe, spec §6) emits
    // {"path":"x"} while the wrapper stored {"path":"x","includeSchemas":false}.
    // On resume the divergence guard compared the stored request byte-for-byte
    // against the guest's re-emit → mismatch → NondeterministicExecutionError,
    // killing a perfectly deterministic approved execution. Journaling the
    // guest's original bytes closes it.
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // describe WITHOUT includeSchemas, then a review-class write (the gate).
    const code = `
      const details = await tools.describe.tool({ path: "github.create_issue" });
      const created = await tools.github.create_issue({ title: "lazy describe" });
      return { described: details?.path ?? "none", created };
    `;
    const started = await manager.start(code);
    expect(started.status).toBe("paused");
    if (started.status !== "paused") {
      return;
    }
    const id = started.executionId;

    // The pre-gate describe is journaled with the GUEST'S bytes — no injected
    // includeSchemas:false. This is the exact string the guest re-emits on
    // replay, so the divergence guard sees a match.
    const rows = await h.store.replayJournal.listByExecution(id);
    expect(rows.map((r) => r.op)).toEqual(["describe"]);
    expect(rows[0]?.request).toBe(JSON.stringify({ path: "github.create_issue" }));

    // Resume(approve) must COMPLETE — not die with NondeterministicExecutionError.
    const outcome = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.value).toEqual({
        described: "github.create_issue",
        created: { ok: true, tool: "create_issue" },
      });
    }
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);
  });

  it("§5.5: describe WITH includeSchemas:true still journals and resumes cleanly", async () => {
    // The other arm of the same fix: an explicit includeSchemas:true is part of
    // the guest's options object, so the guest emits it verbatim and the
    // wrapper journals the same bytes — replay stays deterministic.
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    const code = `
      const details = await tools.describe.tool({ path: "github.create_issue", includeSchemas: true });
      const created = await tools.github.create_issue({ title: "with schema" });
      return { hasSchema: details?.inputSchema !== undefined, created };
    `;
    const started = await manager.start(code);
    expect(started.status).toBe("paused");
    if (started.status !== "paused") {
      return;
    }
    const id = started.executionId;
    const rows = await h.store.replayJournal.listByExecution(id);
    expect(rows[0]?.request).toBe(
      JSON.stringify({ path: "github.create_issue", includeSchemas: true }),
    );

    const outcome = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      const value = outcome.value as { hasSchema: boolean };
      expect(value.hasSchema).toBe(true);
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

    const p2 = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
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

    const done = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
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
    const outcome = await manager.resume(
      first.executionId,
      { kind: "approve" },
      await pendingCallOf(manager, first.executionId),
    );
    expect(outcome.status).toBe("expired");
    // The approved call was never made — expiry short-circuits before re-drive.
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(0);
    const persisted = await manager.get(first.executionId);
    expect(persisted?.status).toBe("expired");
  });

  it("§5.5 (F6): the STRUCTURAL §9.2 guarantee — no credential material survives into the persisted replay journal or the returned value across a live call", async () => {
    // What this test actually proves (and does NOT): it asserts the STRUCTURAL
    // guarantee (design D7 / spec §9.2) — credentials are request-scoped and
    // never persisted, so the replay journal and the returned outcome hold only
    // host-classified upstream results, never credential material. It does NOT
    // prove the best-effort scrub ran: the manager passes `secret: undefined`
    // to the journaling wrapper (it deliberately does not resolve credentials —
    // that stays in the pipeline, design D7), so `scrubCredential` is a no-op
    // here. The secret's absence is structural (the /echo401 upstream returns
    // the credential in its OWN response only on a path the guest's value never
    // carries), not a consequence of scrubbing. The scrub logic itself — the
    // best-effort defense-in-depth layer — is exercised directly with real
    // secrets in scrub.test.ts, so its coverage does not depend on this test.
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

  it("§5.5 (F2): confused-deputy — an approval for tool A never authorizes tool B, and the divergence is TERMINAL (guest cannot catch-and-continue)", async () => {
    // End-to-end confused-deputy defense (design D6/F2, design §9), now TERMINAL.
    // A run pauses on a DESTRUCTIVE call (delete_repo, tool B). Before resume,
    // the persisted `pausedOn` is corrupted to look like a benign create_issue
    // approval (tool A) — the identity a human "thought" they were approving. On
    // resume the manager stages the approve decision bound to that A-identity,
    // but the replay reaches the real first un-journaled call (delete_repo, B).
    // The invoker's identity check throws an uncatchable ConduitReplayDivergence:
    // the guest's try/catch does NOT run (the interrupt is uncatchable), the
    // execution is TERMINAL `failed`, and delete_repo NEVER executes.
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    const code = `
      try {
        const r = await tools.github.delete_repo({ repo: "prod" });
        return { deleted: true, r };
      } catch (error) {
        // Under the TERMINAL model this catch must NOT run — the divergence is
        // an uncatchable interrupt, so control never returns to guest code.
        return { deleted: false, caughtAndContinued: true, name: error.name };
      }
    `;
    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;
    // It paused on the destructive call (tool B).
    expect(first.pending.toolName).toBe("github.delete_repo");
    // delete_repo did NOT reach upstream at pause time.
    expect(h.calls.filter((c) => c.name === "delete_repo")).toHaveLength(0);

    // Corrupt the persisted pausedOn to a DIFFERENT (benign) call identity —
    // the crux of the confused-deputy scenario: the staged decision will be
    // bound to create_issue (A), not to the delete_repo (B) the replay reaches.
    const persisted = await manager.get(id);
    if (persisted?.pausedOn === undefined) {
      throw new Error("expected a persisted pausedOn to corrupt");
    }
    await h.store.executions.put({
      ...persisted,
      pausedOn: {
        ...persisted.pausedOn,
        toolName: "github.create_issue",
        input: { title: "harmless" },
      },
    });

    // Resume with approve. The staged approve is bound to create_issue (A); the
    // first live call on replay is delete_repo (B) → identity mismatch → TERMINAL
    // replay-divergence. The guest CANNOT catch-and-continue; the execution fails.
    const outcome = await manager.resume(id, { kind: "approve" }, first.pending.callId);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitReplayDivergence");
    }
    // The wrong tool was NEVER executed: delete_repo (B) never reached upstream,
    // and neither did create_issue (A) — the approval authorized nothing.
    expect(h.calls.filter((c) => c.name === "delete_repo")).toHaveLength(0);
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(0);

    // TERMINAL + non-resumable: the row is `failed` with pausedOn cleared, and a
    // later resume is a no-op conflict (no `paused` row to claim). The guest
    // never regained control to invoke the approved tool.
    const settled = await manager.get(id);
    expect(settled?.status).toBe("failed");
    expect(settled?.pausedOn).toBeUndefined();
    const retry = await manager.resume(id, { kind: "approve" }, first.pending.callId);
    expect(retry.status).toBe("conflict");
  });

  it("§5.5 (F5): outcome-ambiguity — a replay-journal append failure after the side effect → terminal `failed`, not resumable", async () => {
    // End-to-end outcome-ambiguity (design D8/F5). An approved call reaches
    // upstream (the side effect fires), but the replay-journal append THEN
    // throws. The barrier records the call as outcome-ambiguous: the execution
    // becomes terminal `failed` (NON-resumable) and the side effect is not
    // re-run on any later resume.
    const h = await makeHarness();
    active = h;

    // Wrap the store so replayJournal.append throws for the APPROVED call only
    // (the one whose serialized request names create_issue), AFTER upstream has
    // already been hit. Every other append (the safe-read prefix) passes.
    const realAppend = h.store.replayJournal.append.bind(h.store.replayJournal);
    let poisoned = false;
    const wrappedStore: ConduitStore = {
      ...h.store,
      replayJournal: {
        ...h.store.replayJournal,
        append: async (executionId, entry) => {
          if (entry.request.includes("create_issue")) {
            poisoned = true;
            throw new Error("[test] simulated replay-journal append failure after side effect");
          }
          return realAppend(executionId, entry);
        },
      },
    };
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      store: wrappedStore,
      // The invoker/toolhost must use the SAME wrapped store so the real
      // upstream side effect still fires through the loopback server.
      makeInvoker: h.deps.makeInvoker,
    };
    const manager = createExecutionManager(deps);

    const code = `
      const before = await tools.github.list_issues({ owner: "acme", repo: "site" });
      const created = await tools.github.create_issue({ title: "ambiguous" });
      return { before, created };
    `;
    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;

    // Resume with approve: create_issue reaches upstream (side effect fires),
    // then its journal append throws → outcome-ambiguous terminal failed.
    const outcome = await manager.resume(id, { kind: "approve" }, first.pending.callId);
    expect(poisoned).toBe(true);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitOutcomeAmbiguous");
    }
    // The approved side effect DID fire exactly once (it is the ambiguity).
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);

    // Terminal + NOT resumable: the row is `failed`, and a further resume is a
    // no-op conflict (no `paused` row to claim) — the side effect is never re-run.
    const settled = await manager.get(id);
    expect(settled?.status).toBe("failed");
    expect(settled?.pausedOn).toBeUndefined();
    const retry = await manager.resume(id, { kind: "approve" }, first.pending.callId);
    expect(retry.status).toBe("conflict");
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);
  });

  // ── I-1: an unexpected sandbox throw on resume/start must not strand the
  //         execution in `running`. It finalizes a terminal `failed`. ──────
  //
  // These tests inject a STUB Sandbox whose `execute` rejects, so they exercise
  // the manager state machine WITHOUT a loopback server — they run directly
  // under the Bash-tool sandbox (no EPERM), unlike the loopback tests above.

  it("§5.5 (I-1): a resume-time sandbox throw finalizes terminal `failed`, never a stranded `running`", async () => {
    // A store with no MCP/loopback wiring: this test never reaches upstream.
    const store = await makeBareStore();
    let calls = 0;
    const throwingSandbox: Sandbox = {
      execute() {
        calls += 1;
        // An infra fault out of the sandbox: bootstrap failure, getQuickJS()
        // failure, or corrupt stored seeds surfacing as a RangeError.
        return Promise.reject(new RangeError("Invalid stored seeds (corrupt replay state)"));
      },
    };
    const deps = makeStubDeps(store, throwingSandbox);
    const manager = createExecutionManager(deps);

    // Seed a paused execution directly (no sandbox needed to reach a pause):
    // status=paused with a pending approval and a one-row prefix journal.
    const id = "exec_i1_resume";
    const pausedOn = {
      callId: "call_1",
      toolName: "github.create_issue",
      input: { title: "from agent" },
      reason: "github.create_issue requires approval before it can run.",
      expiresAt: Date.now() + 3_600_000,
    };
    await store.executions.put({
      id,
      code: "return await tools.github.create_issue({ title: 'from agent' });",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn,
      startedAt: Date.now(),
    });
    await store.replayJournal.append(id, {
      ordinal: 0,
      op: "call",
      request: JSON.stringify({ path: "github.list_issues", input: {} }),
      outcome: { ok: true, value: { ok: true, tool: "list_issues" } },
    });

    // Resume must NOT swallow the throw, but it MUST finalize the row first.
    await expect(manager.resume(id, { kind: "approve" }, pausedOn.callId)).rejects.toThrow(
      "corrupt replay state",
    );
    expect(calls).toBe(1);

    // The invariant: the row is terminal `failed`, NOT a stranded `running`.
    const after = await manager.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.endedAt).toBeDefined();
    expect(after?.pausedOn).toBeUndefined();

    // Consequence proof: because the row is terminal (not the pre-fix stranded
    // `running`), a second resume returns `conflict` (claimForResume finds no
    // `paused` row) rather than re-driving — the execution is settled, not
    // half-transitioned.
    const second = await manager.resume(id, { kind: "approve" }, pausedOn.callId);
    expect(second.status).toBe("conflict");
  });

  it("§5.5 (I-2): a post-sandbox persistence throw on resume does not strand the execution in `running`", async () => {
    // Sibling of the drive()-catch fix (commit 0991204): that fix covered a
    // throw OUT of sandbox.execute. This covers the SIBLING store-write path —
    // the post-sandbox `finish`/paused/expiry `put()` that runs after
    // claimForResume has already flipped the row to `running`. If that write
    // throws (a transient store/disk fault) and is left uncaught, the row is
    // stranded `running` with a stale pausedOn → a later resume's
    // claimForResume WHERE status='paused' finds 0 rows → permanently
    // un-resumable (design §8/§6: running must reach a terminal, never a silent
    // half-transition).
    const store = await makeBareStore();

    // A stub sandbox that returns `completed` WITHOUT performing any tool call,
    // so the (rejecting) host/invoker are never touched and no upstream/loopback
    // is needed — this runs under the Bash-tool sandbox.
    const completingSandbox: Sandbox = {
      execute(request) {
        return Promise.resolve({
          status: "completed",
          value: { done: true },
          seeds: request.seeds ?? { now: 1, random: 2 },
          journal: [...(request.journal ?? [])],
        });
      },
    };

    // Wrap the store so `executions.put` throws ONCE — a transient fault on the
    // post-sandbox terminal write (a disk/store blip that clears). The fix's
    // fallback finalize-failed write then succeeds, so the row lands terminal.
    // `claimForResume` is a separate UPDATE, left intact so the paused→running
    // claim still succeeds.
    const realPut = store.executions.put.bind(store.executions);
    let armed = false;
    let faults = 0;
    const wrappedStore: ConduitStore = {
      ...store,
      executions: {
        ...store.executions,
        put: async (execution) => {
          if (armed && faults === 0) {
            faults += 1;
            throw new Error("[test] simulated executions.put fault after sandbox settled");
          }
          return realPut(execution);
        },
      },
    };

    const deps = makeStubDeps(wrappedStore, completingSandbox);
    const manager = createExecutionManager(deps);

    const id = "exec_i2_resume";
    const pausedOn = {
      callId: "call_1",
      toolName: "github.create_issue",
      input: { title: "from agent" },
      reason: "github.create_issue requires approval before it can run.",
      expiresAt: Date.now() + 3_600_000,
    };
    await store.executions.put({
      id,
      code: "return await tools.github.create_issue({ title: 'from agent' });",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn,
      startedAt: Date.now(),
    });

    // Arm the fault: the NEXT put() (the terminal finish write) throws once.
    armed = true;

    // Resume: claimForResume flips paused→running, the sandbox settles
    // `completed`, then finish's put() throws. The error may surface (throw is
    // acceptable) — what is NOT acceptable is a silently-stranded `running`.
    await expect(manager.resume(id, { kind: "approve" }, pausedOn.callId)).rejects.toThrow();
    expect(faults).toBe(1);

    // The invariant: the row is NOT a stranded `running` that looks
    // resumable-but-isn't. The fallback finalize-failed write landed it terminal.
    const after = await manager.get(id);
    expect(after?.status).not.toBe("running");
    expect(after?.status).toBe("failed");
    expect(after?.pausedOn).toBeUndefined();

    // Consequence proof: a later resume is a no-op conflict (no `paused` row to
    // claim) — the execution is settled, not half-transitioned into a
    // permanently un-resumable `running`.
    const retry = await manager.resume(id, { kind: "approve" }, pausedOn.callId);
    expect(retry.status).toBe("conflict");
  });

  it("§5.5 (I-1): a start-time sandbox throw finalizes terminal `failed`, never a stranded `running`", async () => {
    const store = await makeBareStore();
    const throwingSandbox: Sandbox = {
      execute() {
        return Promise.reject(new Error("getQuickJS() bootstrap failed"));
      },
    };
    // Deterministic id so we can inspect the row `start` minted (id = exec_<newId>).
    const deps = makeStubDeps(store, throwingSandbox, { newId: () => "start_i1" });
    const manager = createExecutionManager(deps);

    await expect(manager.start("return 1;")).rejects.toThrow("bootstrap failed");

    // The row `start` persisted `running` must have been finalized to `failed` —
    // not left stranded `running` by the propagating throw.
    const row = await manager.get("exec_start_i1");
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).toBeDefined();
    expect(row?.pausedOn).toBeUndefined();
  });

  it("§5.5 (I-3): a throw in the post-claim prep window (get returns corrupt data) terminalizes `failed`, never stranded `running`", async () => {
    // (Fix 1 / F5) The window between a successful `claimForResume` (which flips
    // paused→running) and `drive` taking over is fragile: `get` can surface
    // CORRUPT stored JSON as a parse error. If that throw stranded the row
    // `running`, a later resume's `claimForResume WHERE status='paused'` would
    // find 0 rows → permanently un-resumable. The whole prep window must
    // terminalize the claimed row `failed` (via the raw `failClaimedResume`,
    // which needs no parsed Execution) before the fault propagates.
    const store = await makeBareStore();

    // Seed a real paused row so the (real) claimForResume succeeds…
    const id = "exec_i3_corruptget";
    await store.executions.put({
      id,
      code: "return await tools.github.create_issue({ title: 'x' });",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn: {
        callId: "call_1",
        toolName: "github.create_issue",
        input: { title: "x" },
        reason: "requires approval",
        expiresAt: Date.now() + 3_600_000,
      },
      startedAt: Date.now(),
    });

    // …then make `get` throw AFTER the claim (as corrupt stored JSON would),
    // while claimForResume/failClaimedResume stay the real guarded UPDATEs.
    const wrappedStore: ConduitStore = {
      ...store,
      executions: {
        ...store.executions,
        get: async () => {
          throw new Error("[SqliteStore] Failed to read execution: seeds is not valid JSON");
        },
      },
    };
    // A sandbox that must never run — the throw happens before drive.
    const neverSandbox: Sandbox = {
      execute: () => Promise.reject(new Error("sandbox must not run when prep throws")),
    };
    const manager = createExecutionManager(makeStubDeps(wrappedStore, neverSandbox));

    // The fault surfaces (not swallowed), but the row is finalized first.
    await expect(manager.resume(id, { kind: "approve" }, "call_1")).rejects.toThrow(
      /not valid JSON/,
    );

    // Invariant: terminal `failed`, NOT a stranded `running`. Read via the REAL
    // store (the wrapped get throws).
    const after = await store.executions.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.pausedOn).toBeUndefined();

    // Consequence: a later resume is a no-op conflict (no `paused` row to claim).
    const retry = await manager.resume(id, { kind: "approve" }, "call_1");
    expect(retry.status).toBe("conflict");
  });

  it("INVARIANT §5.5: a pause whose stored JSON carries no callId is claimed and terminalized `failed` (corrupt state), never stranded `paused` or approved", async () => {
    const store = await makeBareStore();
    const id = "exec_nocallid";
    // Written raw with NO callId: the shape a pre-callId fixture (or a
    // corrupt row) would leave behind. `put` cannot write it.
    const raw = createClient({ url: ":memory:" });
    void raw;
    await store.executions.put({
      id,
      code: "return 1;",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn: {
        callId: "will-be-stripped",
        toolName: "github.create_issue",
        input: {},
        reason: "r",
        expiresAt: Date.now() + 3_600_000,
      },
      startedAt: Date.now(),
    });
    const wrappedStore: ConduitStore = {
      ...store,
      executions: {
        ...store.executions,
        // The claim runs against the real row; the manager then reads a
        // pausedOn whose callId does not match what it claimed with.
        get: async (getId) => {
          const row = await store.executions.get(getId);
          if (row?.pausedOn === undefined) return row;
          return { ...row, pausedOn: { ...row.pausedOn, callId: "" } };
        },
      },
    };
    const neverSandbox: Sandbox = {
      execute: () => Promise.reject(new Error("sandbox must not run for a corrupt pause")),
    };
    const manager = createExecutionManager(makeStubDeps(wrappedStore, neverSandbox));

    const outcome = await manager.resume(id, { kind: "approve" }, "will-be-stripped");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitInternalError");
      expect(outcome.error.message).toContain("no call id");
    }
    expect(outcome.decisionApplied).toBe(false);
    const after = await store.executions.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.pausedOn).toBeUndefined();
  });

  it("§5.5 (I-4): the corrupt-state branch (pausedOn undefined after claim) persists terminal `failed` before returning", async () => {
    // (Fix 1) A paused row whose pausedOn is somehow absent after the claim is a
    // corrupt state. The early-return must persist `failed` (not just return a
    // failed OUTCOME while leaving the row `running`), or the row is stranded.
    const store = await makeBareStore();
    const id = "exec_i4_nopaused";
    // Seed a `paused` row (so claimForResume succeeds) then strip pausedOn via a
    // wrapped `get` that returns the row WITHOUT pausedOn — simulating the
    // corrupt state the branch guards.
    await store.executions.put({
      id,
      code: "return 1;",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn: {
        callId: "c1",
        toolName: "github.create_issue",
        input: {},
        reason: "r",
        expiresAt: Date.now() + 3_600_000,
      },
      startedAt: Date.now(),
    });
    const wrappedStore: ConduitStore = {
      ...store,
      executions: {
        ...store.executions,
        get: async (getId) => {
          const row = await store.executions.get(getId);
          if (row === undefined) {
            return undefined;
          }
          const { pausedOn: _drop, ...withoutPaused } = row;
          return withoutPaused;
        },
      },
    };
    const neverSandbox: Sandbox = {
      execute: () => Promise.reject(new Error("sandbox must not run in the corrupt-state branch")),
    };
    const manager = createExecutionManager(makeStubDeps(wrappedStore, neverSandbox));

    // The claim runs against the REAL row (callId "c1"); only the wrapped
    // `get` afterwards strips pausedOn — the corrupt state under test.
    const outcome = await manager.resume(id, { kind: "approve" }, "c1");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitInternalError");
      expect(outcome.error.message).toContain("no pending approval");
    }

    // The row was PERSISTED terminal `failed` (not left `running`): read the
    // REAL store and confirm, then a later resume is a no-op conflict.
    const after = await store.executions.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.pausedOn).toBeUndefined();
    const retry = await manager.resume(id, { kind: "approve" }, "c1");
    expect(retry.status).toBe("conflict");
  });

  it("§11 (D7 guard): the replay journal keeps the semantically-unredacted request while the Trace row is redacted", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // list_issues is riskClass safe → auto-allowed. The input carries a
    // builtin-sensitive key: the journal must keep it, the Trace must mask it.
    const code = `return await tools.github.list_issues({ owner: "acme", token: "sk-fixture" });`;
    const outcome = await manager.start(code);
    expect(outcome.status).toBe("completed");

    const journal = await h.store.replayJournal.listByExecution(outcome.executionId);
    const callRow = journal.find((row) => row.op === "call");
    expect(callRow).toBeDefined();
    // Replay fidelity: the journaled REQUEST carries the raw input.
    expect(callRow?.request).toContain("sk-fixture");

    const [trace] = await h.store.trace.listByExecution(outcome.executionId);
    expect(JSON.stringify(trace?.input)).not.toContain("sk-fixture");
    expect(JSON.stringify(trace?.input)).toContain("[redacted]");
  });
});

/**
 * Wrap `store.executions.put` so its (n+1)th call — 0-indexed by `faultAt` —
 * throws once, then all subsequent calls (including the retry from
 * `persistOrFinalizeFailed`'s fallback) pass through to the real store. This
 * targets the SETTLE write specifically (the second `put` in every scenario
 * below: `start`/`claimForResume` already durably wrote the first `running`
 * row through a DIFFERENT path — a raw put or the guarded UPDATE — so the
 * fault lands exactly on the terminal/paused/expired write under test).
 */
function withPutFaultAt(store: ConduitStore, faultAt: number): ConduitStore {
  const realPut = store.executions.put.bind(store.executions);
  let calls = 0;
  return {
    ...store,
    executions: {
      ...store.executions,
      put: async (execution: Execution) => {
        const at = calls;
        calls += 1;
        if (at === faultAt) {
          throw new Error("[test] simulated executions.put fault on the settle write");
        }
        return realPut(execution);
      },
    },
  };
}

describe("outcome persistence (mcp design M4)", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
  });

  it("persists result on completed and error on failed", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    const completed = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "site" });`,
    );
    expect(completed.status).toBe("completed");
    const completedRow = await h.store.executions.get(completed.executionId);
    expect(completedRow?.result).toEqual({ ok: true, tool: "list_issues" });

    // An uncaught guest-side throw settles the execution `failed` with a
    // real SandboxError — no upstream call or approval gate involved.
    const failed = await manager.start(`throw new TypeError("boom");`);
    expect(failed.status).toBe("failed");
    const failedRow = await h.store.executions.get(failed.executionId);
    expect(failedRow?.error?.name).toBeTruthy();
  });

  it.each([
    {
      label: "completed settle faulted",
      code: `return 1;`,
      sandbox: (): Sandbox => ({
        execute: (request) =>
          Promise.resolve({
            status: "completed",
            value: 1,
            seeds: request.seeds ?? { now: 1, random: 2 },
            journal: [...(request.journal ?? [])],
          }),
      }),
    },
    {
      label: "failed settle faulted",
      code: `throw new TypeError("boom");`,
      sandbox: (): Sandbox => ({
        execute: (request) =>
          Promise.resolve({
            status: "failed",
            error: { name: "TypeError", message: "boom" },
            seeds: request.seeds ?? { now: 1, random: 2 },
            journal: [...(request.journal ?? [])],
          }),
      }),
    },
  ])("INVARIANT M4: a stored failed row always explains itself — fallback carries ConduitPersistError ($label)", async ({
    code,
    sandbox,
  }) => {
    const store = await makeBareStore();
    // Fault the SECOND put (index 1): the first (index 0) is `start`'s
    // initial `running` row; the second is the settle write under test.
    const faultyStore = withPutFaultAt(store, 1);
    const deps = makeStubDeps(faultyStore, sandbox(), { newId: () => "settle_fault" });
    const manager = createExecutionManager(deps);

    await expect(manager.start(code)).rejects.toThrow(
      "[test] simulated executions.put fault on the settle write",
    );
    // Not swallowed: the fault surfaces to the caller. But the fallback
    // write in persistOrFinalizeFailed still lands the row terminal.
    const row = await store.executions.get("exec_settle_fault");
    expect(row?.status).toBe("failed");
    expect(row?.error?.name).toBe("ConduitPersistError");
  });

  it("INVARIANT M4: paused persistence faulted — fallback carries ConduitPersistError", async () => {
    const h = await makeHarness();
    active = h;
    // Fault the SECOND put (index 1): the first (index 0) is `start`'s
    // initial `running` row; the second is the `paused` write in drive().
    const faultyStore = withPutFaultAt(h.store, 1);
    // Deterministic id so the row can be recovered after `start` rejects.
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      store: faultyStore,
      newId: () => "paused_fault",
    };
    const manager = createExecutionManager(deps);

    await expect(
      manager.start(`return await tools.github.create_issue({ title: "from agent" });`),
    ).rejects.toThrow("[test] simulated executions.put fault on the settle write");

    const row = await h.store.executions.get("exec_paused_fault");
    expect(row?.status).toBe("failed");
    expect(row?.error?.name).toBe("ConduitPersistError");
  });

  it("INVARIANT M4: expired persistence faulted — fallback carries ConduitPersistError", async () => {
    const h = await makeHarness();
    active = h;
    let clock = 1_000_000;
    const deps: ExecutionManagerDeps = { ...h.deps, now: () => clock };
    const manager = createExecutionManager(deps);

    const paused = await manager.start(
      `return await tools.github.create_issue({ title: "stale" });`,
    );
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") {
      return;
    }
    clock = paused.pending.expiresAt + 1;

    // Fault the settle write on RESUME: resume's expiry branch does exactly
    // one `executions.put` before reaching persistOrFinalizeFailed's fallback.
    const faultyStore = withPutFaultAt(h.store, 0);
    const resumeDeps: ExecutionManagerDeps = { ...deps, store: faultyStore };
    const resumeManager = createExecutionManager(resumeDeps);

    await expect(
      resumeManager.resume(
        paused.executionId,
        { kind: "approve" },
        await pendingCallOf(resumeManager, paused.executionId),
      ),
    ).rejects.toThrow("[test] simulated executions.put fault on the settle write");
    const row = await h.store.executions.get(paused.executionId);
    expect(row?.status).toBe("failed");
    expect(row?.error?.name).toBe("ConduitPersistError");
  });

  it("expired rows carry neither result nor error", async () => {
    const h = await makeHarness();
    active = h;
    let clock = 1_000_000;
    const deps: ExecutionManagerDeps = { ...h.deps, now: () => clock };
    const manager = createExecutionManager(deps);

    const paused = await manager.start(
      `return await tools.github.create_issue({ title: "stale" });`,
    );
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") {
      return;
    }
    clock = paused.pending.expiresAt + 1;
    await manager.resume(
      paused.executionId,
      { kind: "approve" },
      await pendingCallOf(manager, paused.executionId),
    );
    const row = await h.store.executions.get(paused.executionId);
    expect(row?.status).toBe("expired");
    expect(row?.result).toBeUndefined();
    expect(row?.error).toBeUndefined();
  });
});

describe("requestKey (mcp design M1)", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
  });

  it("persists the key BEFORE the sandbox runs", async () => {
    const store = await makeBareStore();
    const throwingSandbox: Sandbox = {
      execute: () => Promise.reject(new Error("sandbox threw synchronously")),
    };
    const manager = createExecutionManager(makeStubDeps(store, throwingSandbox));

    await expect(manager.start("x", { requestKey: "k1" })).rejects.toThrow();
    expect(await store.executions.getByRequestKey("k1")).toBeDefined();
  });

  it("duplicate key → conflict with the existing execution's id, no second run", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    const first = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "site" });`,
      { requestKey: "k2" },
    );
    expect(first.status).toBe("completed");
    const second = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "other" });`,
      { requestKey: "k2" },
    );
    expect(second).toEqual({ status: "conflict", executionId: first.executionId });
    // The second start never drove a sandbox run: exactly one upstream call.
    expect(h.calls).toHaveLength(1);
  });
});

describe("§16 wall-clock budget is wired into the invoker (finding F1, gate two)", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
    for (const c of bareClients.splice(0)) {
      c.close();
    }
  });

  /** A stub sandbox that settles `completed` without performing any tool call. */
  const completingSandbox: Sandbox = {
    execute: (request) =>
      Promise.resolve({
        status: "completed",
        value: null,
        seeds: request.seeds ?? { now: 0, random: 1 },
        journal: [...(request.journal ?? [])],
      }),
  };

  it("INVARIANT §16: the manager supplies makeInvoker a deadline reflecting the wall-clock budget", async () => {
    const store = await makeBareStore();
    let clock = 1_000;
    const captured: Array<() => number> = [];
    const deps: ExecutionManagerDeps = {
      store,
      sandbox: completingSandbox,
      makeInvoker: ({ deadline }) => {
        // The F1 fix: production wiring must SUPPLY a deadline (it previously
        // passed only { executionId, log }, leaving remaining = Infinity so the
        // §16 budget never clamped per-call timeouts).
        if (deadline === undefined) {
          throw new Error("makeInvoker received no deadline — F1 regression");
        }
        captured.push(deadline);
        return () => Promise.resolve(null);
      },
      // The stub sandbox settles `completed` with zero tool calls, so the host
      // is never invoked — a never-resolving stub keeps that explicit.
      makeToolHost: () => ({
        search: () => Promise.reject(new Error("host must not be called")),
        describe: () => Promise.reject(new Error("host must not be called")),
        call: () => Promise.reject(new Error("host must not be called")),
      }),
      makeDecisions: () => createInMemoryApprovalDecisions(),
      now: () => clock,
    };
    const manager = createExecutionManager(deps);
    await manager.start("return 1;", { limits: { wallClockMs: 60_000 } });

    expect(captured).toHaveLength(1);
    const deadline = captured[0];
    if (deadline === undefined) {
      throw new Error("no deadline captured");
    }
    // Captured at start-time `clock`; the full budget remains.
    expect(deadline()).toBe(60_000);
    // As the injected clock advances, the remaining budget shrinks — and goes
    // non-positive past the window, which is exactly what makes the invoker's
    // `remaining <= 0` refusal live in production.
    clock += 45_000;
    expect(deadline()).toBe(15_000);
    clock += 20_000;
    expect(deadline()).toBeLessThanOrEqual(0);
  });

  it("INVARIANT §16: a small wall-clock budget actually CLAMPS the upstream call timeout (end-to-end)", async () => {
    // The real invoker + real upstream: a 2s wall-clock budget must shrink the
    // per-call timeout well below the 30s default ceiling (proving the manager's
    // deadline reaches min(ceiling, remaining) — not merely that a callback was
    // supplied).
    const timeouts: number[] = [];
    const h = await makeHarness({ recordTimeout: (ms) => timeouts.push(ms) });
    active = h;
    const manager = createExecutionManager(h.deps);
    const result = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "site" });`,
      { limits: { wallClockMs: 2_000 } },
    );
    expect(result.status).toBe("completed");
    expect(timeouts).toHaveLength(1);
    // Clamped to the remaining budget (≤ 2000ms), strictly below the 30s ceiling.
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(2_000);
  });
});

describe("§18-C4 the manager owns a per-drive upstream session scope", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
    for (const c of bareClients.splice(0)) {
      c.close();
    }
  });

  /**
   * A recording fake `UpstreamSessionScope`: never touches a real MCP session,
   * just proves creation/disposal timing. `acquire` is never called by these
   * tests — they drive the REAL pipeline, so what's under test is the manager's
   * own create/dispose wrapping around `drive()`, independent of whether
   * `upstream.ts` ever calls `acquire`. (`acquire` here rejects to prove it is
   * not exercised on these paths.)
   */
  function makeRecordingUpstreamSession(
    log: (event: "created" | "disposed") => void,
    opts?: { throwOnDispose?: boolean },
  ): () => UpstreamSessionScope {
    return () => {
      log("created");
      let disposed = false;
      return {
        acquire: () => Promise.reject(new Error("acquire must not be called by these tests")),
        async dispose() {
          if (disposed) return;
          disposed = true;
          log("disposed");
          if (opts?.throwOnDispose) {
            throw new Error("[test] simulated dispose failure");
          }
        },
      };
    };
  }

  it("INVARIANT §18-C4: the manager disposes the upstream session scope on every drive exit — success, failure, AND pause", async () => {
    const events: Array<"created" | "disposed"> = [];
    const h = await makeHarness();
    active = h;
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeUpstreamSession: makeRecordingUpstreamSession((e) => events.push(e)),
    };
    const manager = createExecutionManager(deps);

    // 1. A completing execution (safe read only).
    const completed = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "site" });`,
    );
    expect(completed.status).toBe("completed");

    // 2. A failing execution — a plain uncaught guest error (a policy block
    //    would be guest-catchable, so we use a genuinely uncaught throw here)
    //    so the sandbox itself settles the drive `failed`.
    const failed = await manager.start(`throw new Error("boom");`);
    expect(failed.status).toBe("failed");

    // 3. An execution that pauses on a require_approval call.
    const paused = await manager.start(
      `return await tools.github.create_issue({ title: "from agent" });`,
    );
    expect(paused.status).toBe("paused");

    expect(events.filter((e) => e === "created")).toHaveLength(3);
    expect(events.filter((e) => e === "disposed")).toHaveLength(3);
  });

  it("INVARIANT §18-C4: a resumed drive gets a FRESH scope", async () => {
    const events: Array<"created" | "disposed"> = [];
    const h = await makeHarness();
    active = h;
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeUpstreamSession: makeRecordingUpstreamSession((e) => events.push(e)),
    };
    const manager = createExecutionManager(deps);

    const first = await manager.start(
      `return await tools.github.create_issue({ title: "from agent" });`,
    );
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    expect(events).toEqual(["created", "disposed"]);

    const resumed = await manager.resume(
      first.executionId,
      { kind: "approve" },
      await pendingCallOf(manager, first.executionId),
    );
    expect(resumed.status).toBe("completed");

    // A SECOND scope was created for the resume — not a reuse of the first —
    // and it too was disposed.
    expect(events).toEqual(["created", "disposed", "created", "disposed"]);
  });

  it("INVARIANT §18-C4: a throwing makeUpstreamSession at start() terminalizes the row failed, never stranded running", async () => {
    const h = await makeHarness();
    active = h;
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeUpstreamSession: () => {
        throw new Error("[test] scope factory blew up (e.g. randomBytes failure)");
      },
    };
    const manager = createExecutionManager(deps);

    const result = await manager
      .start(`return 1;`, { requestKey: "rk-scope-throw" })
      .then((r) => ({ kind: "resolved" as const, r }))
      .catch((e) => ({ kind: "threw" as const, e }));
    // Whether it rejects or resolves-failed, the persisted row MUST be terminal.
    const row = await h.store.executions.getByRequestKey("rk-scope-throw");
    expect(row).toBeDefined();
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).toBeDefined();
    if (result.kind === "resolved") {
      expect(result.r.status).toBe("failed");
    }
  });

  it("INVARIANT §6: a synchronously-throwing makeInvoker at start() terminalizes the row failed, never stranded running", async () => {
    const h = await makeHarness();
    active = h;
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeInvoker: () => {
        throw new Error("[test] makeInvoker blew up synchronously");
      },
    };
    const manager = createExecutionManager(deps);

    const result = await manager
      .start(`return 1;`, { requestKey: "rk-invoker-throw" })
      .then((r) => ({ kind: "resolved" as const, r }))
      .catch((e) => ({ kind: "threw" as const, e }));
    // The window from the running-state persist until drive() takes over must
    // terminalize on ANY throw (§6: running must reach a terminal). A stranded
    // `running` row is un-resumable forever.
    const row = await h.store.executions.getByRequestKey("rk-invoker-throw");
    expect(row).toBeDefined();
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).toBeDefined();
    if (result.kind === "resolved") {
      expect(result.r.status).toBe("failed");
    }
  });

  it("INVARIANT §6: a throwing makeUpstreamSession on the RESUME path terminalizes, never stranded running (F-5 twin)", async () => {
    const h = await makeHarness();
    active = h;
    // First: a normal start that pauses, using the default scope factory.
    const manager0 = createExecutionManager(h.deps);
    const first = await manager0.start(
      `return await tools.github.create_issue({ title: "from agent" });`,
    );
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    // Now resume with a manager whose scope factory throws.
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeUpstreamSession: () => {
        throw new Error("[test] resume-path scope factory blew up");
      },
    };
    const manager = createExecutionManager(deps);
    const resumed = await manager
      .resume(
        first.executionId,
        { kind: "approve" },
        await pendingCallOf(manager, first.executionId),
      )
      .then((r) => ({ kind: "resolved" as const, r }))
      .catch((e) => ({ kind: "threw" as const, e }));
    const row = await h.store.executions.get(first.executionId);
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).toBeDefined();
    if (resumed.kind === "resolved") {
      expect(resumed.r.status).toBe("failed");
    }
  });

  it("a throwing dispose does not change the drive outcome", async () => {
    const events: Array<"created" | "disposed"> = [];
    const h = await makeHarness();
    active = h;
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeUpstreamSession: makeRecordingUpstreamSession((e) => events.push(e), {
        throwOnDispose: true,
      }),
    };
    const manager = createExecutionManager(deps);

    const result = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "site" });`,
    );
    // The execution still reports its own (successful) outcome — the
    // dispose failure is swallowed (routed to the diagnostics sink) rather
    // than surfacing as a rejection or flipping the outcome to failed.
    expect(result.status).toBe("completed");
    expect(events).toEqual(["created", "disposed"]);
  });
});

describe("§5.5 resume outcome carries decisionApplied — host-side decision-consumption truth", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
    for (const c of bareClients.splice(0)) {
      c.close();
    }
  });

  /** Start the standard pause-on-create_issue run and return its id. */
  async function pauseOnCreateIssue(
    manager: ReturnType<typeof createExecutionManager>,
    code?: string,
  ): Promise<string> {
    const first = await manager.start(
      code ??
        `
      const created = await tools.github.create_issue({ title: "from agent" });
      return created;
    `,
    );
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      throw new Error(`expected paused, got ${first.status}`);
    }
    return first.executionId;
  }

  it("INVARIANT §5.5: an applied approve reports decisionApplied:true", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);
    const id = await pauseOnCreateIssue(manager);

    const outcome = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("completed");
    expect(outcome.decisionApplied).toBe(true);
  });

  it("INVARIANT §5.5: an applied deny reports decisionApplied:true even when the guest catches it and the drive COMPLETES", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);
    const id = await pauseOnCreateIssue(
      manager,
      `
      try {
        await tools.github.create_issue({ title: "nope" });
        return { blocked: false };
      } catch (error) {
        return { blocked: true, name: error.name };
      }
    `,
    );

    const outcome = await manager.resume(id, { kind: "deny" }, await pendingCallOf(manager, id));
    // The drive's own outcome is completed (guest handled the denial) — but the
    // deny itself LANDED, and the outcome says so independently of drive status.
    expect(outcome.status).toBe("completed");
    expect(outcome.decisionApplied).toBe(true);
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(0);
  });

  it("INVARIANT §5.5: an applied deny reports decisionApplied:true when the guest does NOT catch (drive fails ConduitPolicyBlocked)", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);
    const id = await pauseOnCreateIssue(manager);

    const outcome = await manager.resume(id, { kind: "deny" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitPolicyBlocked");
    }
    expect(outcome.decisionApplied).toBe(true);
  });

  it("a conflict (lost resume race) reports decisionApplied:false", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);
    const id = await pauseOnCreateIssue(manager);

    // Read the id ONCE and launch both resumes from the same tick: an
    // `await` inside the array literal would start the first resume before
    // the second even began, weakening the interleaving F4 is about.
    const callId = await pendingCallOf(manager, id);
    const [a, b] = await Promise.all([
      manager.resume(id, { kind: "approve" }, callId),
      manager.resume(id, { kind: "approve" }, callId),
    ]);
    const loser = a.status === "conflict" ? a : b;
    expect(loser.status).toBe("conflict");
    expect(loser.decisionApplied).toBe(false);
  });

  it("an expired resume reports decisionApplied:false — expiry short-circuits before the decision can apply", async () => {
    const h = await makeHarness();
    active = h;
    let clock = 1_000_000;
    const manager = createExecutionManager({ ...h.deps, now: () => clock });
    const first = await manager.start(`
      const created = await tools.github.create_issue({ title: "stale" });
      return created;
    `);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    clock = first.pending.expiresAt + 1;
    const outcome = await manager.resume(
      first.executionId,
      { kind: "deny" },
      await pendingCallOf(manager, first.executionId),
    );
    expect(outcome.status).toBe("expired");
    expect(outcome.decisionApplied).toBe(false);
  });

  it("a replay-divergence reports decisionApplied:false — a discarded decision was never applied (F2)", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);
    const id = await pauseOnCreateIssue(
      manager,
      `
      const r = await tools.github.delete_repo({ repo: "prod" });
      return r;
    `,
    );
    // Corrupt pausedOn to a different identity so the resume diverges (the
    // same confused-deputy setup as the F2 invariant test above).
    const persisted = await manager.get(id);
    if (persisted?.pausedOn === undefined) {
      throw new Error("expected a persisted pausedOn to corrupt");
    }
    await h.store.executions.put({
      ...persisted,
      pausedOn: { ...persisted.pausedOn, toolName: "github.create_issue", input: { title: "x" } },
    });

    const outcome = await manager.resume(id, { kind: "deny" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitReplayDivergence");
    }
    expect(outcome.decisionApplied).toBe(false);
  });

  it("INVARIANT §5.5: a guest-spoofed ConduitPolicyBlocked failure does NOT read as an applied decision", async () => {
    // The name-proxy hole this field closes: a drive can fail with an error
    // NAMED ConduitPolicyBlocked while the staged decision was never consumed.
    // decisionApplied keys on the decisions seam's consumption state — not the
    // (guest-forgeable) error name — so it stays false here.
    const store = await makeBareStore();
    const spoofingSandbox: Sandbox = {
      execute: async () => ({
        status: "failed",
        error: { name: "ConduitPolicyBlocked", message: "guest-spoofed name, no call made" },
        seeds: generateSeeds(),
        journal: [],
      }),
    };
    const paused: Execution = {
      id: "exec_spoof",
      code: "irrelevant (stub sandbox)",
      status: "paused",
      seeds: generateSeeds(),
      startedAt: Date.now(),
      pausedOn: {
        callId: "call_spoof",
        toolName: "github.create_issue",
        input: { title: "x" },
        reason: "requires approval",
        expiresAt: Date.now() + 60_000,
      },
    };
    await store.executions.put(paused);

    const manager = createExecutionManager(makeStubDeps(store, spoofingSandbox));
    const outcome = await manager.resume("exec_spoof", { kind: "deny" }, "call_spoof");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitPolicyBlocked");
    }
    expect(outcome.decisionApplied).toBe(false);
  });
});
