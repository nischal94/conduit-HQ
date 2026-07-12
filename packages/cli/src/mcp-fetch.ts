/**
 * `add-mcp`'s upstream precondition (design §2.2): fetch `tools/list` from an
 * MCP URL over the same bare JSON-RPC POST shape `scripts/seed-demo.mjs`
 * uses, with a 5s hard timeout. On ANY failure — network, non-2xx, malformed
 * body — this throws. It never falls back to a fixture (that demo scaffolding
 * stays in seed-demo.mjs); the caller (add-mcp.ts) treats a throw as "fail
 * loud, write nothing".
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
  const payload = (await response.json()) as { result?: { tools?: unknown } };
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error(
      `[conduit add-mcp] upstream tools/list response missing result.tools array for ${url}`,
    );
  }
  return tools;
}
