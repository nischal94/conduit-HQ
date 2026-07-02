import { describe, expect, it } from "vitest";
import { normalizeMcp } from "./mcp.js";

/** Shaped like a real `tools/list` result: hints optional, outputSchema rare. */
const fixture = [
  {
    name: "search_issues",
    description: "Search issues by text",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "issues/create",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "delete_project",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { deleted: { type: "boolean" } } },
    annotations: { destructiveHint: true },
  },
  {
    name: "whoami",
  },
];

function normalized() {
  return normalizeMcp({ namespace: "linear", tools: fixture });
}

function toolByName(name: string) {
  const tool = normalized().find((t) => t.name === name);
  if (!tool) {
    throw new Error(`fixture tool not found: ${name}`);
  }
  return tool;
}

describe("normalizeMcp", () => {
  describe("tool naming", () => {
    it("produces one tool per upstream tool", () => {
      expect(normalized()).toHaveLength(4);
    });

    it("namespaces names and converts slashes to dots", () => {
      const names = normalized().map((t) => t.name);
      expect(names).toContain("linear.search_issues");
      expect(names).toContain("linear.issues.create");
    });

    it("refuses duplicate names after namespacing instead of guessing", () => {
      const colliding = [{ name: "a/b" }, { name: "a.b" }];
      expect(() => normalizeMcp({ namespace: "x", tools: colliding })).toThrow(
        /duplicate tool name/,
      );
    });
  });

  describe("risk classification from hints", () => {
    it("classifies readOnlyHint as safe", () => {
      expect(toolByName("linear.search_issues").riskClass).toBe("safe");
    });

    it("classifies destructiveHint as destructive", () => {
      expect(toolByName("linear.delete_project").riskClass).toBe("destructive");
    });

    it("classifies unhinted tools as review", () => {
      expect(toolByName("linear.issues.create").riskClass).toBe("review");
      expect(toolByName("linear.whoami").riskClass).toBe("review");
    });

    it("records only explicitly declared hints in sourceSemantics", () => {
      expect(toolByName("linear.search_issues").sourceSemantics).toEqual({
        kind: "mcp",
        readOnlyHint: true,
      });
      expect(toolByName("linear.whoami").sourceSemantics).toEqual({ kind: "mcp" });
    });
  });

  describe("schemas", () => {
    it("passes declared input and output schemas through", () => {
      const tool = toolByName("linear.delete_project");
      expect(tool.inputSchema).toEqual({ type: "object" });
      expect(tool.outputSchema.properties).toHaveProperty("deleted");
    });

    it("falls back to the permissive schema when schemas are missing", () => {
      const tool = toolByName("linear.whoami");
      expect(tool.inputSchema).toEqual({});
      // The canonical spec §7 case: MCP servers rarely declare outputs.
      expect(tool.outputSchema).toEqual({});
      expect(toolByName("linear.search_issues").outputSchema).toEqual({});
    });
  });

  describe("descriptions", () => {
    it("carries descriptions when present and omits them when absent", () => {
      expect(toolByName("linear.search_issues").description).toBe("Search issues by text");
      expect(toolByName("linear.whoami").description).toBeUndefined();
    });
  });

  describe("boundary validation", () => {
    it("rejects a payload that is not a tool array", () => {
      expect(() => normalizeMcp({ namespace: "x", tools: "nope" })).toThrow(
        /not a structurally valid tools\/list result/,
      );
    });

    it("rejects tools without a usable name", () => {
      expect(() => normalizeMcp({ namespace: "x", tools: [{ name: "" }] })).toThrow(
        /not a structurally valid tools\/list result/,
      );
    });
  });
});
