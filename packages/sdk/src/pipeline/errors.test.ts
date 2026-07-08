import { describe, expect, it, vi } from "vitest";
import {
  ConduitCallError,
  GUEST_ERROR_NAMES,
  type GuestErrorName,
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

  it("the constructor's name parameter is closed over the guest vocabulary (compile-time pin)", () => {
    const legit = new ConduitCallError("upstream", GUEST_ERROR_NAMES.upstream, "HTTP 502");
    expect(legit.name).toBe("ConduitUpstreamError");
  });

  it("INVARIANT §9.2: a runtime-forged name outside the closed set is forced to infra", () => {
    // Adversarial (codex): a custom UpstreamCaller is untrusted JS and can
    // bypass the compile-time union with `as`. A forged name — especially a
    // non-memoizable policy name on a non-policy error — must not cross into
    // the sandbox or mis-drive §5.5 replay stripping.
    const forged = new ConduitCallError("upstream", "TotallyMadeUp" as GuestErrorName, "x");
    expect(forged.name).toBe(GUEST_ERROR_NAMES.infra);
    const forgedPolicy = new ConduitCallError(
      "upstream",
      GUEST_ERROR_NAMES.policyBlocked, // real name, but this IS in the set → allowed
      "x",
    );
    expect(forgedPolicy.name).toBe(GUEST_ERROR_NAMES.policyBlocked);
  });

  it("infra classification survives a throwing log sink (does not re-enter and escape)", () => {
    const throwingLog = () => {
      throw new Error("sink is down");
    };
    // Must not throw out of infraError itself.
    const err = infraError(new Error("[SqliteStore] boom"), throwingLog);
    expect(err.name).toBe(GUEST_ERROR_NAMES.infra);
    expect(err.correlationId).toBeDefined();
  });
});
