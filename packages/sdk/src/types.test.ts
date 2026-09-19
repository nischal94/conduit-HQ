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
  it("compile-time: the legacy arm has no namespace to read", () => {
    const stored: StoredPendingApproval = base;
    // @ts-expect-error — namespace exists only on the provenance arm
    const _ns: string = stored.namespace;
    expect(hasProvenance(stored) ? stored.namespace : "legacy").toBe("legacy");
  });
});
