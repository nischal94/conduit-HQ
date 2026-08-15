/**
 * Wire framing for the daemon UDS protocol (design §3.3). A frame is a
 * 4-byte big-endian length prefix followed by that many bytes of UTF-8
 * JSON. Stream-based transports (Unix domain sockets) deliver arbitrary
 * chunk boundaries — a message can span chunks, and a single chunk can
 * carry multiple messages — so `FrameDecoder` is an incremental,
 * cap-enforcing state machine rather than a one-shot parse.
 *
 * Both caps are normative, not configurable: FRAME_CAP bounds memory a
 * hostile or buggy peer can force the decoder to buffer, and DEPTH_CAP
 * bounds recursion depth so a deeply nested payload can't blow the stack
 * during traversal (this module's own depth counter, not V8's JSON.parse
 * recursion, is what's bounded — JSON.parse itself does not recurse per
 * nesting level, so it is bounds-checked here after parsing).
 *
 * The length prefix is checked against FRAME_CAP as soon as it is known —
 * before a single byte of the body is appended to any buffer. A peer
 * claiming a multi-gigabyte body can never force this decoder to
 * allocate or accumulate that much memory; the header alone is enough to
 * reject it.
 */

export const FRAME_CAP = 1024 * 1024; // 1 MiB, normative
export const DEPTH_CAP = 64; // normative

const HEADER_LEN = 4;

export class FrameTooLarge extends Error {
  constructor(size: number) {
    super(`frame body size ${size} exceeds cap ${FRAME_CAP}`);
    this.name = "FrameTooLarge";
  }
}

export class DepthExceeded extends Error {
  constructor() {
    super(`JSON nesting depth exceeds cap ${DEPTH_CAP}`);
    this.name = "DepthExceeded";
  }
}

export class MalformedFrame extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedFrame";
  }
}

export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  if (body.length > FRAME_CAP) {
    throw new FrameTooLarge(body.length);
  }
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Depth of a parsed JSON value: a scalar (string/number/boolean/null) is
 * depth 0; each array/object nesting level adds 1. An empty array/object
 * counts as depth 1 (a container level exists even with no children).
 */
function checkDepth(value: unknown, depth: number): void {
  if (depth > DEPTH_CAP) {
    throw new DepthExceeded();
  }
  if (Array.isArray(value)) {
    for (const item of value) checkDepth(item, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      checkDepth((value as Record<string, unknown>)[key], depth + 1);
    }
  }
}

/**
 * Incremental frame decoder. `push` accepts an arbitrary chunk of bytes
 * (which may contain zero, one, or many complete frames, and may end
 * mid-frame) and returns every fully-decoded message the chunk
 * completed. Internal buffering state persists across calls.
 *
 * Error behavior: a thrown error reflects a specific malformed/oversized
 * frame. Any bytes already consumed toward the frame that caused the
 * error are dropped; subsequent, independent `push` calls with
 * well-formed frames continue to work normally.
 *
 * Memory bound: this class answers "how much memory can a hostile local
 * process force this decoder to hold?" `buf` only ever retains bytes
 * belonging to a not-yet-complete frame (a partial header, or a partial
 * body whose declared length has already been checked against
 * FRAME_CAP). Every fully-received frame is sliced off and discarded from
 * `buf` in the same `push` call that completes it. So at any point
 * between calls, `buf.length < HEADER_LEN + FRAME_CAP` — strictly less
 * than a 4-byte length prefix plus one capped body. Transiently, mid-call,
 * `buf` can briefly be as large as the previous residual plus one whole
 * incoming chunk (`Buffer.concat` in the line below), but that too is
 * bounded by the caller's chunk size, which for a UDS read is bounded by
 * the OS socket buffer.
 *
 * Ownership: `push` never retains a reference to the caller's `chunk`
 * buffer past the end of the call. Any unconsumed tail is always copied
 * into `buf` (via `Buffer.concat`, which always allocates a fresh
 * buffer) rather than aliased — a caller that mutates or reuses `chunk`
 * after `push` returns can never corrupt a partially-assembled frame.
 */
export class FrameDecoder {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  // Length of the body currently being awaited, once the header for it
  // has been read and validated against FRAME_CAP. null = no header
  // parsed yet for the frame currently being assembled.
  private pendingBodyLen: number | null = null;

  push(chunk: Buffer): unknown[] {
    // Always copy into a fresh buffer — never alias the caller's chunk.
    // `Buffer.concat` always allocates, even for a single-element array,
    // so this holds whether or not there's residual state to merge with.
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];

    for (;;) {
      if (this.pendingBodyLen === null) {
        if (this.buf.length < HEADER_LEN) break;
        const len = this.buf.readUInt32BE(0);
        if (len > FRAME_CAP) {
          // Reject immediately from the header alone. Drop the header
          // bytes so the decoder doesn't get stuck re-reading the same
          // oversized-length header on a future push.
          this.buf = this.buf.subarray(HEADER_LEN);
          throw new FrameTooLarge(len);
        }
        this.pendingBodyLen = len;
        this.buf = this.buf.subarray(HEADER_LEN);
      }

      const bodyLen = this.pendingBodyLen;
      if (this.buf.length < bodyLen) break;

      const bodyBytes = this.buf.subarray(0, bodyLen);
      this.buf = this.buf.subarray(bodyLen);
      this.pendingBodyLen = null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyBytes.toString("utf8"));
      } catch (err) {
        throw new MalformedFrame(
          `failed to parse frame body as JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      checkDepth(parsed, 0);
      out.push(parsed);
    }

    return out;
  }
}
