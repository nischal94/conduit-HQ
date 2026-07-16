import { createHmac, randomBytes } from "node:crypto";
import type { McpClient, McpSession } from "./mcp-client.js";

/**
 * Per-drive upstream session scope: caches (client, session) pairs by url + auth digest,
 * with single-flighted concurrent acquires and best-effort disposal (never throws).
 * Auth material itself is never stored — only a salted HMAC digest is used as part of the cache key.
 */

export interface UpstreamSessionScope {
  /**
   * Returns the cached (client, session) for this exact (url, auth) binding,
   * creating it via `make` (single-flighted) on first use or after a key change.
   */
  acquire(args: {
    url: string;
    authHeaders: Record<string, string>;
    make: () => Promise<{ client: McpClient; session: McpSession }>;
  }): Promise<{ client: McpClient; session: McpSession }>;
  /** Best-effort teardown of every cached session. NEVER throws. */
  dispose(): Promise<void>;
}

/**
 * Produces a canonical serialization of auth headers: length-prefixed,
 * name-lowercased, sorted by lowercased name.
 * Returns "<no-auth>" when the record is empty.
 *
 * The bug fix from the brief: we must map each header to [lowercased-name, original-value],
 * NOT look up headers[n] after lowercasing the name (which would fail on mixed-case headers).
 */
function canonicalAuth(headers: Record<string, string>): string {
  const pairs = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  if (pairs.length === 0) return "<no-auth>";

  return pairs
    .map(([name, value]) => `${name.length}:${name}${String(value).length}:${value}`)
    .join("|");
}

export function createUpstreamSessionScope(log?: (line: string) => void): UpstreamSessionScope {
  const salt = randomBytes(16);
  const entries = new Map<string, Promise<{ client: McpClient; session: McpSession }>>();
  let disposed = false;

  return {
    async acquire(args) {
      const digest = createHmac("sha256", salt)
        .update(canonicalAuth(args.authHeaders))
        .digest("hex");
      const key = `${args.url}\n${digest}`;

      const existing = entries.get(key);
      if (existing !== undefined) return existing;

      const pending = args.make();
      entries.set(key, pending);

      try {
        return await pending;
      } catch (cause) {
        // failed handshakes are not cached
        entries.delete(key);
        throw cause;
      }
    },

    async dispose() {
      if (disposed) return;
      disposed = true;

      for (const pending of entries.values()) {
        try {
          const { client, session } = await pending;
          if (session.sessionId !== undefined) await client.deleteSession(session);
        } catch (cause) {
          log?.(
            `[UpstreamSessionScope] teardown failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }

      entries.clear();
    },
  };
}
