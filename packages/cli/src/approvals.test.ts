import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcRequest, RpcResponse } from "@conduithq/mcp";
import {
  createApprovalRuntime,
  DaemonUnavailable,
  pausedToListRow,
  resumeToPayload,
} from "@conduithq/mcp";
import type { ConduitStore, ResumeOutcome } from "@conduithq/sdk";
import { normalizeMcp, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalsDeps } from "./commands/approvals.js";
import { runDecide, runList } from "./commands/approvals.js";

/**
 * Unit suite for `conduit approvals`, driven through the DAEMON seam.
 *
 * Since Task 7 this command opens NO database: every read and every resume
 * is an `approvals`-capability RPC. The DI seam is now a single `daemon`
 * call, and the suite substitutes for it at two depths:
 *
 * - **Real-runtime fakes** — a fake daemon that answers `approvals.*` by
 *   driving a REAL `createApprovalRuntime` manager over a real loopback MCP
 *   stub (mirrors runtime.test.ts's fixture), including a genuine
 *   double-approve `conflict` and the chained re-pause. This is the same
 *   coverage the pre-conversion suite had, now with the daemon's own
 *   `resumeToPayload` projection in the path.
 * - **Payload doubles** — the outcome-mapping cases pin individual verb-truth
 *   branches in isolation, exactly as before.
 *
 * The daemon's TRANSPORT-level answers (`error`, `outcome-unknown`) get their
 * own block: those are shapes only the converted command can meet, and §5's
 * ambiguity must never be reported as a landed verb.
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

/** A `result` frame — the shape the daemon answers a served request with. */
function result(payload: unknown): RpcResponse {
  return { kind: "result", requestId: "req_1", payload };
}

/**
 * A fake daemon backed by a REAL store and (when asked) a REAL approval
 * runtime — the same work `connection.ts` does for the two `approvals.*`
 * kinds, including the `resumeToPayload` projection. Everything the command
 * sees is therefore a genuine wire-shaped answer, not a hand-written one.
 */
function realDaemon(opts: {
  store: ConduitStore;
  allowPrivateEgress?: boolean;
  live?: boolean;
}): (request: RpcRequest) => Promise<RpcResponse> {
  return async (request) => {
    if (request.kind === "approvals.list") {
      const paused = await opts.store.executions.listPaused();
      // The REAL daemon-side projection (`pausedToListRow`), not a
      // hand-written echo of it — so this fixture cannot drift into
      // asserting a wire shape the daemon no longer sends.
      return result(paused.map((execution) => pausedToListRow(execution)));
    }
    if (request.kind === "approvals.resume") {
      if (opts.live !== true) throw new Error("approvals.resume not stubbed for this test");
      const { manager } = await createApprovalRuntime({
        store: opts.store,
        allowPrivateEgress: opts.allowPrivateEgress ?? false,
      });
      return result(
        resumeToPayload(
          await manager.resume(request.executionId, { kind: request.decision }, request.callId),
        ),
      );
    }
    throw new Error(`[approvals.test] unexpected request kind: ${request.kind}`);
  };
}

