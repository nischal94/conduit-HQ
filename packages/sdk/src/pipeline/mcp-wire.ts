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
  function consumeLine(line: string): void {
    if (line === "") {
      if (dataLines.length > 0) complete.push(dataLines.join("\n"));
      dataLines = [];
      return;
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // comments (:), event:, id:, retry: — ignored (resumption is a D6 non-goal)
  }
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      let idx: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard line-scan loop
      while ((idx = buffer.indexOf("\n")) !== -1) {
        consumeLine(buffer.slice(0, idx).replace(/\r$/, ""));
        buffer = buffer.slice(idx + 1);
      }
      return complete.splice(0);
    },
    flush(): string[] {
      if (buffer !== "") consumeLine(buffer.replace(/\r$/, ""));
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
    const response: ClassifyOneResponse = {
      id: m.id as string,
    };
    if ("result" in m) response.result = m.result;
    if ("error" in m) response.error = m.error as { code: number; message: string };
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
