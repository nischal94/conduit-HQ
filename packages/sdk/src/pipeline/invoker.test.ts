import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient } from "@libsql/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStoreCredentialResolver } from "../credentials.js";
import { createInMemoryApprovalDecisions } from "../execution/decisions.js";
import { createStorePolicyEngine } from "../policy.js";
import { ALL_TOOLS, buildEffectiveScope } from "../scope.js";
import { SecretBox } from "../secrets.js";
import { openSqliteStore } from "../store/sqlite.js";
import type { ConduitStore } from "../store/store.js";
import type { Connection, Tool } from "../types.js";
import { createDispatchCell } from "./dispatch.js";
import {
  ConduitOutcomeAmbiguous,
  GUEST_ERROR_NAMES,
  OUTCOME_AMBIGUOUS_ERROR_NAME,
  upstreamError,
} from "./errors.js";
import { createToolInvoker, type ToolInvokerDeps } from "./invoker.js";
import { createMcpUpstreamCaller, type UpstreamCaller, type UpstreamRequest } from "./upstream.js";

const SECRET = "Bearer ghp_invoker_secret_4c5d";
const PREFIX = "github.acme.prod";

function tool(overrides: Partial<Tool> & Pick<Tool, "name">): Tool {
  return {
    namespace: "github",
    inputSchema: { type: "object" },
    outputSchema: {},
    riskClass: "safe",
    sourceSemantics: { kind: "mcp", readOnlyHint: true },
    ...overrides,
  };
}

function recordingUpstream(result: unknown = { content: [] }): {
  caller: UpstreamCaller;
  requests: UpstreamRequest[];
} {
  const requests: UpstreamRequest[] = [];
  return {
    requests,
    caller: {
      async call(request: UpstreamRequest) {
        requests.push(request);
        return { result, status: 200, latencyMs: 7 };
      },
    },
  };
}

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/**
 * A loopback streamable-HTTP MCP server whose handshake succeeds and whose
 * `tools/call` 200 body echoes the connection's bearer — the §9.2 tripwire's
 * input, arriving AFTER the governed body was written.
 */
