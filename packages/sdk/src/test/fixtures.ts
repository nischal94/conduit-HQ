import type { Execution, PendingApproval } from "../types.js";

/**
 * Shared test-only builders (plan D-A12/F10d). Not exported from index.ts:
 * they exist so a required-field addition to `Execution` is absorbed in one
 * place rather than in every test that builds a row.
 */

export function codeRow(
  overrides: Partial<Extract<Execution, { kind: "code" }>> & { id: string },
): Execution {
  return {
    kind: "code",
    code: "return 1",
    status: "running",
    seeds: { now: 0, random: 0 },
    startedAt: 0,
    clientId: null,
    projection: "code",
    ...overrides,
  };
}

export function directRow(
  overrides: Partial<Extract<Execution, { kind: "direct" }>> & { id: string },
): Execution {
  return {
    kind: "direct",
    call: { toolName: "github.issues.list", namespace: "github", request: "{}" },
    status: "running",
    startedAt: 0,
    clientId: null,
    projection: "direct",
    ...overrides,
  };
}

/** A well-formed R1 pause (provenance included) for the given namespace. */
export function pause(
  namespace: string,
  overrides: Partial<PendingApproval> = {},
): PendingApproval {
  return {
    callId: "c",
    toolName: `${namespace}.t`,
    namespace,
    sourceGeneration: 1,
    input: {},
    reason: "r",
    expiresAt: 9e12,
    ...overrides,
  };
}

/** A canonical `DirectCall` for a direct row. */
export function directCall(
  overrides: Partial<Extract<Execution, { kind: "direct" }>["call"]> = {},
): Extract<Execution, { kind: "direct" }>["call"] {
  return { toolName: "github.issues.list", namespace: "github", request: "{}", ...overrides };
}
