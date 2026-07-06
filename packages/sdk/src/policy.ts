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
 * are Phase 2 — they join as a third `PolicyVerdict.source`, not as a new
 * interface.
 */
export interface PolicyEngine {
  /**
   * Verdict for one tool call. `tool` is the caller's catalog-lookup
   * result — the engine never looks tools up itself, because policy rows
   * outlive their tools (§7) and the invoker already holds the Tool.
   * `undefined` means the lookup missed: fail closed, verdict `block`
   * (the spec is silent on unknown tools; fail-open contradicts the
   * product's posture). `toolName` carries the name the caller asked
   * for, so the unknown-tool reason can name it.
   *
   * Never cached: an operator's policy change is live on the very next
   * call, the same rotation property as the credential resolver.
   */
  evaluate(toolName: string, tool: Tool | undefined): Promise<PolicyVerdict>;
}

/**
 * A verdict is data, not control flow. `reason` is product surface: a
 * paused Execution returns it to the calling agent so the agent can tell
 * the user exactly what it is waiting on (§10.2) — silent policy is
 * indistinguishable from malfunction (LEARNINGS #4). `source` records
 * provenance so §10.3 rules can join as `"rule"` without changing this
 * shape.
 */
export interface PolicyVerdict {
  action: PolicyAction;
  reason: string;
  source: "default" | "override";
}

/**
 * The §10.2 default table: safe→Allow, review/destructive→Require approval.
 * `block` never appears — only a human blocks ("agents auto-run the safe
 * stuff and ask before the rest"); the asymmetry is pinned by the
 * INVARIANT §10.2 test.
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
        reason: `${tool.name} requires approval: it writes data (review class) and no operator has tuned its policy yet.`,
        source: "default",
      };
    case "destructive":
      return {
        action: "require_approval",
        reason: `${tool.name} requires approval: classified destructive by default. Approve or deny via the pending-approvals view.`,
        source: "default",
      };
  }
}

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
  }
}

export function createStorePolicyEngine(policies: PolicyRepository): PolicyEngine {
  return {
    async evaluate(toolName: string, tool: Tool | undefined): Promise<PolicyVerdict> {
      if (tool === undefined) {
        return {
          action: "block",
          reason: `Unknown tool "${toolName}": not in the catalog, so it is blocked. Check the tool name or re-sync the source.`,
          source: "default",
        };
      }
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