async function serveEchoingMcp(): Promise<number> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { id?: string; method?: string };
      if (parsed.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-echo" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "echo", version: "0" },
            },
          }),
        );
        return;
      }
      if (parsed.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id,
          result: { echoed: req.headers.authorization ?? "" },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

let store: ConduitStore;

beforeEach(async () => {
  store = await openSqliteStore({
    client: createClient({ url: ":memory:" }),
    secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
  });
  await store.sources.upsert({
    id: "src_gh",
    type: "mcp",
    namespace: "github",
    location: "https://mcp.example.com/github",
    generation: 0,
  });
  await store.integrations.upsert({ id: "int_gh", sourceId: "src_gh", namespace: "github" });
  await store.connections.upsert({
    id: "conn_gh",
    integrationId: "int_gh",
    prefix: PREFIX,
    credentialRef: "cred_gh",
  });
  await store.secrets.put("cred_gh", SECRET);
  await store.tools.replaceNamespace("github", [
    tool({ name: "github.list_issues" }),
    tool({
      name: "github.delete_repo",
      riskClass: "destructive",
      sourceSemantics: { kind: "mcp", destructiveHint: true },
    }),
  ]);
});

function deps(upstream: UpstreamCaller, overrides: Partial<ToolInvokerDeps> = {}): ToolInvokerDeps {
  return {
    store,
    policy: createStorePolicyEngine(store.policies),
    credentials: createStoreCredentialResolver(store.secrets),
    upstream,
    ...overrides,
  };
}

describe("createToolInvoker (spec §5.3)", () => {
  it("INVARIANT §9.2: a failing secrets.reveal never leaks the ref or store internals to the caller", async () => {
    await store.secrets.remove("cred_gh"); // connection still promises cred_gh
    const { caller, requests } = recordingUpstream();
    const log = vi.fn();
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log,
      projection: "code",
      clientId: null,
    });

    let thrown: unknown;
    try {
      await invoke("github.list_issues", {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { correlationId?: string };
    expect(error.name).toBe(GUEST_ERROR_NAMES.infra);
    const guestVisible = JSON.stringify({ name: error.name, message: error.message });
    expect(guestVisible).not.toContain("cred_gh");
    expect(guestVisible).not.toContain("CredentialResolver");
    expect(guestVisible).not.toContain(PREFIX);
    // The host log keeps the full detail, keyed by the correlation id.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cred_gh"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(error.correlationId ?? "@no-id@"));
    expect(requests).toHaveLength(0);
    // Infra faults are deliberately NOT traced — they live in the host log.
    expect(await store.trace.listByExecution("exec_t")).toHaveLength(0);
  });

  it("denied calls throw ConduitPolicyDenied with the verdict reason and never reach upstream", async () => {
    const { caller, requests } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });

    const attempt = invoke("github.delete_repo", { repo: "site" });
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.policyDenied });
    await expect(attempt).rejects.toThrow(/requires approval/);
    expect(requests).toHaveLength(0);

    const trace = await store.trace.listByExecution("exec_t");
    expect(trace).toHaveLength(1);
    expect(trace[0]?.policyVerdict).toBe("require_approval");
    expect(trace[0]?.toolName).toBe("github.delete_repo");
    expect(trace[0] && "output" in trace[0]).toBe(false);
  });

  it("blocked/unknown tools throw ConduitPolicyBlocked; refusals are traced with their verdict", async () => {
    const { caller, requests } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });

    await expect(invoke("github.no_such_tool", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.policyBlocked,
      message: expect.stringContaining("Unknown tool"),
    });

    await store.policies.upsert({
      toolName: "github.list_issues",
      action: "block",
      seededFrom: "safe",
      manualOverride: true,
      redactFields: [],
    });
    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.policyBlocked,
      message: expect.stringContaining("operator blocked"),
    });

    expect(requests).toHaveLength(0);
    const trace = await store.trace.listByExecution("exec_t");
    expect(trace.map((event) => event.policyVerdict)).toEqual(["block", "block"]);
  });

  it("an unknown tool fails closed as blocked even if a custom engine allows it (M4)", async () => {
    // A seam that returns allow for a tool absent from the catalog must not
    // surface an allow reason under a denial name, nor trace it as allowed.
    const permissivePolicy = {
      evaluate: () =>
        Promise.resolve({
          action: "allow" as const,
          reason: "allowed by default",
          source: "default" as const,
          redactFields: [] as const,
        }),
    };
    const { caller, requests } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller, { policy: permissivePolicy }), {
      executionId: "exec_unknown",
      projection: "code",
      clientId: null,
      log: vi.fn(),
    });

    const attempt = invoke("github.ghost_tool", {});
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.policyBlocked });
    await expect(attempt).rejects.toThrow(/not in the catalog/);
    expect(requests).toHaveLength(0);
    const trace = await store.trace.listByExecution("exec_unknown");
    expect(trace).toHaveLength(1);
    expect(trace[0]?.policyVerdict).toBe("block"); // honest audit, not "allow"
  });

  it("a non-serializable result from a custom caller no longer faults the call — the trace stores only the cycle-safe summary (H1, revised by §11 R3)", async () => {
    // The A5 extension seam: pre-§11 the raw result was stringified into
    // trace_events.output, so a circular structure threw and had to be
    // classified as infra. §11 drops that field (design R3); the only
    // stringify left on the trace path is redact-then-slice, and the
    // redactor replaces back-references with "[redacted]" — so the call
    // succeeds and no raw TypeError can cross into the sandbox.
    // Module-boundary note: this pins invoker-level behavior only — a
    // circular upstream result still faults system-wide one layer up, since
    // the manager's untouched credential scrub (execution/scrub.ts, called
    // from the manager.ts journal barrier) throws on JSON.stringify of a
    // circular value and that gets classified as infra.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const badCaller: UpstreamCaller = {
      call: () => Promise.resolve({ result: circular, status: 200, latencyMs: 1 }),
    };
    const log = vi.fn();
    const invoke = createToolInvoker(deps(badCaller), {
      executionId: "exec_h1",
      log,
      projection: "code",
      clientId: null,
    });

    const result = await invoke("github.list_issues", {});
    expect(result).toBe(circular);
    const [event] = await store.trace.listByExecution("exec_h1");
    expect(event?.outputSummary).toBe('{"self":"[redacted]"}');
  });

  it("proceeds only on allow — a policy-store rejection fails the call as infra, not a verdict", async () => {
    const { caller, requests } = recordingUpstream();
    const rejectingPolicy = {
      evaluate: () => Promise.reject(new Error("[SqliteStore] policies table unreadable")),
    };
    const log = vi.fn();
    const invoke = createToolInvoker(deps(caller, { policy: rejectingPolicy }), {
      executionId: "exec_t",
      projection: "code",
      clientId: null,
      log,
    });

    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.infra,
    });
    expect(requests).toHaveLength(0);
    // An outage is not a verdict: nothing may be journaled as a policy decision.
    expect(await store.trace.listByExecution("exec_t")).toHaveLength(0);
  });

  it("multiple connections for one integration fail closed (decision A1)", async () => {
    await store.connections.upsert({
      id: "conn_gh_staging",
      integrationId: "int_gh",
      prefix: "github.acme.staging",
      credentialRef: "cred_gh",
    });
    const { caller, requests } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });

    const attempt = invoke("github.list_issues", {});
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.infra });
    await expect(attempt).rejects.toThrow(/multiple connections/i);
    await expect(attempt).rejects.toThrow(/not yet supported/);
    expect(requests).toHaveLength(0);
  });

  it("a missing connection fails with a guest-actionable message carrying no refs", async () => {
    await store.connections.remove("conn_gh");
    const { caller } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });

    let thrown: unknown;
    try {
      await invoke("github.list_issues", {});
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error;
    expect(error.name).toBe(GUEST_ERROR_NAMES.upstream);
    expect(error.message).toMatch(/no connection/i);
    expect(error.message).not.toContain("cred_gh");
  });

  it("non-mcp source kinds fail closed naming the kind", async () => {
    await store.tools.replaceNamespace("github", [
      tool({
        name: "github.rest_call",
        sourceSemantics: { kind: "openapi", method: "GET", path: "/x" },
      }),
    ]);
    const { caller, requests } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });

    const attempt = invoke("github.rest_call", {});
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream });
    await expect(attempt).rejects.toThrow(/"openapi".*not yet callable/s);
    expect(requests).toHaveLength(0);
  });

  it("timeout passed to upstream = min(ceiling, deadline())", async () => {
    const { caller, requests } = recordingUpstream();

    const deadlineBound = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      projection: "code",
      clientId: null,
      log: vi.fn(),
      deadline: () => 5_000, // ceiling defaults to 30 000
    });
    await deadlineBound("github.list_issues", {});
    expect(requests[0]?.timeoutMs).toBe(5_000);

    const ceilingBound = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      projection: "code",
      clientId: null,
      log: vi.fn(),
      upstreamTimeoutMs: 100,
      deadline: () => 5_000,
    });
    await ceilingBound("github.list_issues", {});
    expect(requests[1]?.timeoutMs).toBe(100);

    const unbounded = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });
    await unbounded("github.list_issues", {});
    expect(requests[2]?.timeoutMs).toBe(30_000);

    const nearlyExpired = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      projection: "code",
      clientId: null,
      log: vi.fn(),
      deadline: () => 0.5, // sub-ms budget still clamps to a 1ms floor
    });
    await nearlyExpired("github.list_issues", {});
    expect(requests[3]?.timeoutMs).toBe(1);
  });

  it("a burnt §16 budget refuses before any credentialed bytes leave the host", async () => {
    const { caller, requests } = recordingUpstream();
    const expired = createToolInvoker(deps(caller), {
      executionId: "exec_budget",
      projection: "code",
      clientId: null,
      log: vi.fn(),
      deadline: () => -50,
    });

    await expect(expired("github.list_issues", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.upstream,
      message: expect.stringContaining("budget is exhausted"),
    });
    expect(requests).toHaveLength(0); // the upstream was never engaged
    const trace = await store.trace.listByExecution("exec_budget");
    expect(trace).toHaveLength(1); // decision A3: an allowed call with no result still audits
    expect(trace[0]?.policyVerdict).toBe("allow");
  });

  it("a missing integration is an opaque infra fault (store drift)", async () => {
    await store.tools.replaceNamespace("orphan", [
      tool({ name: "orphan.ping", namespace: "orphan" }),
    ]);
    const { caller, requests } = recordingUpstream();
    const log = vi.fn();
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_orphan",
      log,
      projection: "code",
      clientId: null,
    });

    let thrown: unknown;
    try {
      await invoke("orphan.ping", {});
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error;
    expect(error.name).toBe(GUEST_ERROR_NAMES.infra);
    expect(error.message).not.toContain("orphan"); // opaque to the guest
    expect(log).toHaveBeenCalledWith(expect.stringContaining("orphan"));
    expect(requests).toHaveLength(0);
  });

  it("a successful call appends one TraceEvent with summary, latency, status, verdict allow", async () => {
    const upstreamResult = { content: [{ type: "text", text: "3 open issues" }] };
    const { caller } = recordingUpstream(upstreamResult);
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });

    const result = await invoke("github.list_issues", { owner: "acme" });
    expect(result).toEqual(upstreamResult);

    const trace = await store.trace.listByExecution("exec_t");
    expect(trace).toHaveLength(1);
    const event = trace[0];
    expect(event?.toolName).toBe("github.list_issues");
    expect(event?.connectionPrefix).toBe(PREFIX);
    expect(event?.input).toEqual({ owner: "acme" });
    expect(event?.outputSummary).toBe(JSON.stringify(upstreamResult).slice(0, 160));
    expect(event?.upstreamStatus).toBe(200);
    expect(event?.latencyMs).toBe(7);
    expect(event?.policyVerdict).toBe("allow");
  });

  it("an allowed call whose upstream fails is still traced (decision A3)", async () => {
    const failingUpstream: UpstreamCaller = {
      call: () => Promise.reject(upstreamError("Upstream returned HTTP 502.")),
    };
    const invoke = createToolInvoker(deps(failingUpstream), {
      executionId: "exec_t",
      projection: "code",
      clientId: null,
      log: vi.fn(),
    });

    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.upstream,
    });
    const trace = await store.trace.listByExecution("exec_t");
    expect(trace).toHaveLength(1);
    expect(trace[0]?.policyVerdict).toBe("allow"); // the call WAS allowed…
    expect(trace[0] && "output" in trace[0]).toBe(false); // …but produced no result
    expect(trace[0]?.connectionPrefix).toBe(PREFIX);
  });

  it("trace-append failure fails the call (audit is load-bearing, decision A3)", async () => {
    const { caller, requests } = recordingUpstream();
    const auditless: ConduitStore = {
      ...store,
      trace: {
        ...store.trace,
        append: () => Promise.reject(new Error("[SqliteStore] disk full")),
      },
    };
    const log = vi.fn();
    const invoke = createToolInvoker(deps(caller, { store: auditless }), {
      executionId: "exec_t",
      projection: "code",
      clientId: null,
      log,
    });

    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.infra,
    });
    expect(requests).toHaveLength(1); // upstream succeeded, yet the call failed: unauditable ≠ success
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("auth material appears in the UpstreamRequest and nowhere in any thrown error or trace row", async () => {
    const { caller, requests } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });

    await invoke("github.list_issues", {});
    expect(requests[0]?.auth.headers.Authorization).toBe(SECRET);

    const trace = await store.trace.listByExecution("exec_t");
    expect(JSON.stringify(trace)).not.toContain(SECRET);
    expect(JSON.stringify(trace)).not.toContain("cred_gh");
  });

  describe("ApprovalDecisions wiring (§5.5 design D6, confused-deputy defense)", () => {
    it("a staged approve for the EXACT call forces allow, skipping policy — upstream is reached and the row is traced as allow", async () => {
      // github.delete_repo is destructive → policy would return require_approval.
      // A request-bound operator approval for this exact call overrides that.
      const upstreamResult = { content: [{ type: "text", text: "deleted" }] };
      const { caller, requests } = recordingUpstream(upstreamResult);
      const decisions = createInMemoryApprovalDecisions();
      const input = { repo: "site" };
      decisions.stage(
        "exec_approve",
        { op: "call", toolName: "github.delete_repo", request: JSON.stringify(input) },
        { kind: "approve" },
      );
      const invoke = createToolInvoker(deps(caller, { decisions }), {
        executionId: "exec_approve",
        projection: "code",
        clientId: null,
        log: vi.fn(),
      });

      const result = await invoke("github.delete_repo", input);
      expect(result).toEqual(upstreamResult);
      expect(requests).toHaveLength(1); // policy was skipped; upstream WAS reached

      const trace = await store.trace.listByExecution("exec_approve");
      expect(trace).toHaveLength(1);
      expect(trace[0]?.policyVerdict).toBe("allow");
      expect(trace[0]?.toolName).toBe("github.delete_repo");

      // one-shot: the decision is consumed — a second identical call falls back
      // to policy (require_approval), never reusing the approval.
      const second = invoke("github.delete_repo", input);
      await expect(second).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.policyDenied });
      expect(requests).toHaveLength(1); // still 1: the replayed call did not reach upstream
    });

    it("FAILS CLOSED as a TERMINAL replay-divergence when a decision is staged but its identity does NOT match — an approval for tool A never authorizes tool B, and upstream is NEVER reached (F2)", async () => {
      // The confused-deputy defense, now TERMINAL (design F2). Operator approved
      // delete_repo; the resumed run instead invokes list_issues. It MUST NOT
      // fall through to policy's allow, MUST NOT reach the upstream, and MUST
      // throw the uncatchable ConduitReplayDivergence (not a guest-catchable
      // ConduitPolicyBlocked) so the guest cannot catch-and-continue. The staged
      // decision is DISCARDED so it can never authorize a later call.
      const { caller, requests } = recordingUpstream();
      const decisions = createInMemoryApprovalDecisions();
      decisions.stage(
        "exec_divergence",
        { op: "call", toolName: "github.delete_repo", request: JSON.stringify({ repo: "site" }) },
        { kind: "approve" },
      );
      const invoke = createToolInvoker(deps(caller, { decisions }), {
        executionId: "exec_divergence",
        projection: "code",
        clientId: null,
        log: vi.fn(),
      });

      const attempt = invoke("github.list_issues", { owner: "acme" });
      await expect(attempt).rejects.toMatchObject({ name: "ConduitReplayDivergence" });
      await expect(attempt).rejects.toThrow(/resume divergence/i);
      // It is NOT a guest-safe ConduitCallError name (uncatchable-by-design).
      await expect(attempt).rejects.not.toMatchObject({ name: GUEST_ERROR_NAMES.policyBlocked });
      expect(requests).toHaveLength(0); // credentialed bytes NEVER left the host
      // The mismatched decision was discarded — a later matching call cannot
      // reuse it (it was never the guest's to consume).
      expect(decisions.peek("exec_divergence")).toBe(false);
    });

    it("also terminates as replay-divergence when the tool matches but the request (input) diverges — approval is bound to the exact payload (F2)", async () => {
      const { caller, requests } = recordingUpstream();
      const decisions = createInMemoryApprovalDecisions();
      decisions.stage(
        "exec_input_div",
        { op: "call", toolName: "github.delete_repo", request: JSON.stringify({ repo: "site" }) },
        { kind: "approve" },
      );
      const invoke = createToolInvoker(deps(caller, { decisions }), {
        executionId: "exec_input_div",
        projection: "code",
        clientId: null,
        log: vi.fn(),
      });

      // same tool, different input → identity mismatch → terminal divergence
      const attempt = invoke("github.delete_repo", { repo: "OTHER" });
      await expect(attempt).rejects.toMatchObject({ name: "ConduitReplayDivergence" });
      await expect(attempt).rejects.toThrow(/resume divergence/i);
      expect(requests).toHaveLength(0);
      expect(decisions.peek("exec_input_div")).toBe(false);
    });

    it("a staged deny forces ConduitPolicyBlocked for exactly this call and never reaches upstream", async () => {
      const { caller, requests } = recordingUpstream();
      const decisions = createInMemoryApprovalDecisions();
      const input = { owner: "acme" };
      decisions.stage(
        "exec_deny",
        { op: "call", toolName: "github.list_issues", request: JSON.stringify(input) },
        { kind: "deny" },
      );
      const invoke = createToolInvoker(deps(caller, { decisions }), {
        executionId: "exec_deny",
        projection: "code",
        clientId: null,
        log: vi.fn(),
      });

      // github.list_issues is safe → policy would ALLOW it; the operator deny wins.
      const attempt = invoke("github.list_issues", input);
      await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.policyBlocked });
      expect(requests).toHaveLength(0);

      const trace = await store.trace.listByExecution("exec_deny");
      expect(trace).toHaveLength(1);
      expect(trace[0]?.policyVerdict).toBe("block");
    });

    it("no decision staged for this execution → today's policy path is byte-for-byte unchanged", async () => {
      // A decisions dep is present but empty: the common resume case where THIS
      // call has no staged decision must behave exactly as the no-dep path.
      const { caller, requests } = recordingUpstream();
      const decisions = createInMemoryApprovalDecisions();
      const invoke = createToolInvoker(deps(caller, { decisions }), {
        executionId: "exec_empty",
        projection: "code",
        clientId: null,
        log: vi.fn(),
      });

      // safe tool → allowed as usual
      await invoke("github.list_issues", { owner: "acme" });
      expect(requests).toHaveLength(1);

      // destructive tool → policy require_approval as usual (no decision to override)
      const denied = invoke("github.delete_repo", { repo: "x" });
      await expect(denied).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.policyDenied });
      expect(requests).toHaveLength(1);
    });
  });

  it("INVARIANT §11: Trace inputs and output summaries are redacted per policy (builtins + redactFields) on every verdict path, and the Trace stores no full output", async () => {
    await store.policies.upsert({
      toolName: "github.list_issues",
      action: "allow",
      seededFrom: "safe",
      manualOverride: false,
      redactFields: ["repo_label"],
    });
    const { caller } = recordingUpstream({
      content: [{ password: "echoed-pw", repoLabel: "internal", ok: true }],
    });
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_redact",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });

    await invoke("github.list_issues", { token: "sk-live", repo_label: "internal", repo: "hq" });

    const [event] = await store.trace.listByExecution("exec_redact");
    expect(event?.input).toEqual({ token: "[redacted]", repo_label: "[redacted]", repo: "hq" });
    const summary = String(event?.outputSummary);
    expect(summary).not.toContain("echoed-pw");
    expect(summary).not.toContain("internal");
    expect(summary).toContain("[redacted]");

    // Refusal path: the destructive tool's refusal row is redacted too.
    // (require_approval surfaces as ConduitPolicyDenied — errors.ts policyError.)
    const attempt = invoke("github.delete_repo", { password: "pw", repo: "hq" });
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.policyDenied });
    const refused = (await store.trace.listByExecution("exec_redact"))[1];
    expect(refused?.input).toEqual({ password: "[redacted]", repo: "hq" });

    const all = await store.trace.listByExecution("exec_redact");
    expect(all.every((event) => !("output" in event))).toBe(true);
  });

  it("§11: the upstream call itself still receives the UNREDACTED input (redaction is trace-only)", async () => {
    const { caller, requests } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_live",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });
    await invoke("github.list_issues", { token: "sk-live", repo: "hq" });
    expect(requests[0]?.input).toEqual({ token: "sk-live", repo: "hq" });
  });

  it("§11: a sensitive value's head never leaks through the 160-char summary slice (redact-then-slice, R7)", async () => {
    const { caller } = recordingUpstream({ secret: `sk-${"x".repeat(400)}`, note: "fine" });
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_slice",
      log: vi.fn(),
      projection: "code",
      clientId: null,
    });
    await invoke("github.list_issues", {});
    const [event] = await store.trace.listByExecution("exec_slice");
    expect(String(event?.outputSummary)).not.toContain("sk-x");
  });
});

