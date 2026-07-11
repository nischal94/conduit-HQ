import { buildExecuteTool } from "@conduithq/sdk";
import { describe, expect, it } from "vitest";
import {
  CHECK_EXECUTION_TOOL,
  estimateDefinitionTokens,
  executionToCheckPayload,
  extendExecuteDefinition,
  outcomeToPayload,
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
