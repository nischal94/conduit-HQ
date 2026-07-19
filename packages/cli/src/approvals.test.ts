import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalRuntime } from "@conduithq/mcp";
import type { ConduitStore, ResumeOutcome } from "@conduithq/sdk";
import { normalizeMcp, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalsDeps } from "./commands/approvals.js";
import { runDecide, runList } from "./commands/approvals.js";

/**
 * Unit suite for `conduit approvals`. `list` is driven against a real store
 * (mirrors sqlite.test.ts's listPaused fixture) with a fake clock so the
 * expiry label is deterministic. `approve`/`deny` are driven against a REAL
 * `createApprovalRuntime` manager over a real loopback MCP stub — mirrors
 * runtime.test.ts's fixture — including a genuine double-approve `conflict`
 * and the chained re-pause; outcome branches are ALSO pinned in isolation
 * via an injected runtime double, mirroring add-mcp.test.ts's DI style.
 */

const PREFIX = "github.acme.prod";
const mcpToolsList = [
  {
    name: "delete_repo",
    description: "Permanently delete a repository",
    inputSchema: { type: "object", properties: { repo: { type: "string" } } },
    annotations: { destructiveHint: true },
  },
];

interface UpstreamCall {
  name: string;
}

const NEGOTIATED_VERSION = "2025-06-18";
const SESSION_ID = "sess-cli-approvals-1";

/**
 * Streamable-HTTP MCP fixture (mirrors Task 6's `createStreamableFixture`
 * helper in sdk/pipeline/upstream.test.ts — copied local since test files
 * don't share exports across packages). Owns the handshake bookkeeping —
 * replies to `initialize` and `notifications/initialized`, acks DELETE —
 * and only records + answers the `tools/call` request.
 */
