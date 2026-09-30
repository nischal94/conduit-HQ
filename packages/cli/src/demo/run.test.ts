// packages/cli/src/demo/run.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  APPROVED_INPUT,
  type DemoEvidence,
  type DemoManager,
  judgeEvidence,
  runDemo,
} from "./run.js";
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
  it("INVARIANT §18-R3a: good evidence passes", () => {
    expect(judgeEvidence(GOOD)).toEqual([]);
  });

  const cases: [string, DemoEvidence, RegExp][] = [
    [
      "approve did not pause",
      { ...GOOD, approve: { ...GOOD.approve, pausedBeforeRun: false } },
      /approve execution did not pause/,
    ],
    [
      "approval applied, but the approved call failed",
      {
        ...GOOD,
        approve: { ...GOOD.approve, status: "failed", error: "ConduitUpstreamError: boom" },
      },
      /^the approval was applied, but the approved call did not complete \(status failed\): ConduitUpstreamError: boom$/,
    ],
    [
      "approval not consumed",
      { ...GOOD, approve: { ...GOOD.approve, decisionApplied: false } },
      /^the approval was not applied \(status completed\)$/,
    ],
    [
      "approval not consumed, with the execution's error",
      {
        ...GOOD,
        approve: {
          ...GOOD.approve,
          status: "failed",
          decisionApplied: false,
          error: "ConduitSandboxError: boot failed",
        },
      },
      /^the approval was not applied \(status failed\): ConduitSandboxError: boot failed$/,
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
      "denial not consumed, with the execution's error",
      {
        ...GOOD,
        deny: { ...GOOD.deny, decisionApplied: false, error: "ConduitUpstreamError: reset" },
      },
      /^the denial was not applied \(status failed\): ConduitUpstreamError: reset$/,
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
  it.each(cases)("INVARIANT §18-R3a: %s → exactly one failure", (_name, evidence, message) => {
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
  it("INVARIANT §18-R3a: approve runs the exact call once; deny runs nothing; replay conflicts", async () => {
    const result = await runDemo();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.evidence?.approve).toEqual({
      pausedBeforeRun: true,
      status: "completed",
      decisionApplied: true,
      approvedCalls: 1,
      exactInput: true,
    });
    expect(result.evidence?.deny.pausedBeforeRun).toBe(true);
    expect(result.evidence?.deny.decisionApplied).toBe(true);
    expect(result.evidence?.deny.deniedCalls).toBe(0);
    expect(result.evidence?.replay).toEqual({ status: "conflict", totalCallsAfter: 1 });
  }, 60_000);

  it("INVARIANT §18-R3a: fails when the upstream saw the approved call twice", async () => {
    const result = await runDemo({
      startUpstream: lyingUpstream((calls) => [
        ...calls,
        ...calls.filter((c) => (c.arguments as { title?: string })?.title === APPROVED_INPUT.title),
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/approved call ran 2 times/);
  }, 60_000);

  it("INVARIANT §18-R3a: fails when the upstream saw a denied call", async () => {
    const result = await runDemo({
      startUpstream: lyingUpstream((calls) => [
        ...calls,
        { name: "create_note", arguments: { title: "denied by you" } },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/denied call ran 1 time/);
  }, 60_000);

  it("INVARIANT §18-R3a: fails when the real policy auto-allows the tool (no pause)", async () => {
    const result = await runDemo({ startUpstream: () => startDemoUpstream({ readOnly: true }) });
    expect(result.ok).toBe(false);
    expect(result.evidence?.approve.pausedBeforeRun).toBe(false);
    expect(result.failures.join("\n")).toMatch(/did not pause/);
  }, 60_000);

  it("reports a run that cannot start as a failure with no evidence", async () => {
    const result = await runDemo({
      startUpstream: async () => {
        const real = await startDemoUpstream();
        await real.close();
        // The url now points at a closed port: onboarding cannot reach it.
        return { url: real.url, calls: [], close: async () => {} };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.evidence).toBeNull();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatch(/^the demo could not run: /);
  }, 60_000);

  it("INVARIANT §18-R3a: fails when the approved call reached the upstream with altered input", async () => {
    const result = await runDemo({
      startUpstream: lyingUpstream((calls) =>
        calls.map((c) =>
          (c.arguments as { title?: string })?.title === APPROVED_INPUT.title
            ? { ...c, arguments: { ...APPROVED_INPUT, extra: 1 } }
            : c,
        ),
      ),
    });
    expect(result.failures).toEqual(["the upstream did not receive the exact approved input"]);
    expect(result.ok).toBe(false);
  }, 60_000);

  it("INVARIANT §18-R3a: fails when the replayed approval reached the upstream again", async () => {
    let upstreamUrl = "";
    const result = await runDemo({
      startUpstream: async () => {
        const real = await startDemoUpstream();
        upstreamUrl = real.url;
        return real;
      },
      wrapManager: replayWrapper(async (_executionId, replay) => {
        // The runtime answers conflict, but the upstream saw one more call.
        await postToolCall(upstreamUrl, { title: "replayed" });
        return replay();
      }),
    });
    expect(result.failures).toEqual(["the upstream received 2 times in total, expected 1 time"]);
    expect(result.ok).toBe(false);
  }, 60_000);

  it("INVARIANT §18-R3a: fails when the replayed approval is not answered conflict", async () => {
    const result = await runDemo({
      wrapManager: replayWrapper(async (executionId) => ({
        status: "completed",
        executionId,
        value: null,
        decisionApplied: true,
      })),
    });
    expect(result.failures).toEqual(["a replayed approval returned completed, expected conflict"]);
    expect(result.ok).toBe(false);
  }, 60_000);

  it("reports the execution's error when the approved call fails upstream", async () => {
    let closeUpstream: () => Promise<void> = async () => {};
    let approvals = 0;
    const result = await runDemo({
      startUpstream: async () => {
        const real = await startDemoUpstream();
        closeUpstream = () => real.close();
        return real;
      },
      wrapManager: (m) => ({
        start: (...args) => m.start(...args),
        resume: async (executionId, decision, callId, scope) => {
          if (decision.kind === "approve" && approvals++ === 0) {
            // The upstream goes away between the pause and the approval.
            await closeUpstream();
          }
          return m.resume(executionId, decision, callId, scope);
        },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.evidence?.approve.decisionApplied).toBe(true);
    expect(result.failures.join("\n")).toMatch(
      /the approval was applied, but the approved call did not complete \(status failed\): \S+: \S/,
    );
  }, 60_000);

  it("closes the upstream when the run cannot start", async () => {
    const real = await startDemoUpstream();
    const dead = await startDemoUpstream();
    await dead.close();
    const close = vi.fn(() => real.close());
    const result = await runDemo({
      // Onboarding targets a closed port, so drive() throws after the start.
      startUpstream: async () => ({ url: dead.url, calls: real.calls, close }),
    });
    expect(result.ok).toBe(false);
    expect(result.evidence).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(postToolCall(real.url, { title: "after close" })).rejects.toThrow();
  }, 60_000);

  it("closes the upstream when the checks fail", async () => {
    const real = await startDemoUpstream({ readOnly: true });
    const close = vi.fn(() => real.close());
    const result = await runDemo({
      startUpstream: async () => ({ url: real.url, calls: real.calls, close }),
    });
    expect(result.ok).toBe(false);
    expect(result.evidence).not.toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(postToolCall(real.url, { title: "after close" })).rejects.toThrow();
  }, 60_000);
});

/** One JSON-RPC tools/call straight to the demo upstream, bypassing the runtime. */
async function postToolCall(url: string, args: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "create_note", arguments: args },
    }),
    signal: AbortSignal.timeout(5000),
  });
  await res.text();
}

/**
 * Wraps the runtime's manager and intercepts the demo's replay: the second
 * approve on the same execution. `replay()` forwards it to the real runtime.
 */
function replayWrapper(
  onReplay: (
    executionId: string,
    replay: () => ReturnType<DemoManager["resume"]>,
  ) => ReturnType<DemoManager["resume"]>,
): (m: DemoManager) => DemoManager {
  return (m) => {
    const approved = new Set<string>();
    return {
      start: (...args) => m.start(...args),
      resume: (executionId, decision, callId, scope) => {
        const replay = () => m.resume(executionId, decision, callId, scope);
        if (decision.kind !== "approve") {
          return replay();
        }
        if (approved.has(executionId)) {
          return onReplay(executionId, replay);
        }
        approved.add(executionId);
        return replay();
      },
    };
  };
}
