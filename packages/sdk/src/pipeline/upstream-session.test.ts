import { describe, expect, it } from "vitest";
import type { McpClient, McpSession } from "./mcp-client.js";
import { createUpstreamSessionScope } from "./upstream-session.js";

function fakeMake(label: string, made: string[], deleted: string[]) {
  return async (): Promise<{ client: McpClient; session: McpSession }> => {
    made.push(label);
    return {
      session: { protocolVersion: "2025-06-18", sessionId: `sid-${label}-${made.length}` },
      client: {
        initialize: async () => {
          throw new Error("unused");
        },
        listTools: async () => [],
        callTool: async () => ({ result: null, status: 200 }),
        deleteSession: async (s) => {
          deleted.push(s.sessionId ?? "none");
        },
      },
    };
  };
}

describe("INVARIANT §18-C4: per-drive session scope", () => {
  it("caches by url+auth and single-flights concurrent first acquires", async () => {
    const made: string[] = [];
    const scope = createUpstreamSessionScope();
    const args = {
      url: "http://u/mcp",
      authHeaders: { authorization: "Bearer a" },
      make: fakeMake("a", made, []),
    };
    const [one, two] = await Promise.all([scope.acquire(args), scope.acquire(args)]);
    expect(one.session).toBe(two.session);
    expect(made).toEqual(["a"]);
  });

  it("INVARIANT §18-C4: same-url same-ref secret rotation forces a new session (auth digest key)", async () => {
    const made: string[] = [];
    const scope = createUpstreamSessionScope();
    await scope.acquire({
      url: "http://u/mcp",
      authHeaders: { authorization: "Bearer old" },
      make: fakeMake("old", made, []),
    });
    await scope.acquire({
      url: "http://u/mcp",
      authHeaders: { authorization: "Bearer NEW" },
      make: fakeMake("new", made, []),
    });
    expect(made).toEqual(["old", "new"]);
  });

  it("a url change invalidates; unchanged binding reuses", async () => {
    const made: string[] = [];
    const scope = createUpstreamSessionScope();
    const auth = { authorization: "Bearer a" };
    await scope.acquire({
      url: "http://u1/mcp",
      authHeaders: auth,
      make: fakeMake("u1", made, []),
    });
    await scope.acquire({
      url: "http://u1/mcp",
      authHeaders: auth,
      make: fakeMake("u1b", made, []),
    });
    await scope.acquire({
      url: "http://u2/mcp",
      authHeaders: auth,
      make: fakeMake("u2", made, []),
    });
    expect(made).toEqual(["u1", "u2"]);
  });

  it("INVARIANT §18-C4: dispose deletes every cached session and never throws", async () => {
    const made: string[] = [];
    const deleted: string[] = [];
    const scope = createUpstreamSessionScope();
    await scope.acquire({
      url: "http://u/mcp",
      authHeaders: {},
      make: fakeMake("x", made, deleted),
    });
    await scope.dispose();
    expect(deleted).toHaveLength(1);
    // second dispose is a no-op, still resolves
    await expect(scope.dispose()).resolves.toBeUndefined();
  });

  it("dispose swallows a throwing deleteSession into the log", async () => {
    const lines: string[] = [];
    const scope = createUpstreamSessionScope((l) => lines.push(l));
    await scope.acquire({
      url: "http://u/mcp",
      authHeaders: {},
      make: async () => ({
        session: { protocolVersion: "2025-06-18", sessionId: "sid" },
        client: {
          initialize: async () => {
            throw new Error("x");
          },
          listTools: async () => [],
          callTool: async () => ({ result: null, status: 200 }),
          deleteSession: async () => {
            throw new Error("boom");
          },
        },
      }),
    });
    await expect(scope.dispose()).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes("boom"))).toBe(true);
  });

  it("a failed make is not cached (next acquire retries)", async () => {
    let calls = 0;
    const scope = createUpstreamSessionScope();
    const make = async () => {
      calls++;
      if (calls === 1) throw new Error("first fails");
      return await fakeMake("ok", [], [])();
    };
    await expect(scope.acquire({ url: "http://u/mcp", authHeaders: {}, make })).rejects.toThrow(
      "first fails",
    );
    await expect(
      scope.acquire({ url: "http://u/mcp", authHeaders: {}, make }),
    ).resolves.toBeDefined();
  });

  it("mixed-case header names produce the same cache key as lowercase", async () => {
    const made: string[] = [];
    const scope = createUpstreamSessionScope();

    // First acquire with mixed-case header name
    await scope.acquire({
      url: "http://u/mcp",
      authHeaders: { Authorization: "Bearer a" },
      make: fakeMake("a", made, []),
    });

    // Second acquire with lowercase header name - should reuse from cache
    await scope.acquire({
      url: "http://u/mcp",
      authHeaders: { authorization: "Bearer a" },
      make: fakeMake("b", made, []),
    });

    // make should only be called once (cache hit on second)
    expect(made).toEqual(["a"]);
  });
});
