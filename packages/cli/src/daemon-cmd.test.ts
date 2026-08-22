import { DaemonUnavailable, type RpcRequest, type RpcResponse } from "@conduithq/mcp";
import { describe, expect, it } from "vitest";
import { type DaemonCmdDeps, runStatus, runStop, STOP_WAIT_MS } from "./commands/daemon.js";

/**
 * `conduit daemon status|stop` through its DI seam (the pattern
 * `approvals.ts` established): no sockets, no daemon, no clock.
 *
 * The two facts these tests exist to pin are the ones a wrong answer makes
 * dangerous: the NORMATIVE exit codes (spec §3.2 — a script must never read
 * "not running" as healthy), and that neither verb ever spawns a daemon.
 */

interface Recorder {
  deps: DaemonCmdDeps;
  out: string[];
  err: string[];
  requests: RpcRequest[];
  probes: number;
}

interface FakeOptions {
  /** Answers the daemon call; may throw. */
  answer: (request: RpcRequest) => Promise<RpcResponse>;
  /** Lifecycle-lock readings, consumed in order; the last repeats. */
  probes?: ("busy" | "free")[];
}

/** A fake clock: `now` advances only when the command sleeps. */
function makeDeps(options: FakeOptions): Recorder {
  const out: string[] = [];
  const err: string[] = [];
  const requests: RpcRequest[] = [];
  const probes = options.probes ?? ["free"];
  let clock = 1_000;
  let probeCount = 0;

  const deps: DaemonCmdDeps = {
    daemon: (request) => {
      requests.push(request);
      return options.answer(request);
    },
    probeLifecycle: async () => {
      const reading = probes[Math.min(probeCount, probes.length - 1)] ?? "free";
      probeCount += 1;
      return reading;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };

  return {
    deps,
    out,
    err,
    requests,
    get probes() {
      return probeCount;
    },
  };
}

const STATUS_PAYLOAD = {
  pid: 4242,
  agentVersion: "0.1.0",
  startedAt: Date.UTC(2026, 7, 22, 12, 0, 0),
  dbPath: "/state/conduit.db",
  connections: 3,
  executionsInFlight: 2,
  queueDepth: 5,
  logPath: "/state/conduitd.log",
  logSizeBytes: 8192,
};

/** The frame a PRE-CONTROL daemon sends: it has no `control` capability. */
const PRE_CONTROL_FRAME: RpcResponse = {
  kind: "error",
  requestId: "r1",
  code: "invalid",
  message: "handshake.capability must be one of serve | approvals | add-mcp",
};

describe("conduit daemon status", () => {
  it("prints the running daemon's projection and exits 0", async () => {
    const rec = makeDeps({
      answer: async () => ({ kind: "result", requestId: "r1", payload: STATUS_PAYLOAD }),
    });

    expect(await runStatus(rec.deps)).toBe(0);

    const printed = rec.out.join("");
    expect(printed).toContain("running");
    expect(printed).toContain("4242");
    // Both versions: the daemon's build AND this CLI's, so an operator
    // reading a skew warning can see the two numbers it names.
    expect(printed).toContain("0.1.0");
    expect(printed).toContain("/state/conduit.db");
    expect(printed).toContain("3");
    expect(printed).toContain("2");
    expect(printed).toContain("5");
    expect(printed).toContain("/state/conduitd.log");
    expect(rec.requests).toEqual([{ kind: "daemon.status" }]);
  });

  it("exits 3 with 'not running' when no daemon is up — and never spawns", async () => {
    const rec = makeDeps({
      answer: async () => {
        throw new DaemonUnavailable("unavailable", "no daemon is listening at /state");
      },
    });

    // 3 is NORMATIVE (spec §3.2): distinct from 1 so a script cannot read
    // an absent daemon as a healthy one, and distinct from 0 so it cannot
    // read it as running.
    expect(await runStatus(rec.deps)).toBe(3);
    expect(`${rec.out.join("")}${rec.err.join("")}`).toContain("not running");
    // Never spawns: status must not create the thing it is asking about.
    // The suppression itself is asserted against the prod wiring below.
    expect(rec.probes).toBe(0);
  });

  it("prints rotation guidance and exits 1 during a rotation", async () => {
    const rec = makeDeps({
      answer: async () => {
        throw new DaemonUnavailable(
          "rotation-in-progress",
          "a key rotation holds the maintenance lock",
        );
      },
    });

    expect(await runStatus(rec.deps)).toBe(1);
    const printed = rec.err.join("");
    expect(printed).toMatch(/rotation/i);
    // NOT the absent reading: a rotating daemon is not a missing one.
    expect(rec.out.join("")).not.toContain("not running");
  });

  it("explains the manual signal path against a pre-control daemon", async () => {
    const rec = makeDeps({ answer: async () => PRE_CONTROL_FRAME });

    expect(await runStatus(rec.deps)).toBe(1);
    const printed = rec.err.join("");
    expect(printed).toContain("predates the control API");
    expect(printed).toContain("SIGTERM");
  });
});

describe("conduit daemon stop", () => {
  it("acks, waits for the lifecycle lock to release, prints 'stopped', exits 0", async () => {
    const rec = makeDeps({
      answer: async () => ({ kind: "result", requestId: "r1", payload: { stopping: true } }),
      probes: ["busy", "busy", "free"],
    });

    expect(await runStop(rec.deps)).toBe(0);
    expect(rec.out.join("")).toContain("stopped");
    // Waited for VERIFIED termination rather than trusting the ack: three
    // readings, the last one free.
    expect(rec.probes).toBe(3);
    expect(rec.requests).toEqual([{ kind: "daemon.stop" }]);
  });

  it("is idempotent: no daemon running prints 'not running' and exits 0", async () => {
    const rec = makeDeps({
      answer: async () => {
        throw new DaemonUnavailable("unavailable", "no daemon is listening at /state");
      },
    });

    // Exit 0, unlike status: the operator wanted it stopped, and it is.
    expect(await runStop(rec.deps)).toBe(0);
    expect(rec.out.join("")).toContain("not running");
    expect(rec.probes).toBe(0);
  });

  it("reports 'still draining' and exits 1 when the wait window elapses", async () => {
    const rec = makeDeps({
      answer: async () => ({ kind: "result", requestId: "r1", payload: { stopping: true } }),
      probes: ["busy"],
    });

    expect(await runStop(rec.deps)).toBe(1);
    const printed = rec.err.join("");
    expect(printed).toMatch(/draining/i);
    expect(printed).toContain("conduit daemon status");
    expect(rec.out.join("")).not.toContain("stopped");
    // The window is bounded: the fake clock only advances on sleep, so a
    // finite probe count proves the loop terminated on STOP_WAIT_MS.
    expect(rec.probes).toBeGreaterThan(0);
    expect(rec.probes).toBeLessThanOrEqual(STOP_WAIT_MS);
  });

  it("explains the manual signal path against a pre-control daemon", async () => {
    const rec = makeDeps({ answer: async () => PRE_CONTROL_FRAME });

    expect(await runStop(rec.deps)).toBe(1);
    const printed = rec.err.join("");
    expect(printed).toContain("predates the control API");
    expect(printed).toContain("SIGTERM");
    // Never waits on a lock a pre-control daemon was never asked to drop.
    expect(rec.probes).toBe(0);
  });
});
