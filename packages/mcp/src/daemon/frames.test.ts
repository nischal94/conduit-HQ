import { describe, expect, it } from "vitest";
import {
  DEPTH_CAP,
  DecoderPoisoned,
  DepthExceeded,
  encodeFrame,
  FRAME_CAP,
  FrameDecoder,
  FrameTooLarge,
  MalformedFrame,
} from "./frames.js";

describe("encodeFrame / FrameDecoder round-trip", () => {
  it("round-trips a simple message", () => {
    const msg = { kind: "handshake", protocol: 1 };
    const frame = encodeFrame(msg);
    const decoder = new FrameDecoder();
    const out = decoder.push(frame);
    expect(out).toEqual([msg]);
  });

  it("reassembles a frame split across multiple chunks", () => {
    const msg = { kind: "result", requestId: "abc", payload: { a: [1, 2, 3], b: "hello world" } };
    const frame = encodeFrame(msg);
    const decoder = new FrameDecoder();

    const mid = Math.floor(frame.length / 2);
    const first = frame.subarray(0, mid);
    const second = frame.subarray(mid);

    expect(decoder.push(first)).toEqual([]);
    expect(decoder.push(second)).toEqual([msg]);
  });

  it("reassembles byte-by-byte", () => {
    const msg = { kind: "search", query: "foo" };
    const frame = encodeFrame(msg);
    const decoder = new FrameDecoder();

    let results: unknown[] = [];
    for (let i = 0; i < frame.length; i++) {
      results = results.concat(decoder.push(frame.subarray(i, i + 1)));
    }
    expect(results).toEqual([msg]);
  });

  it("does not retain a reference to the caller's chunk: mutating the source buffer after a partial push does not corrupt the pending frame", () => {
    const msg = { kind: "search", query: "hello world this is a payload" };
    const frame = encodeFrame(msg);
    const decoder = new FrameDecoder();

    const mid = Math.floor(frame.length / 2);
    const first = Buffer.from(frame.subarray(0, mid)); // owned, mutable copy
    const second = frame.subarray(mid);

    expect(decoder.push(first)).toEqual([]);
    // Mutate the source buffer after the partial push returns. If the
    // decoder aliased `first` instead of copying it, this corrupts the
    // in-flight frame.
    first.fill(0);

    expect(decoder.push(second)).toEqual([msg]);
  });

  it("decodes multiple frames delivered in a single chunk", () => {
    const msg1 = { kind: "handshake", protocol: 1 };
    const msg2 = { kind: "approvals.list" };
    const combined = Buffer.concat([encodeFrame(msg1), encodeFrame(msg2)]);
    const decoder = new FrameDecoder();
    expect(decoder.push(combined)).toEqual([msg1, msg2]);
  });

  it("throws FrameTooLarge when the length prefix exceeds the cap, without buffering the payload", () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(FRAME_CAP + 1, 0);

    expect(() => decoder.push(header)).toThrow(FrameTooLarge);
  });

  it("rejects a frame whose body reaches the cap+1 boundary via length prefix alone (does not wait for body bytes)", () => {
    const decoder = new FrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(FRAME_CAP + 1, 0);
    // Only the header is pushed — no body bytes at all. The decoder must
    // reject immediately from the length prefix, proving it never
    // attempts to buffer FRAME_CAP+1 bytes of payload.
    let threw = false;
    try {
      decoder.push(header);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(FrameTooLarge);
    }
    expect(threw).toBe(true);
  });

  it("accepts a frame exactly at the cap", () => {
    // Build a JSON payload whose byte length is exactly FRAME_CAP.
    const overhead = JSON.stringify({ kind: "search", query: "" }).length;
    const padLen = FRAME_CAP - overhead;
    const msg = { kind: "search", query: "x".repeat(padLen) };
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    expect(body.length).toBe(FRAME_CAP);

    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    const frame = Buffer.concat([header, body]);

    const decoder = new FrameDecoder();
    const out = decoder.push(frame);
    expect(out).toEqual([msg]);
  });

  it("accepts nesting exactly at DEPTH_CAP but throws DepthExceeded one level deeper", () => {
    // nested(n) produces n levels of array wrapping around a scalar,
    // i.e. a value whose maximum nesting depth is exactly n.
    function nested(depth: number): unknown {
      let v: unknown = 0;
      for (let i = 0; i < depth; i++) {
        v = [v];
      }
      return v;
    }

    const okMsg = nested(DEPTH_CAP);
    const okFrame = encodeFrame(okMsg);
    const okDecoder = new FrameDecoder();
    expect(() => okDecoder.push(okFrame)).not.toThrow();

    const tooDeep = nested(DEPTH_CAP + 1);
    const badFrame = encodeFrame(tooDeep);
    const badDecoder = new FrameDecoder();
    expect(() => badDecoder.push(badFrame)).toThrow(DepthExceeded);
  });

  it("throws MalformedFrame on invalid JSON body", () => {
    const body = Buffer.from("{not json", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    const frame = Buffer.concat([header, body]);

    const decoder = new FrameDecoder();
    expect(() => decoder.push(frame)).toThrow(MalformedFrame);
  });

  it("a decoder that threw is POISONED — reuse throws rather than returning plausible nonsense", () => {
    // The decoder used to document recovery across independent pushes.
    // That contract was false for FrameTooLarge: the oversized body's
    // bytes are never consumed, so the next push reads a length prefix
    // at an arbitrary offset inside it and every subsequent "frame" is
    // garbage derived from attacker- or bug-chosen bytes. Rather than
    // recover selectively, any throw poisons the decoder — both callers
    // already tear the connection down, which is the only correct
    // disposition once the stream has desynchronized.
    const badBody = Buffer.from("{not json", "utf8");
    const badHeader = Buffer.alloc(4);
    badHeader.writeUInt32BE(badBody.length, 0);

    const decoder = new FrameDecoder();
    expect(() => decoder.push(Buffer.concat([badHeader, badBody]))).toThrow(MalformedFrame);

    // A perfectly well-formed frame is still refused: the decoder cannot
    // know where this stream's frame boundaries are any more.
    expect(() => decoder.push(encodeFrame({ kind: "handshake", protocol: 1 }))).toThrow(
      DecoderPoisoned,
    );
  });

  it("an oversized frame poisons the decoder too — the desync case the old doc got wrong", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(FRAME_CAP + 1, 0);

    const decoder = new FrameDecoder();
    expect(() => decoder.push(header)).toThrow(FrameTooLarge);
    expect(() => decoder.push(encodeFrame({ kind: "ready" }))).toThrow(DecoderPoisoned);
  });
});
