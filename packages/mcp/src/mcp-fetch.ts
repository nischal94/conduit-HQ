import { createMcpClient, createPinnedLookup } from "@conduithq/sdk";

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
 * (+ any pagination / one session-expiry retry) must all complete within it.
 *
 * Exported since Task 8: this is the DAEMON-side bound on a
 * `source.provision`/`source.revalidate`, and `server.ts` derives the
 * client budget for those kinds from it so the client cannot abandon a
 * fetch the daemon is still legitimately performing. */
export const ONBOARDING_DEADLINE_MS = 5000;

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
 * **Egress IS pinned, with `allowPrivate: true`** (design §18-C4 D2,
 * "`add-mcp` passes `allowPrivate: true`"; daemon-ownership design §3.3.1,
 * "the §9.3 egress guard and its pinned lookup still apply on every hop").
 * The two halves are independent and both are load-bearing here:
 *
 * - **Pinned** (`createPinnedLookup`) closes DNS rebinding. Since Task 8 this
 *   fetch runs inside the long-lived, credential-holding daemon, and
 *   `source.revalidate` re-fetches a STORED url with the stored credential
 *   attached — so the URL is client-supplied or replayed from the store, not
 *   "operator-typed at the terminal". A hostname that resolves benignly on one
 *   hop and to a link-local/metadata address on the next would otherwise carry
 *   the `Authorization` header to the rebound target. Pinning resolves once and
 *   forces the socket to that vetted address, so the address the guard checked
 *   IS the address connected to.
 * - **`allowPrivate: true`** keeps onboarding able to reach a local upstream
 *   (`http://127.0.0.1:…/mcp`, a LAN MCP server) — a legitimate and common
 *   onboarding target, and the documented §18-C4 D2 posture. The private-address
 *   *filter* is what onboarding waives; the *pinning* is not waived.
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
      // §9.3 pinning on every hop (design §3.3.1). `allowPrivate` waives the
      // private-address filter — local upstreams are legitimate onboarding
      // targets — and nothing else: the lookup still resolves once and forces
      // the connect to that address, so no hop can be rebound after vetting.
      lookup: createPinnedLookup({ allowPrivate: true }),
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
