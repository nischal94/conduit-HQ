import { describe, expect, it } from "vitest";
import { hasProvenance, isPendingApproval, type StoredPendingApproval } from "./types.js";

const base = {
  callId: "c1",
  toolName: "github.issues.list",
  input: {},
  reason: "r",
  expiresAt: 9e12,
};

describe("isPendingApproval (§4.1, one validator; row #50 branches)", () => {
  it("accepts the R1 shape: both provenance fields present and typed", () => {
    const v: unknown = { ...base, namespace: "github", sourceGeneration: 7 };
    expect(isPendingApproval(v)).toBe(true);
    if (isPendingApproval(v)) expect(hasProvenance(v)).toBe(true);
  });
  it("accepts the legacy shape: both provenance fields absent", () => {
    expect(isPendingApproval(base)).toBe(true);
    if (isPendingApproval(base)) expect(hasProvenance(base)).toBe(false);
  });
  it.each([
    ["namespace present, sourceGeneration absent", { ...base, namespace: "github" }],
    ["sourceGeneration present, namespace absent", { ...base, sourceGeneration: 7 }],
    ["namespace not text", { ...base, namespace: 3, sourceGeneration: 7 }],
    ["sourceGeneration not finite", { ...base, namespace: "github", sourceGeneration: Number.NaN }],
    ["sourceGeneration a string", { ...base, namespace: "github", sourceGeneration: "7" }],
  ])("rejects a half-present or mistyped provenance pair: %s", (_label, v) => {
    expect(isPendingApproval(v)).toBe(false);
  });
  it("still rejects the shipped corrupt shapes", () => {
    expect(isPendingApproval({ ...base, callId: " " })).toBe(false);
    expect(isPendingApproval({ ...base, expiresAt: "soon" })).toBe(false);
    expect(isPendingApproval(null)).toBe(false);
  });
  it("hasProvenance is SOUND on its own — a mistyped pair is not provenance", () => {
    // It is exported, and its result feeds the §5.4 step-3 generation
    // comparison. A presence-only check accepted `sourceGeneration: "7"`,
    // which then compares unequal to every number and fails closed only by
    // accident. Asserted WITHOUT `isPendingApproval` in front of it, because
    // that guard is exactly what a caller may not have run.
    // The values come from the STORE, which hydrates `paused_on` without
    // validating it, so the compile-time shape is a claim about the column,
    // not a fact. These are the rows a database can actually hold.
    const stored = (v: unknown) => hasProvenance(v as StoredPendingApproval);
    expect(stored({ ...base, namespace: "github", sourceGeneration: "7" })).toBe(false);
    expect(stored({ ...base, namespace: 3, sourceGeneration: 7 })).toBe(false);
    expect(stored({ ...base, sourceGeneration: 7 })).toBe(false);
    expect(hasProvenance({ ...base, namespace: "github", sourceGeneration: 7 })).toBe(true);
  });

  it("compile-time: the legacy arm has no namespace to read", () => {
    const stored: StoredPendingApproval = base;
    // @ts-expect-error — namespace exists only on the provenance arm
    const _ns: string = stored.namespace;
    expect(hasProvenance(stored) ? stored.namespace : "legacy").toBe("legacy");
  });
});
