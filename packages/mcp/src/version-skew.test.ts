import { describe, expect, it } from "vitest";
import { AGENT_VERSION } from "./env.js";
import { sanitizeVersionForDisplay, skewWarningLine } from "./version-skew.js";

describe("skewWarningLine", () => {
  it("is silent when the daemon matches this build", () => {
    expect(skewWarningLine(AGENT_VERSION)).toBeNull();
  });

  it("warns on a mismatched version, naming both and the stop command", () => {
    const line = skewWarningLine("9.9.9");
    expect(line).toContain("9.9.9");
    expect(line).toContain(AGENT_VERSION);
    expect(line).toContain("conduit daemon stop");
  });

  it("treats an ABSENT version as skew from an older build, with the signal remediation", () => {
    const line = skewWarningLine(undefined);
    expect(line).toContain("older build");
    // Pre-control daemons cannot be RPC-stopped (spec §4): the absent-
    // version arm points at the signal path, not at `daemon stop`.
    expect(line).toContain("--daemon");
  });

  it("strips control characters and caps length before printing", () => {
    // Escapes, not raw bytes: the hostile input is an ESC-bracket terminal
    // sequence plus a BEL, written so this source file stays printable.
    const hostile = `1.0.0\u001b[2J\u0007${"x".repeat(500)}`;
    const line = skewWarningLine(hostile);
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\u0007");
    expect(sanitizeVersionForDisplay(hostile).length).toBeLessThanOrEqual(64);
  });
});
