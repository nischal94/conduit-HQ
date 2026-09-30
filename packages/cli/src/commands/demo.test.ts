import { describe, expect, it, vi } from "vitest";
import type { DemoResult } from "../demo/run.js";
import { demo, NEXT_STEP, renderDemo } from "./demo.js";

const PASS: DemoResult = {
  ok: true,
  failures: [],
  log: ["[runtime] noise"],
  evidence: {
    approve: {
      pausedBeforeRun: true,
      status: "completed",
      decisionApplied: true,
      approvedCalls: 1,
      exactInput: true,
    },
    deny: { pausedBeforeRun: true, status: "failed", decisionApplied: true, deniedCalls: 0 },
    replay: { status: "conflict", totalCallsAfter: 1 },
  },
};

const FAIL: DemoResult = {
  ...PASS,
  ok: false,
  failures: ["the approved call ran 2 times, expected 1 time"],
  evidence: { ...PASS.evidence, approve: { ...PASS.evidence.approve, approvedCalls: 2 } },
};

describe("conduit demo rendering", () => {
  it("a pass prints the three evidence lines, keeps the log off stdout, exits 0", () => {
    const out = renderDemo(PASS);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(
      "approve: paused before it ran; after approval the upstream received it 1 time, with the exact input",
    );
    expect(out.stdout).toContain(
      "deny:    paused before it ran; after denial the upstream received it 0 times",
    );
    expect(out.stdout).toContain(
      "replay:  approving the same call again was refused (conflict); upstream total is still 1",
    );
    expect(out.stdout).toContain(`PASS\n${NEXT_STEP}\n`);
    expect(out.stdout).not.toContain("[runtime] noise");
    expect(out.stderr).toBe("");
  });

  it("a fail never prints the next step", () => {
    expect(renderDemo(FAIL).stdout).not.toContain(NEXT_STEP);
  });

  it("the header is written BEFORE the run resolves (no silent wait)", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    let release!: (r: DemoResult) => void;
    const pending = demo([], {
      run: () =>
        new Promise<DemoResult>((r) => {
          release = r;
        }),
    });
    await Promise.resolve();
    expect(writes.join("")).toContain("conduit demo — the approval gate");
    expect(writes.join("")).not.toContain("PASS");
    release(PASS);
    await pending;
    spy.mockRestore();
    expect(writes.join("")).toContain("PASS");
  });

  it("a fail prints the failures and the runtime log to stderr, exits 1", () => {
    const out = renderDemo(FAIL);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("FAIL");
    expect(out.stderr).toContain("the approved call ran 2 times, expected 1 time");
    expect(out.stderr).toContain("[runtime] noise");
  });

  it("a run that never paused says so on the evidence line", () => {
    const out = renderDemo({
      ...FAIL,
      evidence: { ...PASS.evidence, approve: { ...PASS.evidence.approve, pausedBeforeRun: false } },
    });
    expect(out.stdout).toContain("approve: DID NOT PAUSE;");
    expect(out.exitCode).toBe(1);
  });

  it("refuses unexpected arguments with exit 1 and never runs the demo", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let ran = false;
    const code = await demo(["--state-dir", "/x"], {
      run: async () => {
        ran = true;
        return PASS;
      },
    });
    spy.mockRestore();
    expect(code).toBe(1);
    expect(ran).toBe(false);
  });
});