function makeDeps(
  overrides: Partial<ApprovalsDeps> & {
    store?: ConduitStore;
    allowPrivateEgress?: boolean;
    live?: boolean;
  },
): ApprovalsDeps & {
  stdoutLines: string[];
  stderrLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const { store, allowPrivateEgress, live, ...rest } = overrides;
  return {
    daemon:
      store !== undefined
        ? realDaemon({
            store,
            ...(allowPrivateEgress !== undefined ? { allowPrivateEgress } : {}),
            ...(live !== undefined ? { live } : {}),
          })
        : async () => {
            throw new Error("daemon not stubbed for this test");
          },
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
    expect(output).toMatch(/EXEC ID\s+CALL ID\s+TOOL/);
    expect(output).toMatch(/exec_old\s+c1\s+github\.delete_repo/);
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
      callId: string;
      tool: string;
      waitingSince: number;
      expiresAt: number;
      expired: boolean;
    }>;
    expect(parsed).toEqual([
      {
        executionId: "exec_old",
        callId: "c1",
        tool: "github.delete_repo",
        waitingSince: 1_000,
        expiresAt: 5_000,
        expired: true,
      },
      {
        executionId: "exec_new",
        callId: "c2",
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

  /** The call id the operator reads off `approvals list` for this execution. */
  async function pendingCallId(executionId: string): Promise<string> {
    const callId = (await store.executions.get(executionId))?.pausedOn?.callId;
    if (callId === undefined)
      throw new Error(`[approvals.test] ${executionId} has no pending call`);
    return callId;
  }

  it("approve maps to manager.resume({kind:'approve'}) and prints 'completed'", async () => {
    await setup();
    const executionId = await pauseOne();
    const deps = makeDeps({
      store,
      allowPrivateEgress: true,
      live: true,
    });

    const result = await runDecide("approve", executionId, await pendingCallId(executionId), deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("completed\n");
    expect(upstream.calls.map((c) => c.name)).toEqual(["delete_repo"]);

    const row = await store.executions.get(executionId);
    expect(row?.status).toBe("completed");
  });

  it("INVARIANT §5.5: approve names the pending call the OPERATOR reviewed — the resume request carries the call id passed on the command line, and nothing is looked up", async () => {
    await setup();
    const executionId = await pauseOne();
    const reviewed = await pendingCallId(executionId);

    const inner = makeDeps({ store, allowPrivateEgress: true, live: true });
    const seen: RpcRequest["kind"][] = [];
    let captured: RpcRequest | undefined;
    const deps = {
      ...inner,
      daemon: async (request: RpcRequest) => {
        seen.push(request.kind);
        if (request.kind === "approvals.resume") captured = request;
        return inner.daemon(request);
      },
    };

    const result = await runDecide("approve", executionId, reviewed, deps);
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual(["approvals.resume"]);
    expect(captured?.kind === "approvals.resume" ? captured.callId : undefined).toBe(reviewed);
  });

  it("INVARIANT §5.5: a call id that went stale between review and approve is refused as conflict — the program's LATER pause is never approved", async () => {
    await setup();
    // Two approval gates: approving the first pause drives the program to
    // the second. The operator reviewed pause A.
    const runtime = await createApprovalRuntime({ store, allowPrivateEgress: true });
    const started = await runtime.manager.start(
      'await tools.github.delete_repo({ repo: "one" }); await tools.github.delete_repo({ repo: "two" }); return "done";',
    );
    if (started.status !== "paused") throw new Error(`expected paused, got ${started.status}`);
    const executionId = started.executionId;
    const reviewedA = started.pending.callId;

    // Someone else approves A first; the program runs on and pauses on B.
    const advanced = await runtime.manager.resume(executionId, { kind: "approve" }, reviewedA);
    expect(advanced.status).toBe("paused");

    // The operator's queued `approve` of A now arrives.
    const deps = makeDeps({ store, allowPrivateEgress: true, live: true });
    const result = await runDecide("approve", executionId, reviewedA, deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("conflict\n");
    expect(deps.stderrLines.join("")).toMatch(/not in a resumable \(paused\) state/);

    // Pause B is untouched and only the first delete ran upstream.
    expect((await store.executions.get(executionId))?.pausedOn?.callId).not.toBe(reviewedA);
    expect(upstream.calls.map((c) => c.name)).toEqual(["delete_repo"]);
  });

  it("approve without a call id exits 1 without ever reaching the daemon", async () => {
    const daemon = vi.fn();
    const deps = makeDeps({ daemon: daemon as unknown as ApprovalsDeps["daemon"] });
    const result = await runDecide("approve", "exec_1", undefined, deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stderrLines.join("")).toMatch(/missing required <call-id>/);
    expect(daemon).not.toHaveBeenCalled();
  });

  it("INVARIANT /cli deny-verb-truth: a REAL applied deny prints 'denied' and exits 0 — the operator's verb succeeded, no tool call", async () => {
    await setup();
    const executionId = await pauseOne();
    const deps = makeDeps({
      store,
      allowPrivateEgress: true,
      live: true,
    });

    const result = await runDecide("deny", executionId, await pendingCallId(executionId), deps);
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
      live: true,
    });
    const result = await runDecide("approve", executionId, await pendingCallId(executionId), deps);

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
      live: true,
    });

    // The operator reviewed ONE call id and reuses it for both invocations —
    // the second cannot look anything up because nothing is pending anymore.
    const reviewed = await pendingCallId(executionId);
    const first = await runDecide("approve", executionId, reviewed, deps);
    expect(first.exitCode).toBe(0);

    // Second approve of the same id: claimForResume finds no paused row →
    // a genuine conflict outcome through the real runtime path (sdk
    // manager.test.ts double-resume precedent).
    const second = await runDecide("approve", executionId, reviewed, deps);
    expect(second.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("completed\nconflict\n");
    expect(deps.stderrLines.join("")).toMatch(/not in a resumable \(paused\) state/);

    // The approved tool call fired exactly once — the conflicted second
    // decision never re-executed it.
    expect(upstream.calls.map((c) => c.name)).toEqual(["delete_repo"]);
  });

  it("missing execution-id exits 1 without ever reaching the daemon", async () => {
    await setup();
    const daemon = vi.fn();
    const deps = makeDeps({ daemon: daemon as unknown as ApprovalsDeps["daemon"] });
    const result = await runDecide("approve", undefined, "call_1", deps);
    expect(result.exitCode).toBe(1);
    // Argument validation is client-side and happens BEFORE any RPC: a
    // malformed invocation must not auto-start a daemon.
    expect(daemon).not.toHaveBeenCalled();
    expect(deps.stderrLines.join("")).toMatch(/missing required <execution-id>/);
  });
});

describe("conduit approvals approve|deny — outcome mapping (payload doubles)", () => {
  /**
   * Pins one verb-truth branch in isolation. The double answers with the
   * daemon's OWN projection of the outcome (`resumeToPayload`), so these
   * cases exercise the real wire shape rather than a hand-written one —
   * a projection that stopped carrying `decisionApplied` would break them.
   */
  function depsWithOutcome(outcome: ResumeOutcome) {
    return makeDeps({
      daemon: async () => result(resumeToPayload(outcome)),
    });
  }

  it("expired outcome (from approve) prints the 'no tool call was made' line and exits 0", async () => {
    const outcome: ResumeOutcome = {
      status: "expired",
      executionId: "exec_x",
      pending: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 1 },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("approve", "exec_x", "call_x", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("expired\n");
    expect(deps.stderrLines.join("")).toMatch(
      /expired before the decision applied.*finalized as expired.*no tool call was made/is,
    );
  });

  it("expired outcome (from deny) ALSO prints the 'no tool call was made' line", async () => {
    const outcome: ResumeOutcome = {
      status: "expired",
      executionId: "exec_y",
      pending: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 1 },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("deny", "exec_y", "call_x", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stderrLines.join("")).toMatch(/no tool call was made/i);
  });

  it("conflict outcome exits non-zero", async () => {
    const outcome: ResumeOutcome = {
      status: "conflict",
      executionId: "exec_z",
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("approve", "exec_z", "call_x", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("conflict\n");
  });

  it("INVARIANT /cli deny-verb-truth: a deny that did NOT apply reports failure (exit 1), never 'denied'", async () => {
    const outcome: ResumeOutcome = {
      status: "failed",
      executionId: "exec_w",
      error: { name: "SomeError", message: "boom" },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("deny", "exec_w", "call_x", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("failed\n");
    expect(deps.stderrLines.join("")).toMatch(/SomeError: boom/);
  });

  it("INVARIANT /cli deny-verb-truth: an applied deny prints 'denied' and exits 0, keyed on decisionApplied — not the error name", async () => {
    const outcome: ResumeOutcome = {
      status: "failed",
      executionId: "exec_denied",
      error: { name: "ConduitPolicyBlocked", message: "policy denied the execution" },
      decisionApplied: true,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("deny", "exec_denied", "call_x", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("denied\n");
    // One informational drive-outcome line: the operator sees what the
    // execution did AFTER the deny landed.
    expect(deps.stderrLines.join("")).toMatch(/deny was applied.*failed/is);
  });

  it("INVARIANT /cli deny-verb-truth: a guest-spoofed ConduitPolicyBlocked failure is NOT reported as 'denied' when the deny never applied", async () => {
    const outcome: ResumeOutcome = {
      status: "failed",
      executionId: "exec_spoof",
      error: { name: "ConduitPolicyBlocked", message: "guest-forged name" },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("deny", "exec_spoof", "call_x", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("failed\n");
    expect(deps.stdoutLines.join("")).not.toContain("denied");
  });

  it("INVARIANT /cli deny-verb-truth: an applied deny is 'denied' (exit 0) even when the guest catches it and the drive COMPLETES", async () => {
    const outcome: ResumeOutcome = {
      status: "completed",
      executionId: "exec_caught",
      value: { blocked: true },
      decisionApplied: true,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("deny", "exec_caught", "call_x", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("denied\n");
    expect(deps.stderrLines.join("")).toMatch(/deny was applied.*completed/is);
  });

  it("INVARIANT /cli deny-verb-truth: an applied deny followed by a later unrelated upstream failure is still 'denied' (exit 0)", async () => {
    const outcome: ResumeOutcome = {
      status: "failed",
      executionId: "exec_later_fail",
      error: { name: "NetworkError", message: "connection failed" },
      decisionApplied: true,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("deny", "exec_later_fail", "call_x", deps);
    expect(result.exitCode).toBe(0);
    expect(deps.stdoutLines.join("")).toBe("denied\n");
    expect(deps.stderrLines.join("")).toMatch(/deny was applied.*failed.*NetworkError/is);
  });

  it("an applied deny that re-pauses on a NEW approval prints 'denied' plus the queue guidance", async () => {
    const outcome: ResumeOutcome = {
      status: "paused",
      executionId: "exec_repause",
      pending: { callId: "c", toolName: "github.push", input: {}, reason: "review", expiresAt: 9 },
      decisionApplied: true,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("deny", "exec_repause", "call_x", deps);
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
    const outcome: ResumeOutcome = {
      status: "completed",
      executionId: "exec_never_applied",
      value: { done: true },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("deny", "exec_never_applied", "call_x", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("completed\n");
    expect(deps.stdoutLines.join("")).not.toContain("denied");
    expect(deps.stderrLines.join("")).toMatch(/deny was never applied/i);
  });

  it("INVARIANT /cli deny-verb-truth: an APPROVE that never applied while the drive COMPLETED also exits 1 — verb truth is symmetric", async () => {
    // The same divergence-that-never-manifested-as-a-call class as the deny
    // guard: reporting unqualified success for an approve that never landed
    // is the same false-positive the deny fix exists to kill.
    const outcome: ResumeOutcome = {
      status: "completed",
      executionId: "exec_approve_never_applied",
      value: { done: true },
      decisionApplied: false,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("approve", "exec_approve_never_applied", "call_x", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("completed\n");
    expect(deps.stderrLines.join("")).toMatch(/approve was never applied/i);
  });

  it("approve with a failed outcome still exits non-zero regardless of error name (unchanged)", async () => {
    const outcome: ResumeOutcome = {
      status: "failed",
      executionId: "exec_approve_blocked",
      error: { name: "ConduitPolicyBlocked", message: "policy denied the execution" },
      decisionApplied: true,
    };
    const deps = depsWithOutcome(outcome);
    const result = await runDecide("approve", "exec_approve_blocked", "call_x", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("failed\n");
    expect(deps.stderrLines.join("")).toMatch(/ConduitPolicyBlocked: policy denied the execution/);
  });
});

/**
 * The answers only a DAEMON CLIENT can receive. None of these existed while
 * the command opened the store directly, and each one has a wrong-but-
 * plausible handling that the verb-truth contract forbids.
 */
describe("conduit approvals — daemon transport answers", () => {
  it("INVARIANT §17 / §5: an outcome-unknown resume is NEVER reported as a landed verb, and exits non-zero", async () => {
    // §5's ambiguity: the connection died after the request bytes went out,
    // so the resume may or may not have driven the execution. Reporting
    // "denied"/exit 0 here would tell the operator their verb landed when
    // nobody knows — the exact false positive PR #40 removed for the
    // never-applied case. It must also not be retried.
    const deps = makeDeps({
      daemon: async () => ({ kind: "outcome-unknown", requestId: "req_9" }),
    });
    const result = await runDecide("deny", "exec_amb", "call_x", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).not.toContain("denied");
    const stderr = deps.stderrLines.join("");
    expect(stderr).toMatch(/unknown/i);
    // Actionable: the operator is told to look it up, not to re-run it.
    expect(stderr).toMatch(/do not retry|don't retry/i);
    expect(stderr).toMatch(/approvals list/);
    expect(stderr).toContain("req_9");
  });

  it("a typed daemon error (busy) exits non-zero and surfaces the daemon's own words", async () => {
    const deps = makeDeps({
      daemon: async () => ({
        kind: "error",
        requestId: "req_b",
        code: "busy",
        message: "the daemon is at capacity",
      }),
    });
    const result = await runDecide("approve", "exec_busy", "call_x", deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stderrLines.join("")).toMatch(/busy.*at capacity/is);
  });

  it("a rotation-in-progress refusal reaches the operator as a refusal, not a crash", async () => {
    const deps = makeDeps({
      daemon: async () => {
        throw new DaemonUnavailable(
          "rotation-in-progress",
          "[conduit] Daemon unavailable: key rotation is in progress.",
        );
      },
    });
    const result = await runList({ json: false }, deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stderrLines.join("")).toMatch(/rotation is in progress/i);
  });

  it("list refuses a non-result frame rather than rendering an empty queue", async () => {
    // An empty table for a queue the daemon never reported is a dangerous
    // lie: the operator concludes nothing is waiting for them.
    const deps = makeDeps({
      daemon: async () => ({
        kind: "error",
        requestId: "req_e",
        code: "internal",
        message: "store fault",
      }),
    });
    const result = await runList({ json: true }, deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("");
    expect(deps.stderrLines.join("")).toMatch(/internal.*store fault/is);
  });

  it("a malformed approvals.list payload exits non-zero with the refusal, never a raw throw", async () => {
    // The client seam converts a malformed payload into a typed `error`
    // BEFORE it reaches this command (client.test.ts pins that half). What
    // this pins is the operator-facing consequence: the refusal is printed
    // and the exit is non-zero, rather than a TypeError escaping `.map` as
    // a stack trace, and rather than an empty table. The wording is
    // load-bearing — an operator must not read silence as "queue empty".
    const deps = makeDeps({
      daemon: async () => ({
        kind: "error",
        requestId: "req_m",
        code: "internal",
        message:
          "the daemon's approvals.list answer was not a list of paused rows. " +
          "Nothing is being reported about the queue — do NOT assume it is empty.",
      }),
    });
    const result = await runList({ json: true }, deps);
    expect(result.exitCode).toBe(1);
    expect(deps.stdoutLines.join("")).toBe("");
    expect(deps.stderrLines.join("")).toContain("do NOT assume it is empty");
  });

  it("INVARIANT §17 / §3.3: the command reaches for NOTHING outside the approvals capability row", async () => {
    const seen: RpcRequest["kind"][] = [];
    const deps = makeDeps({
      daemon: async (request) => {
        seen.push(request.kind);
        return request.kind === "approvals.list"
          ? result([])
          : result(
              resumeToPayload({ status: "conflict", executionId: "x", decisionApplied: false }),
            );
      },
    });
    await runList({ json: true }, deps);
    await runDecide("approve", "x", "call_x", deps);
    await runDecide("deny", "x", "call_x", deps);
    // `handshake` is the client's own, written inside daemonRequest — the
    // command itself may only ever name these two kinds.
    expect([...new Set(seen)].sort()).toEqual(["approvals.list", "approvals.resume"]);
  });
});