const permitAll = async () =>
  buildEffectiveScope(
    { projections: { code: true, direct: true, discovery: true }, allow: ALL_TOOLS },
    await store.tools.list(),
  );
const permitOnly = (names: string[]) => async () =>
  buildEffectiveScope(
    { projections: { code: true, direct: true, discovery: true }, allow: names },
    await store.tools.list(),
  );

describe("§5.5 scope check", () => {
  it("INVARIANT §5.5: an out-of-scope tool is treated exactly as an unknown tool — blocked, audited, no upstream contact", async () => {
    const { caller, requests } = recordingUpstream();
    const scopeLog = vi.fn();
    const invoke = createToolInvoker(deps(caller), {
      executionId: "exec_s",
      projection: "code",
      clientId: "acme",
      scope: permitOnly(["github.delete_repo"]),
      log: scopeLog,
    });
    // I3: the guest-visible refusal must be byte-identical to the one an
    // UNKNOWN tool produces, or the difference is an existence oracle — a
    // probing client learns the tool exists and only its grant is missing.
    // Compared against the error the SAME invoker actually produces for a
    // nonexistent path, never a literal copied into the test, which would
    // drift the moment the real wording changes.
    const asError = (e: unknown): Error => {
      if (!(e instanceof Error)) throw new Error(`expected an Error, got ${String(e)}`);
      return e;
    };
    const outOfScope = await invoke("github.list_issues", {}).then(
      () => {
        throw new Error("expected the out-of-scope call to be refused");
      },
      (e: unknown) => asError(e),
    );
    // The SAME path, now genuinely absent from the catalog: an invoker whose
    // store holds no such tool. Same path in, so the two messages are
    // comparable byte for byte with no rewriting.
    const emptyStore = {
      ...deps(recordingUpstream().caller),
      store: {
        ...store,
        tools: { ...store.tools, get: async () => undefined },
      },
    } as Parameters<typeof createToolInvoker>[0];
    const unknown = await createToolInvoker(emptyStore, {
      executionId: "exec_s_unknown",
      projection: "code",
      clientId: "acme",
      scope: permitOnly(["github.delete_repo"]),
      log: vi.fn(),
    })("github.list_issues", {}).then(
      () => {
        throw new Error("expected the unknown-tool call to be refused");
      },
      (e: unknown) => asError(e),
    );
    // Same class and the same text — equality, not substring.
    expect(outOfScope.name).toBe(GUEST_ERROR_NAMES.policyBlocked);
    expect(outOfScope.name).toBe(unknown.name);
    expect(outOfScope.message).toBe(unknown.message);
    // And it never names the real tool as existing.
    expect(outOfScope.message).not.toContain("scope");
    expect(requests).toHaveLength(0);
    const [row] = await store.trace.listByExecution("exec_s");
    expect(row).toMatchObject({
      toolName: "github.list_issues",
      policyVerdict: "block",
      projection: "code",
      clientId: "acme",
    });
    // `TraceEvent` carries `policyVerdict` only — it has no reason field — so
    // the OPERATOR's distinction lives in the HOST log instead. It names the
    // tool path and never the tool input.
    expect(scopeLog).toHaveBeenCalledWith(expect.stringContaining("outside this client's scope"));
    expect(scopeLog.mock.calls.flat().join(" ")).toContain("github.list_issues");
  });

  it("INVARIANT §5.5: the out-of-scope refusal is identical on the APPROVED-decision path too — one source of the unknown-tool text", async () => {
    // I3, the `allow` arm. `resolveDecisionVerdict` returns action "allow"
    // for an approved decision, and the per-call scope check runs BEFORE it
    // and can set `tool = undefined` — so the guest reason falls to the
    // invoker's own fallback rather than the engine's text. Both are now
    // built by `unknownToolReason`, so they cannot drift. Compared against
    // the error the ordinary path actually produces, never a copied literal.
    const asError = (e: unknown): Error => {
      if (!(e instanceof Error)) throw new Error(`expected an Error, got ${String(e)}`);
      return e;
    };
    const allowEngine = {
      evaluate: () =>
        Promise.resolve({
          action: "allow" as const,
          reason: "approved by decision",
          source: "default" as const,
          redactFields: [] as const,
        }),
    };
    const onAllowPath = await createToolInvoker(
      deps(recordingUpstream().caller, { policy: allowEngine }),
      {
        executionId: "exec_allow_scope",
        projection: "code",
        clientId: "acme",
        scope: permitOnly(["github.delete_repo"]),
        log: vi.fn(),
      },
    )("github.list_issues", {}).then(
      () => {
        throw new Error("expected the out-of-scope call to be refused");
      },
      (e: unknown) => asError(e),
    );
    // The SAME path through the ORDINARY engine, for a byte-for-byte compare.
    const onPolicyPath = await createToolInvoker(deps(recordingUpstream().caller), {
      executionId: "exec_policy_scope",
      projection: "code",
      clientId: "acme",
      scope: permitOnly(["github.delete_repo"]),
      log: vi.fn(),
    })("github.list_issues", {}).then(
      () => {
        throw new Error("expected the out-of-scope call to be refused");
      },
      (e: unknown) => asError(e),
    );
    expect(onAllowPath.name).toBe(onPolicyPath.name);
    expect(onAllowPath.message).toBe(onPolicyPath.message);
  });

  /**
   * The refusal TEXT was already identical. What still separated the two
   * cases was the SCHEDULE: an absent name skipped the resolver entirely
   * while a present-but-ungranted name awaited it, so the guest read
   * existence off latency, off a resolver rejection that surfaced for one
   * case only, and off a hang. These pin the schedule, not the text.
   */
  describe("INVARIANT §5.5: on the scoped path, an absent tool and an out-of-scope tool are indistinguishable by SCHEDULE", () => {
    const asError = (e: unknown): Error => {
      if (!(e instanceof Error)) throw new Error(`expected an Error, got ${String(e)}`);
      return e;
    };
    /** Records the store method names the invoker calls, in order. */
    function trackingStore(present: boolean): {
      store: ConduitStore;
      seq: string[];
    } {
      const seq: string[] = [];
      const tracked = {
        ...store,
        tools: {
          ...store.tools,
          get: async (name: string) => {
            seq.push("tools.get");
            return present ? await store.tools.get("github.list_issues") : undefined;
          },
          list: async () => {
            seq.push("tools.list");
            return await store.tools.list();
          },
        },
        policies: {
          ...store.policies,
          get: async (name: string) => {
            seq.push("policies.get");
            return await store.policies.get(name);
          },
        },
        trace: {
          ...store.trace,
          append: async (...a: Parameters<ConduitStore["trace"]["append"]>) => {
            seq.push("trace.append");
            return await store.trace.append(...a);
          },
        },
      } as ConduitStore;
      return { store: tracked, seq };
    }

    it("calls the resolver exactly once for BOTH, and makes the same store calls in the same order", async () => {
      const absent = trackingStore(false);
      const present = trackingStore(true);
      const absentCalls: number[] = [];
      const presentCalls: number[] = [];
      const countingScope = (into: number[]) => async () => {
        into.push(1);
        return await permitOnly(["github.delete_repo"])();
      };
      const run = async (t: { store: ConduitStore }, into: number[], id: string) =>
        await createToolInvoker(
          { ...deps(recordingUpstream().caller), store: t.store } as Parameters<
            typeof createToolInvoker
          >[0],
          {
            executionId: id,
            projection: "code",
            clientId: "acme",
            scope: countingScope(into),
            log: vi.fn(),
          },
        )("github.list_issues", {}).then(
          () => {
            throw new Error("expected the call to be refused");
          },
          (e: unknown) => asError(e),
        );
      const absentError = await run(absent, absentCalls, "exec_sched_absent");
      const presentError = await run(present, presentCalls, "exec_sched_present");
      // (a) the resolver runs exactly once on each path.
      expect(absentCalls).toHaveLength(1);
      expect(presentCalls).toHaveLength(1);
      // (c) the same store-call sequence, compared as a whole.
      expect(absent.seq).toEqual(present.seq);
      // The refusal itself stays identical too.
      expect(absentError.name).toBe(presentError.name);
      expect(absentError.message).toBe(presentError.message);
    });

    it("a REJECTING resolver produces the same error class and message for BOTH", async () => {
      const rejecting = async () => {
        throw new Error("resolver exploded: internal detail");
      };
      const run = async (present: boolean, id: string) =>
        await createToolInvoker(
          {
            ...deps(recordingUpstream().caller),
            store: trackingStore(present).store,
          } as Parameters<typeof createToolInvoker>[0],
          {
            executionId: id,
            projection: "code",
            clientId: "acme",
            scope: rejecting,
            log: vi.fn(),
          },
        )("github.list_issues", {}).then(
          () => {
            throw new Error("expected the call to be refused");
          },
          (e: unknown) => asError(e),
        );
      const absentError = await run(false, "exec_rej_absent");
      const presentError = await run(true, "exec_rej_present");
      expect(absentError.name).toBe(presentError.name);
      // The opaque reference is deliberately fresh per refusal, so compare the
      // message with it normalized away — everything else must be byte-equal.
      const normalize = (m: string) =>
        m.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<ref>");
      expect(normalize(absentError.message)).toBe(normalize(presentError.message));
      // And the resolver's own detail never reaches the guest on either path.
      expect(absentError.message).not.toContain("internal detail");
      expect(presentError.message).not.toContain("internal detail");
    });
  });

  it("INVARIANT §5.5: the UNSCOPED path makes exactly one tools.get per call and consults no resolver", async () => {
    // Shipped Code Mode takes the unscoped path (D-A3). Closing the oracle
    // on the scoped path must not add a resolver call or a second catalog
    // read here.
    const seq: string[] = [];
    const tracked = {
      ...store,
      tools: {
        ...store.tools,
        get: async (name: string) => {
          seq.push("tools.get");
          return await store.tools.get(name);
        },
        list: async () => {
          seq.push("tools.list");
          return await store.tools.list();
        },
      },
    } as ConduitStore;
    await createToolInvoker(
      { ...deps(recordingUpstream().caller), store: tracked } as Parameters<
        typeof createToolInvoker
      >[0],
      {
        executionId: "exec_unscoped_once",
        projection: "code",
        clientId: null,
        log: vi.fn(),
      },
    )("github.list_issues", {}).catch(() => {});
    expect(seq.filter((s) => s === "tools.get")).toHaveLength(1);
    expect(seq).not.toContain("tools.list");
  });

  it("the out-of-scope HOST log sanitizes the guest-supplied path — no forged line, bounded length", async () => {
    // The path is guest-supplied and untrusted. A raw newline in it would
    // forge a second host log line; an unbounded one would flood the daemon
    // log. `printableName` strips control characters and caps at 120.
    const scopeLog = vi.fn();
    const hostile = `github.${"a".repeat(300)}\nFORGED host log line`;
    // The branch is reached only when the catalog HOLDS the tool and scope
    // then withholds it, so the lookup answers for the hostile path while
    // the profile grants something else entirely.
    const holdsHostile = {
      ...deps(recordingUpstream().caller),
      store: {
        ...store,
        tools: { ...store.tools, get: async () => await store.tools.get("github.list_issues") },
      },
    } as Parameters<typeof createToolInvoker>[0];
    await createToolInvoker(holdsHostile, {
      executionId: "exec_log_sanitize",
      projection: "code",
      clientId: "acme",
      scope: permitOnly(["github.delete_repo"]),
      log: scopeLog,
    })(hostile, {}).catch(() => {});
    const line = scopeLog.mock.calls.flat().join(" ");
    expect(line).toContain("outside this client's scope");
    // The interpolated name carries no newline, so the forged tail cannot
    // start a line of its own, and the whole entry stays bounded.
    expect(line).not.toContain("\n");
    expect(line).not.toContain("FORGED host log line");
    expect(line.length).toBeLessThan(400);
  });

  it("the refusal names only the tool, never the profile's other entries", async () => {
    const invoke = createToolInvoker(deps(recordingUpstream().caller), {
      executionId: "exec_o",
      projection: "direct",
      clientId: "acme",
      scope: permitOnly(["github.delete_repo"]),
      log: vi.fn(),
    });
    await expect(invoke("github.list_issues", {})).rejects.toSatisfy(
      (e: Error) => !e.message.includes("delete_repo"),
    );
  });

  it("a permitted tool proceeds; an absent scope behaves as today", async () => {
    const { caller, requests } = recordingUpstream();
    await createToolInvoker(deps(caller), {
      executionId: "exec_p",
      projection: "code",
      clientId: null,
      scope: permitAll,
      log: vi.fn(),
    })("github.list_issues", {});
    await createToolInvoker(deps(caller), {
      executionId: "exec_q",
      projection: "code",
      clientId: null,
      log: vi.fn(),
    })("github.list_issues", {});
    expect(requests).toHaveLength(2);
  });

  it("INVARIANT §4.3 (#27): every trace row carries projection and clientId, on allow and on refusal", async () => {
    const invoke = createToolInvoker(deps(recordingUpstream().caller), {
      executionId: "exec_t2",
      projection: "discovery",
      clientId: "acme",
      log: vi.fn(),
    });
    await invoke("github.list_issues", {});
    await invoke("github.delete_repo", {}).catch(() => {});
    const rows = await store.trace.listByExecution("exec_t2");
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([r.projection, r.clientId]).toEqual(["discovery", "acme"]);
  });
});

