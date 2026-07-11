import { describe, expect, it } from "vitest";
import { InMemoryCatalog } from "./catalog.js";
import { buildExecuteTool, createCatalogToolHost, estimateTokens } from "./execute.js";
import { QuickJSSandbox } from "./sandbox/quickjs.js";
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
