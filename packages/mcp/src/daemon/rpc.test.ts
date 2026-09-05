import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_REJECTION_PREFIX,
  decodeRequest,
  InvalidRpcRequest,
} from "./rpc.js";

describe("decodeRequest", () => {
  it("accepts each valid RpcRequest shape", () => {
    expect(decodeRequest({ kind: "handshake", protocol: 1, capability: "serve" })).toEqual({
      kind: "handshake",
      protocol: 1,
      capability: "serve",
    });
    expect(decodeRequest({ kind: "execute", code: "1+1", deadlineMs: 5000 })).toEqual({
      kind: "execute",
      code: "1+1",
      deadlineMs: 5000,
    });
    expect(decodeRequest({ kind: "search", query: "foo" })).toEqual({
      kind: "search",
      query: "foo",
    });
    expect(decodeRequest({ kind: "describe", toolName: "bar" })).toEqual({
      kind: "describe",
      toolName: "bar",
    });
    expect(decodeRequest({ kind: "approvals.list" })).toEqual({ kind: "approvals.list" });
    expect(
      decodeRequest({
        kind: "approvals.resume",
        executionId: "e1",
        decision: "approve",
        callId: "call_1",
      }),
    ).toEqual({
      kind: "approvals.resume",
      executionId: "e1",
      decision: "approve",
      callId: "call_1",
    });
    expect(
      decodeRequest({
        kind: "approvals.resume",
        executionId: "e1",
        decision: "deny",
        callId: "call_1",
      }),
    ).toEqual({ kind: "approvals.resume", executionId: "e1", decision: "deny", callId: "call_1" });
    expect(
      decodeRequest({
        kind: "source.provision",
        namespace: "ns",
        url: "https://example.com",
        prefix: "ns.p",
        secret: "s3cr3t",
        replace: false,
        clearCredential: false,
      }),
    ).toEqual({
      kind: "source.provision",
      namespace: "ns",
      url: "https://example.com",
      prefix: "ns.p",
      secret: "s3cr3t",
      replace: false,
      clearCredential: false,
    });
    // An absent `secret` stays ABSENT rather than becoming `secret: undefined`.
    expect(
      decodeRequest({
        kind: "source.provision",
        namespace: "ns",
        url: "https://example.com",
        prefix: "ns.p",
        replace: true,
        clearCredential: true,
      }),
    ).toEqual({
      kind: "source.provision",
      namespace: "ns",
      url: "https://example.com",
      prefix: "ns.p",
      replace: true,
      clearCredential: true,
    });
    expect(decodeRequest({ kind: "source.revalidate", namespace: "ns" })).toEqual({
      kind: "source.revalidate",
      namespace: "ns",
    });
  });

  it("rejects an unknown kind", () => {
    expect(() => decodeRequest({ kind: "nonsense" })).toThrow();
  });

  /**
   * D-B1 (controller-ruled): the three read-only kinds the `serve` process
   * needs, plus `execute.requestKey`. Each is a PROJECTION request — the
   * daemon answers with a computed view, never a repository row shape.
   */
  it("accepts the D-B1 read-only kinds", () => {
    expect(decodeRequest({ kind: "execution.get", executionId: "exec_1" })).toEqual({
      kind: "execution.get",
      executionId: "exec_1",
    });
    expect(decodeRequest({ kind: "execution.getByRequestKey", requestKey: "rk-1" })).toEqual({
      kind: "execution.getByRequestKey",
      requestKey: "rk-1",
    });
    expect(decodeRequest({ kind: "catalog.listing" })).toEqual({ kind: "catalog.listing" });
  });

  it("carries an optional execute.requestKey, still rejecting unknown keys", () => {
    expect(
      decodeRequest({ kind: "execute", code: "1+1", deadlineMs: 5000, requestKey: "rk-1" }),
    ).toEqual({ kind: "execute", code: "1+1", deadlineMs: 5000, requestKey: "rk-1" });
    // Absent stays absent — never materialized as `undefined`, which would
    // make `"requestKey" in request` true for a request that carries none.
    expect(decodeRequest({ kind: "execute", code: "1+1", deadlineMs: 5000 })).toEqual({
      kind: "execute",
      code: "1+1",
      deadlineMs: 5000,
    });
    expect(() =>
      decodeRequest({ kind: "execute", code: "1+1", deadlineMs: 5000, requestKey: 5 }),
    ).toThrow(InvalidRpcRequest);
    // The widening is ONE named field, not a hole.
    expect(() =>
      decodeRequest({ kind: "execute", code: "1+1", deadlineMs: 5000, limits: {} }),
    ).toThrow(InvalidRpcRequest);
  });

  it("rejects wrong field types and extra keys on the D-B1 kinds", () => {
    expect(() => decodeRequest({ kind: "execution.get", executionId: 5 })).toThrow(
      InvalidRpcRequest,
    );
    expect(() => decodeRequest({ kind: "execution.get" })).toThrow(InvalidRpcRequest);
    expect(() => decodeRequest({ kind: "execution.getByRequestKey", requestKey: null })).toThrow(
      InvalidRpcRequest,
    );
    // catalog.listing is a nullary request: it takes NO parameters, so a
    // client cannot narrow, filter, or otherwise steer what it returns.
    expect(() => decodeRequest({ kind: "catalog.listing", namespace: "ns" })).toThrow(
      InvalidRpcRequest,
    );
    expect(() =>
      decodeRequest({ kind: "execution.get", executionId: "exec_1", reveal: true }),
    ).toThrow(InvalidRpcRequest);
  });

  it("rejects wrong field types", () => {
    expect(() =>
      decodeRequest({ kind: "handshake", protocol: "1", capability: "serve" }),
    ).toThrow();
    expect(() => decodeRequest({ kind: "execute", code: 123, deadlineMs: 5000 })).toThrow();
    expect(() => decodeRequest({ kind: "execute", code: "1+1", deadlineMs: "5000" })).toThrow();
    expect(() => decodeRequest({ kind: "search", query: 42 })).toThrow();
    expect(() => decodeRequest({ kind: "describe", toolName: null })).toThrow();
    expect(() =>
      decodeRequest({
        kind: "approvals.resume",
        executionId: "e1",
        decision: "maybe",
        callId: "call_1",
      }),
    ).toThrow();
    // INVARIANT §5.5: an approval names the pending call it approves — a
    // resume without a callId is refused, never bound to "whatever is paused".
    expect(() =>
      decodeRequest({ kind: "approvals.resume", executionId: "e1", decision: "approve" }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        kind: "approvals.resume",
        executionId: "e1",
        decision: "approve",
        callId: 7,
      }),
    ).toThrow();
    expect(() => decodeRequest({ kind: "source.revalidate", namespace: 5 })).toThrow();
  });

  it("rejects degenerate execute.deadlineMs values that are still typeof number", () => {
    // Each corrupts the admission bound in its own way, and each would
    // pass a bare `typeof v === "number"` check: NaN makes every expiry
    // comparison false so the entry NEVER expires, a negative deadline
    // expires it before it can be dispatched, and Infinity is precisely
    // the unbounded queue entry the capacity cap exists to prevent.
    for (const deadlineMs of [
      Number.NaN,
      -1,
      -0.5,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => decodeRequest({ kind: "execute", code: "1+1", deadlineMs })).toThrow();
    }
    // Zero remains legal — "do not queue me at all" is a coherent bound.
    expect(decodeRequest({ kind: "execute", code: "1+1", deadlineMs: 0 })).toMatchObject({
      deadlineMs: 0,
    });
  });

  it("rejects the anti-oracle shape: source.revalidate carrying a url field", () => {
    expect(() =>
      decodeRequest({ kind: "source.revalidate", namespace: "ns", url: "https://evil.example" }),
    ).toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => decodeRequest(null)).toThrow();
    expect(() => decodeRequest("handshake")).toThrow();
    expect(() => decodeRequest(42)).toThrow();
    expect(() => decodeRequest([])).toThrow();
  });

  it("rejects missing kind", () => {
    expect(() => decodeRequest({})).toThrow();
  });

  it("accepts every capability the §3.3 table declares", () => {
    for (const capability of Object.keys(CAPABILITIES)) {
      expect(decodeRequest({ kind: "handshake", protocol: 1, capability })).toEqual({
        kind: "handshake",
        protocol: 1,
        capability,
      });
    }
  });

  it("requires handshake.capability and rejects anything outside the table", () => {
    expect(() => decodeRequest({ kind: "handshake", protocol: 1 })).toThrow(InvalidRpcRequest);
    expect(() => decodeRequest({ kind: "handshake", protocol: 1, capability: "root" })).toThrow(
      InvalidRpcRequest,
    );
    expect(() => decodeRequest({ kind: "handshake", protocol: 1, capability: 1 })).toThrow(
      InvalidRpcRequest,
    );
    // Prototype keys are not capabilities: the guard consults the table's
    // own keys, so an inherited property name can never narrow.
    expect(() =>
      decodeRequest({ kind: "handshake", protocol: 1, capability: "constructor" }),
    ).toThrow(InvalidRpcRequest);
  });

  it("the bad-capability message keeps the prefix `conduit daemon` matches on", () => {
    // `isPreControlRejection` (cli commands/daemon.ts) detects a PRE-CONTROL
    // daemon by this substring: such a daemon predates the `control`
    // capability, so its refusal of the handshake is the only signal
    // available. Rewording this message silently turns that remediation —
    // the manual SIGTERM path — into a generic "unexpected error", so the
    // wording is pinned HERE, where the reword would happen.
    //
    // Against the exported CONSTANT, which both sides now share: the CLI
    // imports it rather than re-spelling the sentence, so this asserts the
    // decoder actually EMITS the constant it claims to. A reword of the
    // constant moves both sides together and stays detected; a reword of
    // the decoder's message alone fails here.
    expect(() => decodeRequest({ kind: "handshake", protocol: 1, capability: "root" })).toThrow(
      CAPABILITY_REJECTION_PREFIX,
    );
  });

  it("carries an optional dbPath so the daemon can refuse a custom-db client", () => {
    expect(
      decodeRequest({
        kind: "handshake",
        protocol: 1,
        capability: "serve",
        dbPath: "/tmp/x.db",
      }),
    ).toEqual({ kind: "handshake", protocol: 1, capability: "serve", dbPath: "/tmp/x.db" });
    expect(() =>
      decodeRequest({ kind: "handshake", protocol: 1, capability: "serve", dbPath: 5 }),
    ).toThrow(InvalidRpcRequest);
  });

  it("still rejects extra keys on handshake — the widening is two named fields, not a hole", () => {
    expect(() =>
      decodeRequest({ kind: "handshake", protocol: 1, capability: "serve", masterKey: "x" }),
    ).toThrow(InvalidRpcRequest);
  });
});

