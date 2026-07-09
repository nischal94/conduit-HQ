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
import type { Sandbox } from "../sandbox/sandbox.js";
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

/**
 * Wrap a harness's manager deps so the manager's OWN store view has its
 * `replayJournal` marker maintenance (markAttempt / clearAttempt) fault-
 * injectable. Only the manager's `deps.store` is replaced — the invoker and
 * host still close over the real harness store — so this exercises exactly the
 * marker WRITE/CLEAR operations the journaling wrapper performs, without
 * disturbing upstream/loopback wiring (design D8/F5 marker maintenance).
 */
function withMarkerFaults(
  deps: ExecutionManagerDeps,
  faults: {
    markAttempt?: (executionId: string, ordinal: number) => void;
    clearAttempt?: (executionId: string, ordinal: number) => void;
  },
): ExecutionManagerDeps {
  const rj = deps.store.replayJournal;
  const wrappedStore: ConduitStore = {
    ...deps.store,
    replayJournal: {
      ...rj,
      markAttempt: async (executionId, ordinal) => {
        faults.markAttempt?.(executionId, ordinal);
        return rj.markAttempt(executionId, ordinal);
      },
      clearAttempt: async (executionId, ordinal) => {
        faults.clearAttempt?.(executionId, ordinal);
        return rj.clearAttempt(executionId, ordinal);
      },
    },
  };
  return { ...deps, store: wrappedStore };
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
    const outcome = await manager.resume(id, { kind: "approve" });
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

    const outcome = await manager.resume(id, { kind: "approve" });
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
    const outcome = await manager.resume(id, { kind: "approve" });
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
    const retry = await manager.resume(id, { kind: "approve" });
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
    const outcome = await manager.resume(id, { kind: "approve" });
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
    const retry = await manager.resume(id, { kind: "approve" });
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
    await expect(manager.resume(id, { kind: "approve" })).rejects.toThrow("corrupt replay state");
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
    const second = await manager.resume(id, { kind: "approve" });
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
    await expect(manager.resume(id, { kind: "approve" })).rejects.toThrow();
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
    const retry = await manager.resume(id, { kind: "approve" });
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
    await expect(manager.resume(id, { kind: "approve" })).rejects.toThrow(/not valid JSON/);

    // Invariant: terminal `failed`, NOT a stranded `running`. Read via the REAL
    // store (the wrapped get throws).
    const after = await store.executions.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.pausedOn).toBeUndefined();

    // Consequence: a later resume is a no-op conflict (no `paused` row to claim).
    const retry = await manager.resume(id, { kind: "approve" });
    expect(retry.status).toBe("conflict");
  });

  it("§5.5 (F5/I-5): a crash mid-call (attempt marker persisted, no outcome) → resume is terminal outcome-ambiguous, side effect NOT re-run", async () => {
    // (Fix 3) The crash window between an upstream side effect and its journal
    // append. Simulate the crash by seeding a paused row PLUS a lingering
    // attempt marker at an un-journaled ordinal that is NOT the pending call's
    // ordinal. On resume, the recovery check sees the stranded marker and fails
    // CLOSED — terminal `failed` (outcome-ambiguous), never re-running the side
    // effect (the sandbox is never even driven). v1 has no idempotency key, so
    // fail-closed is the correct default (design D8).
    //
    // NOTE (Fix Pass 3 / M1): the marker must NOT sit at the pending-call ordinal.
    // On a genuinely `paused` row the pending call's marker is the require_approval
    // PAUSE artifact (written before upstream, no side effect) and is now
    // deliberately excluded from the ambiguity check — resuming on it is correct.
    // The reachable true-crash this test pins is a marker at a DIFFERENT ordinal:
    // seed a durable prefix row at ordinal 0 (pending ordinal → 1) and strand the
    // crash marker at ordinal 2, above the pending call and absent from the journal.
    const store = await makeBareStore();
    const id = "exec_f5_crash";
    await store.executions.put({
      id,
      code: "return await tools.github.create_issue({ title: 'crashed' });",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn: {
        callId: "c1",
        toolName: "github.create_issue",
        input: { title: "crashed" },
        reason: "requires approval",
        expiresAt: Date.now() + 3_600_000,
      },
      startedAt: Date.now(),
    });
    // A durable prefix row at ordinal 0 → the pending call is ordinal 1.
    await store.replayJournal.append(id, {
      ordinal: 0,
      op: "call",
      request: JSON.stringify({ path: "github.list_issues", input: {} }),
      outcome: { ok: true, value: { ok: true } },
    });
    // A crash left an attempt marker at ordinal 2 (NOT the pending ordinal 1) with
    // no finalized outcome — a genuine unrecorded side effect that must fail closed.
    await store.replayJournal.markAttempt(id, 2);

    // A sandbox that must NEVER run — the recovery check fails closed before any
    // drive, so the side effect is never re-issued.
    let sandboxRuns = 0;
    const neverSandbox: Sandbox = {
      execute: () => {
        sandboxRuns += 1;
        return Promise.reject(new Error("sandbox must not run on an outcome-ambiguous recovery"));
      },
    };
    const manager = createExecutionManager(makeStubDeps(store, neverSandbox));

    const outcome = await manager.resume(id, { kind: "approve" });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitOutcomeAmbiguous");
    }
    // The side effect was NOT re-run: the sandbox was never driven.
    expect(sandboxRuns).toBe(0);

    // Terminal + non-resumable: the row is `failed`, pausedOn cleared, and a
    // later resume is a no-op conflict.
    const after = await store.executions.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.pausedOn).toBeUndefined();
    const retry = await manager.resume(id, { kind: "approve" });
    expect(retry.status).toBe("conflict");
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

    const outcome = await manager.resume(id, { kind: "approve" });
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
    const retry = await manager.resume(id, { kind: "approve" });
    expect(retry.status).toBe("conflict");
  });

  it("§5.5 (H1): a markAttempt WRITE fault on the approved call terminalizes `failed` (NOT a catchable guest error), side effect never fires", async () => {
    // (Fix Pass 2 / H1) The attempt-marker WRITE is host-side infrastructure.
    // If it throws BEFORE the side effect reaches upstream, it must NOT escape
    // into the sandbox as a normal (catchable) tool outcome — no journal row
    // was appended, so the guest would continue on a phantom failure. It must
    // terminalize the drive `failed` uncatchably instead.
    const h = await makeHarness();
    active = h;

    // The guest CATCHES any tool error and returns a sentinel. If the marker
    // fault leaked as a catchable error, the execution would COMPLETE with this
    // sentinel — the bug. Correct behavior: the guest can never catch it; the
    // execution is terminal `failed`.
    const code = `
      try {
        const created = await tools.github.create_issue({ title: "from agent" });
        return { caught: false, created };
      } catch (error) {
        return { caught: true, name: error.name };
      }
    `;
    // Pause on the require_approval call using the plain harness manager.
    const first = await createExecutionManager(h.deps).start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;
    // Resume with a deps view whose markAttempt WRITE faults — for the approved
    // (create_issue) call this fires BEFORE the side effect reaches upstream.
    const faultingDeps = withMarkerFaults(h.deps, {
      markAttempt: () => {
        throw new Error("[test] simulated markAttempt store fault");
      },
    });
    const outcome = await createExecutionManager(faultingDeps).resume(id, { kind: "approve" });

    // Terminal `failed` — NOT completed-with-sentinel (which would prove the
    // guest caught it).
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitOutcomeAmbiguous");
    }
    // The side effect NEVER fired (the write faulted before reaching upstream).
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(0);
    // No journal row was appended for the faulted attempt.
    const rows = await h.store.replayJournal.listByExecution(id);
    expect(rows.some((r) => JSON.parse(r.request).path === "github.create_issue")).toBe(false);
    // Persisted terminal + non-resumable.
    const settled = await h.store.executions.get(id);
    expect(settled?.status).toBe("failed");
    expect(settled?.pausedOn).toBeUndefined();
    const retry = await createExecutionManager(h.deps).resume(id, { kind: "approve" });
    expect(retry.status).toBe("conflict");
  });

  it("§5.5 (H2/pause): a clearAttempt fault on the require_approval branch still PAUSES uncatchably (guest cannot catch-and-continue)", async () => {
    // (Fix Pass 2 / H2) On the pause branch the captured signal is set BEFORE
    // clearAttempt, so a clearAttempt fault can never downgrade the pause into
    // a catchable guest error. The guest wraps the paused call in try/catch: if
    // the fault leaked, the guest would catch it and COMPLETE. Correct: the run
    // suspends and the manager returns `paused`.
    const h = await makeHarness();
    active = h;
    const faultingDeps = withMarkerFaults(h.deps, {
      clearAttempt: () => {
        throw new Error("[test] simulated clearAttempt store fault on pause branch");
      },
    });
    const code = `
      try {
        const created = await tools.github.create_issue({ title: "pause please" });
        return { paused: false, created };
      } catch (error) {
        return { paused: false, caught: error.name };
      }
    `;
    // start() drives to the require_approval pause; the clearAttempt on that
    // branch faults but must NOT surface as a catchable guest error.
    const outcome = await createExecutionManager(faultingDeps).start(code);
    expect(outcome.status).toBe("paused");
    if (outcome.status === "paused") {
      expect(outcome.pending.toolName).toBe("github.create_issue");
    }
    // The paused call never reached upstream.
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(0);
  });

  it("§5.5 (H2/divergence): a clearAttempt fault on the replay-divergence branch still terminalizes `failed` uncatchably", async () => {
    // (Fix Pass 2 / H2) On resume, if the first live call is NOT the approved
    // call, the wrapper captures divergence and terminalizes. The captured
    // signal is set BEFORE clearAttempt, so a clearAttempt fault cannot bypass
    // the terminal path and leak as a catchable guest error.
    const h = await makeHarness();
    active = h;
    const plain = createExecutionManager(h.deps);

    // The guest pauses on delete_repo (tool B) then wraps it in try/catch. On
    // resume we corrupt the persisted `pausedOn` to a DIFFERENT identity
    // (create_issue, tool A) — the confused-deputy setup — so the staged
    // decision does not match the first live call, forcing divergence.
    const code = `
      try {
        const r = await tools.github.delete_repo({ repo: "prod" });
        return { diverged: false, r };
      } catch (error) {
        return { diverged: false, caught: error.name };
      }
    `;
    const first = await plain.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;
    const persisted = await h.store.executions.get(id);
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
    const faultingDeps = withMarkerFaults(h.deps, {
      clearAttempt: () => {
        throw new Error("[test] simulated clearAttempt store fault on divergence branch");
      },
    });
    const outcome = await createExecutionManager(faultingDeps).resume(id, { kind: "approve" });
    // Terminal `failed` (divergence) — NOT completed-with-catch.
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitReplayDivergence");
    }
    const settled = await h.store.executions.get(id);
    expect(settled?.status).toBe("failed");
    expect(settled?.pausedOn).toBeUndefined();
  });

  it("§5.5 (M): a stale marker at an ordinal ALREADY in the journal is RESOLVED — resume proceeds; a marker at an UNRECORDED ordinal terminalizes", async () => {
    // (Fix Pass 2 / M) A crash BETWEEN appendBarrier and clearAttempt leaves a
    // stale marker AND a valid journal row at the same ordinal. That ordinal is
    // RESOLVED (outcome durable) — resume must NOT terminalize on it. Only a
    // marker whose ordinal is ABSENT from the journal is the true ambiguous
    // (attempted-but-unrecorded) case.
    const store = await makeBareStore();

    // --- Case A: stale marker at a JOURNALED ordinal → resume proceeds. ---
    const idResolved = "exec_m_resolved";
    await store.executions.put({
      id: idResolved,
      code: "return 1;",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn: {
        callId: "c1",
        toolName: "github.create_issue",
        input: { title: "x" },
        reason: "requires approval",
        expiresAt: Date.now() + 3_600_000,
      },
      startedAt: Date.now(),
    });
    // A durable journal row exists at ordinal 0 (the append succeeded)…
    await store.replayJournal.append(idResolved, {
      ordinal: 0,
      op: "call",
      request: JSON.stringify({ path: "github.create_issue", input: { title: "x" } }),
      outcome: { ok: true, value: { ok: true } },
    });
    // …but a crash left the marker at ordinal 0 uncleared.
    await store.replayJournal.markAttempt(idResolved, 0);

    // A sandbox that COMPLETES without performing any tool call — proving the
    // recovery check did NOT terminalize (it drove into the sandbox).
    const completingSandbox: Sandbox = {
      execute: (request) =>
        Promise.resolve({
          status: "completed",
          value: { resumed: true },
          seeds: request.seeds ?? { now: 1, random: 2 },
          journal: [...(request.journal ?? [])],
        }),
    };
    const resolvedOutcome = await createExecutionManager(
      makeStubDeps(store, completingSandbox),
    ).resume(idResolved, { kind: "approve" });
    // Resume PROCEEDED (drove the sandbox to completion), NOT terminalized.
    expect(resolvedOutcome.status).toBe("completed");
    // The resolved marker was tidied.
    expect(await store.replayJournal.listAttempts(idResolved)).toEqual([]);

    // --- Case B: stale marker at an UNRECORDED ordinal that is NOT the pending
    //     call's ordinal → terminal ambiguous. (Fix Pass 3 / M1: the pending
    //     call's own ordinal is the pause artifact and now resumes; a marker at
    //     any OTHER un-journaled ordinal is the reachable true-crash and still
    //     fails closed.) Seed a durable prefix row at ordinal 0 (pending ordinal
    //     → 1) and strand the crash marker at ordinal 2. ---
    const idUnrecorded = "exec_m_unrecorded";
    await store.executions.put({
      id: idUnrecorded,
      code: "return 1;",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn: {
        callId: "c1",
        toolName: "github.create_issue",
        input: { title: "y" },
        reason: "requires approval",
        expiresAt: Date.now() + 3_600_000,
      },
      startedAt: Date.now(),
    });
    // A durable prefix row at ordinal 0 → the pending call is ordinal 1.
    await store.replayJournal.append(idUnrecorded, {
      ordinal: 0,
      op: "call",
      request: JSON.stringify({ path: "github.list_issues", input: {} }),
      outcome: { ok: true, value: { ok: true } },
    });
    // Marker at ordinal 2 (NOT the pending ordinal 1) with NO journal row →
    // genuinely attempted-but-unrecorded, must fail closed.
    await store.replayJournal.markAttempt(idUnrecorded, 2);

    let sandboxRuns = 0;
    const neverSandbox: Sandbox = {
      execute: () => {
        sandboxRuns += 1;
        return Promise.reject(new Error("sandbox must not run on an outcome-ambiguous recovery"));
      },
    };
    const unrecordedOutcome = await createExecutionManager(
      makeStubDeps(store, neverSandbox),
    ).resume(idUnrecorded, { kind: "approve" });
    expect(unrecordedOutcome.status).toBe("failed");
    if (unrecordedOutcome.status === "failed") {
      expect(unrecordedOutcome.error.name).toBe("ConduitOutcomeAmbiguous");
    }
    expect(sandboxRuns).toBe(0);
  });

  it("§5.5 (M1): a stranded marker AT THE PENDING-CALL ordinal is the pause artifact — resume(approve) COMPLETES, not false outcome-ambiguous", async () => {
    // (Fix Pass 3 / M1) On a require_approval PAUSE the wrapper writes an attempt
    // marker at the pending call's ordinal BEFORE run(), then best-effort clears
    // it. If that clear FAULTS, a stale marker survives at the pending call's own
    // ordinal — which is (correctly) ABSENT from the journal, because the pause
    // happened BEFORE upstream, so NO side effect fired and nothing was journaled.
    // The prior recovery check treated any un-journaled marker as ambiguous and
    // terminalized the execution — a FALSE ambiguity: a policy pause before
    // upstream has no side effect to protect. The pending-call ordinal
    // (== prefix.length, the first un-journaled call) must be EXCLUDED from the
    // ambiguity check so the approval resumes normally.
    const h = await makeHarness();
    active = h;

    // A safe read (auto-allowed, journaled at ordinal 0) then a review-class
    // write (require_approval → pauses; its marker is written at ordinal 1).
    const code = `
      const before = await tools.github.list_issues({ owner: "acme", repo: "site" });
      const created = await tools.github.create_issue({ title: "from agent" });
      return { before, created };
    `;

    // START with a deps view whose clearAttempt WRITE faults. On the pause branch
    // the marker at the pending ordinal (1) is best-effort cleared — the fault is
    // swallowed, so the marker survives. The execution still PAUSES uncatchably.
    const faultingStart = withMarkerFaults(h.deps, {
      clearAttempt: () => {
        throw new Error("[test] simulated clearAttempt store fault on the pause branch");
      },
    });
    const first = await createExecutionManager(faultingStart).start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;
    expect(first.pending.toolName).toBe("github.create_issue");

    // The safe read is journaled at ordinal 0; the pending call did NOT reach
    // upstream, so it has NO journal row — its ordinal (1) is the pending ordinal.
    const rows = await h.store.replayJournal.listByExecution(id);
    expect(rows.map((r) => r.ordinal)).toEqual([0]);
    // The clearAttempt fault leaves BOTH markers stale: ordinal 0 (the safe read,
    // whose clear after append faulted — but it IS journaled, so RESOLVED) and
    // ordinal 1 (the pending call's own ordinal, absent from the journal — the
    // pause artifact M1 must not terminalize).
    expect(await h.store.replayJournal.listAttempts(id)).toEqual([0, 1]);
    expect(h.calls.map((c) => c.name)).toEqual(["list_issues"]);

    // RESUME(approve) with the PLAIN (non-faulting) manager. The pending-call
    // ordinal must be excluded from the ambiguity check, so the approved call
    // runs live exactly once and the execution COMPLETES — NOT terminalized
    // outcome-ambiguous. (Before the fix this returned failed/ConduitOutcomeAmbiguous.)
    const outcome = await createExecutionManager(h.deps).resume(id, { kind: "approve" });
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.value).toEqual({
        before: { ok: true, tool: "list_issues" },
        created: { ok: true, tool: "create_issue" },
      });
    }
    // EXACTLY ONCE: the approved create_issue reached upstream a single time.
    expect(h.calls.map((c) => c.name)).toEqual(["list_issues", "create_issue"]);
    const done = await h.store.executions.get(id);
    expect(done?.status).toBe("completed");
  });

  it("§5.5 (M1): a stranded marker at an ordinal that is NOT the pending call, absent from the journal, is STILL terminal outcome-ambiguous (F5 preserved)", async () => {
    // (Fix Pass 3 / M1) Only the pending call's OWN ordinal is newly excluded.
    // The pending call is the first un-journaled call, so its ordinal ==
    // prefix.length (the durable journal is the contiguous prefix 0..prefix.length-1,
    // enforced by toSandboxJournal). A marker at the pending ordinal is the pause
    // artifact (refused before upstream, no side effect) → safe to resume. A
    // marker at any OTHER un-journaled ordinal is a genuinely prior/other call
    // that crashed after its side effect but before its append — TRUE ambiguity
    // that must still fail closed. This pins the load-bearing F5/D8 guarantee and
    // proves the M1 exclusion is exactly one ordinal wide.
    const store = await makeBareStore();
    const id = "exec_m1_priorcrash";
    await store.executions.put({
      id,
      code: "return 1;",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn: {
        callId: "c1",
        toolName: "github.create_issue",
        input: { title: "y" },
        reason: "requires approval",
        expiresAt: Date.now() + 3_600_000,
      },
      startedAt: Date.now(),
    });
    // One durable prefix row → pending-call ordinal is 1 (the first un-journaled).
    await store.replayJournal.append(id, {
      ordinal: 0,
      op: "call",
      request: JSON.stringify({ path: "github.list_issues", input: {} }),
      outcome: { ok: true, value: { ok: true } },
    });
    // A stranded marker at ordinal 2 — NOT the pending-call ordinal (1), and
    // absent from the journal: a genuinely other call that crashed after its side
    // effect, NOT the pause artifact. Must still fail closed. (A marker at the
    // pending ordinal 1 would be the pause artifact — excluded; this ordinal 2 is
    // not, so the F5/D8 guarantee holds.)
    await store.replayJournal.markAttempt(id, 2);

    let sandboxRuns = 0;
    const neverSandbox: Sandbox = {
      execute: () => {
        sandboxRuns += 1;
        return Promise.reject(new Error("sandbox must not run on an outcome-ambiguous recovery"));
      },
    };
    const outcome = await createExecutionManager(makeStubDeps(store, neverSandbox)).resume(id, {
      kind: "approve",
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitOutcomeAmbiguous");
    }
    // The side effect was NOT re-run: the sandbox was never driven.
    expect(sandboxRuns).toBe(0);
    const after = await store.executions.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.pausedOn).toBeUndefined();
  });
});
