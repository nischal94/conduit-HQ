import { createMcpClient } from "@conduithq/sdk";

/** Hard cap on the cumulative response bytes across the whole onboarding
 * fetch, enforced DURING ingestion by the shared client's capped reader: raw
 * bytes are counted chunk-by-chunk off the wire and the connection is
 * cancelled the moment the running total crosses the cap — a hostile upstream
 * that omits or understates Content-Length can therefore never make this
 * process buffer an unbounded body. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Hard cap on the number of tools accepted from a tools/list response
 * (summed across pagination pages) — bounds provisioning work independent of
 * response size. */
export const MAX_TOOLS = 1024;

/** Absolute whole-operation deadline for onboarding: handshake + tools/list
 * (+ any pagination / one session-expiry retry) must all complete within it. */
const ONBOARDING_DEADLINE_MS = 5000;

/**
 * `add-mcp`'s upstream precondition (design §2.2, §18-C4/C5): fetch
 * `tools/list` from an MCP URL over the SHARED streamable-HTTP client
 * (`createMcpClient`, packages/sdk/src/pipeline/mcp-client.ts) — the same
 * handshake (`initialize` / `notifications/initialized` / `tools/list`) the
 * serve-time path speaks. On ANY failure — network, non-2xx, malformed body,
 * oversized body, too many tools, timeout — this throws (an `McpClientError`
 * from the client, or a plain Error); the caller (add-mcp.ts) maps the throw
 * to a specific fail-loud line and writes nothing.
 *
 * Egress is NOT pinned here (design §18-C4 D2, "Egress is a per-call option"):
 * the URL is operator-typed at the terminal, so onboarding uses plain DNS (no
 * pinned `lookup`) — the SSRF protections target agent-driven URLs, not an
 * operator's own upstream. Serve-time (`upstream.ts`) always pins.
 */
export async function fetchToolsList(
  url: string,
  opts?: { authorization?: string },
): Promise<unknown[]> {
  const target = new URL(url);
  const startedAt = Date.now();
  const client = createMcpClient(
    {
      target,
      // §9.2: the resolved secret rides as a request-scoped header, verbatim,
      // never interpolated or logged. Omitted entirely when no auth is
      // resolved (an unauthenticated onboarding fetch is legitimate — §9.1).
      headers: opts?.authorization !== undefined ? { authorization: opts.authorization } : {},
      // No `lookup`: onboarding does not pin egress (design §18-C4 D2).
    },
    {
      deadline: () => Math.max(0, ONBOARDING_DEADLINE_MS - (Date.now() - startedAt)),
      maxBytes: MAX_RESPONSE_BYTES,
    },
  );
  const session = await client.initialize();
  const tools = await client.listTools(session, MAX_TOOLS);
  // Best-effort teardown: a failed DELETE must not fail an otherwise-good
  // onboarding fetch (the tools are already in hand).
  await client.deleteSession(session).catch(() => {});
  return tools;
}
