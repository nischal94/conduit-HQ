import type { PolicyRepository } from "./store/store.js";
import type { PolicyAction, Tool } from "./types.js";

/**
 * Policy enforcement (spec §5.3 step 2, §10.2): turns one tool call into a
 * verdict for the ToolInvoker. The interface is the seam (same discipline
 * as CredentialResolver/Catalog/ConduitStore): the §5.3 pipeline consumes
 * this contract, never a concrete engine.
 *
 * Seeding is lazy: no code path writes Policy rows from defaults. A verdict
 * falls back to the tool's riskClass mapping when no manual override exists;
 * rows are written only by explicit upsert (an operator's choice). Eager
 * seeding at ingest would fight the §7 pinned invariant — a source refresh
 * must never revert an operator's overrides — so the engine is read-only
 * over its repository: code that never writes cannot revert anything.
 *
 * Deliberately absent from this vocabulary: approval persistence, pausing,
 * resume. A `require_approval` verdict is data; suspending the Execution it
 * belongs to is the §5.5 execution manager's job. Input-aware rules (§10.3)
 * are Phase 2 — the request already carries `input` and the verdict's
 * `source` vocabulary already reserves `"rule"`, so they join without an
 * interface change.
 */
export interface PolicyEngine {
  /**
   * Verdict for one tool call. Never cached: an operator's policy change
   * is live on the very next call, the same rotation property as the
   * credential resolver.
   *
   * Rejects if the policy store is unavailable. A rejection is a failed
   * call, never a verdict — callers MUST NOT map it to any action; doing
   * so would launder a store outage into a policy decision. Consumption
   * discipline is allow-list: proceed only on `action === "allow"`,
   * never on `action !== "block"` — that way even a caller bug that
   * swallows a rejection stays closed.
   */
  evaluate(request: PolicyEvaluationRequest): Promise<PolicyVerdict>;
}

/**
 * The §5.3 step-2 question, as data. `target` is the caller's
 * catalog-lookup result — the engine never looks tools up itself, because
 * policy rows outlive their tools (§7) and the invoker already holds the
 * Tool. A miss is its own state, not a nullable parameter, so "which name
 * was asked for" and "which tool was found" can never disagree.
 *
 * `input` is the call's argument values. v1 ignores it; it is required
 * from day one because §10.3 input-aware rules will branch on it, and an
 * optional input on a security decision is fail-open by shape — a caller
 * that forgot to pass it would silently skip every rule.
 */
export interface PolicyEvaluationRequest {
  readonly target: PolicyTarget;
  readonly input: unknown;
}

export type PolicyTarget =
  | { readonly kind: "known"; readonly tool: Tool }
  | { readonly kind: "unknown"; readonly toolName: string };

/**
 * Where a verdict came from. The full vocabulary ships now so exhaustive
 * consumers compile against it from day one: `"rule"` is reserved for
 * §10.3 input-aware rules (Phase 2 — v1 never emits it), `"unknown_tool"`
 * is the fail-closed catalog miss, distinct from the §10.2 default table
 * so audit surfaces can say "re-sync the source" vs "tune this policy".
 */
export type PolicyVerdictSource = "default" | "override" | "rule" | "unknown_tool";

/**
 * A verdict is data, not control flow. `reason` is product surface: a
 * paused Execution returns it to the calling agent so the agent can tell
 * the user exactly what it is waiting on (§10.2) — silent policy is
 * indistinguishable from malfunction (LEARNINGS #4). Fields are readonly:
 * nothing between the engine and the invoker may edit a verdict.
 */
export interface PolicyVerdict {
  readonly action: PolicyAction;
  readonly reason: string;
  readonly source: PolicyVerdictSource;
}

/**
 * The §10.2 default table: safe→Allow, review/destructive→Require approval.
 * `block` never appears for a valid riskClass — only a human blocks
 * ("agents auto-run the safe stuff and ask before the rest"); the
 * asymmetry is pinned by the INVARIANT §10.2 test. The `default` arm is
 * for values outside the type vocabulary: TypeScript's exhaustiveness is
 * compile-time only, and riskClass reaches this process from untyped
 * storage — an unrecognized value fails closed, never falls through
 * (the `never` binding keeps the compile-time check: a new legitimate
 * RiskClass member still breaks this build).
 */
function defaultVerdict(tool: Tool): PolicyVerdict {
  switch (tool.riskClass) {
    case "safe":
      return {
        action: "allow",
        reason: `${tool.name} is allowed: read-only, safe by default.`,
        source: "default",
      };
    case "review":
      return {
        action: "require_approval",
        reason: `${tool.name} requires approval: it writes data (review class) and its policy has not been manually set.`,
        source: "default",
      };
    case "destructive":
      return {
        action: "require_approval",
        reason: `${tool.name} requires approval: classified destructive by default. Approve or deny via the pending-approvals view.`,
        source: "default",
      };
    default: {
      const unexpected: never = tool.riskClass;
      return {
        action: "block",
        reason: `${tool.name} is blocked: its riskClass "${String(unexpected)}" is not recognized by this version — catalog data may be corrupt or from a newer schema. Re-sync the source.`,
        source: "default",
      };
    }
  }
}

/** Same fail-closed `default` discipline as defaultVerdict: an operator row
 * is the one storage the engine trusts, so an unrecognized action there
 * (schema drift, hand-edited row) must block, not vanish. */
function overrideVerdict(toolName: string, action: PolicyAction): PolicyVerdict {
  switch (action) {
    case "allow":
      return {
        action,
        reason: `${toolName} is allowed: an operator allowed it manually, overriding its default.`,
        source: "override",
      };
    case "require_approval":
      return {
        action,
        reason: `${toolName} requires approval: an operator requires manual approval for it. Approve or deny via the pending-approvals view.`,
        source: "override",
      };
    case "block":
      return {
        action,
        reason: `${toolName} is blocked: an operator blocked this tool manually. Ask them to change its policy if you need it.`,
        source: "override",
      };
    default: {
      const unexpected: never = action;
      return {
        action: "block",
        reason: `${toolName} is blocked: its stored policy action "${String(unexpected)}" is not recognized by this version. An operator must reset this tool's policy.`,
        source: "override",
      };
    }
  }
}

/**
 * Unknown-tool names originate from the sandboxed agent's call — untrusted
 * (§9.2 posture). Reasons are product surface shown in the console and the
 * agent-facing pause message, so strip control characters and cap length
 * before interpolating.
 */
function printableName(raw: string): string {
  const cleaned = [...raw].filter((ch) => ch >= " " && ch !== "\u007f").join("");
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
}

export function createStorePolicyEngine(policies: PolicyRepository): PolicyEngine {
  return {
    async evaluate(request: PolicyEvaluationRequest): Promise<PolicyVerdict> {
      const { target } = request;
      if (target.kind === "unknown") {
        return {
          action: "block",
          reason: `Unknown tool "${printableName(target.toolName)}": not in the catalog, so it is blocked. Check the tool name or re-sync the source.`,
          source: "unknown_tool",
        };
      }
      const tool = target.tool;
      const row = await policies.get(tool.name);
      if (row?.manualOverride) {
        return overrideVerdict(tool.name, row.action);
      }
      // A row without manualOverride is inert: seeds are derived from the
      // live tool's riskClass, never trusted from storage. This keeps a
      // verdict's action and reason consistent by construction and picks
      // up riskClass changes from source refreshes; only manual overrides
      // are storage-authoritative (§7 protects exactly those).
      return defaultVerdict(tool);
    },
  };
}
