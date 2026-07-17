/**
 * Wire-level helpers for the MCP streamable-HTTP client (design D2):
 * an incremental SSE frame parser and JSON-RPC message classification.
 * Pure functions — no I/O, no caps (the caller's capped reader feeds them).
 */

export type WireMessage =
  | {
      kind: "response";
      message: { id: string; result?: unknown; error?: { code: number; message: string } };
    }
  | { kind: "ping"; id: string | number }
  | { kind: "other" };

export function createSseParser(): { push(chunk: string): string[]; flush(): string[] } {
  let buffer = "";
  let dataLines: string[] = [];
  const complete: string[] = [];
  // WHATWG SSE: a single leading U+FEFF BOM is stripped at stream start (once,
  // possibly after arriving split from the rest of the first chunk).
  let bomChecked = false;
  function consumeLine(line: string): void {
    if (line === "") {
      if (dataLines.length > 0) complete.push(dataLines.join("\n"));
      dataLines = [];
      return;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // comments (:), event:, id:, retry: — ignored (resumption is a D6 non-goal)
  }
  // WHATWG SSE line endings: CR, LF, or CRLF. Scan for the next boundary and
  // report both its index and its length. A LONE CR that is the LAST char of
  // the buffer is DEFERRED (return undefined): it could be the first half of a
  // CRLF split across chunks, and consuming it early would frame a multi-line
  // event as two. It stays buffered until the next push reveals the following
  // char (or flush treats it as a terminator).
  function nextBreak(s: string): { idx: number; len: number } | undefined {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\n") return { idx: i, len: 1 };
      if (ch === "\r") {
        if (s[i + 1] === "\n") return { idx: i, len: 2 }; // CRLF
        if (i + 1 < s.length) return { idx: i, len: 1 }; // confirmed CR-only
        return undefined; // trailing lone CR — defer until the next char is known
      }
    }
    return undefined;
  }
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      if (!bomChecked) {
        // Only strip once we have at least one char to inspect; a lone "" chunk
        // leaves the check pending for the next push.
        if (buffer.length > 0) {
          if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
          bomChecked = true;
        }
      }
      let brk: { idx: number; len: number } | undefined;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard line-scan loop
      while ((brk = nextBreak(buffer)) !== undefined) {
        consumeLine(buffer.slice(0, brk.idx));
        buffer = buffer.slice(brk.idx + brk.len);
      }
      // A trailing lone CR (if any) stays in `buffer`, held pending to
      // disambiguate a CRLF split across chunks.
      return complete.splice(0);
    },
    flush(): string[] {
      // At stream end a trailing lone CR IS a line terminator — strip it so it
      // never leaks into the data payload.
      if (buffer !== "") consumeLine(buffer.replace(/\r$/, ""));
      buffer = "";
      if (dataLines.length > 0) {
        complete.push(dataLines.join("\n"));
        dataLines = [];
      }
      return complete.splice(0);
    },
  };
}

interface ClassifyOneResponse {
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

function classifyOne(msg: unknown, expectedId: string): WireMessage {
  if (typeof msg !== "object" || msg === null) return { kind: "other" };
  const m = msg as Record<string, unknown>;
  if (m.method === "ping" && (typeof m.id === "string" || typeof m.id === "number")) {
    return { kind: "ping", id: m.id };
  }
  if (m.id === expectedId && m.method === undefined) {
    // An `error` member counts only when it is a non-null object: a hostile
    // `{"error": null}` is NOT a valid error member, so it must not classify as
    // an error response (initialize/listTools/callTool would then read
    // `error.message`/`.code` off null → TypeError). Treating it as absent
    // routes it into the malformed-envelope throw below when no result exists.
    const hasError = "error" in m && typeof m.error === "object" && m.error !== null;
    // A matched id with NEITHER a result key NOR a valid error is a malformed
    // envelope, never a {result: undefined} success the caller could memoize as
    // null (the hardening d534e26 added to the pre-rewrite upstream caller).
    // JSON cannot encode undefined, so `"result" in m` is the right presence test.
    if (!("result" in m) && !hasError) {
      throw new Error("malformed JSON-RPC payload: response carried neither a result nor an error");
    }
    const response: ClassifyOneResponse = {
      id: m.id as string,
    };
    if ("result" in m) response.result = m.result;
    if (hasError) response.error = m.error as { code: number; message: string };
    return { kind: "response", message: response };
  }
  return { kind: "other" };
}

export function classifyJsonRpc(
  payload: string,
  expectedId: string,
  allowBatch: boolean,
): WireMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new Error("malformed JSON-RPC payload: not valid JSON", { cause });
  }
  if (Array.isArray(parsed)) {
    if (!allowBatch)
      throw new Error(
        "malformed JSON-RPC payload: batch received but the negotiated protocol version forbids batching",
      );
    return parsed.map((m) => classifyOne(m, expectedId));
  }
  return [classifyOne(parsed, expectedId)];
}
