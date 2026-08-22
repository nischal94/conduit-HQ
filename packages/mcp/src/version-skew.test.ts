import { describe, expect, it } from "vitest";
import { AGENT_VERSION } from "./env.js";
import { createSkewReporter, sanitizeVersionForDisplay, skewWarningLine } from "./version-skew.js";

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

describe("sanitizeVersionForDisplay boundaries", () => {
  it("leaves a string exactly at the cap untouched", () => {
    const exact = "x".repeat(64);
    expect(sanitizeVersionForDisplay(exact)).toHaveLength(64);
    expect(sanitizeVersionForDisplay(exact)).toBe(exact);
  });

  it("reduces an all-control-character version to empty, and still warns", () => {
    const allControl = "\u0000\u0007\u001b\u007f";
    expect(sanitizeVersionForDisplay(allControl)).toBe("");
    // An empty display string is not a MATCH: the daemon reported SOME
    // version, it just rendered to nothing, so skew is still reported
    // rather than silently swallowed.
    const line = skewWarningLine(allControl);
    expect(line).not.toBeNull();
    expect(line).toContain("conduit daemon stop");
  });
});

/**
 * The wiring property every production caller depends on. The three call
 * sites differ only in where they HOLD the reporter and where it writes, so
 * the once-per-caller latch is pinned here, at the seam itself, rather than
 * behind a spawned daemon.
 */
describe("createSkewReporter", () => {
  it("warns ONCE across repeated mismatched handshakes", () => {
    const lines: string[] = [];
    const report = createSkewReporter((line) => lines.push(line));
    report({ agentVersion: "9.9.9" });
    report({ agentVersion: "9.9.9" });
    report({ agentVersion: "8.8.8" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("9.9.9");
  });

  it("stays silent on a matching handshake WITHOUT latching, so later skew still warns", () => {
    const lines: string[] = [];
    const report = createSkewReporter((line) => lines.push(line));
    // A null line is not a report: the latch must remain unset, or a process
    // outliving a daemon restart would never hear about the new mismatch.
    report({ agentVersion: AGENT_VERSION });
    expect(lines).toHaveLength(0);
    report({ agentVersion: "9.9.9" });
    expect(lines).toHaveLength(1);
  });

  it("latches on the ABSENT arm too, and reports the signal remediation once", () => {
    const lines: string[] = [];
    const report = createSkewReporter((line) => lines.push(line));
    report({ agentVersion: undefined });
    report({ agentVersion: undefined });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("--daemon");
  });

  it("gives each caller an INDEPENDENT latch", () => {
    // What lets `serve` share ONE reporter across its two daemon call sites
    // while the CLI commands hold their own: the latch belongs to the
    // returned closure, so scope is the caller's choice.
    const a: string[] = [];
    const b: string[] = [];
    const reportA = createSkewReporter((line) => a.push(line));
    const reportB = createSkewReporter((line) => b.push(line));
    reportA({ agentVersion: "9.9.9" });
    reportA({ agentVersion: "9.9.9" });
    reportB({ agentVersion: "9.9.9" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("sanitizes before handing the line to the writer", () => {
    const lines: string[] = [];
    const report = createSkewReporter((line) => lines.push(line));
    report({ agentVersion: `1.0.0\u001b[2J\u0007` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\u001b");
    expect(lines[0]).not.toContain("\u0007");
  });
});