function startMcpServer(): Promise<{ server: Server; port: number; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const payload = JSON.parse(body || "{}") as {
        id?: string;
        method?: string;
        params?: { name: string };
      };
      if (payload.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": SESSION_ID,
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: NEGOTIATED_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "0" },
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
      if (req.method === "DELETE") {
        res.writeHead(200);
        res.end();
        return;
      }
      const params = payload.params as { name: string };
      calls.push({ name: params.name });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { ok: true, tool: params.name },
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

async function openTestStore(
  dbPath: string,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<ConduitStore> {
  const client = createClient({ url: `file:${dbPath}` });
  return openSqliteStore({ client, secretBox: await SecretBox.fromKeyBytes(keyBytes) });
}

function makeDeps(
  overrides: Partial<ApprovalsDeps> & { store: ConduitStore; allowPrivateEgress?: boolean },
): ApprovalsDeps & {
  stdoutLines: string[];
  stderrLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const { store, allowPrivateEgress, ...rest } = overrides;
  return {
    openStore: async () => ({
      env: {
        dbPath: "",
        keyBytes: new Uint8Array(32) as Uint8Array<ArrayBuffer>,
        keySource: "env",
        allowPrivateEgress: allowPrivateEgress ?? false,
      },
      store,
    }),
    createRuntime: async () => {
      throw new Error("createRuntime not stubbed for this test");
    },
    env: {},
    now: () => Date.now(),
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    stdoutLines,
    stderrLines,
    ...rest,
  };
}

describe("conduit approvals list", () => {
  let scratch: string;

  afterEach(() => {
    if (scratch !== "") {
      rmSync(scratch, { recursive: true, force: true });
      scratch = "";
    }
  });

  async function seedPaused(): Promise<ConduitStore> {
    scratch = mkdtempSync(join(tmpdir(), "conduit-cli-approvals-"));
    const store = await openTestStore(join(scratch, "test.db"), SecretBox.generateKeyBytes());
    const base = { code: "x", seeds: { now: 1, random: 1 }, startedAt: 0 } as const;
    await store.executions.put({
      ...base,
      id: "exec_old",
      status: "paused",
      startedAt: 1_000,
      pausedOn: {
        callId: "c1",
        toolName: "github.delete_repo",
        input: { repo: "a" },
        reason: "requires approval",
        expiresAt: 5_000, // will be EXPIRED relative to now=10_000
      },
    });
    await store.executions.put({
      ...base,
      id: "exec_new",
      status: "paused",
      startedAt: 2_000,
      pausedOn: {
        callId: "c2",
        toolName: "github.create_issue",
        input: { title: "t" },
        reason: "requires approval",
        expiresAt: 999_999_999_999, // far future — live row
      },
    });
    await store.executions.put({
      ...base,
      id: "exec_done",
      status: "completed",
      startedAt: 500,
    });
    return store;
  }

  it("INVARIANT /cli approvals: list renders paused rows oldest-first, with EXPIRED and time-remaining labels, and performs no write", async () => {
    const store = await seedPaused();
    const deps = makeDeps({ store, now: () => 10_000 });

    const result = await runList({ json: false }, deps);
    expect(result.exitCode).toBe(0);

    const output = deps.stdoutLines.join("");
    const oldIdx = output.indexOf("exec_old");
    const newIdx = output.indexOf("exec_new");
    expect(oldIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeGreaterThan(oldIdx);
    expect(output).toMatch(/exec_old.*EXPIRED \(finalizes on next resume\)/s);
    expect(output).toMatch(/exec_new.*remaining/s);
    expect(output).not.toContain("exec_done");

    // NO WRITE: the expired row is still status:"paused" in storage.
    const row = await store.executions.get("exec_old");
    expect(row?.status).toBe("paused");
    expect(row?.pausedOn?.expiresAt).toBe(5_000);
  });

  it("--json emits the machine shape", async () => {
    const store = await seedPaused();
    const deps = makeDeps({ store, now: () => 10_000 });

    await runList({ json: true }, deps);
    const parsed = JSON.parse(deps.stdoutLines.join("")) as Array<{
      executionId: string;
      tool: string;
      waitingSince: number;
      expiresAt: number;
      expired: boolean;
    }>;
    expect(parsed).toEqual([
      {
        executionId: "exec_old",
        tool: "github.delete_repo",
        waitingSince: 1_000,
        expiresAt: 5_000,
        expired: true,
      },
      {
        executionId: "exec_new",
        tool: "github.create_issue",
        waitingSince: 2_000,
        expiresAt: 999_999_999_999,
        expired: false,
      },
    ]);
  });

  it("no paused executions renders a friendly empty message", async () => {
    scratch = mkdtempSync(join(tmpdir(), "conduit-cli-approvals-empty-"));
    const store = await openTestStore(join(scratch, "test.db"), SecretBox.generateKeyBytes());
    const deps = makeDeps({ store });
    const result = await runList({ json: false }, deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toMatch(/no paused executions/i);
  });
});

describe("conduit approvals approve|deny — real runtime", () => {
  let scratch: string;
  let upstream: { server: Server; port: number; calls: UpstreamCall[] };
  let store: ConduitStore;

  afterEach(async () => {
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    if (scratch !== "") {
      rmSync(scratch, { recursive: true, force: true });
      scratch = "";
    }
  });

  async function setup(): Promise<void> {
    scratch = mkdtempSync(join(tmpdir(), "conduit-cli-approvals-live-"));
    upstream = await startMcpServer();
    store = await openTestStore(join(scratch, "test.db"), SecretBox.generateKeyBytes());
    const location = `http://127.0.0.1:${upstream.port}/mcp`;
    const tools = normalizeMcp({ namespace: "github", tools: mcpToolsList });
    await store.sources.upsert({ id: "src_gh", type: "mcp", namespace: "github", location });
    await store.integrations.upsert({ id: "int_gh", sourceId: "src_gh", namespace: "github" });
    await store.connections.upsert({
      id: "conn_gh",
      integrationId: "int_gh",
      prefix: PREFIX,
      credentialRef: "cred_gh",
    });
    await store.secrets.put("cred_gh", "Bearer secret_do_not_leak");
    await store.tools.replaceNamespace("github", tools);
  }

  async function pauseOne(): Promise<string> {
    const runtime = await createApprovalRuntime({ store, allowPrivateEgress: true });
    const outcome = await runtime.manager.start(
      'return await tools.github.delete_repo({ repo: "site" });',
    );
    if (outcome.status !== "paused") {
      throw new Error(`expected paused, got ${outcome.status}`);
    }
    return outcome.executionId;
  }

  it("approve maps to manager.resume({kind:'approve'}) and prints 'completed'", async () => {
    await setup();
    const executionId = await pauseOne();
    const deps = makeDeps({
      store,
      allowPrivateEgress: true,
      createRuntime: (opts) => createApprovalRuntime(opts),
    });

    const result = await runDecide("approve", executionId, deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("completed\n");
    expect(upstream.calls.map((c) => c.name)).toEqual(["delete_repo"]);

    const row = await store.executions.get(executionId);
    expect(row?.status).toBe("completed");
  });

  it("INVARIANT /cli deny-verb-truth: a REAL applied deny prints 'denied' and exits 0 — the operator's verb succeeded, no tool call", async () => {
    await setup();
    const executionId = await pauseOne();
    const deps = makeDeps({
      store,
      allowPrivateEgress: true,
      createRuntime: (opts) => createApprovalRuntime(opts),
    });

    const result = await runDecide("deny", executionId, deps);
    // The deny APPLIED (host-side decision consumption — decisionApplied), so
    // the CLI reports the operator's verb as a success, whatever the drive
    // then did (here: the guest has no try/catch, so the drive itself failed
    // with the guest-visible ConduitPolicyBlocked).
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("denied\n");
    expect(deps.stderrLines.join("")).toMatch(/deny was applied/i);
    expect(upstream.calls).toHaveLength(0);

    const row = await store.executions.get(executionId);
    expect(row?.status).toBe("failed");
  });

  it("re-pause: approving the first of two require_approval calls surfaces the NEW pending approval and the execution is back in listPaused", async () => {
    await setup();
    // TWO sequential review-class calls (sdk manager.test.ts design D3
    // precedent): approving #1 resumes into #2, which pauses again with a
    // fresh persisted pausedOn.
    const runtime = await createApprovalRuntime({ store, allowPrivateEgress: true });
    const first = await runtime.manager.start(`
      const one = await tools.github.delete_repo({ repo: "one" });
      const two = await tools.github.delete_repo({ repo: "two" });
      return { one, two };
    `);
    if (first.status !== "paused") {
      throw new Error(`expected paused, got ${first.status}`);
    }
    const executionId = first.executionId;

    const deps = makeDeps({
      store,
      allowPrivateEgress: true,
      createRuntime: (opts) => createApprovalRuntime(opts),
    });
    const result = await runDecide("approve", executionId, deps);

    // Not an error: the first call ran, the run paused again on the second.
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("paused\n");
    expect(deps.stderrLines.join("")).toMatch(/paused again on a new approval/i);
    expect(deps.stderrLines.join("")).toMatch(/github\.delete_repo/);
    expect(deps.stderrLines.join("")).toMatch(/conduit approvals list/);

    // Only the APPROVED first call reached upstream; the new pending did not.
    expect(upstream.calls.map((c) => c.name)).toEqual(["delete_repo"]);

    // The execution is back in the queue with the fresh pausedOn persisted.
    const queued = await store.executions.listPaused();
    expect(queued.map((e) => e.id)).toContain(executionId);
    const row = await store.executions.get(executionId);
    expect(row?.status).toBe("paused");
    expect(row?.pausedOn?.input).toEqual({ repo: "two" });
  });

  it("conflict for REAL: a second approve of an already-completed execution exits non-zero with the conflict message", async () => {
    await setup();
    const executionId = await pauseOne();
    const deps = makeDeps({
      store,
      allowPrivateEgress: true,
      createRuntime: (opts) => createApprovalRuntime(opts),
    });

    const first = await runDecide("approve", executionId, deps);
    expect(first.exitCode).toBe(0);

    // Second approve of the same id: claimForResume finds no paused row →
    // a genuine conflict outcome through the real runtime path (sdk
    // manager.test.ts double-resume precedent).
    const second = await runDecide("approve", executionId, deps);
    expect(second.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("completed\nconflict\n");
    expect(deps.stderrLines.join("")).toMatch(/not in a resumable \(paused\) state/);

    // The approved tool call fired exactly once — the conflicted second
    // decision never re-executed it.
    expect(upstream.calls.map((c) => c.name)).toEqual(["delete_repo"]);
  });

  it("missing execution-id exits 1 without opening the store", async () => {
    await setup();
    const openStore = vi.fn();
    const deps = makeDeps({ store, openStore: openStore as ApprovalsDeps["openStore"] });
    const result = await runDecide("approve", undefined, deps);
    expect(result.exitCode).toBe(1);
    expect(openStore).not.toHaveBeenCalled();
    expect(deps.stderrLines.join("")).toMatch(/missing required <execution-id>/);
  });
});

describe("conduit approvals approve|deny — outcome mapping (injected runtime)", () => {
  function depsWithOutcome(outcome: ResumeOutcome, store: ConduitStore) {
    return makeDeps({
      store,
      createRuntime: async () => ({
        manager: { resume: async () => outcome },
      }),
    });
  }

  async function bareStore(): Promise<ConduitStore> {
    const scratch = mkdtempSync(join(tmpdir(), "conduit-cli-approvals-outcome-"));
    return openTestStore(join(scratch, "test.db"), SecretBox.generateKeyBytes());
  }

  it("expired outcome (from approve) prints the 'no tool call was made' line and exits 0", async () => {
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "expired",
      executionId: "exec_x",
      pending: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 1 },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("approve", "exec_x", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("expired\n");
    expect(deps.stderrLines.join("")).toMatch(
      /expired before the decision applied.*finalized as expired.*no tool call was made/is,
    );
  });

  it("expired outcome (from deny) ALSO prints the 'no tool call was made' line", async () => {
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "expired",
      executionId: "exec_y",
      pending: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 1 },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("deny", "exec_y", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stderrLines.join("")).toMatch(/no tool call was made/i);
  });

  it("conflict outcome exits non-zero", async () => {
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "conflict",
      executionId: "exec_z",
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("approve", "exec_z", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("conflict\n");
  });

  it("INVARIANT /cli deny-verb-truth: a deny that did NOT apply reports failure (exit 1), never 'denied'", async () => {
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "failed",
      executionId: "exec_w",
      error: { name: "SomeError", message: "boom" },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("deny", "exec_w", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("failed\n");
    expect(deps.stderrLines.join("")).toMatch(/SomeError: boom/);
  });

  it("INVARIANT /cli deny-verb-truth: an applied deny prints 'denied' and exits 0, keyed on decisionApplied — not the error name", async () => {
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "failed",
      executionId: "exec_denied",
      error: { name: "ConduitPolicyBlocked", message: "policy denied the execution" },
      decisionApplied: true,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("deny", "exec_denied", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("denied\n");
    // One informational drive-outcome line: the operator sees what the
    // execution did AFTER the deny landed.
    expect(deps.stderrLines.join("")).toMatch(/deny was applied.*failed/is);
  });

  it("INVARIANT /cli deny-verb-truth: a guest-spoofed ConduitPolicyBlocked failure is NOT reported as 'denied' when the deny never applied", async () => {
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "failed",
      executionId: "exec_spoof",
      error: { name: "ConduitPolicyBlocked", message: "guest-forged name" },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("deny", "exec_spoof", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("failed\n");
    expect(deps.stdoutLines.join("")).not.toContain("denied");
  });

  it("INVARIANT /cli deny-verb-truth: an applied deny is 'denied' (exit 0) even when the guest catches it and the drive COMPLETES", async () => {
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "completed",
      executionId: "exec_caught",
      value: { blocked: true },
      decisionApplied: true,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("deny", "exec_caught", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("denied\n");
    expect(deps.stderrLines.join("")).toMatch(/deny was applied.*completed/is);
  });

  it("INVARIANT /cli deny-verb-truth: an applied deny followed by a later unrelated upstream failure is still 'denied' (exit 0)", async () => {
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "failed",
      executionId: "exec_later_fail",
      error: { name: "NetworkError", message: "connection failed" },
      decisionApplied: true,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("deny", "exec_later_fail", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("denied\n");
    expect(deps.stderrLines.join("")).toMatch(/deny was applied.*failed.*NetworkError/is);
  });

  it("an applied deny that re-pauses on a NEW approval prints 'denied' plus the queue guidance", async () => {
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "paused",
      executionId: "exec_repause",
      pending: { callId: "c", toolName: "github.push", input: {}, reason: "review", expiresAt: 9 },
      decisionApplied: true,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("deny", "exec_repause", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("denied\n");
    expect(deps.stderrLines.join("")).toMatch(/paused again on a new approval/i);
    expect(deps.stderrLines.join("")).toMatch(/conduit approvals list/);
  });

  it("INVARIANT /cli deny-verb-truth: a deny that never applied while the drive COMPLETED exits 1 with an explanation — the verb did not land", async () => {
    // Only reachable when the resumed drive settles without ever re-reaching
    // the pending call (a divergence that never manifests as a call). The
    // denied call never ran — but the operator's deny did NOT apply either,
    // and exit codes track the verb.
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "completed",
      executionId: "exec_never_applied",
      value: { done: true },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("deny", "exec_never_applied", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("completed\n");
    expect(deps.stdoutLines.join("")).not.toContain("denied");
    expect(deps.stderrLines.join("")).toMatch(/deny was never applied/i);
  });

  it("INVARIANT /cli deny-verb-truth: an APPROVE that never applied while the drive COMPLETED also exits 1 — verb truth is symmetric", async () => {
    // The same divergence-that-never-manifested-as-a-call class as the deny
    // guard: reporting unqualified success for an approve that never landed
    // is the same false-positive the deny fix exists to kill.
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "completed",
      executionId: "exec_approve_never_applied",
      value: { done: true },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("approve", "exec_approve_never_applied", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("completed\n");
    expect(deps.stderrLines.join("")).toMatch(/approve was never applied/i);
  });

  it("approve with a failed outcome still exits non-zero regardless of error name (unchanged)", async () => {
    const store = await bareStore();
    const outcome: ResumeOutcome = {
      status: "failed",
      executionId: "exec_approve_blocked",
      error: { name: "ConduitPolicyBlocked", message: "policy denied the execution" },
      decisionApplied: true,
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("approve", "exec_approve_blocked", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("failed\n");
    expect(deps.stderrLines.join("")).toMatch(/ConduitPolicyBlocked: policy denied the execution/);
  });
});
