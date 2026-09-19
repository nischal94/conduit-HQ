import { describe, expect, it, vi } from "vitest";
import { InMemoryCatalog } from "./catalog.js";
import {
  buildExecuteTool,
  createCatalogToolHost,
  createScopedCatalogToolHost,
  estimateTokens,
} from "./execute.js";
import { QuickJSSandbox } from "./sandbox/quickjs.js";
import { ALL_TOOLS, buildEffectiveScope, DEFAULT_PROFILE_GRANT } from "./scope.js";
import type { Tool } from "./types.js";

/** The §4.2 demo configuration: the connections the spec prices at ~1,044 tokens. */
const DEMO_CONNECTIONS = [
  { prefix: "github.org.main", label: "Production GitHub" },
  { prefix: "stripe.org.main", label: "Live Stripe account" },
  { prefix: "jira.org.main", label: "Team Jira" },
];

function tool(overrides: Partial<Tool> & Pick<Tool, "name" | "namespace">): Tool {
  return {
    inputSchema: { type: "object" },
    outputSchema: {},
    riskClass: "safe",
    sourceSemantics: { kind: "mcp" },
    ...overrides,
  };
}

describe("buildExecuteTool", () => {
  it("INVARIANT §4.2: the execute surface serializes within the one-tool token budget (~1,044)", () => {
    const definition = buildExecuteTool({ connections: DEMO_CONNECTIONS });
    expect(estimateTokens(definition)).toBeLessThanOrEqual(1_044);
  });

  it("advertises the §6 workflow, §8 search guidance, and connection prefixes", () => {
    const definition = buildExecuteTool({ connections: DEMO_CONNECTIONS });
    expect(definition.name).toBe("execute");
    expect(definition.description).toContain("tools.search({ query })");
    expect(definition.description).toContain("tools.describe.tool({ path, includeSchemas: true })");
    expect(definition.description).toContain("retry with synonyms");
    for (const connection of DEMO_CONNECTIONS) {
      expect(definition.description).toContain(`${connection.prefix} : ${connection.label}`);
    }
  });

  it("marks the connection listing explicitly when none are configured", () => {
    const definition = buildExecuteTool({ connections: [] });
    expect(definition.description).toContain("(none configured yet)");
  });

  it("INVARIANT §4.2: the definition stays under budget with 100 connections (capped listing)", () => {
    const connections = Array.from({ length: 100 }, (_, i) => ({
      prefix: `service${i}.org.main`,
      label: `Service ${i} connection with a fairly long label`,
    }));
    const definition = buildExecuteTool({ connections });
    expect(estimateTokens(definition)).toBeLessThanOrEqual(1_044);
    expect(definition.description).toContain("…and 90 more — search the catalog");
  });
});

describe("createCatalogToolHost", () => {
  const catalog = new InMemoryCatalog();
  catalog.upsert([
    tool({
      name: "github.issues.list",
      namespace: "github",
      description: "List issues in a repository",
      inputSchema: { type: "object", properties: { owner: { type: "string" } } },
    }),
  ]);

  it("answers search and describe from the catalog", async () => {
    const host = createCatalogToolHost(catalog, async () => null);
    const hits = await host.search({ query: "list issues" });
    expect(hits[0]?.path).toBe("github.issues.list");
    const described = await host.describe("github.issues.list", { includeSchemas: true });
    expect(described?.inputSchema).toEqual({
      type: "object",
      properties: { owner: { type: "string" } },
    });
  });

  it("delegates invocation to the injected pipeline", async () => {
    const invocations: Array<{ path: string; input: unknown }> = [];
    const host = createCatalogToolHost(catalog, async (path, input) => {
      invocations.push({ path, input });
      return { ok: true };
    });
    await expect(host.call("github.issues.list", { owner: "acme" })).resolves.toEqual({
      ok: true,
    });
    expect(invocations).toEqual([{ path: "github.issues.list", input: { owner: "acme" } }]);
  });

  it("runs the full §6 4-step workflow end to end through the sandbox", async () => {
    const host = createCatalogToolHost(catalog, async (path) =>
      path === "github.issues.list" ? [{ number: 7, title: "bug" }] : null,
    );
    const result = await new QuickJSSandbox().execute({
      code: `
        const { items } = await tools.search({ query: "list issues" });
        const path = items[0]?.path;
        const details = await tools.describe.tool({ path, includeSchemas: true });
        const result = await tools[path]({ owner: "acme", repo: "site" });
        return { path, hasSchema: details.inputSchema !== undefined, issues: result };
      `,
      tools: host,
    });
    expect(result).toMatchObject({
      status: "completed",
      value: {
        path: "github.issues.list",
        hasSchema: true,
        issues: [{ number: 7, title: "bug" }],
      },
    });
  });
});

