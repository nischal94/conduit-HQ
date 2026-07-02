import { describe, expect, it } from "vitest";
import { InMemoryCatalog } from "./catalog.js";
import type { Tool } from "./types.js";

function tool(overrides: Partial<Tool> & Pick<Tool, "name" | "namespace">): Tool {
  return {
    inputSchema: { type: "object" },
    outputSchema: {},
    riskClass: "safe",
    sourceSemantics: { kind: "mcp" },
    ...overrides,
  };
}

function seeded() {
  const catalog = new InMemoryCatalog();
  catalog.upsert([
    tool({
      name: "github.issues.create",
      namespace: "github",
      description: "Create a new issue in a repository",
      riskClass: "review",
    }),
    tool({
      name: "github.issues.list",
      namespace: "github",
      description: "List issues in a repository",
    }),
    tool({
      name: "linear.search_issues",
      namespace: "linear",
      description: "Search issues by text",
    }),
    tool({
      name: "stripe.refunds.create",
      namespace: "stripe",
      description: "Refund a charge",
      riskClass: "review",
    }),
  ]);
  return catalog;
}

describe("InMemoryCatalog", () => {
  describe("upsert", () => {
    it("keys tools by name and replaces on re-ingestion", () => {
      const catalog = seeded();
      expect(catalog.size).toBe(4);
      catalog.upsert([
        tool({ name: "github.issues.create", namespace: "github", riskClass: "destructive" }),
      ]);
      expect(catalog.size).toBe(4);
      expect(catalog.describe("github.issues.create")?.riskClass).toBe("destructive");
    });
  });

  describe("removeNamespace", () => {
    it("drops exactly one namespace's tools", () => {
      const catalog = seeded();
      catalog.removeNamespace("github");
      expect(catalog.size).toBe(2);
      expect(catalog.describe("github.issues.list")).toBeUndefined();
      expect(catalog.describe("linear.search_issues")).toBeDefined();
    });
  });

  describe("search", () => {
    it("ranks name-segment matches above description-only matches", () => {
      const hits = seeded().search({ query: "issues" });
      const paths = hits.map((h) => h.path);
      // stripe.refunds.create mentions nothing about issues → absent.
      expect(paths).not.toContain("stripe.refunds.create");
      // Name-segment hits come before the description-only style matches.
      expect(paths[0]).toMatch(/issues/);
    });

    it("combines multi-word intent queries", () => {
      const hits = seeded().search({ query: "create issue repository" });
      expect(hits[0]?.path).toBe("github.issues.create");
    });

    it("is case-insensitive", () => {
      const hits = seeded().search({ query: "REFUND" });
      expect(hits[0]?.path).toBe("stripe.refunds.create");
    });

    it("respects the limit and defaults sensibly", () => {
      expect(seeded().search({ query: "issues", limit: 1 })).toHaveLength(1);
    });

    it("returns nothing for empty or whitespace queries", () => {
      expect(seeded().search({ query: "  " })).toEqual([]);
    });

    it("INVARIANT §4.2: search hits never carry schemas (progressive disclosure)", () => {
      for (const hit of seeded().search({ query: "issues" })) {
        expect(Object.keys(hit).sort()).toEqual(
          expect.not.arrayContaining(["inputSchema", "outputSchema"]),
        );
      }
    });

    it("breaks score ties deterministically by path", () => {
      const first = seeded().search({ query: "issues" });
      const second = seeded().search({ query: "issues" });
      expect(first).toEqual(second);
    });
  });

  describe("describe", () => {
    it("returns metadata without schemas by default", () => {
      const described = seeded().describe("github.issues.create");
      expect(described?.riskClass).toBe("review");
      expect(described?.inputSchema).toBeUndefined();
      expect(described?.outputSchema).toBeUndefined();
    });

    it("INVARIANT §8: schemas load only when explicitly asked (lazy loading)", () => {
      const described = seeded().describe("github.issues.create", { includeSchemas: true });
      expect(described?.inputSchema).toEqual({ type: "object" });
      expect(described?.outputSchema).toEqual({});
    });

    it("returns undefined for unknown paths", () => {
      expect(seeded().describe("nope.missing")).toBeUndefined();
    });
  });
});
