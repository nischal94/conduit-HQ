import { describe, expect, it } from "vitest";
import { deriveRiskClass } from "./risk.js";
import type { SourceSemantics } from "./types.js";

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

  describe("fail-closed hardening (untyped storage reality)", () => {
    // deriveRiskClass is exported public API and semantics can reach it
    // from untyped storage: compile-time exhaustiveness alone would let
    // an impossible kind fall off the switch and return undefined as a
    // RiskClass. Same discipline as policy.ts's default arms.
    it("classifies an unrecognized kind as destructive, never undefined", () => {
      const semantics = { kind: "soap" } as unknown as SourceSemantics;
      expect(deriveRiskClass(semantics)).toBe("destructive");
    });

    it("classifies custom_js with an out-of-vocabulary declaredRisk as destructive", () => {
      const semantics = {
        kind: "custom_js",
        declaredRisk: "extreme",
      } as unknown as SourceSemantics;
      expect(deriveRiskClass(semantics)).toBe("destructive");
    });

    it("never lets a truthy non-boolean readOnlyHint classify as safe", () => {
      // The fail-OPEN trap: "false" is a truthy string, and a truthiness
      // check would award the least restrictive class to corrupt data.
      const semantics = { kind: "mcp", readOnlyHint: "false" } as unknown as SourceSemantics;
      expect(deriveRiskClass(semantics)).toBe("destructive");
    });

    it("classifies mcp semantics with a non-boolean destructiveHint as destructive", () => {
      const semantics = { kind: "mcp", destructiveHint: "yes" } as unknown as SourceSemantics;
      expect(deriveRiskClass(semantics)).toBe("destructive");
    });

    it("classifies openapi semantics with a non-string method as destructive, never a TypeError", () => {
      const semantics = { kind: "openapi", method: 5, path: "/x" } as unknown as SourceSemantics;
      expect(deriveRiskClass(semantics)).toBe("destructive");
    });
  });
});
