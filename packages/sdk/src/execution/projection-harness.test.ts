import { afterEach, describe, expect, it } from "vitest";
import { ALL_TOOLS, buildEffectiveScope, type ScopeResolver } from "../scope.js";
import type { ExecutionOutcome } from "./manager.js";
import { createExecutionManager, type ExecutionManager } from "./manager.js";
import { type Harness, makeHarness, pendingCallOf } from "./manager-harness.js";

/**
 * The §9.2 D5 harness. ONE fixture set and ONE body of assertions run over
 * every valid `(kind, projection)` pair, so a claim that must hold "on every
 * projection" is stated once and executed three times. A per-projection copy
 * of any case here is a review REJECT (spec §9.2).
 *
 * NOTE: the suite binds a loopback socket through `makeHarness`; the
 * authoritative pass is unsandboxed.
 */

type Pair =
  | { kind: "code"; projection: "code" }
  | { kind: "direct"; projection: "direct" }
  | { kind: "direct"; projection: "discovery" };

const PAIRS: Pair[] = [
  { kind: "code", projection: "code" },
  { kind: "direct", projection: "direct" },
  { kind: "direct", projection: "discovery" },
];

/**
 * A `describe.each` over an empty or shrunken list reports success while
 * asserting nothing — the classic false green. This pins the parameter list
 * itself, so dropping a pair fails here rather than silently halving coverage.
 */
it("INVARIANT §4.1: the D5 harness runs over all THREE valid (kind, projection) pairs — never zero cases", () => {
  expect(PAIRS).toHaveLength(3);
  expect(PAIRS.map((p) => `${p.kind}/${p.projection}`)).toEqual([
    "code/code",
    "direct/direct",
    "direct/discovery",
  ]);
});

/** Every projection on, every tool allowed: the pair under test is the only variable. */
const permitAll =
  (h: Harness): ScopeResolver =>
  async () =>
    buildEffectiveScope(
      { projections: { code: true, direct: true, discovery: true }, allow: ALL_TOOLS },
      await h.store.tools.list(),
    );

/**
 * One entry point per pair: perform `tool(input)` exactly once and return the
 * settled outcome. Code Mode reaches the tool through a one-line guest
 * program; the direct arm calls it with no guest program at all.
 */
async function performOnce(
  m: ExecutionManager,
  h: Harness,
  pair: Pair,
  tool: string,
  input: unknown,
  opts: { clientId: string | null; requestKey?: string },
): Promise<ExecutionOutcome | Awaited<ReturnType<ExecutionManager["startDirect"]>["outcome"]>> {
  if (pair.kind === "code") {
    return m.start(`return await tools.${tool}(${JSON.stringify(input)});`, {
      ...opts,
      scope: permitAll(h),
    });
  }
  return m.startDirect(tool, input, {
    ...opts,
    projection: pair.projection,
    scope: permitAll(h),
  }).outcome;
}

describe.each(PAIRS)("D5 harness — kind=$kind projection=$projection", (pair) => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
  });

  it("INVARIANT §9.2 (#2): an upstream that echoes the credential in a 200 body is refused on every projection — nothing stored, traced, journaled, or returned carries it", async () => {
    // F7: the plain fixture never returns the secret, so a `not.toContain`
    // against it would be vacuous. `echoCredential` makes the tools/call 200
    // embed req.headers.authorization at result.nested.token.
    active = await makeHarness({ echoCredential: true });
    const m = createExecutionManager(active.deps);
    const out = await performOnce(
      m,
      active,
      pair,
      "github.list_issues",
      { owner: "o" },
      {
        clientId: "acme",
      },
    );
    // The secret was genuinely in play: the upstream saw the governed call.
    expect(active.calls).toHaveLength(1);
    // The wrapper name is BY DESIGN, not a coincidence of this fixture: the
    // echo is detected after the 200, so the call may already have had its
    // effect and the only truthful terminal is ambiguous.
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitOutcomeAmbiguous" },
    });
    const everything = JSON.stringify([
      out,
      await active.store.trace.listByExecution(out.executionId),
      await active.store.replayJournal.listByExecution(out.executionId),
      await m.get(out.executionId),
    ]);
    expect(everything).not.toContain("ghp_manager_secret");

    // POSITIVE CONTROL. `ConduitOutcomeAmbiguous` is the terminal for ANY
    // post-dispatch failure, so the assertion above alone does not show the
    // ECHO caused it — a broken fixture would fail the same way. The SAME
    // call without `echoCredential` must complete, which makes the echo the
    // only difference between the two runs.
    await active.cleanup();
    active = await makeHarness();
    const clean = createExecutionManager(active.deps);
    const ok = await performOnce(
      clean,
      active,
      pair,
      "github.list_issues",
      { owner: "o" },
      { clientId: "acme" },
    );
    expect(ok.status).toBe("completed");
  });

  it("INVARIANT §4.3 (#10/#27): every Trace row carries this pair's projection and the client id, so Trace is comparable across projections", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const out = await performOnce(m, active, pair, "github.list_issues", {}, { clientId: "acme" });
    expect(out.status).toBe("completed");
    const rows = await active.store.trace.listByExecution(out.executionId);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect([r.projection, r.clientId, r.toolName, r.policyVerdict]).toEqual([
        pair.projection,
        "acme",
        "github.list_issues",
        "allow",
      ]);
    }
  });

  it("INVARIANT §4.1 (#11): request-conflict is defined for this pair — a repeated key conflicts within the client, and a keyless direct call simply runs twice", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    if (pair.projection === "direct") {
      // A4: the `direct` projection carries NO requestKey (the wire decoder
      // refuses one, row #30). Two identical keyless calls are therefore two
      // independent executions — there is no key to conflict on.
      const a = await performOnce(m, active, pair, "github.list_issues", {}, { clientId: "acme" });
      const b = await performOnce(m, active, pair, "github.list_issues", {}, { clientId: "acme" });
      expect([a.status, b.status]).toEqual(["completed", "completed"]);
      expect(a.executionId).not.toBe(b.executionId);
      return;
    }
    const a = await performOnce(
      m,
      active,
      pair,
      "github.list_issues",
      {},
      {
        clientId: "acme",
        requestKey: "rk",
      },
    );
    const b = await performOnce(
      m,
      active,
      pair,
      "github.list_issues",
      {},
      {
        clientId: "acme",
        requestKey: "rk",
      },
    );
    expect(b).toEqual({ status: "conflict", executionId: a.executionId });
    const c = await performOnce(
      m,
      active,
      pair,
      "github.list_issues",
      {},
      {
        clientId: "beta",
        requestKey: "rk",
      },
    );
    expect(c.status).toBe("completed");
  });

  it("INVARIANT §4.1 (#42/#14): a re-provisioned namespace makes the paused row resume to ConduitCatalogChanged", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const paused = await performOnce(
      m,
      active,
      pair,
      "github.create_issue",
      { title: "t" },
      {
        clientId: null,
      },
    );
    expect(paused.status).toBe("paused");
    // The §4.1a triggers bump the namespace's generation on any write path,
    // including a re-provision with identical rows.
    await active.reprovision();
    const out = await m.resume(
      paused.executionId,
      { kind: "approve" },
      await pendingCallOf(m, paused.executionId),
      permitAll(active),
    );
    expect(out).toMatchObject({
      status: "failed",
      decisionApplied: false,
      error: { name: "ConduitCatalogChanged" },
    });
    expect(active.calls.map((c) => c.name)).not.toContain("create_issue");
  });
});
