import { describe, expect, it } from "vitest";
import { deriveRiskClass } from "./risk.js";

describe("deriveRiskClass (INVARIANT §10.1: default risk mapping)", () => {
  describe("openapi", () => {
    it.each([["GET"], ["HEAD"], ["OPTIONS"]])("classifies %s as safe", (method) => {
      expect(deriveRiskClass({ kind: "openapi", method, path: "/x" })).toBe("safe");
    });

    it.each([["POST"], ["PUT"], ["PATCH"]])("classifies %s as review", (method) => {
      expect(deriveRiskClass({ kind: "openapi", method, path: "/x" })).toBe("review");
    });

    it("classifies DELETE as destructive", () => {
      expect(deriveRiskClass({ kind: "openapi", method: "DELETE", path: "/x" })).toBe(
        "destructive",
      );
    });

    it("is case-insensitive about the verb", () => {
      expect(deriveRiskClass({ kind: "openapi", method: "get", path: "/x" })).toBe("safe");
    });
  });

  describe("graphql", () => {
    it("classifies queries as safe", () => {
      expect(deriveRiskClass({ kind: "graphql", operation: "query" })).toBe("safe");
    });

    it("classifies mutations as destructive", () => {
      expect(deriveRiskClass({ kind: "graphql", operation: "mutation" })).toBe("destructive");
    });
  });

  describe("mcp", () => {
    it("classifies destructiveHint as destructive even when read-only is also claimed", () => {
      expect(deriveRiskClass({ kind: "mcp", destructiveHint: true, readOnlyHint: true })).toBe(
        "destructive",
      );
    });

    it("classifies readOnlyHint as safe", () => {
      expect(deriveRiskClass({ kind: "mcp", readOnlyHint: true })).toBe("safe");
    });

    it("defaults to review when no hints are present", () => {
      expect(deriveRiskClass({ kind: "mcp" })).toBe("review");
    });
  });

  describe("custom_js", () => {
    it("passes through the author-declared risk", () => {
      expect(deriveRiskClass({ kind: "custom_js", declaredRisk: "destructive" })).toBe(
        "destructive",
      );
    });
  });
});
