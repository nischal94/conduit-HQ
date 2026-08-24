import {
  AGENT_VERSION,
  CAPABILITY_REJECTION_PREFIX,
  DaemonUnavailable,
  DRAIN_DEADLINE_MS,
  type RpcRequest,
  type RpcResponse,
} from "@conduithq/mcp";
import { describe, expect, it } from "vitest";
import {
  type DaemonCmdDeps,
  runStatus,
  runStop,
  STOP_POLL_MS,
  STOP_WAIT_MS,
} from "./commands/daemon.js";
import { VERSION } from "./dispatch.js";

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
    // The seam is kind-generic, so a fake has to be too. The cast is the
    // FAKE's, not the command's: this stub answers every kind from one
    // untyped literal, which is exactly what a fake is for — the command
    // itself reads its payloads with no cast at all.
    daemon: ((request: RpcRequest) => {
      requests.push(request);
      return options.answer(request);
    }) as DaemonCmdDeps["daemon"],
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

/**
 * The frame a PRE-CONTROL daemon sends: it has no `control` capability.
 *
 * The prefix is IMPORTED rather than re-spelled — the same coupling the
 * detection under test makes. A local copy would keep passing after a
 * reword on the daemon side, pinning a message no daemon sends. The row
 * list is the literal a pre-control daemon carried (no `control` in it),
 * which is the whole point of the fixture and correctly stays a literal.
 */
const PRE_CONTROL_FRAME: RpcResponse = {
  kind: "error",
  requestId: "r1",
  code: "invalid",
  message: `${CAPABILITY_REJECTION_PREFIX} serve | approvals | add-mcp`,
};

