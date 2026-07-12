/** Hard cap on the response body, enforced DURING ingestion: raw bytes are
 * counted chunk-by-chunk off `response.body`'s reader, and the connection is
 * cancelled the moment the running total crosses the cap — a hostile
 * upstream that omits or understates Content-Length can therefore never make
 * this process buffer an unbounded body (at most the cap plus ~one chunk). */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Hard cap on the number of tools accepted from a single tools/list
 * response — bounds provisioning work independent of response size. */
export const MAX_TOOLS = 1024;

function byteCapError(url: string, detail: string): Error {
  return new Error(
    `[conduit add-mcp] upstream tools/list response for ${url} exceeds the ${MAX_RESPONSE_BYTES}-byte cap` +
      `${detail}; nothing was written.`,
  );
}

/**
 * `add-mcp`'s upstream precondition (design §2.2): fetch `tools/list` from an
 * MCP URL over the same bare JSON-RPC POST shape `scripts/seed-demo.mjs`
 * uses, with a 5s hard timeout. On ANY failure — network, non-2xx, malformed
 * body, oversized body, too many tools — this throws. It never falls back to
 * a fixture (that demo scaffolding stays in seed-demo.mjs); the caller
 * (add-mcp.ts) treats a throw as "fail loud, write nothing".
 */
export async function fetchToolsList(url: string): Promise<unknown[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`[conduit add-mcp] upstream responded ${response.status} for ${url}`);
  }
  // Cheap rejection when the upstream is honest about Content-Length —
  // avoids reading the body at all for an obviously-oversized response.
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw byteCapError(url, ` (Content-Length: ${declaredLength})`);
  }
  // Node's fetch (undici) always provides a ReadableStream body for a real
  // 2xx response; a null body here is a degenerate/empty response that can
  // never carry a tools array — treat it like any other malformed body.
  if (response.body === null) {
    throw new Error(
      `[conduit add-mcp] upstream tools/list response missing result.tools array for ${url}`,
    );
  }
  // The cap is enforced WHILE streaming, not after buffering: a hostile
  // upstream that omits/understates Content-Length gets its connection
  // cancelled the moment the received byte count crosses the cap — the
  // whole body is never resident in memory.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw byteCapError(url, "");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  let payload: { result?: { tools?: unknown } };
  try {
    payload = JSON.parse(text) as { result?: { tools?: unknown } };
  } catch (cause) {
    throw new Error(
      `[conduit add-mcp] upstream tools/list response missing result.tools array for ${url}`,
      { cause },
    );
  }
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(
      `[conduit add-mcp] upstream tools/list response missing result.tools array for ${url}`,
    );
  }
  if (tools.length > MAX_TOOLS) {
    throw new Error(
      `[conduit add-mcp] upstream tools/list response for ${url} exceeds the ${MAX_TOOLS}-tool cap ` +
        `(got ${tools.length}); nothing was written.`,
    );
  }
  return tools;
}
