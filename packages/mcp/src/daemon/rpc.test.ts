import { describe, expect, it } from "vitest";
import { CAPABILITIES, decodeRequest, InvalidRpcRequest } from "./rpc.js";

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
      decodeRequest({ kind: "approvals.resume", executionId: "e1", decision: "approve" }),
    ).toEqual({ kind: "approvals.resume", executionId: "e1", decision: "approve" });
    expect(
      decodeRequest({ kind: "approvals.resume", executionId: "e1", decision: "deny" }),
    ).toEqual({ kind: "approvals.resume", executionId: "e1", decision: "deny" });
    expect(
      decodeRequest({
        kind: "source.provision",
        namespace: "ns",
        url: "https://example.com",
        secret: "s3cr3t",
      }),
    ).toEqual({
      kind: "source.provision",
      namespace: "ns",
      url: "https://example.com",
      secret: "s3cr3t",
    });
    expect(
      decodeRequest({ kind: "source.provision", namespace: "ns", url: "https://example.com" }),
    ).toEqual({ kind: "source.provision", namespace: "ns", url: "https://example.com" });
    expect(decodeRequest({ kind: "source.revalidate", namespace: "ns" })).toEqual({
      kind: "source.revalidate",
      namespace: "ns",
    });
  });

  it("rejects an unknown kind", () => {
    expect(() => decodeRequest({ kind: "nonsense" })).toThrow();
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
      decodeRequest({ kind: "approvals.resume", executionId: "e1", decision: "maybe" }),
    ).toThrow();
    expect(() => decodeRequest({ kind: "source.revalidate", namespace: 5 })).toThrow();
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
  it("serve = execute/search/describe/handshake", () => {
    expect(CAPABILITIES.serve).toEqual(new Set(["execute", "search", "describe", "handshake"]));
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
