import type { RiskClass, SourceSemantics } from "./types.js";

const RISK_CLASSES: readonly RiskClass[] = ["safe", "review", "destructive"];

/**
 * The spec §10.1 default-mapping table as code. Heuristics are imperfect
 * (a POST can be safe or destructive), so manual policy overrides always win
 * over this derivation.
 *
 * Exported public API: semantics can reach this from untyped callers, so
 * values outside the compile-time unions fail closed to "destructive"
 * (same discipline as policy.ts's default arms) — never fall off the
 * switch as undefined-pretending-to-be-a-RiskClass.
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
      // declaredRisk is author-supplied data inside the semantics blob —
      // the one branch where the answer is read, not derived.
      return isRiskClass(semantics.declaredRisk) ? semantics.declaredRisk : "destructive";
    default: {
      // The `never` binding keeps the compile-time exhaustiveness check:
      // a new legitimate kind still breaks this build.
      const _exhaustive: never = semantics;
      return "destructive";
    }
  }
}

function isRiskClass(value: string): value is RiskClass {
  return (RISK_CLASSES as readonly string[]).includes(value);
}
