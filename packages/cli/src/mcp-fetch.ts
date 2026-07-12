/** Hard cap on the decoded response body (bytes, UTF-16 code units as a
 * proxy — good enough since the check is a DoS/memory-exhaustion guard, not
 * a byte-exact accounting requirement). A hostile upstream returning an
 * unbounded body must not be read into memory in full before rejection. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Hard cap on the number of tools accepted from a single tools/list
 * response — bounds provisioning work independent of response size. */
export const MAX_TOOLS = 1024;

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
    throw new Error(
      `[conduit add-mcp] upstream tools/list response for ${url} exceeds the ${MAX_RESPONSE_BYTES}-byte cap ` +
        `(Content-Length: ${declaredLength}); nothing was written.`,
    );
  }
  // A hostile or misconfigured upstream can omit/understate Content-Length,
  // so the decoded body itself is checked against the same cap before
  // JSON.parse ever sees it.
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `[conduit add-mcp] upstream tools/list response for ${url} exceeds the ${MAX_RESPONSE_BYTES}-byte cap; ` +
        `nothing was written.`,
    );
  }
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