describe("createScopedCatalogToolHost (§5.2, #43)", () => {
  const mk = (name: string, description: string): Tool => ({
    name,
    namespace: name.split(".")[0] as string,
    description,
    inputSchema: { type: "object" },
    outputSchema: {},
    riskClass: "safe",
    sourceSemantics: { kind: "mcp" },
  });
  const disallowed = Array.from({ length: 10 }, (_, i) => mk(`ops.deploy_${i}`, ""));
  const catalog = new InMemoryCatalog();
  // ten disallowed tools that out-rank the one allowed tool on the query "deploy"
  catalog.upsert(
    Array.from({ length: 10 }, (_, i) => mk(`ops.deploy_${i}`, "deploy deploy deploy")),
  );
  catalog.upsert([mk("allowed.thing", "deploy")]);
  const scope = async () =>
    buildEffectiveScope(
      { projections: { code: true, direct: false, discovery: false }, allow: ["allowed"] },
      [...disallowed, mk("allowed.thing", "")],
    );
  const invoke = vi.fn(async () => ({}));

  it("INVARIANT §5.3 (#43): eligibility is applied BEFORE ranking and the limit — an allowed tool ranked below ten disallowed ones is still returned", async () => {
    const host = createScopedCatalogToolHost(catalog, invoke, scope, "code");
    const hits = await host.search({ query: "deploy" });
    expect(hits.map((h) => h.path)).toEqual(["allowed.thing"]);
  });

  it("describe of an out-of-scope tool is undefined, indistinguishable from nonexistent", async () => {
    const host = createScopedCatalogToolHost(catalog, invoke, scope, "code");
    expect(await host.describe("ops.deploy_1")).toBeUndefined();
    expect(await host.describe("nope.tool")).toBeUndefined();
    expect((await host.describe("allowed.thing"))?.path).toBe("allowed.thing");
  });

  it("a flag turned off empties search and describe for that projection", async () => {
    const off = async () =>
      buildEffectiveScope(
        { projections: { code: false, direct: false, discovery: false }, allow: ALL_TOOLS },
        [mk("allowed.thing", "")],
      );
    const host = createScopedCatalogToolHost(catalog, invoke, off, "code");
    expect(await host.search({ query: "deploy" })).toEqual([]);
    expect(await host.describe("allowed.thing")).toBeUndefined();
  });

  it("the limit still applies after filtering", async () => {
    const wide = async () => buildEffectiveScope(DEFAULT_PROFILE_GRANT, disallowed);
    const host = createScopedCatalogToolHost(catalog, invoke, wide, "code");
    expect(await host.search({ query: "deploy", limit: 3 })).toHaveLength(3);
  });

  it("call passes through to the invoker untouched — scope is the invoker's job at call time", async () => {
    const host = createScopedCatalogToolHost(catalog, invoke, scope, "code");
    await host.call("ops.deploy_1", { x: 1 });
    expect(invoke).toHaveBeenCalledWith("ops.deploy_1", { x: 1 });
  });

  it("a resolver failure crosses as the opaque infra error, raw detail only in the host log", async () => {
    const log = vi.fn();
    const failing = async (): Promise<never> => {
      throw new Error("[SqliteStore] disk full at ~/.conduit/conduit.db");
    };
    const host = createScopedCatalogToolHost(catalog, invoke, failing, "code", log);
    let thrown: Error | undefined;
    try {
      await host.search({ query: "deploy" });
    } catch (error) {
      if (error instanceof Error) thrown = error;
    }
    expect(thrown?.name).toBe("ConduitInternalError");
    expect(thrown?.message).not.toContain("SqliteStore");
    expect(thrown?.message).not.toContain(".conduit");
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("SqliteStore");
  });
});
