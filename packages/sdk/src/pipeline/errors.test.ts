import { describe, expect, it, vi } from "vitest";
import {
  ConduitCallError,
  GUEST_ERROR_NAMES,
  infraError,
  NON_MEMOIZABLE_ERROR_NAMES,
  policyError,
  upstreamError,
} from "./errors.js";

describe("pipeline error vocabulary", () => {
  it("policy denial carries the reserved non-memoizable name and the verdict reason", () => {
    const err = policyError("require_approval", "needs a human");
    expect(err).toBeInstanceOf(ConduitCallError);
    expect(err.kind).toBe("policy");
    expect(err.name).toBe(GUEST_ERROR_NAMES.policyDenied);
    expect(err.message).toBe("needs a human");
    expect(NON_MEMOIZABLE_ERROR_NAMES).toContain(err.name);
  });

  it("block and unknown-tool map to ConduitPolicyBlocked", () => {
    const err = policyError("block", "nope");
    expect(err.name).toBe(GUEST_ERROR_NAMES.policyBlocked);
    expect(err.message).toBe("nope");
    expect(NON_MEMOIZABLE_ERROR_NAMES).toContain(err.name);
  });

  it("upstream errors are memoizable — only policy refusals are stripped on replay", () => {
    expect(NON_MEMOIZABLE_ERROR_NAMES).not.toContain(GUEST_ERROR_NAMES.upstream);
    expect(NON_MEMOIZABLE_ERROR_NAMES).not.toContain(GUEST_ERROR_NAMES.infra);
  });

  it("infra errors log the real cause host-side and cross opaque", () => {
    const log = vi.fn();
    const cause = new Error(
      "[SqliteStore] Failed to read row: expected text column. Context: { ref: cred_gh }",
    );
    const err = infraError(cause, log);
    expect(err.kind).toBe("infra");
    expect(err.name).toBe(GUEST_ERROR_NAMES.infra);
    expect(err.message).not.toContain("cred_gh");
    expect(err.message).not.toContain("SqliteStore");
    expect(err.correlationId).toBeDefined();
    expect(err.message).toContain(err.correlationId);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cred_gh"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(err.correlationId ?? ""));
  });

  it("infra errors stringify non-Error causes without leaking structure", () => {
    const log = vi.fn();
    const err = infraError({ secretish: "cred_gh" }, log);
    expect(err.message).not.toContain("cred_gh");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("upstream errors keep their name distinct from infra", () => {
    const err = upstreamError("Upstream returned HTTP 502.");
    expect(err.kind).toBe("upstream");
    expect(err.name).toBe(GUEST_ERROR_NAMES.upstream);
    expect(err.correlationId).toBeUndefined();
  });
});
