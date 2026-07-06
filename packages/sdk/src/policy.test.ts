import { describe, expect, it } from "vitest";
import { createStorePolicyEngine } from "./policy.js";
import type { PolicyRepository } from "./store/store.js";
import type { Policy, RiskClass, Tool } from "./types.js";

function makeTool(riskClass: RiskClass, name = `acme.things.${riskClass}`): Tool {
  return {
    name,
    namespace: "acme",
    description: "test fixture",
    inputSchema: { type: "object" },
    outputSchema: { type: "object", additionalProperties: true },
    riskClass,
    sourceSemantics: { kind: "custom_js", declaredRisk: riskClass },
  };
}

/** In-memory PolicyRepository that counts writes, so tests can pin the engine as read-only. */
function memoryPolicies(): PolicyRepository & { writes: () => number } {
  const rows = new Map<string, Policy>();
  let writeCount = 0;
  return {
    writes: () => writeCount,
    async upsert(policy) {
      writeCount += 1;
      rows.set(policy.toolName, policy);
    },
    async get(toolName) {
      return rows.get(toolName);
    },
    async list() {
      return [...rows.values()];
    },
  };
}

describe("createStorePolicyEngine", () => {
  it("INVARIANT §10.2: policy defaults are safe→Allow, review/destructive→Require approval — and block is never a seeded default", async () => {
    const engine = createStorePolicyEngine(memoryPolicies());

    const safe = await engine.evaluate("acme.things.safe", makeTool("safe"));
    expect(safe.action).toBe("allow");
    expect(safe.source).toBe("default");
    expect(safe.reason).toBe("acme.things.safe is allowed: read-only, safe by default.");

    const review = await engine.evaluate("acme.things.review", makeTool("review"));
    expect(review.action).toBe("require_approval");
    expect(review.source).toBe("default");
    expect(review.reason).toBe(
      "acme.things.review requires approval: it writes data (review class) and no operator has tuned its policy yet.",
    );

    const destructive = await engine.evaluate("acme.things.destructive", makeTool("destructive"));
    expect(destructive.action).toBe("require_approval");
    expect(destructive.source).toBe("default");
    expect(destructive.reason).toBe(
      "acme.things.destructive requires approval: classified destructive by default. Approve or deny via the pending-approvals view.",
    );

    // The asymmetry (spec §10.2): block exists only as a manual choice.
    const riskClasses: RiskClass[] = ["safe", "review", "destructive"];
    for (const riskClass of riskClasses) {
      const verdict = await engine.evaluate(
        `t.${riskClass}`,
        makeTool(riskClass, `t.${riskClass}`),
      );
      expect(verdict.action).not.toBe("block");
    }
  });

  it("fails closed on an unknown tool: block, with a reason naming the tool", async () => {
    const engine = createStorePolicyEngine(memoryPolicies());

    const verdict = await engine.evaluate("ghost.tool", undefined);

    expect(verdict.action).toBe("block");
    expect(verdict.source).toBe("default");
    expect(verdict.reason).toBe(
      'Unknown tool "ghost.tool": not in the catalog, so it is blocked. Check the tool name or re-sync the source.',
    );
  });

  it("honors a manual block override on a safe tool, reporting override provenance", async () => {
    const policies = memoryPolicies();
    const tool = makeTool("safe");
    await policies.upsert({
      toolName: tool.name,
      action: "block",
      seededFrom: "safe",
      manualOverride: true,
    });
    const engine = createStorePolicyEngine(policies);

    const verdict = await engine.evaluate(tool.name, tool);

    expect(verdict.action).toBe("block");
    expect(verdict.source).toBe("override");
    expect(verdict.reason).toBe(
      "acme.things.safe is blocked: an operator blocked this tool manually. Ask them to change its policy if you need it.",
    );
  });

  it("honors a manual allow override on a destructive tool", async () => {
    const policies = memoryPolicies();
    const tool = makeTool("destructive");
    await policies.upsert({
      toolName: tool.name,
      action: "allow",
      seededFrom: "destructive",
      manualOverride: true,
    });
    const engine = createStorePolicyEngine(policies);

    const verdict = await engine.evaluate(tool.name, tool);

    expect(verdict.action).toBe("allow");
    expect(verdict.source).toBe("override");
    expect(verdict.reason).toBe(
      "acme.things.destructive is allowed: an operator allowed it manually, overriding its default.",
    );
  });

  it("treats a non-manual row as inert: the live tool's riskClass governs", async () => {
    // Seeds are derived, never trusted from storage — only manual overrides
    // are storage-authoritative (§7 protects exactly those). A stray row
    // claiming allow on a destructive tool must not open a hole.
    const policies = memoryPolicies();
    const tool = makeTool("destructive");
    await policies.upsert({
      toolName: tool.name,
      action: "allow",
      seededFrom: "safe",
      manualOverride: false,
    });
    const engine = createStorePolicyEngine(policies);

    const verdict = await engine.evaluate(tool.name, tool);

    expect(verdict.action).toBe("require_approval");
    expect(verdict.source).toBe("default");
  });

  it("never writes to the repository: seeding is lazy", async () => {
    const policies = memoryPolicies();
    const engine = createStorePolicyEngine(policies);

    await engine.evaluate("acme.things.safe", makeTool("safe"));
    await engine.evaluate("acme.things.destructive", makeTool("destructive"));
    await engine.evaluate("ghost.tool", undefined);

    expect(policies.writes()).toBe(0);
    expect(await policies.list()).toEqual([]);
  });

  it("is uncached: an override upserted after a default verdict is honored on the next evaluate", async () => {
    const policies = memoryPolicies();
    const tool = makeTool("safe");
    const engine = createStorePolicyEngine(policies);

    const before = await engine.evaluate(tool.name, tool);
    expect(before.action).toBe("allow");

    await policies.upsert({
      toolName: tool.name,
      action: "block",
      seededFrom: "safe",
      manualOverride: true,
    });

    const after = await engine.evaluate(tool.name, tool);
    expect(after.action).toBe("block");
    expect(after.source).toBe("override");
  });
});
