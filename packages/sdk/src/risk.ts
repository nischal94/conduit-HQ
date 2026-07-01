import type { RiskClass, SourceSemantics } from "./types.js";

/**
 * The spec §10.1 default-mapping table as code. Heuristics are imperfect
 * (a POST can be safe or destructive), so manual policy overrides always win
 * over this derivation.
 */
export function deriveRiskClass(semantics: SourceSemantics): RiskClass {
  switch (semantics.kind) {
    case "openapi": {
      const method = semantics.method.toUpperCase();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        return "safe";
      }
      if (method === "DELETE") {
        return "destructive";
      }
      // POST/PUT/PATCH and anything unrecognized: a human should look once.
      return "review";
    }
    case "graphql":
      return semantics.operation === "query" ? "safe" : "destructive";
    case "mcp":
      if (semantics.destructiveHint) {
        return "destructive";
      }
      if (semantics.readOnlyHint) {
        return "safe";
      }
      return "review";
    case "custom_js":
      return semantics.declaredRisk;
  }
}
