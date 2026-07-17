import { describe, expect, it } from "vitest";
import { classifyJsonRpc, createSseParser } from "./mcp-wire.js";

describe("createSseParser", () => {
  it("emits a data payload terminated by a blank line", () => {
    const p = createSseParser();
    expect(p.push('event: message\ndata: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });
  it("joins multi-data lines and handles chunk splits mid-line", () => {
    const p = createSseParser();
    expect(p.push("data: hel")).toEqual([]);
    expect(p.push("lo\ndata: world\n\n")).toEqual(["hello\nworld"]);
  });
  it("ignores comments, event names, id and retry fields", () => {
    const p = createSseParser();
    expect(p.push(": comment\nid: 7\nretry: 100\ndata: x\n\n")).toEqual(["x"]);
  });
  it("flush returns an unterminated trailing payload", () => {
    const p = createSseParser();
    p.push("data: tail");
    expect(p.flush()).toEqual(["tail"]);
  });
  it("INVARIANT §18-C4: splits on CR-only line endings (WHATWG SSE)", () => {
    const p = createSseParser();
    expect(p.push("data: a\rdata: b\r\r")).toEqual(["a\nb"]);
  });
  it("INVARIANT §18-C4: strips a single leading BOM at stream start", () => {
    const p = createSseParser();
    expect(p.push('﻿data: {"a":1}\n\n')).toEqual(['{"a":1}']);
  });
  it("strips the BOM even when it arrives split from the rest", () => {
    const p = createSseParser();
    expect(p.push("﻿")).toEqual([]);
    expect(p.push("data: x\n\n")).toEqual(["x"]);
  });
});

describe("classifyJsonRpc", () => {
  it("matches the response by id", () => {
    const [m] = classifyJsonRpc('{"jsonrpc":"2.0","id":"r1","result":{"ok":true}}', "r1", false);
    expect(m).toEqual({ kind: "response", message: { id: "r1", result: { ok: true } } });
  });
  it("classifies a server ping request", () => {
    const [m] = classifyJsonRpc('{"jsonrpc":"2.0","id":9,"method":"ping"}', "r1", false);
    expect(m).toEqual({ kind: "ping", id: 9 });
  });
  it("classifies notifications and unrelated responses as other", () => {
    expect(
      classifyJsonRpc('{"jsonrpc":"2.0","method":"notifications/progress"}', "r1", false)[0],
    ).toEqual({ kind: "other" });
    expect(classifyJsonRpc('{"jsonrpc":"2.0","id":"zzz","result":1}', "r1", false)[0]).toEqual({
      kind: "other",
    });
  });
  it("accepts batches only when allowed (2025-03-26)", () => {
    const batch = '[{"jsonrpc":"2.0","id":"r1","result":1},{"jsonrpc":"2.0","method":"x"}]';
    expect(classifyJsonRpc(batch, "r1", true).some((m) => m.kind === "response")).toBe(true);
    expect(() => classifyJsonRpc(batch, "r1", false)).toThrow(/malformed JSON-RPC payload/);
  });
  it("throws on unparseable JSON", () => {
    expect(() => classifyJsonRpc("{nope", "r1", false)).toThrow(/malformed JSON-RPC payload/);
  });
  it("INVARIANT §18-C4: a matched id with neither result nor error is a protocol violation, not a response", () => {
    expect(() => classifyJsonRpc('{"jsonrpc":"2.0","id":"r1"}', "r1", false)).toThrow(
      /neither a result nor an error/,
    );
  });
  it("INVARIANT §18-C4: a null error member with no result is a malformed envelope, not a response", () => {
    // {error: null} is not a valid error member — it must NOT classify as a
    // response (which would let initialize read error.message off null → TypeError).
    expect(() => classifyJsonRpc('{"jsonrpc":"2.0","id":"r1","error":null}', "r1", false)).toThrow(
      /neither a result nor an error/,
    );
  });
  it("a well-formed error member still classifies as an error response", () => {
    const [m] = classifyJsonRpc(
      '{"jsonrpc":"2.0","id":"r1","error":{"code":-32601,"message":"nope"}}',
      "r1",
      false,
    );
    expect(m).toEqual({
      kind: "response",
      message: { id: "r1", error: { code: -32601, message: "nope" } },
    });
  });
});
