import { buildExecuteTool, type ExecutionOutcome } from "@conduithq/sdk";
import { describe, expect, it } from "vitest";
import {
  CHECK_BODY_STATUSES,
  CHECK_EXECUTION_TOOL,
  type DaemonStatusPayload,
  EXECUTE_STATUSES,
  type ExecuteStatus,
  estimateDefinitionTokens,
  executionToCheckPayload,
  extendExecuteDefinition,
  isCheckPayloadShape,
  isDaemonStatusShape,
  isExecutePayloadShape,
  isResumePayloadShape,
  outcomeToPayload,
  pausedToListRow,
  resumeToPayload,
} from "./payloads.js";

const seeds = { now: 1, random: 0.5 };

describe("tool definitions", () => {
  it("INVARIANT §4.2: check_execution definition ≤ 256 estimated tokens", () => {
    expect(estimateDefinitionTokens(CHECK_EXECUTION_TOOL)).toBeLessThanOrEqual(256);
  });
  it("INVARIANT §4.2: extended execute definition (requestKey) stays ≤ 1044 tokens", () => {
    const base = buildExecuteTool({
      connections: [{ prefix: "github.acme.prod", label: "Acme GitHub" }],
    });
    const extended = extendExecuteDefinition(base);
    // JsonSchema is Record<string, unknown>, so `properties` is untyped; the cast
    // mirrors extendExecuteDefinition's own internal access.
    expect((extended.inputSchema.properties as Record<string, unknown>).requestKey).toBeDefined();
    expect(estimateDefinitionTokens(extended)).toBeLessThanOrEqual(1_044);
  });
});

describe("outcomeToPayload (execute)", () => {
  it("completed normalizes undefined result to null and requires the field", () => {
    const p = outcomeToPayload({ status: "completed", executionId: "e1", value: undefined });
    expect(p).toEqual({ status: "completed", executionId: "e1", result: null });
  });
  it("failed wraps the error envelope", () => {
    const p = outcomeToPayload({
      status: "failed",
      executionId: "e2",
      error: { name: "ConduitExecutionError", message: "boom" },
    });
    expect(p.error).toEqual({ code: "ConduitExecutionError", message: "boom", retryable: false });
  });
  it("paused message tells the agent to report to the human and STOP", () => {
    const p = outcomeToPayload({
      status: "paused",
      executionId: "e3",
      pending: {
        callId: "c",
        toolName: "github.delete_repo",
        input: {},
        reason: "destructive",
        expiresAt: 99,
      },
    });
    expect(p.pending).toEqual({
      toolName: "github.delete_repo",
      reason: "destructive",
      expiresAt: 99,
    });
    expect(p.message).toMatch(/report .* to the (user|human)/i);
    expect(p.message).toMatch(/stop/i);
    expect(p.message).toMatch(/check_execution/);
  });
  it("conflict (duplicate requestKey) points at check_execution", () => {
    const p = outcomeToPayload({ status: "conflict", executionId: "e4" });
    expect(p.status).toBe("conflict");
    expect(p.message).toMatch(/check_execution/);
  });
});

