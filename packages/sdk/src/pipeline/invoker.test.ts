import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStoreCredentialResolver } from "../credentials.js";
import { createStorePolicyEngine } from "../policy.js";
import { SecretBox } from "../secrets.js";
import { openSqliteStore } from "../store/sqlite.js";
import type { ConduitStore } from "../store/store.js";
import type { Tool } from "../types.js";
import { GUEST_ERROR_NAMES } from "./errors.js";
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
    });
    await expect(invoke("github.list_issues", {})).rejects.toMatchObject({
      name: GUEST_ERROR_NAMES.policyBlocked,
      message: expect.stringContaining("operator blocked"),
    });

    expect(requests).toHaveLength(0);
    const trace = await store.trace.listByExecution("exec_t");
    expect(trace.map((event) => event.policyVerdict)).toEqual(["block", "block"]);
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

    const expired = createToolInvoker(deps(caller), {
      executionId: "exec_t",
      log: vi.fn(),
      deadline: () => -50, // §16 budget already burnt: clamp, never a negative timeout
    });
    await expired("github.list_issues", {});
    expect(requests[3]?.timeoutMs).toBe(1);
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
});
