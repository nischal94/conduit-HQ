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
    // CR-only terminators: two data lines with a blank line (\r\r) between the
    // events → two separate events. The trailing \n resolves the final CR so
    // nothing is left deferred.
    expect(p.push("data: a\r\rdata: b\r\r\n")).toEqual(["a", "b"]);
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
  it("INVARIANT §18-C4: a CRLF split across chunks frames as one event", () => {
    const p = createSseParser();
    // The trailing \r of chunk 1 must be DEFERRED — it is the first half of a
    // CRLF, not a CR-only line terminator.
    expect(p.push("data: one\r")).toEqual([]);
    expect(p.push("\ndata: two\r\n\r\n")).toEqual(["one\ntwo"]);
  });
  it("a lone CR at a chunk boundary that turns out to be CR-only frames correctly", () => {
    const p = createSseParser();
    expect(p.push("data: a\r")).toEqual([]);
    // The deferred \r is followed by another \r (not \n) → confirmed CR-only
    // terminators; the blank line ends event "a", then "b" is its own event.
    // The trailing \n resolves the final CR so nothing stays deferred.
    expect(p.push("\rdata: b\r\r\n")).toEqual(["a", "b"]);
  });
  it("flush resets the buffer so a reused parser never prepends stale content", () => {
    const p = createSseParser();
    // A partial line left in the buffer, then flushed.
    expect(p.push("data: stale")).toEqual([]);
    p.flush();
    // Reusing the SAME parser must NOT prepend the flushed partial.
    expect(p.push("data: x\n\n")).toEqual(["x"]);
  });
  it("flush terminates a trailing lone CR without leaking it into the payload", () => {
    const p = createSseParser();
    expect(p.push("data: x\r")).toEqual([]);
    expect(p.flush()).toEqual(["x"]);
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