describe("CAPABILITIES", () => {
  it("serve = execute/search/describe/handshake + the D-B1 read-only kinds", () => {
    expect(CAPABILITIES.serve).toEqual(
      new Set([
        "execute",
        "search",
        "describe",
        "handshake",
        "execution.get",
        "execution.getByRequestKey",
        "catalog.listing",
      ]),
    );
  });

  /**
   * D-B1 widened `serve` ONLY. The ruling is explicit that the other two
   * rows gain nothing, and this pins that: a read added for the stdio
   * server must not silently become reachable from an administrative
   * client's connection.
   */
  it("D-B1 widened serve alone — approvals and add-mcp gain nothing", () => {
    for (const kind of ["execution.get", "execution.getByRequestKey", "catalog.listing"] as const) {
      expect(CAPABILITIES.approvals.has(kind)).toBe(false);
      expect(CAPABILITIES["add-mcp"].has(kind)).toBe(false);
    }
  });

  /**
   * The §3.3 hard line, pinned at the capability table: `serve` is the
   * agent-facing row, so no administrative verb may ever appear in it.
   * D-B1 added three READS; this fails if a future widening slips a
   * mutation in beside them.
   */
  it("INVARIANT §17 / §3.3: no administrative verb is reachable from serve", () => {
    for (const administrative of [
      "approvals.list",
      "approvals.resume",
      "source.provision",
      "source.revalidate",
    ] as const) {
      expect(CAPABILITIES.serve.has(administrative)).toBe(false);
    }
  });

  it("approvals = approvals.*/handshake", () => {
    expect(CAPABILITIES.approvals).toEqual(
      new Set(["approvals.list", "approvals.resume", "handshake"]),
    );
  });

  it("add-mcp = source.*/handshake", () => {
    expect(CAPABILITIES["add-mcp"]).toEqual(
      new Set(["source.provision", "source.revalidate", "handshake"]),
    );
  });

  it("denies approvals.resume to serve", () => {
    expect(CAPABILITIES.serve.has("approvals.resume")).toBe(false);
  });

  it("denies execute to approvals", () => {
    expect(CAPABILITIES.approvals.has("execute")).toBe(false);
  });

  it("denies execute to add-mcp", () => {
    expect(CAPABILITIES["add-mcp"].has("execute")).toBe(false);
  });
});