describe("resumeToPayload (approvals.resume)", () => {
  it("INVARIANT §17 / §3.3: the resume projection carries decisionApplied — the verb-truth axis the CLI keys on", () => {
    // `decisionApplied` is host-side truth about whether the operator's
    // staged decision was CONSUMED (sdk D6), and it is the ONLY field the
    // CLI may key its verb reporting on: outcome error NAMES are
    // guest-reachable and therefore spoofable in both directions. If the
    // wire shape dropped it, the daemon path could not honor the PR #40
    // contract at all.
    const applied = resumeToPayload({
      status: "failed",
      executionId: "e_denied",
      error: { name: "ConduitPolicyBlocked", message: "policy denied the execution" },
      decisionApplied: true,
    });
    expect(applied.decisionApplied).toBe(true);
    expect(applied.status).toBe("failed");

    const notApplied = resumeToPayload({
      status: "failed",
      executionId: "e_spoof",
      error: { name: "ConduitPolicyBlocked", message: "guest-forged name" },
      decisionApplied: false,
    });
    expect(notApplied.decisionApplied).toBe(false);
  });

  it("is a PROJECTION over ExecutePayload, not the raw ResumeOutcome: the failed arm carries the vetted error envelope", () => {
    // Same discipline as every other D-B1 answer: the raw outcome's
    // `SandboxError` and `PendingApproval` shapes come straight off the
    // pipeline (`pending.input` carries the CALL ARGUMENTS), and only the
    // vetted view crosses the socket.
    const p = resumeToPayload({
      status: "failed",
      executionId: "e1",
      error: { name: "SomeError", message: "boom" },
      decisionApplied: false,
    });
    expect(p.error).toEqual({ code: "SomeError", message: "boom", retryable: false });
  });

  it("the paused arm projects the pending VIEW and drops the raw pausedOn input", () => {
    const p = resumeToPayload({
      status: "paused",
      executionId: "e2",
      pending: {
        callId: "c1",
        toolName: "github.push",
        input: { token: "should-never-cross-the-socket" },
        reason: "review",
        expiresAt: 9,
      },
      decisionApplied: true,
    });
    expect(p.pending).toEqual({ toolName: "github.push", reason: "review", expiresAt: 9 });
    // The projection is what the socket carries; the call arguments the
    // agent passed are not part of the approvals answer.
    expect(JSON.stringify(p)).not.toContain("should-never-cross-the-socket");
  });

  it("carries every outcome status the verb-truth branches need", () => {
    expect(
      resumeToPayload({ status: "conflict", executionId: "e3", decisionApplied: false }).status,
    ).toBe("conflict");
    expect(
      resumeToPayload({
        status: "expired",
        executionId: "e4",
        pending: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 1 },
        decisionApplied: false,
      }).status,
    ).toBe("expired");
    expect(
      resumeToPayload({
        status: "completed",
        executionId: "e5",
        value: { ok: true },
        decisionApplied: true,
      }),
    ).toMatchObject({ status: "completed", result: { ok: true }, decisionApplied: true });
  });
});

describe("executionToCheckPayload (check_execution)", () => {
  const base = { id: "e", code: "1", seeds, startedAt: 1 } as const;
  it("not_found for unknown executions", () => {
    expect(executionToCheckPayload(undefined, 10)).toEqual({ status: "not_found" });
  });
  it("running passes through", () => {
    expect(executionToCheckPayload({ ...base, status: "running" }, 10).status).toBe("running");
  });
  it("paused past expiresAt presents expired READ-ONLY with a retry message", () => {
    const p = executionToCheckPayload(
      {
        ...base,
        status: "paused",
        pausedOn: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 5 },
      },
      10,
    );
    expect(p.status).toBe("expired");
    if (p.status === "expired") {
      expect(p.message).toMatch(/re-issue|retry/i);
    }
  });
  it("paused before expiresAt carries pending", () => {
    const p = executionToCheckPayload(
      {
        ...base,
        status: "paused",
        pausedOn: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 50 },
      },
      10,
    );
    expect(p.status).toBe("paused");
    if (p.status === "paused") {
      expect(p.pending?.toolName).toBe("t");
    }
  });
  it("completed requires result (null when absent/legacy)", () => {
    expect(executionToCheckPayload({ ...base, status: "completed", endedAt: 2 }, 10)).toEqual({
      status: "completed",
      executionId: "e",
      result: null,
    });
  });
  it("failed always carries the envelope", () => {
    const p = executionToCheckPayload(
      {
        ...base,
        status: "failed",
        endedAt: 2,
        error: { name: "ConduitPersistError", message: "m" },
      },
      10,
    );
    expect(p.status).toBe("failed");
    if (p.status === "failed") {
      expect(p.error?.code).toBe("ConduitPersistError");
    }
  });
});

describe("pausedToListRow (the approvals.list projection)", () => {
  const base = { id: "e", code: "1", seeds, startedAt: 1_000 } as const;

  it("INVARIANT §17: the paused call's ARGUMENTS never cross the socket on approvals.list", () => {
    // The stored `pausedOn` is a raw `PendingApproval` whose `input` is the
    // agent-supplied call arguments. `conduit approvals list` reads only the
    // tool name and the expiry, so shipping the raw row would put sensitive
    // arguments on the socket to buy nothing. Same discipline, and the same
    // assertion shape, as `resumeToPayload`'s paused arm.
    const row = pausedToListRow({
      ...base,
      status: "paused",
      pausedOn: {
        callId: "c1",
        toolName: "github.delete_repo",
        input: { token: "should-never-cross-the-socket" },
        reason: "requires approval",
        expiresAt: 9,
      },
    });

    expect(row).toEqual({
      executionId: "e",
      startedAt: 1_000,
      toolName: "github.delete_repo",
      reason: "requires approval",
      expiresAt: 9,
    });
    // The whole serialized row, not just the fields named above: a field
    // added later that reintroduced the arguments would fail here.
    expect(JSON.stringify(row)).not.toContain("should-never-cross-the-socket");
  });

  it("returns undefined for a corrupt paused row with no pausedOn (caller logs, never silently drops)", () => {
    expect(pausedToListRow({ ...base, status: "paused" })).toBeUndefined();
  });
});

