import { describe, expect, it } from "vitest";
import type { ReplayJournalRow } from "../store/store.js";
import type { PendingApproval } from "../types.js";
import type { PendingCallIdentity } from "./decisions.js";
import { matchesPending, toSandboxJournal } from "./journal.js";

describe("toSandboxJournal (§5.5 design D4)", () => {
  it("maps rows in ordinal order to JournalEntry[], preserving op/request/outcome", () => {
    const rows: ReplayJournalRow[] = [
      {
        ordinal: 2,
        op: "call",
        request: '{"b":1}',
        outcome: { ok: true, value: "second" },
      },
      {
        ordinal: 0,
        op: "search",
        request: '{"a":1}',
        outcome: { ok: true, value: "first" },
      },
      {
        ordinal: 1,
        op: "describe",
        request: '{"c":1}',
        outcome: { ok: false, error: { name: "PolicyDenied", message: "no" } },
      },
    ];

    const journal = toSandboxJournal(rows);

    expect(journal).toEqual([
      { op: "search", request: '{"a":1}', outcome: { ok: true, value: "first" } },
      {
        op: "describe",
        request: '{"c":1}',
        outcome: { ok: false, error: { name: "PolicyDenied", message: "no" } },
      },
      { op: "call", request: '{"b":1}', outcome: { ok: true, value: "second" } },
    ]);
  });

  it("maps an empty row list to an empty journal", () => {
    expect(toSandboxJournal([])).toEqual([]);
  });

  it("REJECTS a journal with a gap in the ordinals (0,2 → not contiguous)", () => {
    // (F5) The sandbox replays by array POSITION; a gap compacts the surviving
    // rows into different slots than the guest re-emits → a silent WRONG prefix.
    // Fail loudly instead of replaying a corrupt journal as a valid short one.
    const rows: ReplayJournalRow[] = [
      { ordinal: 0, op: "call", request: "{}", outcome: { ok: true, value: 1 } },
      { ordinal: 2, op: "call", request: "{}", outcome: { ok: true, value: 2 } },
    ];
    expect(() => toSandboxJournal(rows)).toThrow(/contiguous/i);
  });

  it("REJECTS a journal that does not start at ordinal 0", () => {
    const rows: ReplayJournalRow[] = [
      { ordinal: 1, op: "call", request: "{}", outcome: { ok: true, value: 1 } },
    ];
    expect(() => toSandboxJournal(rows)).toThrow(/contiguous/i);
  });

  it("REJECTS a journal with a duplicate ordinal", () => {
    const rows: ReplayJournalRow[] = [
      { ordinal: 0, op: "call", request: "{}", outcome: { ok: true, value: 1 } },
      { ordinal: 0, op: "call", request: "{}", outcome: { ok: true, value: 2 } },
    ];
    expect(() => toSandboxJournal(rows)).toThrow(/contiguous/i);
  });

  it("accepts a contiguous 0..n-1 journal", () => {
    const rows: ReplayJournalRow[] = [
      { ordinal: 0, op: "search", request: "{}", outcome: { ok: true, value: 1 } },
      { ordinal: 1, op: "call", request: "{}", outcome: { ok: true, value: 2 } },
      { ordinal: 2, op: "call", request: "{}", outcome: { ok: true, value: 3 } },
    ];
    expect(toSandboxJournal(rows).map((e) => e.outcome)).toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
      { ok: true, value: 3 },
    ]);
  });

  it("does not mutate the input rows array (pure function)", () => {
    const rows: ReplayJournalRow[] = [
      { ordinal: 1, op: "call", request: "{}", outcome: { ok: true, value: null } },
      { ordinal: 0, op: "call", request: "{}", outcome: { ok: true, value: null } },
    ];
    const rowsCopy = rows.map((r) => ({ ...r }));
    toSandboxJournal(rows);
    expect(rows).toEqual(rowsCopy);
  });
});

describe("matchesPending (§5.5 design F2)", () => {
  const pausedOn: PendingApproval = {
    callId: "call_1",
    toolName: "github.delete_repo",
    input: { repo: "x" },
    reason: "destructive",
    expiresAt: Date.now() + 60_000,
  };

  it("true when op, toolName, and request all match", () => {
    const identity: PendingCallIdentity = {
      op: "call",
      toolName: "github.delete_repo",
      request: JSON.stringify({ repo: "x" }),
    };
    expect(matchesPending(identity, pausedOn)).toBe(true);
  });

  it("false when toolName differs", () => {
    const identity: PendingCallIdentity = {
      op: "call",
      toolName: "github.create_issue",
      request: JSON.stringify({ repo: "x" }),
    };
    expect(matchesPending(identity, pausedOn)).toBe(false);
  });

  it("false when request differs", () => {
    const identity: PendingCallIdentity = {
      op: "call",
      toolName: "github.delete_repo",
      request: JSON.stringify({ repo: "y" }),
    };
    expect(matchesPending(identity, pausedOn)).toBe(false);
  });

  it("false when op differs", () => {
    // PendingCallIdentity["op"] is the literal "call"; simulate a divergent
    // op via a same-shaped object cast, since a real call site could never
    // construct a non-"call" identity — the test proves op is still checked.
    const identity = {
      op: "search",
      toolName: "github.delete_repo",
      request: JSON.stringify({ repo: "x" }),
    } as unknown as PendingCallIdentity;
    expect(matchesPending(identity, pausedOn)).toBe(false);
  });
});