describe("control vocabulary", () => {
  it("decodes daemon.status and daemon.stop as nullary requests", () => {
    expect(decodeRequest({ kind: "daemon.status" })).toEqual({ kind: "daemon.status" });
    expect(decodeRequest({ kind: "daemon.stop" })).toEqual({ kind: "daemon.stop" });
  });

  it("rejects any field on the nullary control kinds — a client steers nothing", () => {
    expect(() => decodeRequest({ kind: "daemon.status", verbose: true })).toThrow(
      InvalidRpcRequest,
    );
    expect(() => decodeRequest({ kind: "daemon.stop", force: true })).toThrow(InvalidRpcRequest);
  });

  it("accepts a control-capability handshake", () => {
    expect(decodeRequest({ kind: "handshake", protocol: 1, capability: "control" })).toEqual({
      kind: "handshake",
      protocol: 1,
      capability: "control",
    });
  });

  it("scopes the control row to exactly handshake + the two daemon verbs", () => {
    expect([...CAPABILITIES.control].sort()).toEqual(["daemon.status", "daemon.stop", "handshake"]);
  });

  it("leaves the serve/approvals/add-mcp rows without any control verb", () => {
    for (const row of ["serve", "approvals", "add-mcp"] as const) {
      expect(CAPABILITIES[row].has("daemon.status")).toBe(false);
      expect(CAPABILITIES[row].has("daemon.stop")).toBe(false);
    }
  });
});