describe("§7 post-dispatch classification", () => {
  function dispatchingCaller(fail: () => Error): UpstreamCaller {
    return {
      async call(request: UpstreamRequest) {
        request.dispatch?.advance("initializing");
        request.dispatch?.advance("dispatched");
        throw fail();
      },
    };
  }

  it("the ambiguity class's name equals the exported constant every reader keys on", () => {
    expect(new ConduitOutcomeAmbiguous("x").name).toBe(OUTCOME_AMBIGUOUS_ERROR_NAME);
  });

  it("INVARIANT §7 (#24): an upstream failure after dispatch surfaces as ConduitOutcomeAmbiguous, not a guest-catchable upstream error", async () => {
    const invoke = createToolInvoker(deps(dispatchingCaller(() => upstreamError("HTTP 404"))), {
      executionId: "exec_a",
      projection: "code",
      clientId: null,
      log: vi.fn(),
    });
    await expect(invoke("github.list_issues", {})).rejects.toBeInstanceOf(ConduitOutcomeAmbiguous);
  });

  it("INVARIANT §7 (#24): classification survives error REPLACEMENT — a failing refusal audit after dispatch is still ambiguous", async () => {
    const failingTrace: ConduitStore = {
      ...store,
      trace: { ...store.trace, append: () => Promise.reject(new Error("disk full")) },
    };
    const invoke = createToolInvoker(
      deps(
        dispatchingCaller(() => upstreamError("HTTP 404")),
        { store: failingTrace },
      ),
      { executionId: "exec_b", projection: "code", clientId: null, log: vi.fn() },
    );
    await expect(invoke("github.list_issues", {})).rejects.toBeInstanceOf(ConduitOutcomeAmbiguous);
  });

  it("a failure while the cell is initializing (handshake) keeps its own classification", async () => {
    const initOnly: UpstreamCaller = {
      async call(request: UpstreamRequest) {
        request.dispatch?.advance("initializing");
        throw upstreamError("handshake refused");
      },
    };
    const invoke = createToolInvoker(deps(initOnly), {
      executionId: "exec_c",
      projection: "code",
      clientId: null,
      log: vi.fn(),
    });
    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.upstream,
    });
  });

  it("REGRESSION (one-way door #3, eng review D4): a credential echo after a 200 is post-dispatch — ConduitOutcomeAmbiguous, result never delivered", async () => {
    // A real loopback MCP server: initialize + tools/call both succeed, and the
    // 200 body echoes the bearer — so the §9.2 tripwire fires AFTER dispatch.
    const port = await serveEchoingMcp();
    await store.sources.upsert({
      id: "src_gh",
      type: "mcp",
      namespace: "github",
      location: `http://127.0.0.1:${port}/mcp`,
      generation: 0,
    });
    const echoing = createMcpUpstreamCaller({ egress: { allowPrivate: true } });
    const invoke = createToolInvoker(deps(echoing), {
      executionId: "exec_echo",
      projection: "code",
      clientId: null,
      log: vi.fn(),
    });
    await expect(invoke("github.list_issues", {})).rejects.toBeInstanceOf(ConduitOutcomeAmbiguous);
    const rows = await store.trace.listByExecution("exec_echo");
    expect(JSON.stringify(rows)).not.toContain("ghp_invoker_secret");
  });

  it("a caller-supplied cell (direct drive) is the one the upstream caller advances", async () => {
    const cell = createDispatchCell();
    const advancing: UpstreamCaller = {
      async call(request: UpstreamRequest) {
        request.dispatch?.advance("initializing");
        request.dispatch?.advance("dispatched");
        return { result: {}, status: 200, latencyMs: 1 };
      },
    };
    const invoke = createToolInvoker(deps(advancing), {
      executionId: "exec_d",
      projection: "direct",
      clientId: null,
      dispatch: cell,
      log: vi.fn(),
    });
    await invoke("github.list_issues", {});
    expect(cell.state).toBe("dispatched"); // F6: would read "none" if the invoker minted its own cell
  });

  it("INVARIANT §5.3: the budget is re-checked AFTER the source read — a stall there never dispatches once the budget is gone", async () => {
    let remaining = 100;
    const slowSources: ConduitStore = {
      ...store,
      sources: {
        ...store.sources,
        getByNamespace: async (ns: string) => {
          remaining = 0;
          return store.sources.getByNamespace(ns);
        },
      },
    };
    const { caller, requests } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller, { store: slowSources }), {
      executionId: "exec_f2",
      projection: "direct",
      clientId: null,
      deadline: () => remaining,
      log: vi.fn(),
    });
    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.upstream,
      message: expect.stringContaining("budget is exhausted"),
    });
    expect(requests).toHaveLength(0);
  });

  it("INVARIANT §5.3 quarantine gate: an exhausted deadline refuses BEFORE credentials are resolved", async () => {
    const resolve = vi.fn();
    const credentials = {
      resolve: async (c: Connection) => {
        resolve();
        return createStoreCredentialResolver(store.secrets).resolve(c);
      },
    };
    const invoke = createToolInvoker(deps(recordingUpstream().caller, { credentials }), {
      executionId: "exec_e",
      projection: "code",
      clientId: null,
      deadline: () => 0,
      log: vi.fn(),
    });
    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.upstream,
      message: expect.stringContaining("budget is exhausted"),
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});
