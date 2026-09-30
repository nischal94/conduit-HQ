// packages/cli/src/demo/run.test.ts
import { describe, expect, it } from "vitest";
import { APPROVED_INPUT, type DemoEvidence, judgeEvidence, runDemo } from "./run.js";
import { type DemoUpstream, startDemoUpstream } from "./upstream.js";

const GOOD: DemoEvidence = {
  approve: {
    pausedBeforeRun: true,
    status: "completed",
    decisionApplied: true,
    approvedCalls: 1,
    exactInput: true,
  },
  deny: { pausedBeforeRun: true, status: "failed", decisionApplied: true, deniedCalls: 0 },
  replay: { status: "conflict", totalCallsAfter: 1 },
};

describe("judgeEvidence — every predicate fails on its own", () => {
  it("good evidence passes", () => {
    expect(judgeEvidence(GOOD)).toEqual([]);
  });

  const cases: [string, DemoEvidence, RegExp][] = [
    [
      "approve did not pause",
      { ...GOOD, approve: { ...GOOD.approve, pausedBeforeRun: false } },
      /approve execution did not pause/,
    ],
    [
      "approve status not completed",
      { ...GOOD, approve: { ...GOOD.approve, status: "failed" } },
      /approval was not applied \(status failed\)/,
    ],
    [
      "approval not consumed",
      { ...GOOD, approve: { ...GOOD.approve, decisionApplied: false } },
      /approval was not applied/,
    ],
    [
      "approved call ran twice",
      { ...GOOD, approve: { ...GOOD.approve, approvedCalls: 2 } },
      /approved call ran 2 times/,
    ],
    [
      "approved call never ran",
      { ...GOOD, approve: { ...GOOD.approve, approvedCalls: 0 } },
      /approved call ran 0 times/,
    ],
    [
      "wrong input reached upstream",
      { ...GOOD, approve: { ...GOOD.approve, exactInput: false } },
      /exact approved input/,
    ],
    [
      "deny did not pause",
      { ...GOOD, deny: { ...GOOD.deny, pausedBeforeRun: false } },
      /deny execution did not pause/,
    ],
    [
      "denial not consumed",
      { ...GOOD, deny: { ...GOOD.deny, decisionApplied: false } },
      /denial was not applied/,
    ],
    [
      "denied call ran",
      { ...GOOD, deny: { ...GOOD.deny, deniedCalls: 1 } },
      /denied call ran 1 time/,
    ],
    [
      "replay accepted",
      { ...GOOD, replay: { ...GOOD.replay, status: "completed" } },
      /replayed approval returned completed/,
    ],
    [
      "upstream total wrong",
      { ...GOOD, replay: { ...GOOD.replay, totalCallsAfter: 2 } },
      /received 2 times in total/,
    ],
  ];
  it.each(cases)("%s → exactly one failure", (_name, evidence, message) => {
    const failures = judgeEvidence(evidence);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(message);
  });
});

/**
 * Wraps the real upstream but lies in its ledger. The demo's verdict must
 * come from the ledger, so a lying ledger must turn the verdict red.
 */
function lyingUpstream(mutate: (calls: DemoUpstream["calls"]) => DemoUpstream["calls"]) {
  return async (): Promise<DemoUpstream> => {
    const real = await startDemoUpstream();
    return {
      url: real.url,
      get calls() {
        return mutate(real.calls);
      },
      close: () => real.close(),
    };
  };
}

describe("runDemo", () => {
  it("approve runs the exact call once; deny runs nothing; replay conflicts", async () => {
    const result = await runDemo();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.evidence.approve).toEqual({
      pausedBeforeRun: true,
      status: "completed",
      decisionApplied: true,
      approvedCalls: 1,
      exactInput: true,
    });
    expect(result.evidence.deny.pausedBeforeRun).toBe(true);
    expect(result.evidence.deny.decisionApplied).toBe(true);
    expect(result.evidence.deny.deniedCalls).toBe(0);
    expect(result.evidence.replay).toEqual({ status: "conflict", totalCallsAfter: 1 });
  }, 60_000);

  it("fails when the upstream saw the approved call twice", async () => {
    const result = await runDemo({
      startUpstream: lyingUpstream((calls) => [
        ...calls,
        ...calls.filter((c) => (c.arguments as { title?: string })?.title === APPROVED_INPUT.title),
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/approved call ran 2 times/);
  }, 60_000);

  it("fails when the upstream saw a denied call", async () => {
    const result = await runDemo({
      startUpstream: lyingUpstream((calls) => [
        ...calls,
        { name: "create_note", arguments: { title: "denied by you" } },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/denied call ran 1 time/);
  }, 60_000);

  it("fails when the real policy auto-allows the tool (no pause)", async () => {
    const result = await runDemo({ startUpstream: () => startDemoUpstream({ readOnly: true }) });
    expect(result.ok).toBe(false);
    expect(result.evidence.approve.pausedBeforeRun).toBe(false);
    expect(result.failures.join("\n")).toMatch(/did not pause/);
  }, 60_000);

  it("reports a run that cannot start as a failure and keeps the log", async () => {
    const result = await runDemo({
      startUpstream: async () => {
        const real = await startDemoUpstream();
        await real.close();
        // The url now points at a closed port: onboarding cannot reach it.
        return { url: real.url, calls: [], close: async () => {} };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/^the demo could not run: /);
  }, 60_000);
});
