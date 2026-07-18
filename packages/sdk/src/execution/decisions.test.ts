import { describe, expect, it } from "vitest";
import { createInMemoryApprovalDecisions, type PendingCallIdentity } from "./decisions.js";

const deleteRepo: PendingCallIdentity = {
  op: "call",
  toolName: "github.delete_repo",
  request: '{"repo":"x"}',
};
const createIssue: PendingCallIdentity = {
  op: "call",
  toolName: "github.create_issue",
  request: '{"repo":"x"}',
};

describe("createInMemoryApprovalDecisions (§5.5 design D6)", () => {
  it("take: returns the staged decision once, only for the matching identity", () => {
    const d = createInMemoryApprovalDecisions();
    d.stage("exec_1", deleteRepo, { kind: "approve" });
    // wrong identity → undefined (the decision stays staged; it is NOT consumed)
    expect(d.take("exec_1", createIssue)).toBeUndefined();
    // right identity → approve, once
    expect(d.take("exec_1", deleteRepo)).toEqual({ kind: "approve" });
    // consumed one-shot: a second take of the same identity returns undefined
    expect(d.take("exec_1", deleteRepo)).toBeUndefined();
  });

  it("peek: reports a decision is staged without consuming it", () => {
    const d = createInMemoryApprovalDecisions();
    expect(d.peek("exec_1")).toBe(false);
    d.stage("exec_1", deleteRepo, { kind: "deny" });
    expect(d.peek("exec_1")).toBe(true);
    // peek does not consume — the matching take still succeeds
    expect(d.take("exec_1", deleteRepo)).toEqual({ kind: "deny" });
    expect(d.peek("exec_1")).toBe(false);
  });

  it("isolates decisions by executionId — a decision for one execution never leaks to another", () => {
    const d = createInMemoryApprovalDecisions();
    d.stage("exec_1", deleteRepo, { kind: "approve" });
    expect(d.take("exec_2", deleteRepo)).toBeUndefined();
    expect(d.peek("exec_2")).toBe(false);
    // exec_1's decision is untouched by the exec_2 probe
    expect(d.take("exec_1", deleteRepo)).toEqual({ kind: "approve" });
  });

  it("request equality is byte-exact: a differing input serialization does not match", () => {
    const d = createInMemoryApprovalDecisions();
    d.stage("exec_1", deleteRepo, { kind: "approve" });
    expect(
      d.take("exec_1", { op: "call", toolName: "github.delete_repo", request: '{"repo":"y"}' }),
    ).toBeUndefined();
    expect(d.take("exec_1", deleteRepo)).toEqual({ kind: "approve" });
  });

  it("discard: drops a staged decision unconditionally so it can never be reused (F2)", () => {
    const d = createInMemoryApprovalDecisions();
    d.stage("exec_1", deleteRepo, { kind: "approve" });
    expect(d.peek("exec_1")).toBe(true);
    d.discard("exec_1");
    // Gone: neither peek nor a matching take sees it after a divergence discard.
    expect(d.peek("exec_1")).toBe(false);
    expect(d.take("exec_1", deleteRepo)).toBeUndefined();
  });

  it("discard: is a no-op when nothing is staged", () => {
    const d = createInMemoryApprovalDecisions();
    expect(() => d.discard("exec_none")).not.toThrow();
    expect(d.peek("exec_none")).toBe(false);
  });

  describe("consumed — host-side truth that the staged decision was applied", () => {
    it("is false before staging and while a decision is merely staged", () => {
      const d = createInMemoryApprovalDecisions();
      expect(d.consumed("exec_1")).toBe(false);
      d.stage("exec_1", deleteRepo, { kind: "deny" });
      expect(d.consumed("exec_1")).toBe(false);
    });

    it("becomes true only after a matching take consumes the decision", () => {
      const d = createInMemoryApprovalDecisions();
      d.stage("exec_1", deleteRepo, { kind: "deny" });
      expect(d.take("exec_1", deleteRepo)).toEqual({ kind: "deny" });
      expect(d.consumed("exec_1")).toBe(true);
    });

    it("stays false on an identity-mismatched take (nothing was consumed)", () => {
      const d = createInMemoryApprovalDecisions();
      d.stage("exec_1", deleteRepo, { kind: "approve" });
      expect(d.take("exec_1", createIssue)).toBeUndefined();
      expect(d.consumed("exec_1")).toBe(false);
    });

    it("stays false after a divergence discard — a discarded decision was never applied", () => {
      const d = createInMemoryApprovalDecisions();
      d.stage("exec_1", deleteRepo, { kind: "deny" });
      d.discard("exec_1");
      expect(d.consumed("exec_1")).toBe(false);
    });

    it("is scoped per executionId", () => {
      const d = createInMemoryApprovalDecisions();
      d.stage("exec_1", deleteRepo, { kind: "approve" });
      d.take("exec_1", deleteRepo);
      expect(d.consumed("exec_1")).toBe(true);
      expect(d.consumed("exec_2")).toBe(false);
    });

    it("re-staging for the same execution RESETS consumption — a long-lived seam cannot report a fresh decision as already applied", () => {
      // The manager builds a fresh seam per resume, but the seam is public
      // API: a long-lived instance staging a second decision for the same
      // execution (a re-pause) must not inherit the first decision's
      // consumed state.
      const d = createInMemoryApprovalDecisions();
      d.stage("exec_1", deleteRepo, { kind: "deny" });
      d.take("exec_1", deleteRepo);
      expect(d.consumed("exec_1")).toBe(true);
      d.stage("exec_1", createIssue, { kind: "deny" });
      expect(d.consumed("exec_1")).toBe(false);
    });
  });
});
