import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStoreCredentialResolver } from "../credentials.js";
import { createInMemoryApprovalDecisions } from "../execution/decisions.js";
import { createStorePolicyEngine } from "../policy.js";
import { SecretBox } from "../secrets.js";
import { openSqliteStore } from "../store/sqlite.js";
import type { ConduitStore } from "../store/store.js";
import type { Tool } from "../types.js";
import { GUEST_ERROR_NAMES, upstreamError } from "./errors.js";
import { createToolInvoker, type ToolInvokerDeps } from "./invoker.js";
import type { UpstreamCaller, UpstreamRequest } from "./upstream.js";

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
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_t", log });

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
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_t", log: vi.fn() });

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
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_t", log: vi.fn() });

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

  it("a non-serializable result from a custom caller becomes infra, never a raw throw (H1)", async () => {
    // The A5 extension seam: a caller returning a circular structure makes
    // JSON.stringify throw. The outermost classification must catch it so no
    // raw TypeError crosses into the sandbox.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const badCaller: UpstreamCaller = {
      call: () => Promise.resolve({ result: circular, status: 200, latencyMs: 1 }),
    };
    const log = vi.fn();
    const invoke = createToolInvoker(deps(badCaller), { executionId: "exec_h1", log });

    let thrown: unknown;
    try {
      await invoke("github.list_issues", {});
    } catch (error) {
      thrown = error;
    }
    const error = thrown as Error;
    expect(error.name).toBe(GUEST_ERROR_NAMES.infra);
    expect(error.message).not.toMatch(/circular/i); // structure detail stays host-side
    expect(log).toHaveBeenCalled();
  });

  it("proceeds only on allow — a policy-store rejection fails the call as infra, not a verdict", async () => {
    const { caller, requests } = recordingUpstream();
    const rejectingPolicy = {
      evaluate: () => Promise.reject(new Error("[SqliteStore] policies table unreadable")),
    };
    const log = vi.fn();
    const invoke = createToolInvoker(deps(caller, { policy: rejectingPolicy }), {
      executionId: "exec_t",
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
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_t", log: vi.fn() });

    const attempt = invoke("github.list_issues", {});
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.infra });
    await expect(attempt).rejects.toThrow(/multiple connections/i);
    await expect(attempt).rejects.toThrow(/not yet supported/);
    expect(requests).toHaveLength(0);
  });

  it("a missing connection fails with a guest-actionable message carrying no refs", async () => {
    await store.connections.remove("conn_gh");
    const { caller } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_t", log: vi.fn() });

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
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_t", log: vi.fn() });

    const attempt = invoke("github.rest_call", {});
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.upstream });
    await expect(attempt).rejects.toThrow(/"openapi".*not yet callable/s);
    expect(requests).toHaveLength(0);
  });

  it("timeout passed to upstream = min(ceiling, deadline())", async () => {
    const { caller, requests } = recordingUpstream();

    const deadlineBound = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      deadline: () => 5_000, // ceiling defaults to 30 000
    });
    await deadlineBound("github.list_issues", {});
    expect(requests[0]?.timeoutMs).toBe(5_000);

    const ceilingBound = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      upstreamTimeoutMs: 100,
      deadline: () => 5_000,
    });
    await ceilingBound("github.list_issues", {});
    expect(requests[1]?.timeoutMs).toBe(100);

    const unbounded = createToolInvoker(deps(caller), { executionId: "exec_t", log: vi.fn() });
    await unbounded("github.list_issues", {});
    expect(requests[2]?.timeoutMs).toBe(30_000);

    const nearlyExpired = createToolInvoker(deps(caller), {
      executionId: "exec_t",
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
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_orphan", log });

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

  it("a successful call appends one TraceEvent with output, latency, status, verdict allow", async () => {
    const upstreamResult = { content: [{ type: "text", text: "3 open issues" }] };
    const { caller } = recordingUpstream(upstreamResult);
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_t", log: vi.fn() });

    const result = await invoke("github.list_issues", { owner: "acme" });
    expect(result).toEqual(upstreamResult);

    const trace = await store.trace.listByExecution("exec_t");
    expect(trace).toHaveLength(1);
    const event = trace[0];
    expect(event?.toolName).toBe("github.list_issues");
    expect(event?.connectionPrefix).toBe(PREFIX);
    expect(event?.input).toEqual({ owner: "acme" });
    expect(event?.output).toEqual(upstreamResult);
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
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_t", log: vi.fn() });

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
});