/**
 * F6 — the predicates are the SINGLE SOURCE OF TRUTH the sender projections
 * and the client guard both read.
 *
 * The point of these tests is not that a given arm renders some fields —
 * that is covered above — but that EVERY status arm a sender can produce
 * passes the SAME shape predicate the client (`client.ts`) refuses on. If a
 * projection ever emitted an arm the guard would reject, this fails; that is
 * what makes "single source of truth" a checked property rather than a
 * claim. The status-set exhaustiveness (each legal member is exercised) is
 * asserted alongside, so an added union member with no covering arm is
 * caught here too.
 */
describe("INVARIANT §17 (F6): sender projections pass the SAME predicate the client guard uses", () => {
  const base = { id: "e", code: "1", seeds, startedAt: 1 } as const;

  // One representative outcome per execute status. Every member of
  // EXECUTE_STATUSES must appear as a key, or the set-coverage check fails.
  const executeOutcomes = {
    completed: { status: "completed", executionId: "e", value: { ok: true } },
    failed: { status: "failed", executionId: "e", error: { name: "E", message: "m" } },
    paused: {
      status: "paused",
      executionId: "e",
      pending: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 9 },
    },
    expired: {
      status: "expired",
      executionId: "e",
      pending: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 9 },
    },
    conflict: { status: "conflict", executionId: "e" },
  } satisfies Record<ExecuteStatus, ExecutionOutcome>;

  it("every EXECUTE_STATUSES arm of outcomeToPayload passes isExecutePayloadShape", () => {
    // Set coverage: the fixtures name exactly the legal members.
    expect(Object.keys(executeOutcomes).sort()).toEqual([...EXECUTE_STATUSES].sort());
    for (const status of EXECUTE_STATUSES) {
      const payload = outcomeToPayload(executeOutcomes[status]);
      expect(payload.status).toBe(status);
      expect(isExecutePayloadShape(payload)).toBe(true);
    }
  });

  it("every EXECUTE_STATUSES arm of resumeToPayload passes isResumePayloadShape (and carries decisionApplied)", () => {
    for (const status of EXECUTE_STATUSES) {
      for (const decisionApplied of [true, false]) {
        const payload = resumeToPayload({ ...executeOutcomes[status], decisionApplied });
        expect(payload.status).toBe(status);
        expect(payload.decisionApplied).toBe(decisionApplied);
        expect(isResumePayloadShape(payload)).toBe(true);
      }
    }
  });

  it("every CHECK_BODY_STATUSES arm of executionToCheckPayload — plus not_found — passes isCheckPayloadShape", () => {
    // not_found is the id-less arm the predicate accepts specially.
    expect(isCheckPayloadShape(executionToCheckPayload(undefined, 10))).toBe(true);

    const checkExecutions = {
      running: { ...base, status: "running" },
      completed: { ...base, status: "completed", endedAt: 2 },
      failed: { ...base, status: "failed", endedAt: 2, error: { name: "E", message: "m" } },
      // A future expiresAt keeps this arm PAUSED (a past one would present as
      // expired — covered by the expired key below via the store status).
      paused: {
        ...base,
        status: "paused",
        pausedOn: { callId: "c", toolName: "t", input: {}, reason: "r", expiresAt: 5_000 },
      },
      expired: { ...base, status: "expired", endedAt: 2 },
    } as const;
    expect(Object.keys(checkExecutions).sort()).toEqual([...CHECK_BODY_STATUSES].sort());

    for (const status of CHECK_BODY_STATUSES) {
      const payload = executionToCheckPayload(checkExecutions[status], 10);
      expect(payload.status).toBe(status);
      expect(isCheckPayloadShape(payload)).toBe(true);
    }
  });

  it("a representative ILLEGAL status is rejected by each predicate (the guard is membership, not merely a string)", () => {
    const bogusExecute = { status: "bogus", executionId: "e" };
    expect(isExecutePayloadShape(bogusExecute)).toBe(false);
    expect(isResumePayloadShape({ ...bogusExecute, decisionApplied: true })).toBe(false);
    expect(isCheckPayloadShape(bogusExecute)).toBe(false);
    // A legal execute status that is NOT a legal check body status is also
    // rejected by the check predicate — the sets are genuinely distinct.
    expect(isCheckPayloadShape({ status: "conflict", executionId: "e" })).toBe(false);
    // And a legal status missing the mandatory executionId is rejected.
    expect(isExecutePayloadShape({ status: "completed" })).toBe(false);
  });
});