describe("conduit daemon status", () => {
  it("prints the running daemon's projection and exits 0", async () => {
    const rec = makeDeps({
      answer: async () => ({ kind: "result", requestId: "r1", payload: STATUS_PAYLOAD }),
    });

    expect(await runStatus(rec.deps)).toBe(0);

    const printed = rec.out.join("");
    expect(printed).toContain("running");
    // LABELLED substrings, not bare digits: `toContain("3")` passes on any
    // output containing a 3 anywhere — including the wrong field.
    expect(printed).toContain("pid:         4242");
    // Both versions: the daemon's build AND this CLI's, so an operator
    // reading a skew warning can see the two numbers it names.
    expect(printed).toContain("version:     0.1.0 (this CLI: 0.1.0)");
    expect(printed).toContain("db:          /state/conduit.db");
    expect(printed).toContain("connections: 3");
    expect(printed).toContain("in flight:   2 running, 5 queued");
    expect(printed).toContain("log:         /state/conduitd.log (8192 bytes)");
    expect(printed).toContain("started:     2026-08-22T12:00:00.000Z");
    expect(rec.requests).toEqual([{ kind: "daemon.status" }]);
  });

  it("sanitizes the daemon-reported version before printing it", async () => {
    const rec = makeDeps({
      answer: async () => ({
        kind: "result",
        requestId: "r1",
        payload: { ...STATUS_PAYLOAD, agentVersion: "9.9.9\x1b[2J\x1b[H" },
      }),
    });

    expect(await runStatus(rec.deps)).toBe(0);
    const printed = rec.out.join("");
    // The version arrives over a socket and lands on a terminal: no
    // terminal-escape introducer survives the render.
    expect(printed).not.toContain("\x1b");
    expect(printed).toContain("9.9.9");
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
    // CX3: absence is VERIFIED, not assumed from the timeout — status probes
    // the lifecycle lock exactly once and reads it free. The probe is
    // read-only (never creates the state dir), so "never spawns" still holds:
    // it reads the lock, it does not start a daemon.
    expect(rec.probes).toBe(1);
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

  it("exits 1 on outcome-unknown: unlike stop, there is nothing to verify", async () => {
    // The asymmetry with `stop` is deliberate. `stop`'s answer is a goal
    // state the lifecycle lock can confirm independently, so a lost ack is
    // recoverable. `status`'s answer IS the lost frame — the projection
    // exists nowhere else — so an ambiguous outcome is simply a failure.
    const rec = makeDeps({
      answer: async () => ({ kind: "outcome-unknown", requestId: "r1" }),
    });

    expect(await runStatus(rec.deps)).toBe(1);
    expect(rec.out.join("")).not.toContain("running");
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

    // Exit 0, unlike status: the operator wanted it stopped, and it is —
    // but only after CX3 VERIFIES absence. One read-only lifecycle-lock probe
    // reads it free, so "not running" is truthful, not a timeout guess. Still
    // no spawn: the probe reads the lock, it does not start a daemon.
    expect(await runStop(rec.deps)).toBe(0);
    expect(rec.out.join("")).toContain("not running");
    expect(rec.probes).toBe(1);
  });

  it("CX3: DaemonUnavailable + lifecycle lock BUSY → 'still running/unreachable', exit 1", async () => {
    // A wedged/starting/draining daemon holds the lifecycle lock but never
    // reaches READY before the client deadline, surfacing as a plain
    // `DaemonUnavailable("unavailable")`. Printing "not running" exit 0 there
    // is a false success. CX3 probes the lock, reads it busy, and reports the
    // daemon as still running / unreachable with a nonzero exit.
    const rec = makeDeps({
      answer: async () => {
        throw new DaemonUnavailable("unavailable", "no daemon answered at /state");
      },
      probes: ["busy"],
    });

    expect(await runStop(rec.deps)).toBe(1);
    // NOT the idempotent success line.
    expect(rec.out.join("")).not.toContain("not running");
    const combined = rec.err.join("");
    expect(combined).toContain("lifecycle lock");
    expect(combined.toLowerCase()).toContain("unreachable");
    expect(rec.probes).toBe(1);
  });

  it("CX3: DaemonUnavailable + lifecycle lock FREE → 'not running', exit 0 (verified absence)", async () => {
    // The complement of the busy case: a free lock is proof of genuine
    // absence, so stop's idempotent success is truthful.
    const rec = makeDeps({
      answer: async () => {
        throw new DaemonUnavailable("unavailable", "no daemon answered at /state");
      },
      probes: ["free"],
    });

    expect(await runStop(rec.deps)).toBe(0);
    expect(rec.out.join("")).toContain("not running");
    expect(rec.probes).toBe(1);
  });

  it("CX3: status + lifecycle lock BUSY → up-but-unreachable, exit 1, never 'not running'", async () => {
    // The same conflation on the status path: a busy lock means the daemon is
    // running but unreachable, which status must not misreport as absent.
    const rec = makeDeps({
      answer: async () => {
        throw new DaemonUnavailable("unavailable", "no daemon answered at /state");
      },
      probes: ["busy"],
    });

    expect(await runStatus(rec.deps)).toBe(1);
    expect(rec.out.join("")).not.toContain("not running");
    expect(rec.err.join("").toLowerCase()).toContain("unreachable");
    expect(rec.probes).toBe(1);
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
    // The window is bounded, and EXACTLY so: the fake clock advances only
    // on sleep, so the loop probes once per poll interval across the wait
    // window. No `+1` — the guard is `now < waitUntil`, so the iteration
    // that would sit exactly ON the boundary never runs. The old bound
    // (`<= STOP_WAIT_MS`) was 100x looser than the real count and would
    // have passed a loop that polled every millisecond.
    expect(rec.probes).toBe(STOP_WAIT_MS / STOP_POLL_MS);
  });

  it("reports a probe failure as unverified termination rather than a stack trace", async () => {
    // The probe opens the lock database, so it can fail for reasons that
    // have nothing to do with the daemon — a permissions change, a removed
    // state directory. Unhandled, that rejection escaped `runStop` and hit
    // the operator as a raw stack trace on a command that had already
    // successfully asked the daemon to stop.
    const rec = makeDeps({
      answer: async () => ({ kind: "result", requestId: "r1", payload: { stopping: true } }),
    });
    rec.deps.probeLifecycle = async () => {
      throw new Error("EACCES: permission denied, open '/state/lifecycle.db'");
    };

    // A defined exit code, not a thrown error.
    expect(await runStop(rec.deps)).toBe(1);
    const printed = rec.err.join("");
    // Names the probe failure, and carries its cause for diagnosis.
    expect(printed).toContain("could NOT be verified");
    expect(printed).toContain("EACCES");
    // Forbids BOTH wrong inferences: the ack landed, so this is not "still
    // running", and verification failed, so it is not "stopped" either.
    expect(printed).toContain("conduit daemon status");
    expect(rec.out.join("")).not.toContain("stopped");
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

  it("falls through to the lock poll on outcome-unknown and reports the verified stop", async () => {
    // A cut ack is the NATURAL case on a stopping daemon, not a fault: the
    // daemon writes the frame and immediately begins draining, so the
    // connection can close before the client finishes reading it. The
    // lifecycle lock answers the only question this command asks, and it
    // is readable whatever happened to the ack — so refusing here would
    // print "stop failed" about a daemon that exited cleanly.
    const rec = makeDeps({
      answer: async () => ({ kind: "outcome-unknown", requestId: "r1" }),
      probes: ["busy", "free"],
    });

    expect(await runStop(rec.deps)).toBe(0);
    expect(rec.out.join("")).toContain("stopped");
    // The verification actually ran rather than the arm being skipped.
    expect(rec.probes).toBe(2);
    // Said so on stderr, so the operator can tell a verified stop from an
    // acked one when reading the transcript afterwards.
    expect(rec.err.join("")).toContain("outcome unknown");
  });

  it("still exits 1 on outcome-unknown when the lock never frees", async () => {
    // The fall-through is a VERIFICATION, not a pardon: an ambiguous ack
    // over a daemon that never releases the lock is the still-draining
    // path, identical to a clean ack that never verifies.
    const rec = makeDeps({
      answer: async () => ({ kind: "outcome-unknown", requestId: "r1" }),
      probes: ["busy"],
    });

    expect(await runStop(rec.deps)).toBe(1);
    expect(rec.err.join("")).toMatch(/draining/i);
    expect(rec.out.join("")).not.toContain("stopped");
  });

  it("waits longer than the daemon takes to drain", () => {
    // STOP_WAIT_MS is documented as "the drain deadline plus margin" but
    // derived from neither constant, and the two live in different
    // packages — so nothing else fails if the daemon's budget grows. A wait
    // window BELOW the drain deadline would report "still draining" at an
    // operator for every daemon that merely used its full budget.
    expect(STOP_WAIT_MS).toBeGreaterThan(DRAIN_DEADLINE_MS);
  });
});

describe("CLI and agent versions", () => {
  it("ship in lockstep", () => {
    // Two DIFFERENT versions that happen to be equal today. `VERSION` names
    // the user-facing CLI release; `AGENT_VERSION` names the mcp package's
    // build, which is what the daemon runs and therefore what the §4 skew
    // warning compares against. `daemon status` prints `VERSION` on its
    // "this CLI" line, because that line answers "which conduit am I
    // running", not "which mcp does it bundle".
    //
    // The packages version together today, so no reader can tell the two
    // apart by inspection — which is precisely the hazard. This test is the
    // TRIPWIRE for a future split: the day the versions diverge it fails,
    // and whoever splits them has to decide deliberately what each display
    // site and each comparand should say, rather than discovering it from
    // an operator report about a wrong number on a status line.
    expect(VERSION).toBe(AGENT_VERSION);
  });
});
