// packages/cli/src/demo/upstream.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TOOL, type DemoUpstream, startDemoUpstream } from "./upstream.js";

async function rpc(url: string, method: string, params?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
    signal: AbortSignal.timeout(2000),
  });
}

describe("demo upstream", () => {
  let upstream: DemoUpstream | undefined;
  afterEach(async () => {
    await upstream?.close();
    upstream = undefined;
  });

  it("answers initialize and tools/list, and records nothing for them", async () => {
    upstream = await startDemoUpstream();
    expect(upstream.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const init = await rpc(upstream.url, "initialize", {});
    expect(init.status).toBe(200);
    const list = (await (await rpc(upstream.url, "tools/list")).json()) as {
      result: { tools: { name: string; annotations?: unknown }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual([DEMO_TOOL]);
    expect(list.result.tools[0]?.annotations).toBeUndefined();
    expect(upstream.calls).toEqual([]);
  });

  it("readOnly: true annotates the tool readOnlyHint", async () => {
    upstream = await startDemoUpstream({ readOnly: true });
    const list = (await (await rpc(upstream.url, "tools/list")).json()) as {
      result: { tools: { annotations?: unknown }[] };
    };
    expect(list.result.tools[0]?.annotations).toEqual({ readOnlyHint: true });
  });

  it("records each tools/call with its exact arguments", async () => {
    upstream = await startDemoUpstream();
    await rpc(upstream.url, "tools/call", { name: DEMO_TOOL, arguments: { title: "a" } });
    await rpc(upstream.url, "tools/call", { name: DEMO_TOOL, arguments: { title: "b" } });
    expect(upstream.calls).toEqual([
      { name: DEMO_TOOL, arguments: { title: "a" } },
      { name: DEMO_TOOL, arguments: { title: "b" } },
    ]);
  });

  it("refuses GET (no SSE stream) and a body that is not JSON", async () => {
    upstream = await startDemoUpstream();
    const get = await fetch(upstream.url, { signal: AbortSignal.timeout(2000) });
    expect(get.status).toBe(405);
    const bad = await fetch(upstream.url, {
      method: "POST",
      body: "not json",
      signal: AbortSignal.timeout(2000),
    });
    expect(bad.status).toBe(400);
    for (const body of ["null", "[]"]) {
      const notObject = await fetch(upstream.url, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(2000),
      });
      expect(notObject.status).toBe(400);
    }
    expect(upstream.calls).toEqual([]);
  });
});