describe("isDaemonStatusShape (the daemon.status projection)", () => {
  /**
   * A complete, legal payload. Every field below is interpolated into the
   * operator's report by `conduit daemon status`, which is why the guard
   * checks all of them rather than a structural floor.
   */
  const FULL: DaemonStatusPayload = {
    pid: 4242,
    agentVersion: "0.1.0",
    startedAt: Date.UTC(2026, 7, 22, 12, 0, 0),
    dbPath: "/state/conduit.db",
    connections: 2,
    executionsInFlight: 1,
    queueDepth: 3,
    logPath: "/state/conduitd.log",
    logSizeBytes: 1024,
  };

  it("INVARIANT §3.1: accepts the full projection, and the nullable log fields as null", () => {
    expect(isDaemonStatusShape(FULL)).toBe(true);
    // TTY-hosted daemon: no log file to report. `null` is the CONTRACT
    // value, distinct from an absent field.
    expect(isDaemonStatusShape({ ...FULL, logPath: null, logSizeBytes: null })).toBe(true);
  });

  it("INVARIANT §3.1: deleting ANY field makes the status projection invalid", () => {
    // Field-completeness, derived from the payload rather than from a
    // hand-written list: a field ADDED to `DaemonStatusPayload` is covered
    // here automatically, so the guard cannot silently stop checking one.
    // Every field fails the same way — the renderer interpolates it, so an
    // absent one reaches the operator as "undefined" or, for `startedAt`,
    // as a RangeError out of `toISOString()`.
    const keys = Object.keys(FULL) as (keyof DaemonStatusPayload)[];
    expect(keys).toHaveLength(9);
    for (const key of keys) {
      const partial: Record<string, unknown> = { ...FULL };
      delete partial[key];
      expect(isDaemonStatusShape(partial), `deleting ${key} must invalidate`).toBe(false);
    }
  });

  it("rejects an array, which is an object but never a payload", () => {
    // `isRecord` excludes arrays (matching rpc.ts): without that, `[]`
    // clears the first hurdle and the field checks decide the answer on a
    // value that was never a projection.
    expect(isDaemonStatusShape([])).toBe(false);
  });

  it("CX6: rejects a finite-but-out-of-Date-range startedAt (guard refuses, no RangeError)", () => {
    // 1e20 is finite, so the old `Number.isFinite` check let it through — and
    // `new Date(1e20).toISOString()` throws RangeError, turning a protocol
    // fault into a CLI-fatal stack trace. The guard must refuse it as a
    // malformed projection instead.
    const badStatus = { ...FULL, startedAt: 1e20 };
    expect(isDaemonStatusShape(badStatus)).toBe(false);
    // Non-vacuous: the value the guard rejects is exactly the one that would
    // throw if it reached the renderer.
    expect(() => new Date(badStatus.startedAt).toISOString()).toThrow(RangeError);
  });

  it("CX6: rejects a negative startedAt", () => {
    expect(isDaemonStatusShape({ ...FULL, startedAt: -1 })).toBe(false);
  });

  it("CX6: accepts startedAt at the exact Date-range boundary, rejects one past it", () => {
    expect(isDaemonStatusShape({ ...FULL, startedAt: 8.64e15 })).toBe(true);
    expect(isDaemonStatusShape({ ...FULL, startedAt: 8.64e15 + 1 })).toBe(false);
  });

  it("CX6: rejects negative, fractional, or 2^53-imprecise counters", () => {
    for (const field of ["pid", "connections", "executionsInFlight", "queueDepth"] as const) {
      expect(isDaemonStatusShape({ ...FULL, [field]: -1 }), `${field} negative`).toBe(false);
      expect(isDaemonStatusShape({ ...FULL, [field]: 1.5 }), `${field} fractional`).toBe(false);
      expect(
        isDaemonStatusShape({ ...FULL, [field]: Number.MAX_SAFE_INTEGER + 1 }),
        `${field} beyond safe integer`,
      ).toBe(false);
    }
  });

  it("CX6: rejects a negative or fractional logSizeBytes while still accepting null", () => {
    expect(isDaemonStatusShape({ ...FULL, logSizeBytes: -1 })).toBe(false);
    expect(isDaemonStatusShape({ ...FULL, logSizeBytes: 1.5 })).toBe(false);
    expect(isDaemonStatusShape({ ...FULL, logSizeBytes: null, logPath: null })).toBe(true);
  });
});
