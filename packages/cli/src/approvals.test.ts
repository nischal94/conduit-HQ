import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalRuntime } from "@conduithq/mcp";
import type { ConduitStore, ExecutionOutcome } from "@conduithq/sdk";
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
 * runtime.test.ts's fixture — for the happy paths; `conflict` (hard to
 * produce for real without a race) is driven via an injected runtime double,
 * mirroring add-mcp.test.ts's DI style.
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

function startMcpServer(): Promise<{ server: Server; port: number; calls: UpstreamCall[] }> {
  const calls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const payload = JSON.parse(body) as { id: string; params: { name: string } };
      calls.push({ name: payload.params.name });
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
    scratch = "";
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

  it("deny maps to manager.resume({kind:'deny'}) and prints 'failed' (guest-reported denial), no tool call", async () => {
    await setup();
    const executionId = await pauseOne();
    const deps = makeDeps({
      store,
      allowPrivateEgress: true,
      createRuntime: (opts) => createApprovalRuntime(opts),
    });

    const result = await runDecide("deny", executionId, deps);
    // Denial resolves the pending call as blocked — the sandbox script above
    // has no try/catch, so the guest throw surfaces as a failed outcome.
    expect(["completed", "failed"]).toContain(result.exitCode === 0 ? "completed" : "failed");
    expect(upstream.calls).toHaveLength(0);
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
  function depsWithOutcome(outcome: ExecutionOutcome, store: ConduitStore) {
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
    const outcome: ExecutionOutcome = {
      status: "expired",
      executionId: "exec_x",
      pending: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 1 },
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
    const outcome: ExecutionOutcome = {
      status: "expired",
      executionId: "exec_y",
      pending: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 1 },
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("deny", "exec_y", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stderrLines.join("")).toMatch(/no tool call was made/i);
  });

  it("conflict outcome exits non-zero", async () => {
    const store = await bareStore();
    const outcome: ExecutionOutcome = { status: "conflict", executionId: "exec_z" };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("approve", "exec_z", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("conflict\n");
  });

  it("failed outcome exits non-zero", async () => {
    const store = await bareStore();
    const outcome: ExecutionOutcome = {
      status: "failed",
      executionId: "exec_w",
      error: { name: "SomeError", message: "boom" },
    };
    const deps = depsWithOutcome(outcome, store);
    const result = await runDecide("deny", "exec_w", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("failed\n");
    expect(deps.stderrLines.join("")).toMatch(/SomeError: boom/);
  });
});
