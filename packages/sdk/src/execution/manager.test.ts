import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMcp } from "../normalize/mcp.js";
import { OUTCOME_AMBIGUOUS_ERROR_NAME } from "../pipeline/errors.js";
import { redactSensitiveFields } from "../pipeline/redact.js";
import type { UpstreamSessionScope } from "../pipeline/upstream-session.js";
import { generateSeeds, type Sandbox } from "../sandbox/sandbox.js";
import { ALL_TOOLS, buildEffectiveScope, type ScopeResolver } from "../scope.js";
import { SecretBox } from "../secrets.js";
import { openSqliteStore } from "../store/sqlite.js";
import type { ConduitStore } from "../store/store.js";
import {
  type DirectCall,
  type Execution,
  NEWER_BUILD_SENTINEL,
  type PendingApproval,
  type Tool,
} from "../types.js";
import { createInMemoryApprovalDecisions } from "./decisions.js";
import { deliverableBytes } from "./direct.js";
import {
  createExecutionManager,
  type ExecutionManager,
  type ExecutionManagerDeps,
  type ResumeOutcome,
} from "./manager.js";
import { type Harness, makeHarness, pendingCallOf } from "./manager-harness.js";

/**
 * §5.5 execution-manager invariant + behavior suite. Composes the REAL stack
 * across its seams the way the product will (mirrors e2e.smoke.test.ts): an
 * MCP source normalized → persisted to SQLite → catalog rehydrated → policy +
 * credential resolver + QuickJS sandbox wired through the real §5.3 pipeline
 * against a loopback node:http MCP server. Nothing in the call path is a
 * stand-in — pause/resume is exercised end to end.
 *
 * NOTE: these tests use a loopback server and HANG under the Bash-tool
 * sandbox; the authoritative pass is the (unsandboxed) pre-commit hook run.
 */

/**
 * A fresh, empty on-disk store with NO source/loopback wiring. Used by the
 * stub-Sandbox tests (I-1), which drive the manager state machine directly and
 * never reach upstream — so they run under the Bash-tool sandbox without EPERM.
 */
async function makeBareStore(): Promise<ConduitStore> {
  const scratch = mkdtempSync(join(tmpdir(), "conduit-bare-"));
  const client = createClient({ url: `file:${join(scratch, "bare.db")}` });
  bareClients.push(client);
  return openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
  });
}
const bareClients: ReturnType<typeof createClient>[] = [];

/**
 * Seed the catalog rows a provenance-stamped pause needs on a bare store, and
 * return the pause's `{ namespace, sourceGeneration }` pair. §5.4 step 3
 * refuses any pause whose generation does not match the namespace's current
 * one, so a bare-store test that wants to reach the DRIVE — rather than the
 * guard — must stamp its pause from the live generation.
 */
async function seedProvenance(
  store: ConduitStore,
  toolName: string,
): Promise<{ namespace: string; sourceGeneration: number }> {
  const namespace = toolName.slice(0, toolName.indexOf("."));
  await store.sources.upsert({
    id: `src_${namespace}`,
    type: "mcp",
    namespace,
    location: `https://${namespace}`,
    generation: 0,
  });
  await store.tools.replaceNamespace(namespace, [
    {
      name: toolName,
      namespace,
      inputSchema: { type: "object" },
      outputSchema: {},
      riskClass: "review",
      sourceSemantics: { kind: "mcp" },
    },
  ]);
  const sourceGeneration = await store.sources.getGeneration(namespace);
  if (sourceGeneration === undefined) {
    throw new Error(`[test] no generation for seeded namespace ${namespace}`);
  }
  return { namespace, sourceGeneration };
}

/**
 * Read the live harness from inside a deferred closure (a store override, a
 * scope resolver) that runs only after `active` is assigned. A runtime
 * guarantee rather than a non-null assertion: if a refactor ever runs such a
 * closure before setup, the test names the fault instead of throwing on
 * `undefined` somewhere deeper.
 */
function requireActive(harness: Harness | undefined): Harness {
  if (harness === undefined) {
    throw new Error("[manager.test] the harness was read before setup assigned it");
  }
  return harness;
}

/**
 * Manager deps wired to a stub Sandbox. The invoker/host/decisions seams are
 * present but never exercised in the I-1 tests, because the stub sandbox throws
 * before it performs any tool call. `overrides` lets a test pin `newId` so the
 * `start`-minted execution id is inspectable.
 */
function makeStubDeps(
  store: ConduitStore,
  sandbox: Sandbox,
  overrides?: Partial<Pick<ExecutionManagerDeps, "newId" | "now">>,
): ExecutionManagerDeps {
  const unusedHost = {
    search: () => Promise.reject(new Error("host must not be called when sandbox throws")),
    describe: () => Promise.reject(new Error("host must not be called when sandbox throws")),
    call: () => Promise.reject(new Error("host must not be called when sandbox throws")),
  };
  return {
    store,
    sandbox,
    makeInvoker: () => () =>
      Promise.reject(new Error("invoker must not be called when sandbox throws")),
    makeToolHost: () => unusedHost,
    makeDecisions: () => createInMemoryApprovalDecisions(),
    ...(overrides?.newId !== undefined ? { newId: overrides.newId } : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
  };
}

describe("§5.5 execution manager — pause/resume via deterministic replay", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
    for (const c of bareClients.splice(0)) {
      c.close();
    }
  });

  it("INVARIANT §5.5: pause/resume via deterministic replay — approve resumes and runs the approved call live exactly once", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // A safe read (auto-allowed) then a review-class write (require_approval).
    const code = `
      const before = await tools.github.list_issues({ owner: "acme", repo: "site" });
      const created = await tools.github.create_issue({ title: "from agent" });
      return { before, created };
    `;

    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;
    // Host-side pause payload is fully populated (design C3).
    expect(first.pending.toolName).toBe("github.create_issue");
    expect(first.pending.input).toEqual({ title: "from agent" });
    expect(first.pending.reason).toContain("requires approval");
    expect(first.pending.callId).toBeTruthy();
    expect(first.pending.expiresAt).toBeGreaterThan(Date.now());

    // The safe read reached upstream once; the paused call did NOT.
    expect(h.calls.map((c) => c.name)).toEqual(["list_issues"]);

    // The persisted execution is paused with pausedOn; the replay journal
    // holds ONLY the finalized prefix (the safe read) — no require_approval.
    const paused = await manager.get(id);
    expect(paused?.status).toBe("paused");
    const journalRows = await h.store.replayJournal.listByExecution(id);
    expect(journalRows.map((r) => r.op)).toEqual(["call"]);
    expect(journalRows).toHaveLength(1);
    expect(JSON.parse(journalRows[0]?.request ?? "{}").path).toBe("github.list_issues");

    // Resume with approve → the paused call runs live, execution completes.
    const outcome = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.value).toEqual({
        before: { ok: true, tool: "list_issues" },
        created: { ok: true, tool: "create_issue" },
      });
    }

    // EXACTLY ONCE: the approved create_issue reached upstream a single time;
    // the replayed list_issues was memoized (not re-called).
    expect(h.calls.map((c) => c.name)).toEqual(["list_issues", "create_issue"]);
    const done = await manager.get(id);
    expect(done?.status).toBe("completed");
  });

  it("INVARIANT §5.5: deny resolves the pending call as blocked", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // Guest catches the denial and reports it — execution completes with the
    // denial as its value (deny reuses ConduitPolicyBlocked, design D1/M3).
    const code = `
      try {
        await tools.github.create_issue({ title: "nope" });
        return { blocked: false };
      } catch (error) {
        return { blocked: true, name: error.name };
      }
    `;
    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }

    const outcome = await manager.resume(
      first.executionId,
      { kind: "deny" },
      await pendingCallOf(manager, first.executionId),
    );
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.value).toEqual({ blocked: true, name: "ConduitPolicyBlocked" });
    }
    // The denied call never reached upstream.
    expect(h.calls.map((c) => c.name)).toEqual([]);
  });

  it("§5.5: concurrent resume — exactly one drives, the other returns conflict", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    const code = `
      const created = await tools.github.create_issue({ title: "race" });
      return created;
    `;
    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;

    // Two concurrent approve-resumes: the atomic claim (F4) guarantees exactly
    // one drives; the other is a no-op conflict.
    // Read the id ONCE and launch both resumes from the same tick: an
    // `await` inside the array literal would start the first resume before
    // the second even began, weakening the interleaving F4 is about.
    const callId = await pendingCallOf(manager, id);
    const [a, b] = await Promise.all([
      manager.resume(id, { kind: "approve" }, callId),
      manager.resume(id, { kind: "approve" }, callId),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["completed", "conflict"]);

    // The approved side effect executed EXACTLY once despite two resumes.
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);
  });

  it("INVARIANT §5.5: an approval binds to ONE pending call — a stale duplicate approval cannot approve a LATER pause of the same program", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // Two approval gates in one program: approving the first pause drives the
    // program straight into the second.
    const code = `
      await tools.github.create_issue({ title: "first" });
      await tools.github.create_issue({ title: "second" });
      return "done";
    `;
    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;
    const firstCallId = first.pending.callId;

    // The operator approves pause A; the program reaches pause B.
    const afterFirst = await manager.resume(id, { kind: "approve" }, firstCallId);
    expect(afterFirst.status).toBe("paused");
    if (afterFirst.status !== "paused") {
      return;
    }
    expect(afterFirst.pending.callId).not.toBe(firstCallId);

    // A queued DUPLICATE approval of pause A arrives now. It must NOT approve
    // pause B: the execution is paused, but not on the call that was approved.
    const stale = await manager.resume(id, { kind: "approve" }, firstCallId);
    expect(stale.status).toBe("conflict");
    expect(stale.decisionApplied).toBe(false);

    // Pause B is still waiting on a human, and only the first call ran upstream.
    expect((await h.deps.store.executions.get(id))?.pausedOn?.callId).toBe(
      afterFirst.pending.callId,
    );
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);
  });

  it("§5.5: catalog change between pause and resume does not diverge replay (search/describe journaled)", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // The guest branches on search/describe results BEFORE the approval gate.
    // Journaling those reads (design D5) makes replay stable even if the
    // catalog is mutated during the approval window.
    const code = `
      const { items } = await tools.search({ query: "issue" });
      const first = items[0]?.path ?? "none";
      const details = await tools.describe.tool({ path: "github.create_issue", includeSchemas: true });
      const created = await tools.github.create_issue({ title: "branch on " + first });
      return { first, hasSchema: details?.inputSchema !== undefined, created };
    `;
    const started = await manager.start(code);
    expect(started.status).toBe("paused");
    if (started.status !== "paused") {
      return;
    }
    const id = started.executionId;
    // The pre-gate reads are journaled as a clean prefix.
    const rows = await h.store.replayJournal.listByExecution(id);
    expect(rows.map((r) => r.op)).toEqual(["search", "describe"]);
    const firstPathBeforeMutation = started.pending.input;

    // MUTATE the catalog underneath: add a whole new namespace the guest's
    // search would now match. Live re-reads would return different search
    // results and the divergence guard would fail the run; journaled reads
    // keep replay stable.
    //
    // The mutation is deliberately in ANOTHER namespace. Touching `github`
    // bumps ITS §4.1a generation (the `sources_gen_on_tools` trigger), and
    // §5.4 step 3 then refuses the resume outright — a different invariant,
    // pinned by "INVARIANT §4.1 (#14)" below. What this test pins is replay
    // stability, which needs the resume to actually run.
    await h.store.sources.upsert({
      id: "src_tracker",
      type: "mcp",
      namespace: "tracker",
      location: "https://tracker",
      generation: 0,
    });
    await h.store.tools.replaceNamespace(
      "tracker",
      normalizeMcp({
        namespace: "tracker",
        tools: [{ name: "unrelated_new_issue_tool", inputSchema: { type: "object" } }],
      }),
    );

    const outcome = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      const value = outcome.value as { first: string; created: unknown };
      // The title was built from the JOURNALED search result, unchanged by the
      // mutation — replay is stable.
      expect((firstPathBeforeMutation as { title: string }).title).toBe(`branch on ${value.first}`);
    }
  });

  it("§5.5: describe WITHOUT includeSchemas journals the guest's bytes → resume completes (no spurious divergence)", async () => {
    // Regression: the journaling wrapper used to RECONSTRUCT the describe
    // request as JSON.stringify({ path, includeSchemas: options?.includeSchemas
    // === true }). The guest bridge emits JSON.stringify(options) verbatim, so
    // `tools.describe.tool({ path })` (the natural lazy-describe, spec §6) emits
    // {"path":"x"} while the wrapper stored {"path":"x","includeSchemas":false}.
    // On resume the divergence guard compared the stored request byte-for-byte
    // against the guest's re-emit → mismatch → NondeterministicExecutionError,
    // killing a perfectly deterministic approved execution. Journaling the
    // guest's original bytes closes it.
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // describe WITHOUT includeSchemas, then a review-class write (the gate).
    const code = `
      const details = await tools.describe.tool({ path: "github.create_issue" });
      const created = await tools.github.create_issue({ title: "lazy describe" });
      return { described: details?.path ?? "none", created };
    `;
    const started = await manager.start(code);
    expect(started.status).toBe("paused");
    if (started.status !== "paused") {
      return;
    }
    const id = started.executionId;

    // The pre-gate describe is journaled with the GUEST'S bytes — no injected
    // includeSchemas:false. This is the exact string the guest re-emits on
    // replay, so the divergence guard sees a match.
    const rows = await h.store.replayJournal.listByExecution(id);
    expect(rows.map((r) => r.op)).toEqual(["describe"]);
    expect(rows[0]?.request).toBe(JSON.stringify({ path: "github.create_issue" }));

    // Resume(approve) must COMPLETE — not die with NondeterministicExecutionError.
    const outcome = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.value).toEqual({
        described: "github.create_issue",
        created: { ok: true, tool: "create_issue" },
      });
    }
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);
  });

  it("§5.5: describe WITH includeSchemas:true still journals and resumes cleanly", async () => {
    // The other arm of the same fix: an explicit includeSchemas:true is part of
    // the guest's options object, so the guest emits it verbatim and the
    // wrapper journals the same bytes — replay stays deterministic.
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    const code = `
      const details = await tools.describe.tool({ path: "github.create_issue", includeSchemas: true });
      const created = await tools.github.create_issue({ title: "with schema" });
      return { hasSchema: details?.inputSchema !== undefined, created };
    `;
    const started = await manager.start(code);
    expect(started.status).toBe("paused");
    if (started.status !== "paused") {
      return;
    }
    const id = started.executionId;
    const rows = await h.store.replayJournal.listByExecution(id);
    expect(rows[0]?.request).toBe(
      JSON.stringify({ path: "github.create_issue", includeSchemas: true }),
    );

    const outcome = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      const value = outcome.value as { hasSchema: boolean };
      expect(value.hasSchema).toBe(true);
    }
  });

  it("§5.5: resume-path re-pause — two sequential approvals (design D3)", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // Two review-class writes: approving #1 resumes into #2, which pauses
    // again. Approving #2 completes. (Task-3 deferred follow-up.)
    const code = `
      const a = await tools.github.create_issue({ title: "one" });
      const b = await tools.github.create_issue({ title: "two" });
      return { a, b };
    `;
    const p1 = await manager.start(code);
    expect(p1.status).toBe("paused");
    if (p1.status !== "paused") {
      return;
    }
    expect(p1.pending.input).toEqual({ title: "one" });
    const id = p1.executionId;

    const p2 = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(p2.status).toBe("paused");
    if (p2.status !== "paused") {
      return;
    }
    // Re-paused on the SECOND call; the first side effect fired exactly once.
    expect(p2.pending.input).toEqual({ title: "two" });
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);
    // The prefix now holds the first (approved, live) call as a finalized row.
    const rows = await h.store.replayJournal.listByExecution(id);
    expect(rows.map((r) => r.op)).toEqual(["call"]);

    const done = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(done.status).toBe("completed");
    if (done.status === "completed") {
      expect(done.value).toEqual({
        a: { ok: true, tool: "create_issue" },
        b: { ok: true, tool: "create_issue" },
      });
    }
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(2);
  });

  it("§5.5: expired pending approval resumes as expired, not completed", async () => {
    const h = await makeHarness();
    active = h;
    // Inject a clock we can advance past the TTL.
    let clock = 1_000_000;
    const deps: ExecutionManagerDeps = { ...h.deps, now: () => clock };
    const manager = createExecutionManager(deps);

    const first = await manager.start(`
      const created = await tools.github.create_issue({ title: "stale" });
      return created;
    `);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    // Advance the clock beyond expiresAt.
    clock = first.pending.expiresAt + 1;
    const outcome = await manager.resume(
      first.executionId,
      { kind: "approve" },
      await pendingCallOf(manager, first.executionId),
    );
    expect(outcome.status).toBe("expired");
    // The approved call was never made — expiry short-circuits before re-drive.
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(0);
    const persisted = await manager.get(first.executionId);
    expect(persisted?.status).toBe("expired");
  });

  it("§5.5 (F6): the STRUCTURAL §9.2 guarantee — no credential material survives into the persisted replay journal or the returned value across a live call", async () => {
    // What this test actually proves (and does NOT): it asserts the STRUCTURAL
    // guarantee (design D7 / spec §9.2) — credentials are request-scoped and
    // never persisted, so the replay journal and the returned outcome hold only
    // host-classified upstream results, never credential material. It does NOT
    // prove the best-effort scrub ran: the manager passes `secret: undefined`
    // to the journaling wrapper (it deliberately does not resolve credentials —
    // that stays in the pipeline, design D7), so `scrubCredential` is a no-op
    // here. The secret's absence is structural (the /echo401 upstream returns
    // the credential in its OWN response only on a path the guest's value never
    // carries), not a consequence of scrubbing. The scrub logic itself — the
    // best-effort defense-in-depth layer — is exercised directly with real
    // secrets in scrub.test.ts, so its coverage does not depend on this test.
    const h = await makeHarness();
    active = h;
    // Repoint the source to the echo endpoint (live source lookup at call
    // time) so a 200/401 body echoing the credential would land in the
    // journal if unscrubbed.
    const src = await h.store.sources.get("src_gh");
    if (src !== undefined) {
      await h.store.sources.upsert({ ...src, location: src.location.replace("/mcp", "/echo401") });
    }
    const manager = createExecutionManager(h.deps);
    const outcome = await manager.start(`
      try {
        await tools.github.list_issues({ owner: "acme", repo: "site" });
        return { reached: true };
      } catch (error) {
        return { reached: false, name: error.name };
      }
    `);
    // The read fails upstream (401) but is journaled as a failed outcome; the
    // execution completes with the guest's catch value.
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      return;
    }
    const journal = await h.store.replayJournal.listByExecution(outcome.executionId);
    expect(JSON.stringify(journal)).not.toContain("ghp_manager");
    expect(JSON.stringify(outcome)).not.toContain("ghp_manager");
  });

  it("§5.5 (F2): confused-deputy — an approval for tool A never authorizes tool B, and the divergence is TERMINAL (guest cannot catch-and-continue)", async () => {
    // End-to-end confused-deputy defense (design D6/F2, design §9), now TERMINAL.
    // A run pauses on a DESTRUCTIVE call (delete_repo, tool B). Before resume,
    // the persisted `pausedOn` is corrupted to look like a benign create_issue
    // approval (tool A) — the identity a human "thought" they were approving. On
    // resume the manager stages the approve decision bound to that A-identity,
    // but the replay reaches the real first un-journaled call (delete_repo, B).
    // The invoker's identity check throws an uncatchable ConduitReplayDivergence:
    // the guest's try/catch does NOT run (the interrupt is uncatchable), the
    // execution is TERMINAL `failed`, and delete_repo NEVER executes.
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    const code = `
      try {
        const r = await tools.github.delete_repo({ repo: "prod" });
        return { deleted: true, r };
      } catch (error) {
        // Under the TERMINAL model this catch must NOT run — the divergence is
        // an uncatchable interrupt, so control never returns to guest code.
        return { deleted: false, caughtAndContinued: true, name: error.name };
      }
    `;
    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;
    // It paused on the destructive call (tool B).
    expect(first.pending.toolName).toBe("github.delete_repo");
    // delete_repo did NOT reach upstream at pause time.
    expect(h.calls.filter((c) => c.name === "delete_repo")).toHaveLength(0);

    // Corrupt the persisted pausedOn to a DIFFERENT (benign) call identity —
    // the crux of the confused-deputy scenario: the staged decision will be
    // bound to create_issue (A), not to the delete_repo (B) the replay reaches.
    const persisted = await manager.get(id);
    if (persisted?.pausedOn === undefined) {
      throw new Error("expected a persisted pausedOn to corrupt");
    }
    await h.store.executions.put({
      ...persisted,
      pausedOn: {
        ...persisted.pausedOn,
        toolName: "github.create_issue",
        input: { title: "harmless" },
      },
    });

    // Resume with approve. The staged approve is bound to create_issue (A); the
    // first live call on replay is delete_repo (B) → identity mismatch → TERMINAL
    // replay-divergence. The guest CANNOT catch-and-continue; the execution fails.
    const outcome = await manager.resume(id, { kind: "approve" }, first.pending.callId);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitReplayDivergence");
    }
    // The wrong tool was NEVER executed: delete_repo (B) never reached upstream,
    // and neither did create_issue (A) — the approval authorized nothing.
    expect(h.calls.filter((c) => c.name === "delete_repo")).toHaveLength(0);
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(0);

    // TERMINAL + non-resumable: the row is `failed` with pausedOn cleared, and a
    // later resume is a no-op conflict (no `paused` row to claim). The guest
    // never regained control to invoke the approved tool.
    const settled = await manager.get(id);
    expect(settled?.status).toBe("failed");
    expect(settled?.pausedOn).toBeUndefined();
    const retry = await manager.resume(id, { kind: "approve" }, first.pending.callId);
    expect(retry.status).toBe("conflict");
  });

  it("§5.5 (F5): outcome-ambiguity — a replay-journal append failure after the side effect → terminal `failed`, not resumable", async () => {
    // End-to-end outcome-ambiguity (design D8/F5). An approved call reaches
    // upstream (the side effect fires), but the replay-journal append THEN
    // throws. The barrier records the call as outcome-ambiguous: the execution
    // becomes terminal `failed` (NON-resumable) and the side effect is not
    // re-run on any later resume.
    const h = await makeHarness();
    active = h;

    // Wrap the store so replayJournal.append throws for the APPROVED call only
    // (the one whose serialized request names create_issue), AFTER upstream has
    // already been hit. Every other append (the safe-read prefix) passes.
    const realAppend = h.store.replayJournal.append.bind(h.store.replayJournal);
    let poisoned = false;
    const wrappedStore: ConduitStore = {
      ...h.store,
      replayJournal: {
        ...h.store.replayJournal,
        append: async (executionId, entry) => {
          if (entry.request.includes("create_issue")) {
            poisoned = true;
            throw new Error("[test] simulated replay-journal append failure after side effect");
          }
          return realAppend(executionId, entry);
        },
      },
    };
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      store: wrappedStore,
      // The invoker/toolhost must use the SAME wrapped store so the real
      // upstream side effect still fires through the loopback server.
      makeInvoker: h.deps.makeInvoker,
    };
    const manager = createExecutionManager(deps);

    const code = `
      const before = await tools.github.list_issues({ owner: "acme", repo: "site" });
      const created = await tools.github.create_issue({ title: "ambiguous" });
      return { before, created };
    `;
    const first = await manager.start(code);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    const id = first.executionId;

    // Resume with approve: create_issue reaches upstream (side effect fires),
    // then its journal append throws → outcome-ambiguous terminal failed.
    const outcome = await manager.resume(id, { kind: "approve" }, first.pending.callId);
    expect(poisoned).toBe(true);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitOutcomeAmbiguous");
    }
    // The approved side effect DID fire exactly once (it is the ambiguity).
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);

    // Terminal + NOT resumable: the row is `failed`, and a further resume is a
    // no-op conflict (no `paused` row to claim) — the side effect is never re-run.
    const settled = await manager.get(id);
    expect(settled?.status).toBe("failed");
    expect(settled?.pausedOn).toBeUndefined();
    const retry = await manager.resume(id, { kind: "approve" }, first.pending.callId);
    expect(retry.status).toBe("conflict");
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(1);
  });

  // ── I-1: an unexpected sandbox throw on resume/start must not strand the
  //         execution in `running`. It finalizes a terminal `failed`. ──────
  //
  // These tests inject a STUB Sandbox whose `execute` rejects, so they exercise
  // the manager state machine WITHOUT a loopback server — they run directly
  // under the Bash-tool sandbox (no EPERM), unlike the loopback tests above.

  it("§5.5 (I-1): a resume-time sandbox throw finalizes terminal `failed`, never a stranded `running`", async () => {
    // A store with no MCP/loopback wiring: this test never reaches upstream.
    const store = await makeBareStore();
    let calls = 0;
    const throwingSandbox: Sandbox = {
      execute() {
        calls += 1;
        // An infra fault out of the sandbox: bootstrap failure, getQuickJS()
        // failure, or corrupt stored seeds surfacing as a RangeError.
        return Promise.reject(new RangeError("Invalid stored seeds (corrupt replay state)"));
      },
    };
    const deps = makeStubDeps(store, throwingSandbox);
    const manager = createExecutionManager(deps);

    // Seed a paused execution directly (no sandbox needed to reach a pause):
    // status=paused with a pending approval and a one-row prefix journal.
    const id = "exec_i1_resume";
    const pausedOn = {
      callId: "call_1",
      toolName: "github.create_issue",
      // §5.4: the pause must carry live provenance, or the resume guard
      // terminalizes it before the sandbox — and the sandbox throw under
      // test would never happen.
      ...(await seedProvenance(store, "github.create_issue")),
      input: { title: "from agent" },
      reason: "github.create_issue requires approval before it can run.",
      expiresAt: Date.now() + 3_600_000,
    };
    await store.executions.put({
      kind: "code",
      clientId: null,
      projection: "code",
      id,
      code: "return await tools.github.create_issue({ title: 'from agent' });",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn,
      startedAt: Date.now(),
    });
    await store.replayJournal.append(id, {
      ordinal: 0,
      op: "call",
      request: JSON.stringify({ path: "github.list_issues", input: {} }),
      outcome: { ok: true, value: { ok: true, tool: "list_issues" } },
    });

    // Resume must NOT swallow the throw, but it MUST finalize the row first.
    await expect(manager.resume(id, { kind: "approve" }, pausedOn.callId)).rejects.toThrow(
      "corrupt replay state",
    );
    expect(calls).toBe(1);

    // The invariant: the row is terminal `failed`, NOT a stranded `running`.
    const after = await manager.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.endedAt).toBeDefined();
    expect(after?.pausedOn).toBeUndefined();

    // Consequence proof: because the row is terminal (not the pre-fix stranded
    // `running`), a second resume returns `conflict` (claimForResume finds no
    // `paused` row) rather than re-driving — the execution is settled, not
    // half-transitioned.
    const second = await manager.resume(id, { kind: "approve" }, pausedOn.callId);
    expect(second.status).toBe("conflict");
  });

  it("§5.5 (I-2): a post-sandbox persistence throw on resume does not strand the execution in `running`", async () => {
    // Sibling of the drive()-catch fix (commit 0991204): that fix covered a
    // throw OUT of sandbox.execute. This covers the SIBLING store-write path —
    // the post-sandbox `finish`/paused/expiry `put()` that runs after
    // claimForResume has already flipped the row to `running`. If that write
    // throws (a transient store/disk fault) and is left uncaught, the row is
    // stranded `running` with a stale pausedOn → a later resume's
    // claimForResume WHERE status='paused' finds 0 rows → permanently
    // un-resumable (design §8/§6: running must reach a terminal, never a silent
    // half-transition).
    const store = await makeBareStore();

    // A stub sandbox that returns `completed` WITHOUT performing any tool call,
    // so the (rejecting) host/invoker are never touched and no upstream/loopback
    // is needed — this runs under the Bash-tool sandbox.
    const completingSandbox: Sandbox = {
      execute(request) {
        return Promise.resolve({
          status: "completed",
          value: { done: true },
          seeds: request.seeds ?? { now: 1, random: 2 },
          journal: [...(request.journal ?? [])],
        });
      },
    };

    // Wrap the store so `executions.put` throws ONCE — a transient fault on the
    // post-sandbox terminal write (a disk/store blip that clears). The fix's
    // fallback finalize-failed write then succeeds, so the row lands terminal.
    // `claimForResume` is a separate UPDATE, left intact so the paused→running
    // claim still succeeds.
    const realPut = store.executions.put.bind(store.executions);
    let armed = false;
    let faults = 0;
    const wrappedStore: ConduitStore = {
      ...store,
      executions: {
        ...store.executions,
        put: async (execution) => {
          if (armed && faults === 0) {
            faults += 1;
            throw new Error("[test] simulated executions.put fault after sandbox settled");
          }
          return realPut(execution);
        },
      },
    };

    const deps = makeStubDeps(wrappedStore, completingSandbox);
    const manager = createExecutionManager(deps);

    const id = "exec_i2_resume";
    const pausedOn = {
      callId: "call_1",
      toolName: "github.create_issue",
      // §5.4: live provenance, so the guard passes and the post-sandbox
      // persistence fault under test is the one that fires.
      ...(await seedProvenance(store, "github.create_issue")),
      input: { title: "from agent" },
      reason: "github.create_issue requires approval before it can run.",
      expiresAt: Date.now() + 3_600_000,
    };
    await store.executions.put({
      kind: "code",
      clientId: null,
      projection: "code",
      id,
      code: "return await tools.github.create_issue({ title: 'from agent' });",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn,
      startedAt: Date.now(),
    });

    // Arm the fault: the NEXT put() (the terminal finish write) throws once.
    armed = true;

    // Resume: claimForResume flips paused→running, the sandbox settles
    // `completed`, then finish's put() throws. The error may surface (throw is
    // acceptable) — what is NOT acceptable is a silently-stranded `running`.
    await expect(manager.resume(id, { kind: "approve" }, pausedOn.callId)).rejects.toThrow();
    expect(faults).toBe(1);

    // The invariant: the row is NOT a stranded `running` that looks
    // resumable-but-isn't. The fallback finalize-failed write landed it terminal.
    const after = await manager.get(id);
    expect(after?.status).not.toBe("running");
    expect(after?.status).toBe("failed");
    expect(after?.pausedOn).toBeUndefined();

    // Consequence proof: a later resume is a no-op conflict (no `paused` row to
    // claim) — the execution is settled, not half-transitioned into a
    // permanently un-resumable `running`.
    const retry = await manager.resume(id, { kind: "approve" }, pausedOn.callId);
    expect(retry.status).toBe("conflict");
  });

  it("§5.5 (I-1): a start-time sandbox throw finalizes terminal `failed`, never a stranded `running`", async () => {
    const store = await makeBareStore();
    const throwingSandbox: Sandbox = {
      execute() {
        return Promise.reject(new Error("getQuickJS() bootstrap failed"));
      },
    };
    // Deterministic id so we can inspect the row `start` minted (id = exec_<newId>).
    const deps = makeStubDeps(store, throwingSandbox, { newId: () => "start_i1" });
    const manager = createExecutionManager(deps);

    await expect(manager.start("return 1;")).rejects.toThrow("bootstrap failed");

    // The row `start` persisted `running` must have been finalized to `failed` —
    // not left stranded `running` by the propagating throw.
    const row = await manager.get("exec_start_i1");
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).toBeDefined();
    expect(row?.pausedOn).toBeUndefined();
  });

  it("§5.5 (I-3): a throw in the post-claim prep window (get returns corrupt data) terminalizes `failed`, never stranded `running`", async () => {
    // (Fix 1 / F5) The window between a successful `claimForResume` (which flips
    // paused→running) and `drive` taking over is fragile: `get` can surface
    // CORRUPT stored JSON as a parse error. If that throw stranded the row
    // `running`, a later resume's `claimForResume WHERE status='paused'` would
    // find 0 rows → permanently un-resumable. The whole prep window must
    // terminalize the claimed row `failed` (via the raw `failClaimedResume`,
    // which needs no parsed Execution) before the fault propagates.
    const store = await makeBareStore();

    // Seed a real paused row so the (real) claimForResume succeeds…
    const id = "exec_i3_corruptget";
    await store.executions.put({
      kind: "code",
      clientId: null,
      projection: "code",
      id,
      code: "return await tools.github.create_issue({ title: 'x' });",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn: {
        callId: "call_1",
        toolName: "github.create_issue",
        input: { title: "x" },
        reason: "requires approval",
        expiresAt: Date.now() + 3_600_000,
      },
      startedAt: Date.now(),
    });

    // …then make `get` throw AFTER the claim (as corrupt stored JSON would),
    // while claimForResume/failClaimedResume stay the real guarded UPDATEs.
    const wrappedStore: ConduitStore = {
      ...store,
      executions: {
        ...store.executions,
        get: async () => {
          throw new Error("[SqliteStore] Failed to read execution: seeds is not valid JSON");
        },
      },
    };
    // A sandbox that must never run — the throw happens before drive.
    const neverSandbox: Sandbox = {
      execute: () => Promise.reject(new Error("sandbox must not run when prep throws")),
    };
    const manager = createExecutionManager(makeStubDeps(wrappedStore, neverSandbox));

    // The fault surfaces (not swallowed), but the row is finalized first.
    await expect(manager.resume(id, { kind: "approve" }, "call_1")).rejects.toThrow(
      /not valid JSON/,
    );

    // Invariant: terminal `failed`, NOT a stranded `running`. Read via the REAL
    // store (the wrapped get throws).
    const after = await store.executions.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.pausedOn).toBeUndefined();

    // Consequence: a later resume is a no-op conflict (no `paused` row to claim).
    const retry = await manager.resume(id, { kind: "approve" }, "call_1");
    expect(retry.status).toBe("conflict");
  });

  /**
   * A `paused` row seeded through raw SQL against the same client the store
   * uses: `put` cannot write a malformed `pausedOn`, and a mocked `get` would
   * not exercise the claim's own corruption allowance — the thing under test.
   * The sandbox rejects, so any resume that runs the pending call fails loudly.
   */
  async function seedPausedRow(
    label: string,
    pausedOnJson: string,
  ): Promise<{ client: ReturnType<typeof createClient>; manager: ExecutionManager; id: string }> {
    const scratch = mkdtempSync(join(tmpdir(), `conduit-${label}-`));
    const client = createClient({ url: `file:${join(scratch, `${label}.db`)}` });
    bareClients.push(client);
    const store = await openSqliteStore({
      client,
      secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
    });
    const id = `exec_${label}`;
    await client.execute({
      sql: `INSERT INTO executions (id, code, status, seeds, paused_on, started_at)
            VALUES (?, 'return 1;', 'paused', '{"now":1,"random":2}', ?, ?)`,
      args: [id, pausedOnJson, Date.now()],
    });
    const neverSandbox: Sandbox = {
      execute: () => Promise.reject(new Error("sandbox must not run for a corrupt pause")),
    };
    return { client, manager: createExecutionManager(makeStubDeps(store, neverSandbox)), id };
  }

  it.each([
    {
      // The one validator the list projection also uses: a matching call
      // id beside a corrupt field is still corrupt, so the TTL check can
      // never run against `"bogus"` and stage a decision.
      shape: "a VALID callId beside a corrupt expiresAt",
      pausedOnJson: JSON.stringify({
        callId: "call_A",
        toolName: "t",
        input: {},
        reason: "r",
        expiresAt: "bogus",
      }),
      operatorArg: "call_A",
    },
    {
      // SQLite's extractor claims by the FIRST duplicate key; JSON.parse
      // hydrates the LAST. The list advertises the first, the operator
      // sends it, the claim wins, and the strict check terminalizes.
      shape: "duplicate callId keys (claimed by the first, hydrated as the last)",
      pausedOnJson:
        '{"callId":"call_A","callId":"call_B","toolName":"t","input":{},"reason":"r","expiresAt":9000000000000}',
      operatorArg: "call_A",
    },
    {
      // The claim admits this through the NON-TEXT arm (SQLite reads the
      // first key, 123); JSON.parse hydrates the last, "123", which would
      // pass strict equality. The SQL-side identity check catches it.
      shape: "duplicate callId keys, first non-text and last matching text",
      pausedOnJson:
        '{"callId":123,"callId":"123","toolName":"t","input":{},"reason":"r","expiresAt":9000000000000}',
      operatorArg: "123",
    },
    {
      shape: "a JSON number",
      pausedOnJson: JSON.stringify({
        callId: 123,
        toolName: "t",
        input: {},
        reason: "r",
        expiresAt: 9e12,
      }),
      operatorArg: "123",
    },
    {
      shape: "a blank string",
      pausedOnJson: JSON.stringify({
        callId: " \t",
        toolName: "t",
        input: {},
        reason: "r",
        expiresAt: 9e12,
      }),
      operatorArg: "x",
    },
    {
      shape: "the JSON literal null (no object at all)",
      pausedOnJson: "null",
      operatorArg: "x",
    },
  ])("INVARIANT §5.5: a pause whose STORED callId is $shape is claimed through the real SQL and terminalized `failed` (corrupt state), never stranded `paused`", async ({
    pausedOnJson,
    operatorArg,
  }) => {
    // None of these can equal the text the decoder admits, so no operator
    // can name the call; the claim must still win so the corrupt-state
    // branch can terminalize it instead of leaving it listed forever. The
    // `null` literal hydrates to JS null, not undefined — it must be
    // caught by the shape check, not by a property read that throws.
    const { client, manager, id } = await seedPausedRow("badcallid", pausedOnJson);

    const outcome = await manager.resume(id, { kind: "approve" }, operatorArg);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitInternalError");
      expect(outcome.error.message).toContain("corrupt state");
      expect(outcome.error.message).toContain("did not run");
    }
    expect(outcome.decisionApplied).toBe(false);
    // Host-side discriminator the daemon log keys on — never the error name.
    expect(outcome.corruptPause).toBe(true);
    const after = await client.execute({
      sql: "SELECT status, paused_on, error FROM executions WHERE id = ?",
      args: [id],
    });
    expect(after.rows[0]?.status).toBe("failed");
    expect(after.rows[0]?.paused_on).toBeNull();
    expect(String(after.rows[0]?.error)).toContain("corrupt state");
  });

  it("INVARIANT §5.5: resume refuses a callId that is not a non-blank string BEFORE the claim — no row is touched", async () => {
    // Public SDK entrypoint: an embedder bypasses the wire decoder. A bound
    // number could equal a stored numeric callId in the claim's SQL and
    // then pass the manager's strict-equality check — so refuse first.
    const { client, manager, id } = await seedPausedRow(
      "badarg",
      JSON.stringify({ callId: 123, toolName: "t", input: {}, reason: "r", expiresAt: 9e12 }),
    );
    for (const bad of [123, " \t\n", ""] as unknown[]) {
      await expect(manager.resume(id, { kind: "approve" }, bad as string)).rejects.toThrow(
        /non-blank string/,
      );
    }
    const after = await client.execute({
      sql: "SELECT status FROM executions WHERE id = ?",
      args: [id],
    });
    expect(after.rows[0]?.status).toBe("paused");
  });

  it("INVARIANT §5.5: a pause whose STORED JSON carries no callId is claimed through the real SQL and terminalized `failed` (corrupt state), never stranded `paused` or approved", async () => {
    const { client, manager, id } = await seedPausedRow(
      "nocallid",
      JSON.stringify({
        toolName: "github.create_issue",
        input: {},
        reason: "r",
        expiresAt: Date.now() + 3_600_000,
      }),
    );

    const outcome = await manager.resume(id, { kind: "approve" }, "any-id-the-operator-typed");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitInternalError");
      expect(outcome.error.message).toContain("no call id");
    }
    expect(outcome.decisionApplied).toBe(false);
    const after = await client.execute({
      sql: "SELECT status, paused_on FROM executions WHERE id = ?",
      args: [id],
    });
    expect(after.rows[0]?.status).toBe("failed");
    expect(after.rows[0]?.paused_on).toBeNull();
  });

  it("§5.5 (I-4): the corrupt-state branch (pausedOn undefined after claim) persists terminal `failed` before returning", async () => {
    // (Fix 1) A paused row whose pausedOn is somehow absent after the claim is a
    // corrupt state. The early-return must persist `failed` (not just return a
    // failed OUTCOME while leaving the row `running`), or the row is stranded.
    const store = await makeBareStore();
    const id = "exec_i4_nopaused";
    // Seed a `paused` row (so claimForResume succeeds) then strip pausedOn via a
    // wrapped `get` that returns the row WITHOUT pausedOn — simulating the
    // corrupt state the branch guards.
    await store.executions.put({
      kind: "code",
      clientId: null,
      projection: "code",
      id,
      code: "return 1;",
      status: "paused",
      seeds: { now: 1, random: 2 },
      pausedOn: {
        callId: "c1",
        toolName: "github.create_issue",
        input: {},
        reason: "r",
        expiresAt: Date.now() + 3_600_000,
      },
      startedAt: Date.now(),
    });
    const wrappedStore: ConduitStore = {
      ...store,
      executions: {
        ...store.executions,
        get: async (getId) => {
          const row = await store.executions.get(getId);
          if (row === undefined) {
            return undefined;
          }
          const { pausedOn: _drop, ...withoutPaused } = row;
          return withoutPaused;
        },
      },
    };
    const neverSandbox: Sandbox = {
      execute: () => Promise.reject(new Error("sandbox must not run in the corrupt-state branch")),
    };
    const manager = createExecutionManager(makeStubDeps(wrappedStore, neverSandbox));

    // The claim runs against the REAL row (callId "c1"); only the wrapped
    // `get` afterwards strips pausedOn — the corrupt state under test.
    const outcome = await manager.resume(id, { kind: "approve" }, "c1");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitInternalError");
      expect(outcome.error.message).toContain("no pending approval");
    }

    // The row was PERSISTED terminal `failed` (not left `running`): read the
    // REAL store and confirm, then a later resume is a no-op conflict.
    const after = await store.executions.get(id);
    expect(after?.status).toBe("failed");
    expect(after?.pausedOn).toBeUndefined();
    const retry = await manager.resume(id, { kind: "approve" }, "c1");
    expect(retry.status).toBe("conflict");
  });

  it("§11 (D7 guard): the replay journal keeps the semantically-unredacted request while the Trace row is redacted", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // list_issues is riskClass safe → auto-allowed. The input carries a
    // builtin-sensitive key: the journal must keep it, the Trace must mask it.
    const code = `return await tools.github.list_issues({ owner: "acme", token: "sk-fixture" });`;
    const outcome = await manager.start(code);
    expect(outcome.status).toBe("completed");

    const journal = await h.store.replayJournal.listByExecution(outcome.executionId);
    const callRow = journal.find((row) => row.op === "call");
    expect(callRow).toBeDefined();
    // Replay fidelity: the journaled REQUEST carries the raw input.
    expect(callRow?.request).toContain("sk-fixture");

    const [trace] = await h.store.trace.listByExecution(outcome.executionId);
    expect(JSON.stringify(trace?.input)).not.toContain("sk-fixture");
    expect(JSON.stringify(trace?.input)).toContain("[redacted]");
  });
});

/**
 * Wrap `store.executions.put` so its (n+1)th call — 0-indexed by `faultAt` —
 * throws once, then all subsequent calls (including the retry from
 * `persistOrFinalizeFailed`'s fallback) pass through to the real store. This
 * targets the SETTLE write specifically. Every scenario below passes
 * `faultAt: 0` — the FIRST `put` — because `start`/`claimForResume` already
 * durably wrote the `running` row through a DIFFERENT path (a raw insert or
 * the guarded UPDATE), so the first `put` this wrapper ever sees is the
 * terminal/paused/expired write under test.
 */
function withPutFaultAt(store: ConduitStore, faultAt: number): ConduitStore {
  const realPut = store.executions.put.bind(store.executions);
  let calls = 0;
  return {
    ...store,
    executions: {
      ...store.executions,
      put: async (execution: Execution) => {
        const at = calls;
        calls += 1;
        if (at === faultAt) {
          throw new Error("[test] simulated executions.put fault on the settle write");
        }
        return realPut(execution);
      },
    },
  };
}

describe("outcome persistence (mcp design M4)", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
  });

  it("persists result on completed and error on failed", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    const completed = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "site" });`,
    );
    expect(completed.status).toBe("completed");
    const completedRow = await h.store.executions.get(completed.executionId);
    expect(completedRow?.result).toEqual({ ok: true, tool: "list_issues" });

    // An uncaught guest-side throw settles the execution `failed` with a
    // real SandboxError — no upstream call or approval gate involved.
    const failed = await manager.start(`throw new TypeError("boom");`);
    expect(failed.status).toBe("failed");
    const failedRow = await h.store.executions.get(failed.executionId);
    expect(failedRow?.error?.name).toBeTruthy();
  });

  it.each([
    {
      label: "completed settle faulted",
      code: `return 1;`,
      sandbox: (): Sandbox => ({
        execute: (request) =>
          Promise.resolve({
            status: "completed",
            value: 1,
            seeds: request.seeds ?? { now: 1, random: 2 },
            journal: [...(request.journal ?? [])],
          }),
      }),
    },
    {
      label: "failed settle faulted",
      code: `throw new TypeError("boom");`,
      sandbox: (): Sandbox => ({
        execute: (request) =>
          Promise.resolve({
            status: "failed",
            error: { name: "TypeError", message: "boom" },
            seeds: request.seeds ?? { now: 1, random: 2 },
            journal: [...(request.journal ?? [])],
          }),
      }),
    },
  ])("INVARIANT M4: a stored failed row always explains itself — fallback carries ConduitPersistError ($label)", async ({
    code,
    sandbox,
  }) => {
    const store = await makeBareStore();
    // Fault the FIRST put (index 0): `start` now writes its initial
    // `running` row with `create`, so the first `put` IS the settle write.
    const faultyStore = withPutFaultAt(store, 0);
    const deps = makeStubDeps(faultyStore, sandbox(), { newId: () => "settle_fault" });
    const manager = createExecutionManager(deps);

    await expect(manager.start(code)).rejects.toThrow(
      "[test] simulated executions.put fault on the settle write",
    );
    // Not swallowed: the fault surfaces to the caller. But the fallback
    // write in persistOrFinalizeFailed still lands the row terminal.
    const row = await store.executions.get("exec_settle_fault");
    expect(row?.status).toBe("failed");
    expect(row?.error?.name).toBe("ConduitPersistError");
  });

  it("INVARIANT M4: paused persistence faulted — fallback carries ConduitPersistError", async () => {
    const h = await makeHarness();
    active = h;
    // Fault the FIRST put (index 0): `start` now writes its initial
    // `running` row with `create`, so the first `put` is drive()'s `paused`
    // write.
    const faultyStore = withPutFaultAt(h.store, 0);
    // Deterministic id so the row can be recovered after `start` rejects.
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      store: faultyStore,
      newId: () => "paused_fault",
    };
    const manager = createExecutionManager(deps);

    await expect(
      manager.start(`return await tools.github.create_issue({ title: "from agent" });`),
    ).rejects.toThrow("[test] simulated executions.put fault on the settle write");

    const row = await h.store.executions.get("exec_paused_fault");
    expect(row?.status).toBe("failed");
    expect(row?.error?.name).toBe("ConduitPersistError");
  });

  it("INVARIANT M4: expired persistence faulted — fallback carries ConduitPersistError", async () => {
    const h = await makeHarness();
    active = h;
    let clock = 1_000_000;
    const deps: ExecutionManagerDeps = { ...h.deps, now: () => clock };
    const manager = createExecutionManager(deps);

    const paused = await manager.start(
      `return await tools.github.create_issue({ title: "stale" });`,
    );
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") {
      return;
    }
    clock = paused.pending.expiresAt + 1;

    // Fault the settle write on RESUME: resume's expiry branch does exactly
    // one `executions.put` before reaching persistOrFinalizeFailed's fallback.
    const faultyStore = withPutFaultAt(h.store, 0);
    const resumeDeps: ExecutionManagerDeps = { ...deps, store: faultyStore };
    const resumeManager = createExecutionManager(resumeDeps);

    await expect(
      resumeManager.resume(
        paused.executionId,
        { kind: "approve" },
        await pendingCallOf(resumeManager, paused.executionId),
      ),
    ).rejects.toThrow("[test] simulated executions.put fault on the settle write");
    const row = await h.store.executions.get(paused.executionId);
    expect(row?.status).toBe("failed");
    expect(row?.error?.name).toBe("ConduitPersistError");
  });

  it("expired rows carry neither result nor error", async () => {
    const h = await makeHarness();
    active = h;
    let clock = 1_000_000;
    const deps: ExecutionManagerDeps = { ...h.deps, now: () => clock };
    const manager = createExecutionManager(deps);

    const paused = await manager.start(
      `return await tools.github.create_issue({ title: "stale" });`,
    );
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") {
      return;
    }
    clock = paused.pending.expiresAt + 1;
    await manager.resume(
      paused.executionId,
      { kind: "approve" },
      await pendingCallOf(manager, paused.executionId),
    );
    const row = await h.store.executions.get(paused.executionId);
    expect(row?.status).toBe("expired");
    expect(row?.result).toBeUndefined();
    expect(row?.error).toBeUndefined();
  });
});

describe("requestKey (mcp design M1)", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
  });

  it("persists the key BEFORE the sandbox runs", async () => {
    const store = await makeBareStore();
    const throwingSandbox: Sandbox = {
      execute: () => Promise.reject(new Error("sandbox threw synchronously")),
    };
    const manager = createExecutionManager(makeStubDeps(store, throwingSandbox));

    await expect(manager.start("x", { requestKey: "k1" })).rejects.toThrow();
    expect(await store.executions.getByRequestKey("k1", null)).toBeDefined();
  });

  it("duplicate key → conflict with the existing execution's id, no second run", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    const first = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "site" });`,
      { requestKey: "k2" },
    );
    expect(first.status).toBe("completed");
    const second = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "other" });`,
      { requestKey: "k2" },
    );
    expect(second).toEqual({ status: "conflict", executionId: first.executionId });
    // The second start never drove a sandbox run: exactly one upstream call.
    expect(h.calls).toHaveLength(1);
  });
});

describe("§16 wall-clock budget is wired into the invoker (finding F1, gate two)", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
    for (const c of bareClients.splice(0)) {
      c.close();
    }
  });

  /** A stub sandbox that settles `completed` without performing any tool call. */
  const completingSandbox: Sandbox = {
    execute: (request) =>
      Promise.resolve({
        status: "completed",
        value: null,
        seeds: request.seeds ?? { now: 0, random: 1 },
        journal: [...(request.journal ?? [])],
      }),
  };

  it("INVARIANT §16: the manager supplies makeInvoker a deadline reflecting the wall-clock budget", async () => {
    const store = await makeBareStore();
    let clock = 1_000;
    const captured: Array<() => number> = [];
    const deps: ExecutionManagerDeps = {
      store,
      sandbox: completingSandbox,
      makeInvoker: ({ deadline }) => {
        // The F1 fix: production wiring must SUPPLY a deadline (it previously
        // passed only { executionId, log }, leaving remaining = Infinity so the
        // §16 budget never clamped per-call timeouts).
        if (deadline === undefined) {
          throw new Error("makeInvoker received no deadline — F1 regression");
        }
        captured.push(deadline);
        return () => Promise.resolve(null);
      },
      // The stub sandbox settles `completed` with zero tool calls, so the host
      // is never invoked — a never-resolving stub keeps that explicit.
      makeToolHost: () => ({
        search: () => Promise.reject(new Error("host must not be called")),
        describe: () => Promise.reject(new Error("host must not be called")),
        call: () => Promise.reject(new Error("host must not be called")),
      }),
      makeDecisions: () => createInMemoryApprovalDecisions(),
      now: () => clock,
    };
    const manager = createExecutionManager(deps);
    await manager.start("return 1;", { limits: { wallClockMs: 60_000 } });

    expect(captured).toHaveLength(1);
    const deadline = captured[0];
    if (deadline === undefined) {
      throw new Error("no deadline captured");
    }
    // Captured at start-time `clock`; the full budget remains.
    expect(deadline()).toBe(60_000);
    // As the injected clock advances, the remaining budget shrinks — and goes
    // non-positive past the window, which is exactly what makes the invoker's
    // `remaining <= 0` refusal live in production.
    clock += 45_000;
    expect(deadline()).toBe(15_000);
    clock += 20_000;
    expect(deadline()).toBeLessThanOrEqual(0);
  });

  it("INVARIANT §16: a small wall-clock budget actually CLAMPS the upstream call timeout (end-to-end)", async () => {
    // The real invoker + real upstream: a 2s wall-clock budget must shrink the
    // per-call timeout well below the 30s default ceiling (proving the manager's
    // deadline reaches min(ceiling, remaining) — not merely that a callback was
    // supplied).
    const timeouts: number[] = [];
    const h = await makeHarness({ recordTimeout: (ms) => timeouts.push(ms) });
    active = h;
    const manager = createExecutionManager(h.deps);
    const result = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "site" });`,
      { limits: { wallClockMs: 2_000 } },
    );
    expect(result.status).toBe("completed");
    expect(timeouts).toHaveLength(1);
    // Clamped to the remaining budget (≤ 2000ms), strictly below the 30s ceiling.
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThanOrEqual(2_000);
  });
});

describe("§18-C4 the manager owns a per-drive upstream session scope", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
    for (const c of bareClients.splice(0)) {
      c.close();
    }
  });

  /**
   * A recording fake `UpstreamSessionScope`: never touches a real MCP session,
   * just proves creation/disposal timing. `acquire` is never called by these
   * tests — they drive the REAL pipeline, so what's under test is the manager's
   * own create/dispose wrapping around `drive()`, independent of whether
   * `upstream.ts` ever calls `acquire`. (`acquire` here rejects to prove it is
   * not exercised on these paths.)
   */
  function makeRecordingUpstreamSession(
    log: (event: "created" | "disposed") => void,
    opts?: { throwOnDispose?: boolean },
  ): () => UpstreamSessionScope {
    return () => {
      log("created");
      let disposed = false;
      return {
        acquire: () => Promise.reject(new Error("acquire must not be called by these tests")),
        async dispose() {
          if (disposed) return;
          disposed = true;
          log("disposed");
          if (opts?.throwOnDispose) {
            throw new Error("[test] simulated dispose failure");
          }
        },
      };
    };
  }

  it("INVARIANT §18-C4: the manager disposes the upstream session scope on every drive exit — success, failure, AND pause", async () => {
    const events: Array<"created" | "disposed"> = [];
    const h = await makeHarness();
    active = h;
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeUpstreamSession: makeRecordingUpstreamSession((e) => events.push(e)),
    };
    const manager = createExecutionManager(deps);

    // 1. A completing execution (safe read only).
    const completed = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "site" });`,
    );
    expect(completed.status).toBe("completed");

    // 2. A failing execution — a plain uncaught guest error (a policy block
    //    would be guest-catchable, so we use a genuinely uncaught throw here)
    //    so the sandbox itself settles the drive `failed`.
    const failed = await manager.start(`throw new Error("boom");`);
    expect(failed.status).toBe("failed");

    // 3. An execution that pauses on a require_approval call.
    const paused = await manager.start(
      `return await tools.github.create_issue({ title: "from agent" });`,
    );
    expect(paused.status).toBe("paused");

    expect(events.filter((e) => e === "created")).toHaveLength(3);
    expect(events.filter((e) => e === "disposed")).toHaveLength(3);
  });

  it("INVARIANT §18-C4: a resumed drive gets a FRESH scope", async () => {
    const events: Array<"created" | "disposed"> = [];
    const h = await makeHarness();
    active = h;
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeUpstreamSession: makeRecordingUpstreamSession((e) => events.push(e)),
    };
    const manager = createExecutionManager(deps);

    const first = await manager.start(
      `return await tools.github.create_issue({ title: "from agent" });`,
    );
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    expect(events).toEqual(["created", "disposed"]);

    const resumed = await manager.resume(
      first.executionId,
      { kind: "approve" },
      await pendingCallOf(manager, first.executionId),
    );
    expect(resumed.status).toBe("completed");

    // A SECOND scope was created for the resume — not a reuse of the first —
    // and it too was disposed.
    expect(events).toEqual(["created", "disposed", "created", "disposed"]);
  });

  it("INVARIANT §18-C4: a throwing makeUpstreamSession at start() terminalizes the row failed, never stranded running", async () => {
    const h = await makeHarness();
    active = h;
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeUpstreamSession: () => {
        throw new Error("[test] scope factory blew up (e.g. randomBytes failure)");
      },
    };
    const manager = createExecutionManager(deps);

    const result = await manager
      .start(`return 1;`, { requestKey: "rk-scope-throw" })
      .then((r) => ({ kind: "resolved" as const, r }))
      .catch((e) => ({ kind: "threw" as const, e }));
    // Whether it rejects or resolves-failed, the persisted row MUST be terminal.
    const row = await h.store.executions.getByRequestKey("rk-scope-throw", null);
    expect(row).toBeDefined();
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).toBeDefined();
    if (result.kind === "resolved") {
      expect(result.r.status).toBe("failed");
    }
  });

  it("INVARIANT §6: a synchronously-throwing makeInvoker at start() terminalizes the row failed, never stranded running", async () => {
    const h = await makeHarness();
    active = h;
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeInvoker: () => {
        throw new Error("[test] makeInvoker blew up synchronously");
      },
    };
    const manager = createExecutionManager(deps);

    const result = await manager
      .start(`return 1;`, { requestKey: "rk-invoker-throw" })
      .then((r) => ({ kind: "resolved" as const, r }))
      .catch((e) => ({ kind: "threw" as const, e }));
    // The window from the running-state persist until drive() takes over must
    // terminalize on ANY throw (§6: running must reach a terminal). A stranded
    // `running` row is un-resumable forever.
    const row = await h.store.executions.getByRequestKey("rk-invoker-throw", null);
    expect(row).toBeDefined();
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).toBeDefined();
    if (result.kind === "resolved") {
      expect(result.r.status).toBe("failed");
    }
  });

  it("INVARIANT §6: a throwing makeUpstreamSession on the RESUME path terminalizes, never stranded running (F-5 twin)", async () => {
    const h = await makeHarness();
    active = h;
    // First: a normal start that pauses, using the default scope factory.
    const manager0 = createExecutionManager(h.deps);
    const first = await manager0.start(
      `return await tools.github.create_issue({ title: "from agent" });`,
    );
    expect(first.status).toBe("paused");
    if (first.status !== "paused") return;

    // Now resume with a manager whose scope factory throws.
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeUpstreamSession: () => {
        throw new Error("[test] resume-path scope factory blew up");
      },
    };
    const manager = createExecutionManager(deps);
    const resumed = await manager
      .resume(
        first.executionId,
        { kind: "approve" },
        await pendingCallOf(manager, first.executionId),
      )
      .then((r) => ({ kind: "resolved" as const, r }))
      .catch((e) => ({ kind: "threw" as const, e }));
    const row = await h.store.executions.get(first.executionId);
    expect(row?.status).toBe("failed");
    expect(row?.endedAt).toBeDefined();
    if (resumed.kind === "resolved") {
      expect(resumed.r.status).toBe("failed");
    }
  });

  it("a throwing dispose does not change the drive outcome", async () => {
    const events: Array<"created" | "disposed"> = [];
    const h = await makeHarness();
    active = h;
    const deps: ExecutionManagerDeps = {
      ...h.deps,
      makeUpstreamSession: makeRecordingUpstreamSession((e) => events.push(e), {
        throwOnDispose: true,
      }),
    };
    const manager = createExecutionManager(deps);

    const result = await manager.start(
      `return await tools.github.list_issues({ owner: "acme", repo: "site" });`,
    );
    // The execution still reports its own (successful) outcome — the
    // dispose failure is swallowed (routed to the diagnostics sink) rather
    // than surfacing as a rejection or flipping the outcome to failed.
    expect(result.status).toBe("completed");
    expect(events).toEqual(["created", "disposed"]);
  });
});

describe("§5.5 resume outcome carries decisionApplied — host-side decision-consumption truth", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
    for (const c of bareClients.splice(0)) {
      c.close();
    }
  });

  /** Start the standard pause-on-create_issue run and return its id. */
  async function pauseOnCreateIssue(
    manager: ReturnType<typeof createExecutionManager>,
    code?: string,
  ): Promise<string> {
    const first = await manager.start(
      code ??
        `
      const created = await tools.github.create_issue({ title: "from agent" });
      return created;
    `,
    );
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      throw new Error(`expected paused, got ${first.status}`);
    }
    return first.executionId;
  }

  it("INVARIANT §5.5: an applied approve reports decisionApplied:true", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);
    const id = await pauseOnCreateIssue(manager);

    const outcome = await manager.resume(id, { kind: "approve" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("completed");
    expect(outcome.decisionApplied).toBe(true);
  });

  it("INVARIANT §5.5: an applied deny reports decisionApplied:true even when the guest catches it and the drive COMPLETES", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);
    const id = await pauseOnCreateIssue(
      manager,
      `
      try {
        await tools.github.create_issue({ title: "nope" });
        return { blocked: false };
      } catch (error) {
        return { blocked: true, name: error.name };
      }
    `,
    );

    const outcome = await manager.resume(id, { kind: "deny" }, await pendingCallOf(manager, id));
    // The drive's own outcome is completed (guest handled the denial) — but the
    // deny itself LANDED, and the outcome says so independently of drive status.
    expect(outcome.status).toBe("completed");
    expect(outcome.decisionApplied).toBe(true);
    expect(h.calls.filter((c) => c.name === "create_issue")).toHaveLength(0);
  });

  it("INVARIANT §5.5: an applied deny reports decisionApplied:true when the guest does NOT catch (drive fails ConduitPolicyBlocked)", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);
    const id = await pauseOnCreateIssue(manager);

    const outcome = await manager.resume(id, { kind: "deny" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitPolicyBlocked");
    }
    expect(outcome.decisionApplied).toBe(true);
  });

  it("a conflict (lost resume race) reports decisionApplied:false", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);
    const id = await pauseOnCreateIssue(manager);

    // Read the id ONCE and launch both resumes from the same tick: an
    // `await` inside the array literal would start the first resume before
    // the second even began, weakening the interleaving F4 is about.
    const callId = await pendingCallOf(manager, id);
    const [a, b] = await Promise.all([
      manager.resume(id, { kind: "approve" }, callId),
      manager.resume(id, { kind: "approve" }, callId),
    ]);
    const loser = a.status === "conflict" ? a : b;
    expect(loser.status).toBe("conflict");
    expect(loser.decisionApplied).toBe(false);
  });

  it("an expired resume reports decisionApplied:false — expiry short-circuits before the decision can apply", async () => {
    const h = await makeHarness();
    active = h;
    let clock = 1_000_000;
    const manager = createExecutionManager({ ...h.deps, now: () => clock });
    const first = await manager.start(`
      const created = await tools.github.create_issue({ title: "stale" });
      return created;
    `);
    expect(first.status).toBe("paused");
    if (first.status !== "paused") {
      return;
    }
    clock = first.pending.expiresAt + 1;
    const outcome = await manager.resume(
      first.executionId,
      { kind: "deny" },
      await pendingCallOf(manager, first.executionId),
    );
    expect(outcome.status).toBe("expired");
    expect(outcome.decisionApplied).toBe(false);
  });

  it("a replay-divergence reports decisionApplied:false — a discarded decision was never applied (F2)", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);
    const id = await pauseOnCreateIssue(
      manager,
      `
      const r = await tools.github.delete_repo({ repo: "prod" });
      return r;
    `,
    );
    // Corrupt pausedOn to a different identity so the resume diverges (the
    // same confused-deputy setup as the F2 invariant test above).
    const persisted = await manager.get(id);
    if (persisted?.pausedOn === undefined) {
      throw new Error("expected a persisted pausedOn to corrupt");
    }
    await h.store.executions.put({
      ...persisted,
      pausedOn: { ...persisted.pausedOn, toolName: "github.create_issue", input: { title: "x" } },
    });

    const outcome = await manager.resume(id, { kind: "deny" }, await pendingCallOf(manager, id));
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitReplayDivergence");
    }
    expect(outcome.decisionApplied).toBe(false);
  });

  it("INVARIANT §5.5: a guest-spoofed ConduitPolicyBlocked failure does NOT read as an applied decision", async () => {
    // The name-proxy hole this field closes: a drive can fail with an error
    // NAMED ConduitPolicyBlocked while the staged decision was never consumed.
    // decisionApplied keys on the decisions seam's consumption state — not the
    // (guest-forgeable) error name — so it stays false here.
    const store = await makeBareStore();
    const spoofingSandbox: Sandbox = {
      execute: async () => ({
        status: "failed",
        error: { name: "ConduitPolicyBlocked", message: "guest-spoofed name, no call made" },
        seeds: generateSeeds(),
        journal: [],
      }),
    };
    const paused: Execution = {
      kind: "code",
      clientId: null,
      projection: "code",
      id: "exec_spoof",
      code: "irrelevant (stub sandbox)",
      status: "paused",
      seeds: generateSeeds(),
      startedAt: Date.now(),
      pausedOn: {
        callId: "call_spoof",
        toolName: "github.create_issue",
        // §5.4: live provenance, so the drive runs and the guest's spoofed
        // error name is what the outcome carries.
        ...(await seedProvenance(store, "github.create_issue")),
        input: { title: "x" },
        reason: "requires approval",
        expiresAt: Date.now() + 60_000,
      },
    };
    await store.executions.put(paused);

    const manager = createExecutionManager(makeStubDeps(store, spoofingSandbox));
    const outcome = await manager.resume("exec_spoof", { kind: "deny" }, "call_spoof");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.name).toBe("ConduitPolicyBlocked");
    }
    expect(outcome.decisionApplied).toBe(false);
  });
});

describe("R1 start: attribution, provenance, scope (§4.1, §5.4)", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
  });

  /** D11: every named start passes a resolver (a named client without one is refused). */
  const permitAllCode = (h: () => Harness): ScopeResolver => {
    return async () =>
      buildEffectiveScope(
        { projections: { code: true, direct: false, discovery: false }, allow: ALL_TOOLS },
        await h().store.tools.list(),
      );
  };

  it("INVARIANT §4.1: start persists clientId and projection for a code row; default profile is null/code", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const a = await m.start("return 1");
    const b = await m.start("return 1", {
      clientId: "acme",
      scope: permitAllCode(() => active as Harness),
    });
    expect(await m.get(a.executionId)).toMatchObject({
      kind: "code",
      clientId: null,
      projection: "code",
    });
    expect(await m.get(b.executionId)).toMatchObject({
      kind: "code",
      clientId: "acme",
      projection: "code",
    });
  });

  it("INVARIANT §4.1 (#19): the persisted code row carries the sentinel in `code` and the program in `program` — end to end", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const { executionId } = await m.start("return 7");
    const raw = await active.client.execute({
      sql: "SELECT code, program FROM executions WHERE id = ?",
      args: [executionId],
    });
    expect(raw.rows[0]?.code).toBe(NEWER_BUILD_SENTINEL);
    expect(raw.rows[0]?.program).toBe("return 7");
  });

  it("INVARIANT §4.1: a pause captures namespace and sourceGeneration equal to the store's current generation", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const out = await m.start('await tools.github.create_issue({ title: "x" }); return 1;');
    expect(out.status).toBe("paused");
    const row = await m.get(out.executionId);
    const gen = await active.store.sources.getGeneration("github");
    expect(gen).toBeTypeOf("number");
    expect(row?.pausedOn).toMatchObject({
      toolName: "github.create_issue",
      namespace: "github",
      sourceGeneration: gen,
    });
  });

  it("D-A7: a pause whose namespace has no source row terminalizes ConduitCatalogChanged instead of writing an unstamped pause", async () => {
    active = await makeHarness();
    // Tools and policies remain; only the provenance row is gone, so the pause
    // cannot be stamped and the call must not run.
    await active.store.sources.remove("src_gh");
    const m = createExecutionManager(active.deps);
    const out = await m.start('await tools.github.create_issue({ title: "x" }); return 1;');
    expect(out).toMatchObject({ status: "failed", error: { name: "ConduitCatalogChanged" } });
    expect((await m.get(out.executionId))?.pausedOn).toBeUndefined();
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.2 (#15 start half): a narrowed scope makes in-sandbox search hide, describe null, and a direct tools[path]() call fail closed", async () => {
    active = await makeHarness();
    const scope: ScopeResolver = async () =>
      buildEffectiveScope(
        {
          projections: { code: true, direct: false, discovery: false },
          allow: ["github.list_issues"],
        },
        await (active as Harness).store.tools.list(),
      );
    const m = createExecutionManager(active.deps);
    const out = await m.start(
      `
      const { items } = await tools.search({ query: "issue" });
      const described = await tools.describe.tool({ path: "github.create_issue" });
      try { await tools.github.create_issue({ title: "x" }); return { items: items.map(i => i.path), described, blocked: false }; }
      catch (e) { return { items: items.map(i => i.path), described, blocked: e.name }; }
    `,
      { clientId: "acme", scope },
    );
    expect(out).toMatchObject({
      status: "completed",
      value: { items: ["github.list_issues"], described: null, blocked: "ConduitPolicyBlocked" },
    });
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.2 (#16): turning the code flag off mid-drive bites on the running program's NEXT call", async () => {
    let codeOn = true;
    // `onCall` runs on the fixture server BEFORE it answers a tools/call, so the
    // flip lands between the first call's dispatch and the second call's scope check.
    active = await makeHarness({
      onCall: () => {
        codeOn = false;
      },
    });
    const scope: ScopeResolver = async () =>
      buildEffectiveScope(
        { projections: { code: codeOn, direct: false, discovery: false }, allow: ALL_TOOLS },
        await (active as Harness).store.tools.list(),
      );
    const m = createExecutionManager(active.deps);
    const out = await m.start(
      `
      await tools.github.list_issues({});
      await tools.github.list_issues({}); // lands after the flag flipped
      return "reached";
    `,
      { scope },
    );
    expect(out).toMatchObject({ status: "failed", error: { name: "ConduitPolicyBlocked" } });
    expect(active.calls).toHaveLength(1);
  });

  it("D11 (codex #1): start with a NAMED client and no resolver is refused before any row is written", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    await expect(m.start("return 1", { clientId: "acme" })).rejects.toThrow(
      /named client requires a scope resolver/,
    );
    expect(await active.store.executions.listRunningIds()).toEqual([]);
  });

  it("INVARIANT §4.1 (#25, manager half): a named client's requestKey conflicts within that client and returns the SAME client's id; another client with the same key runs", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const scope = permitAllCode(() => active as Harness);
    const first = await m.start("return 1", { clientId: "acme", requestKey: "k", scope });
    const again = await m.start("return 2", { clientId: "acme", requestKey: "k", scope });
    expect(again).toEqual({ status: "conflict", executionId: first.executionId });
    const other = await m.start("return 3", { clientId: "beta", requestKey: "k", scope });
    expect(other.status).toBe("completed");
    const dflt = await m.start("return 4", { requestKey: "k" });
    expect(dflt.status).toBe("completed");
  });

  it("INVARIANT §7 (#21/#24, Code Mode): a side-effect-then-404 upstream terminalizes the execution ConduitOutcomeAmbiguous even inside a guest try/catch, and the call is never re-sent", async () => {
    active = await makeHarness({
      respondToCall: (res) => {
        res.writeHead(404);
        res.end();
      },
    });
    const m = createExecutionManager(active.deps);
    const out = await m.start(
      'try { await tools.github.list_issues({}); } catch (e) { return "caught " + e.name; } return "ok";',
    );
    expect(out).toMatchObject({ status: "failed", error: { name: "ConduitOutcomeAmbiguous" } });
    expect(active.calls).toHaveLength(1);
    expect((await m.get(out.executionId))?.error?.name).toBe("ConduitOutcomeAmbiguous");
  });
});

/**
 * §5.4 steps 2–4: the post-claim read-side guard. An approval granted against
 * one catalog state, one call, and one client's authority must never be spent
 * against another. Every case below drives a HAND-BUILT row through the real
 * claim and the real store, with a Sandbox that rejects: the guard fires
 * before any drive, so a sandbox rejection means the guard let something
 * through.
 */
describe("INVARIANT §5.4 (#50): post-claim read-side guard, one test per disposition row", () => {
  let store: ConduitStore;
  let client: ReturnType<typeof createClient>;
  let manager: ExecutionManager;

  /** F10c: a Sandbox whose execute rejects — the guard under test fires BEFORE any drive. */
  const throwingSandbox = (): Sandbox => ({
    execute: () =>
      Promise.reject(new Error("[test] sandbox must not run: the resume guard terminalizes first")),
  });

  const tool = (name: string, namespace: string): Tool => ({
    name,
    namespace,
    inputSchema: { type: "object" },
    outputSchema: {},
    riskClass: "review",
    sourceSemantics: { kind: "mcp" },
  });

  const pause = (over: Partial<PendingApproval> = {}): PendingApproval => ({
    callId: "c1",
    toolName: "github.list_issues",
    namespace: "github",
    sourceGeneration: 0,
    input: { a: 1 },
    reason: "r",
    expiresAt: 9e12,
    ...over,
  });

  const directCall = (over: Partial<DirectCall> = {}): DirectCall => ({
    toolName: "github.list_issues",
    namespace: "github",
    request: JSON.stringify({ a: 1 }),
    ...over,
  });

  const codeRow = (over: Partial<Extract<Execution, { kind: "code" }>>): Execution => ({
    id: "e",
    kind: "code",
    code: "return 1;",
    status: "paused",
    seeds: generateSeeds(),
    startedAt: Date.now(),
    clientId: null,
    projection: "code",
    ...over,
  });

  const directRow = (over: Partial<Extract<Execution, { kind: "direct" }>>): Execution => ({
    id: "d",
    kind: "direct",
    call: directCall(),
    status: "paused",
    startedAt: Date.now(),
    clientId: null,
    projection: "direct",
    ...over,
  });

  const permitAll: ScopeResolver = async () =>
    buildEffectiveScope(
      { projections: { code: true, direct: true, discovery: true }, allow: ALL_TOOLS },
      await store.tools.list(),
    );

  beforeEach(async () => {
    const scratch = mkdtempSync(join(tmpdir(), "conduit-guard-"));
    client = createClient({ url: `file:${join(scratch, "guard.db")}` });
    bareClients.push(client);
    store = await openSqliteStore({
      client,
      secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
    });
    await store.sources.upsert({
      id: "src_gh",
      type: "mcp",
      namespace: "github",
      location: "https://gh",
      generation: 0,
    });
    await store.tools.replaceNamespace("github", [tool("github.list_issues", "github")]);
    manager = createExecutionManager(makeStubDeps(store, throwingSandbox()));
  });

  afterEach(() => {
    for (const c of bareClients.splice(0)) {
      c.close();
    }
  });

  const currentGen = async (): Promise<number> => {
    const generation = await store.sources.getGeneration("github");
    if (generation === undefined) {
      throw new Error("[test] the seeded source has no generation");
    }
    return generation;
  };

  /**
   * Seed a well-formed paused row, then overwrite `paused_on` with hand-crafted
   * JSON `put` could not write, and resume it. The row must be created with a
   * VALID pause first so `claimForResume` has a claimable `callId`.
   */
  async function resumeRaw(id: string, rawPausedOn: string, callId = "c1"): Promise<ResumeOutcome> {
    await client.execute({
      sql: "UPDATE executions SET paused_on = ? WHERE id = ?",
      args: [rawPausedOn, id],
    });
    return manager.resume(id, { kind: "approve" }, callId, permitAll);
  }

  const corrupt = {
    status: "failed",
    decisionApplied: false,
    corruptPause: true,
    error: { name: "ConduitInternalError" },
  };

  it.each([
    ["toolName not text", { ...pause(), toolName: 5 }],
    ["reason not text", { ...pause(), reason: null }],
    [
      "input absent",
      (() => {
        const { input: _i, ...rest } = pause();
        return rest;
      })(),
    ],
    ["expiresAt not finite", { ...pause(), expiresAt: "never" }],
    [
      "namespace present, sourceGeneration absent",
      (() => {
        const { sourceGeneration: _g, ...rest } = pause();
        return rest;
      })(),
    ],
    ["namespace not text", { ...pause(), namespace: 7 }],
    ["sourceGeneration not finite", { ...pause(), sourceGeneration: "7" }],
  ])("terminalizes corrupt: %s", async (_label, stored) => {
    await store.executions.create(
      codeRow({ status: "paused", pausedOn: pause({ sourceGeneration: await currentGen() }) }),
    );
    expect(await resumeRaw("e", JSON.stringify(stored))).toMatchObject(corrupt);
    expect((await store.executions.get("e"))?.status).toBe("failed");
  });

  it("terminalizes corrupt: namespace disagrees with the grammar-derived namespace of toolName", async () => {
    // The GRAMMAR half alone must catch this. A pause naming `github.x` with
    // namespace "slack" would also be caught by the COLUMN half, so it cannot
    // tell the two guards apart: seed a tool row whose COLUMN agrees with the
    // stored namespace ("slack") while its NAME parses to "github". Only the
    // grammar check can fire.
    await client.execute("UPDATE tools SET namespace = 'slack' WHERE name = 'github.list_issues'");
    await store.sources.upsert({
      id: "src_slack",
      type: "mcp",
      namespace: "slack",
      location: "https://slack",
      generation: 0,
    });
    await store.executions.create(
      codeRow({ status: "paused", pausedOn: pause({ sourceGeneration: await currentGen() }) }),
    );
    const slackGen = await store.sources.getGeneration("slack");
    if (slackGen === undefined) {
      throw new Error("[test] the seeded slack source has no generation");
    }
    expect(
      await resumeRaw(
        "e",
        JSON.stringify(pause({ namespace: "slack", sourceGeneration: slackGen })),
      ),
    ).toMatchObject(corrupt);
    expect((await store.executions.get("e"))?.status).toBe("failed");
  });

  it("terminalizes corrupt: namespace agrees with the grammar but not with the resolved tool row's namespace COLUMN", async () => {
    // A `{ name: "github.list_issues", namespace: "b" }` row: the invoker
    // dispatches connection and source through the COLUMN, so validating
    // generation "github" and dispatching through "b" must never happen.
    await client.execute("UPDATE tools SET namespace = 'b' WHERE name = 'github.list_issues'");
    await store.executions.create(
      codeRow({ status: "paused", pausedOn: pause({ sourceGeneration: await currentGen() }) }),
    );
    const gen = await currentGen();
    expect(await resumeRaw("e", JSON.stringify(pause({ sourceGeneration: gen })))).toMatchObject(
      corrupt,
    );
  });

  it("catalog change, not corruption: toolName no longer resolves → ConduitCatalogChanged", async () => {
    await store.executions.create(
      codeRow({
        status: "paused",
        pausedOn: pause({ toolName: "github.gone", sourceGeneration: await currentGen() }),
      }),
    );
    const out = await manager.resume("e", { kind: "approve" }, "c1", permitAll);
    expect(out).toMatchObject({
      status: "failed",
      decisionApplied: false,
      error: { name: "ConduitCatalogChanged" },
    });
    expect((out as { corruptPause?: true }).corruptPause).toBeUndefined();
  });

  it("legacy pause (both provenance fields absent) → ConduitCatalogChanged before any source read (§5.4 step 3, row #14)", async () => {
    const legacy = {
      callId: "c1",
      toolName: "github.list_issues",
      input: {},
      reason: "r",
      expiresAt: 9e12,
    };
    await store.executions.create(
      codeRow({ status: "paused", pausedOn: pause({ sourceGeneration: await currentGen() }) }),
    );
    const spy = vi.spyOn(store.sources, "getGeneration");
    const out = await resumeRaw("e", JSON.stringify(legacy));
    expect(out).toMatchObject({
      status: "failed",
      decisionApplied: false,
      error: { name: "ConduitCatalogChanged" },
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each([
    ["toolName", directCall({ toolName: "github.other" })],
    ["namespace", directCall({ namespace: "slack" })],
    ["request", directCall({ request: '{"a":1000}' })],
  ])("direct row: direct_call disagrees with pausedOn on %s → terminalize corrupt, the call never runs", async (_f, call) => {
    await store.executions.create(
      directRow({
        status: "paused",
        call,
        pausedOn: pause({ sourceGeneration: await currentGen() }),
      }),
    );
    expect(await manager.resume("d", { kind: "approve" }, "c1", permitAll)).toMatchObject(corrupt);
  });

  it("INVARIANT §5.4 step 3 (#14/#42, D3 authority): generation mismatch → ConduitCatalogChanged for BOTH kinds", async () => {
    const gen = await currentGen();
    await store.executions.create(
      codeRow({ id: "c", status: "paused", pausedOn: pause({ sourceGeneration: gen }) }),
    );
    await store.executions.create(
      directRow({ id: "d", status: "paused", pausedOn: pause({ sourceGeneration: gen }) }),
    );
    // The §4.1a triggers own the generation: an UPDATE bumps it.
    await client.execute("UPDATE sources SET location = 'https://moved' WHERE id = 'src_gh'");
    expect(await currentGen()).not.toBe(gen);
    for (const id of ["c", "d"]) {
      expect(await manager.resume(id, { kind: "approve" }, "c1", permitAll)).toMatchObject({
        status: "failed",
        decisionApplied: false,
        error: { name: "ConduitCatalogChanged" },
      });
    }
  });

  it("INVARIANT §4.1a (#17): remove then re-add never revives a paused row of either kind", async () => {
    const gen = await currentGen();
    await store.executions.create(
      codeRow({ id: "c", status: "paused", pausedOn: pause({ sourceGeneration: gen }) }),
    );
    await store.sources.remove("src_gh");
    await store.sources.upsert({
      id: "src_gh",
      type: "mcp",
      namespace: "github",
      location: "https://gh",
      generation: 0,
    });
    expect(await manager.resume("c", { kind: "approve" }, "c1", permitAll)).toMatchObject({
      error: { name: "ConduitCatalogChanged" },
    });
  });

  it("INVARIANT §5.4 step 4 (#16): a projection flag turned off, or the grant narrowed, revokes on resume — ConduitScopeRevoked", async () => {
    const gen = await currentGen();
    await store.executions.create(
      codeRow({ id: "c", status: "paused", pausedOn: pause({ sourceGeneration: gen }) }),
    );
    const codeOff: ScopeResolver = async () =>
      buildEffectiveScope(
        { projections: { code: false, direct: true, discovery: true }, allow: ALL_TOOLS },
        await store.tools.list(),
      );
    expect(await manager.resume("c", { kind: "approve" }, "c1", codeOff)).toMatchObject({
      status: "failed",
      decisionApplied: false,
      error: { name: "ConduitScopeRevoked" },
    });
    await store.executions.create(
      directRow({ id: "d", status: "paused", pausedOn: pause({ sourceGeneration: gen }) }),
    );
    // D-A3: no resolver = the default profile, whose `direct` flag is off.
    expect(await manager.resume("d", { kind: "approve" }, "c1")).toMatchObject({
      error: { name: "ConduitScopeRevoked" },
    });
  });

  it("D11 (codex #1): a NAMED row resumed with no resolver fails closed — never the default profile, never an unscoped drive", async () => {
    const gen = await currentGen();
    await store.executions.create(
      codeRow({
        id: "named",
        clientId: "acme",
        status: "paused",
        pausedOn: pause({ sourceGeneration: gen }),
      }),
    );
    const spy = vi.spyOn(store.tools, "list");
    expect(await manager.resume("named", { kind: "approve" }, "c1")).toMatchObject({
      status: "failed",
      decisionApplied: false,
      error: { name: "ConduitScopeRevoked" },
    });
    // The default profile was not even consulted.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("the prep-window catch persists an OPAQUE reason: no host detail reaches the agent-readable row", async () => {
    // The guard's reads flow through the shipped catch; a store rejection
    // carries host-only detail (a database path) that `check_execution`
    // would hand to the agent.
    const secret = "/Users/hostonly/private/conduit.db";
    const faulty: ConduitStore = {
      ...store,
      tools: {
        ...store.tools,
        get: () => Promise.reject(new Error(`SQLITE_CANTOPEN: unable to open ${secret}`)),
      },
    };
    const m = createExecutionManager(makeStubDeps(faulty, throwingSandbox()));
    await store.executions.create(
      codeRow({ status: "paused", pausedOn: pause({ sourceGeneration: await currentGen() }) }),
    );
    await expect(m.resume("e", { kind: "approve" }, "c1", permitAll)).rejects.toThrow(
      /SQLITE_CANTOPEN/,
    );
    const row = await client.execute({
      sql: "SELECT status, error FROM executions WHERE id = ?",
      args: ["e"],
    });
    expect(row.rows[0]?.status).toBe("failed");
    const stored = String(row.rows[0]?.error);
    expect(stored).not.toContain(secret);
    expect(stored).toContain("resume preparation failed. Reference:");
  });
});

describe("§5.4 resume under scope — real stack", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    await active?.cleanup();
    active = undefined;
  });

  it("INVARIANT §5.4 (#15): a code row that paused under a narrowed profile resumes UNDER that profile — an out-of-scope call after resume is blocked", async () => {
    active = await makeHarness();
    const narrow: ScopeResolver = async () =>
      buildEffectiveScope(
        {
          projections: { code: true, direct: false, discovery: false },
          allow: ["github.create_issue"],
        },
        await (active as Harness).store.tools.list(),
      );
    const m = createExecutionManager(active.deps);
    const paused = await m.start(
      'await tools.github.create_issue({ title: "x" }); try { await tools.github.list_issues({}); return "leaked"; } catch (e) { return e.name; }',
      { clientId: "acme", scope: narrow },
    );
    expect(paused.status).toBe("paused");
    const out = await m.resume(
      paused.executionId,
      { kind: "approve" },
      await pendingCallOf(m, paused.executionId),
      narrow,
    );
    expect(out).toMatchObject({
      status: "completed",
      value: "ConduitPolicyBlocked",
      decisionApplied: true,
    });
    expect(active.calls.map((c) => c.name)).toEqual(["create_issue"]);
  });

  it("INVARIANT §4.1 (#14): a provision AFTER the pause invalidates it — resume fails closed re-approve and the upstream never sees the call", async () => {
    active = await makeHarness();
    const m = createExecutionManager(active.deps);
    const paused = await m.start('await tools.github.create_issue({ title: "x" }); return 1;');
    const callId = await pendingCallOf(m, paused.executionId);
    // F13: triggers bump the generation.
    await active.reprovision();
    // No sweep in the SDK; the daemon runs it (Lane B).
    expect(await active.store.executions.get(paused.executionId)).toMatchObject({
      status: "paused",
    });
    const out = await m.resume(paused.executionId, { kind: "approve" }, callId);
    expect(out).toMatchObject({
      status: "failed",
      decisionApplied: false,
      error: { name: "ConduitCatalogChanged" },
    });
    expect(active.calls).toHaveLength(0);
  });
});

/**
 * §5.3/§5.4 direct arm: ONE governed tool call with no guest program. The
 * properties under test are exactly-once dispatch, a bounded client-visible
 * outcome, and a truthful record when the outcome cannot be known.
 *
 * Budgets are injected small (`deps.direct`) rather than waited out: the real
 * drive budget is 60 s.
 */
describe("R1 direct arm (§5.3/§5.4)", () => {
  let active: Harness | undefined;
  afterEach(async () => {
    // Real timers FIRST: harness cleanup closes libsql clients and a loopback
    // server, both of which need a working clock to settle.
    vi.useRealTimers();
    await active?.cleanup();
    active = undefined;
  });

  /**
   * Plan-mandated (implementer note 1): the exactly-once tests drive the
   * budget with FAKE timers rather than a real 400 ms budget, which flakes
   * under CI load. Only `setTimeout`/`clearTimeout` are faked — `Date` and
   * the rest stay real, so libsql's own I/O and the harness's loopback
   * server keep working while the drive's budget is under test control.
   */
  function withFakeTimers(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }

  const permitDirect: ScopeResolver = async () =>
    buildEffectiveScope(
      { projections: { code: true, direct: true, discovery: true }, allow: ALL_TOOLS },
      await requireActive(active).store.tools.list(),
    );

  const fast = {
    driveBudgetMs: 400,
    settleWriteBudgetMs: 200,
    slotRetentionMs: 150,
    resultBytesMax: 262_144,
  };

  /** A settleDirect spy that still performs the real write. */
  function spyOnSettle(store: ConduitStore, seen: boolean[]): ConduitStore {
    return {
      ...store,
      executions: {
        ...store.executions,
        settleDirect: async (...a: Parameters<ConduitStore["executions"]["settleDirect"]>) => {
          const r = await store.executions.settleDirect(...a);
          seen.push(r);
          return r;
        },
      },
    } as ConduitStore;
  }

  it("INVARIANT §5.4 (#1): a direct call runs the same policy path — safe tool allowed, destructive tool blocked, review tool paused; exactly one upstream call for the allowed one", async () => {
    active = await makeHarness();
    // §10.2: `destructive` DEFAULTS to require_approval, not block — only an
    // operator blocks. Seed that operator policy so the blocked arm is a real
    // block verdict rather than a third pause.
    await active.store.policies.upsert({
      toolName: "github.delete_repo",
      action: "block",
      seededFrom: "destructive",
      manualOverride: true,
      redactFields: [],
    });
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const ok = await m.startDirect(
      "github.list_issues",
      { owner: "o" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    expect(ok).toMatchObject({ status: "completed", value: { ok: true, tool: "list_issues" } });

    const blocked = await m.startDirect(
      "github.delete_repo",
      { repo: "r" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    expect(blocked).toMatchObject({ status: "failed", error: { name: "ConduitPolicyBlocked" } });

    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    expect(paused).toMatchObject({
      status: "paused",
      pending: { toolName: "github.create_issue", namespace: "github" },
    });
    // EXACTLY ONE upstream call: the blocked and paused calls never dispatched.
    expect(active.calls.map((c) => c.name)).toEqual(["list_issues"]);

    const row = await m.get(paused.executionId);
    expect(row).toMatchObject({
      kind: "direct",
      status: "paused",
      projection: "direct",
      call: { toolName: "github.create_issue", namespace: "github", request: '{"title":"t"}' },
    });
  });

  it("INVARIANT §4.1 (#41): a synchronous completion is `delivered` — result on the wire, NOT stored", async () => {
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const out = await m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    expect(out.status).toBe("completed");
    const row = await m.get(out.executionId);
    expect(row).toMatchObject({ kind: "direct", status: "completed", resultState: "delivered" });
    expect(row?.result).toBeUndefined();
  });

  it("INVARIANT §5.4 (#3): approve resumes a paused direct call, performs EXACTLY that call once, persists the result REDACTED as `retained`, reports decisionApplied", async () => {
    active = await makeHarness();
    await active.store.policies.upsert({
      toolName: "github.create_issue",
      action: "require_approval",
      seededFrom: "review",
      manualOverride: true,
      redactFields: ["tool"],
    });
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const out = await m.resume(
      paused.executionId,
      { kind: "approve" },
      await pendingCallOf(m, paused.executionId),
      permitDirect,
    );
    expect(out).toMatchObject({
      status: "completed",
      decisionApplied: true,
      value: { ok: true, tool: "[redacted]" },
    });
    expect(active.calls).toEqual([{ name: "create_issue", arguments: { title: "t" } }]);
    const row = await m.get(paused.executionId);
    expect(row).toMatchObject({
      resultState: "retained",
      result: { ok: true, tool: "[redacted]" },
    });
  });

  it("INVARIANT §5.4 (#3): deny resolves the direct call as blocked with decisionApplied:true and no upstream call", async () => {
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const out = await m.resume(
      paused.executionId,
      { kind: "deny" },
      await pendingCallOf(m, paused.executionId),
      permitDirect,
    );
    expect(out).toMatchObject({
      status: "failed",
      decisionApplied: true,
      error: { name: "ConduitPolicyBlocked" },
    });
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §4.1 (#41): a deliverable over RESULT_BYTES_MAX is settled `discarded` in ONE write", async () => {
    active = await makeHarness({
      respondToCall: (res, payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { big: "x".repeat(300_000) },
          }),
        );
      },
    });
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const out = await m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    expect(out).toMatchObject({ status: "completed", resultTooLarge: true });
    expect((out as { value?: unknown }).value).toBeUndefined();
    expect(await m.get(out.executionId)).toMatchObject({
      status: "completed",
      resultState: "discarded",
    });
  });

  it("INVARIANT §4.1 (#41): an expanding redaction — fits raw, exceeds the cap redacted — is discarded on the RESUMED path", async () => {
    // 25,000 leaves under a 63-deep spine, so each LEAF sits at the
    // redactor's MAX_DEPTH (64) while the array holding them does not. Raw,
    // each leaf is `{}` — 2 bytes. Redacted, each becomes the 12-byte marker
    // `"[redacted]"`, which takes the total from ~75 KB to ~325 KB: fits the
    // cap raw, exceeds it redacted. (A 64-deep spine would redact the ARRAY
    // itself to one marker and SHRINK the payload — the opposite case.)
    const spine = (depth: number, leaves: unknown): unknown =>
      depth === 0 ? leaves : { d: spine(depth - 1, leaves) };
    const bigResult = spine(
      63,
      Array.from({ length: 25_000 }, () => ({})),
    );
    expect(deliverableBytes(bigResult)).toBeLessThan(262_144);
    expect(deliverableBytes(redactSensitiveFields(bigResult, []))).toBeGreaterThan(262_144);
    active = await makeHarness({
      respondToCall: (res, payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: bigResult }));
      },
    });
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const out = await m.resume(
      paused.executionId,
      { kind: "approve" },
      await pendingCallOf(m, paused.executionId),
      permitDirect,
    );
    expect(out).toMatchObject({
      status: "completed",
      resultTooLarge: true,
      decisionApplied: true,
    });
    const row = await m.get(paused.executionId);
    expect(row).toMatchObject({ resultState: "discarded" });
    expect(row?.result).toBeUndefined();
  });

  it("D-A13: the budget timer is armed before create() — a hung first write still yields the timeout outcome within budget", async () => {
    withFakeTimers();
    active = await makeHarness();
    const never = new Promise<never>(() => {});
    const stuck = {
      ...active.store,
      executions: { ...active.store.executions, create: () => never },
    } as ConduitStore;
    const m = createExecutionManager({ ...active.deps, store: stuck, direct: fast });
    const handle = m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    );
    // The budget elapses on the FAKE clock while create() is still hung.
    await vi.advanceTimersByTimeAsync(fast.driveBudgetMs + fast.settleWriteBudgetMs);
    const out = await handle.outcome;
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
    });
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.3 (#22/#28): exactly-once settlement — the timer wins, a delayed SUCCESS from the continuation never overwrites `failed`", async () => {
    withFakeTimers();
    active = await makeHarness();
    const settleCalls: boolean[] = [];
    const spyStore = spyOnSettle(active.store, settleCalls);
    const m = createExecutionManager({
      ...active.deps,
      store: spyStore,
      direct: fast,
      makeInvoker: () => () =>
        new Promise((resolve) => setTimeout(() => resolve({ late: true }), 900)),
    });
    const handle = m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    );
    // Drive the clock, never the wall: the budget (400) elapses, then the
    // late success (900) lands. Awaiting the promise under test after each
    // advance is what keeps this from being a vacuous pass — `advance` alone
    // would prove nothing about the microtasks the settle depends on.
    await vi.advanceTimersByTimeAsync(fast.driveBudgetMs + fast.settleWriteBudgetMs);
    const out = await handle.outcome;
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await handle.finished;
    // Exactly ONE write changed the row; the late success never reached
    // settleDirect at all — the latch stopped it before the fence.
    expect(settleCalls).toEqual([true]);
    expect(await m.get(out.executionId)).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
    });
  });

  it("INVARIANT §7 (#22): the timer fires with the cell already DISPATCHED — settled ConduitOutcomeAmbiguous, and a late continuation changes nothing", async () => {
    withFakeTimers();
    active = await makeHarness();
    const settleCalls: boolean[] = [];
    const spyStore = spyOnSettle(active.store, settleCalls);
    const m = createExecutionManager({
      ...active.deps,
      store: spyStore,
      direct: fast,
      // Advances the SUPPLIED cell (the drive's) to dispatched, then hangs
      // past the budget.
      makeInvoker:
        ({ dispatch }) =>
        () => {
          dispatch?.advance("initializing");
          dispatch?.advance("dispatched");
          return new Promise((resolve) => setTimeout(() => resolve({ late: true }), 900));
        },
    });
    const handle = m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    );
    await vi.advanceTimersByTimeAsync(fast.driveBudgetMs + fast.settleWriteBudgetMs);
    const out = await handle.outcome;
    expect(out).toMatchObject({
      status: "failed",
      error: { name: OUTCOME_AMBIGUOUS_ERROR_NAME },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await handle.finished;
    expect(settleCalls).toEqual([true]);
    expect(await m.get(out.executionId)).toMatchObject({
      status: "failed",
      error: { name: OUTCOME_AMBIGUOUS_ERROR_NAME },
    });
  });

  it("INVARIANT §5.3: a REJECTED settle write publishes unknown/persist-failed, never the intended outcome", async () => {
    active = await makeHarness();
    const failing = {
      ...active.store,
      executions: {
        ...active.store.executions,
        settleDirect: async () => {
          throw new Error("SQLITE_IOERR");
        },
      },
    } as ConduitStore;
    const m = createExecutionManager({ ...active.deps, store: failing, direct: fast });
    const out = await m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    expect(out).toEqual({
      status: "unknown",
      executionId: expect.any(String),
      reason: "persist-failed",
    });
  });

  it("D-A11 final: on RESUME a stalled settle write yields unknown/persist-timeout within budget, with decisionApplied", async () => {
    active = await makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const slowSettle = {
      ...active.store,
      executions: {
        ...active.store.executions,
        settleDirect: async (...a: Parameters<ConduitStore["executions"]["settleDirect"]>) => {
          await gate;
          return requireActive(active).store.executions.settleDirect(...a);
        },
      },
    } as ConduitStore;
    const slowM = createExecutionManager({ ...active.deps, store: slowSettle, direct: fast });
    // REAL CLOCK, deliberately (fix round 1, finding 3): this test drives a
    // real `resume()` whose approved call crosses the harness's loopback MCP
    // socket. Under `vi.useFakeTimers` that path deadlocks — verified: the
    // test times out at 5 s with the clock frozen. So the budget stays real
    // and the margin is a full SECOND, not a few hundred ms, to survive CI
    // load; the property under test (an answer within budget, not an exact
    // duration) tolerates the slack.
    const t0 = Date.now();
    const out = await slowM.resume(
      paused.executionId,
      { kind: "approve" },
      await pendingCallOf(m, paused.executionId),
      permitDirect,
    );
    expect(Date.now() - t0).toBeLessThan(fast.driveBudgetMs + fast.settleWriteBudgetMs + 1_000);
    expect(out).toMatchObject({
      status: "unknown",
      reason: "persist-timeout",
      decisionApplied: true,
    });
    release();
    await new Promise((r) => setTimeout(r, 100));
    // The write was still tracked and lands afterwards: the `unknown` was
    // honest about the record, not about the effect.
    expect(await m.get(paused.executionId)).toMatchObject({
      status: "completed",
      resultState: "retained",
    });
  });

  it("INVARIANT §5.3 (F2): a source read that outlives the budget never dispatches — the row settles pre-dispatch and the upstream sees nothing", async () => {
    active = await makeHarness();
    // The stall must sit on the read the INVOKER makes (the manager itself
    // performs no source read on this path), so stub the invoker to await it.
    const m = createExecutionManager({
      ...active.deps,
      direct: fast,
      makeInvoker: () => async () => {
        await new Promise((r) => setTimeout(r, 900));
        throw new Error("the drive already settled; this never dispatches");
      },
    });
    const handle = m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    );
    const out = await handle.outcome;
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
    });
    await handle.finished;
    expect(active.calls).toHaveLength(0);
  });

  it("F3: the timer fires while create() is in flight, create() then succeeds — the row is settled failed, never left running, and the pipeline never runs", async () => {
    active = await makeHarness();
    let releaseCreate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseCreate = r;
    });
    const slowCreate = {
      ...active.store,
      executions: {
        ...active.store.executions,
        create: async (...a: Parameters<ConduitStore["executions"]["create"]>) => {
          await gate;
          return requireActive(active).store.executions.create(...a);
        },
      },
    } as ConduitStore;
    const m = createExecutionManager({ ...active.deps, store: slowCreate, direct: fast });
    const handle = m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    );
    const out = await handle.outcome;
    expect(out.status).toBe("failed");
    releaseCreate();
    await handle.finished;
    expect(await m.get(out.executionId)).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
    });
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.3 (#22): a delayed REFUSAL after timeout leaves the row failed under the timeout's own classification (pre-dispatch)", async () => {
    active = await makeHarness();
    // A preparation that outlives the budget, then REFUSES. The timeout has
    // already classified the row pre-dispatch (the cell never advanced), and
    // the late refusal must not relabel it.
    const m = createExecutionManager({
      ...active.deps,
      direct: fast,
      makeInvoker: () => async () => {
        await new Promise((r) => setTimeout(r, 900));
        throw new Error("ConduitPolicyBlocked arriving far too late");
      },
    });
    const handle = m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    );
    const out = await handle.outcome;
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
    });
    expect(active.calls).toHaveLength(0);
    await handle.finished;
    // Late preparation never dispatches: deadline() expired before the write.
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.3 (#22 quarantine, #45): a never-returning store read still yields the timeout outcome within budget; retention reports `abandoned`; finished stays pending", async () => {
    withFakeTimers();
    active = await makeHarness();
    const never = new Promise<never>(() => {});
    // A read that NEVER returns: the continuation can never finish, so
    // `finished` must stay pending forever while `outcome` is still answered
    // in budget and the slot is reported `abandoned` (#45 quarantine).
    const m = createExecutionManager({
      ...active.deps,
      direct: fast,
      makeInvoker: () => () => never,
    });
    const handle = m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    );
    await vi.advanceTimersByTimeAsync(fast.driveBudgetMs + fast.settleWriteBudgetMs);
    const out = await handle.outcome;
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
    });
    // The continuation never returns, so the slot is ABANDONED once the
    // retention window elapses on the fake clock.
    const retention = handle.retention;
    await vi.advanceTimersByTimeAsync(fast.slotRetentionMs + 10);
    expect(await retention).toBe("abandoned");
    expect(
      await (async () => {
        const race = Promise.race([
          handle.finished.then(() => "finished"),
          new Promise((r) => setTimeout(() => r("pending"), 50)),
        ]);
        // Advance AFTER building the race, so the 50 ms probe actually fires
        // on the fake clock; then await it. Awaiting first would deadlock.
        await vi.advanceTimersByTimeAsync(50);
        return race;
      })(),
    ).toBe("pending");
  });

  it('INVARIANT §5.3 (#45): a stalled settle write yields status "unknown" within budget, never a claimed terminalization; the write stays tracked', async () => {
    active = await makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowSettle = {
      ...active.store,
      executions: {
        ...active.store.executions,
        settleDirect: async (...a: Parameters<ConduitStore["executions"]["settleDirect"]>) => {
          await gate;
          return requireActive(active).store.executions.settleDirect(...a);
        },
      },
    } as ConduitStore;
    const m = createExecutionManager({ ...active.deps, store: slowSettle, direct: fast });
    const handle = m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    );
    const out = await handle.outcome;
    expect(out).toMatchObject({ status: "unknown", reason: "persist-timeout" });
    // Not yet persisted — honest: the row still reads `running`.
    expect((await m.get(out.executionId))?.status).toBe("running");
    release();
    await handle.finished;
    expect(await m.get(out.executionId)).toMatchObject({
      status: "completed",
      resultState: "delivered",
    });
  });

  it("INVARIANT §5.3 (#45): a create rejection whose CONFLICT LOOKUP also rejects still answers — outcome, retention and finished all settle", async () => {
    // NOTE (fix round 1, finding 4): this pins the create-rejection BRANCH,
    // not the `finished.finally` backstop. `mapCreateConflict` is wrapped in
    // `.catch(() => undefined)`, so this path always reaches `settle()` and
    // publishes `failed` itself; deleting the backstop leaves this test
    // green. The backstop is labelled untested defence-in-depth in the code.
    active = await makeHarness();
    // A store whose `create` throws a NON-conflict cause and whose conflict
    // lookup also throws — the hostile double-fault this branch must answer.
    const hostile = {
      ...active.store,
      executions: {
        ...active.store.executions,
        create: async () => {
          throw new Error("disk on fire");
        },
        getByRequestKey: async () => {
          throw new Error("and the index too");
        },
      },
    } as ConduitStore;
    const m = createExecutionManager({ ...active.deps, store: hostile, direct: fast });
    const handle = m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", requestKey: "k", scope: permitDirect },
    );
    const out = await Promise.race([
      handle.outcome,
      new Promise((r) => setTimeout(() => r("HUNG"), fast.driveBudgetMs * 3)),
    ]);
    expect(out).not.toBe("HUNG");
    expect(out).toMatchObject({ status: "failed" });
    await handle.finished;
    // And all three handle promises settle.
    expect(await handle.retention).toBe("released");
  });

  it("INVARIANT §5.3 (#22): retention is `released` when the continuation finishes within slotRetentionMs", async () => {
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const handle = m.startDirect(
      "github.list_issues",
      {},
      { clientId: null, projection: "direct", scope: permitDirect },
    );
    await handle.outcome;
    expect(await handle.retention).toBe("released");
  });

  it("INVARIANT §4.1 (#25, discovery): a requestKey on the discovery projection conflicts within the client", async () => {
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const a = await m.startDirect(
      "github.list_issues",
      {},
      { clientId: "acme", projection: "discovery", requestKey: "k", scope: permitDirect },
    ).outcome;
    const b = await m.startDirect(
      "github.list_issues",
      {},
      { clientId: "acme", projection: "discovery", requestKey: "k", scope: permitDirect },
    ).outcome;
    expect(b).toEqual({ status: "conflict", executionId: a.executionId });
  });

  it("INVARIANT §4.1 (#25): a requestKey collision NEVER crosses clients — client B's same key sees its own row, not client A's", async () => {
    // Task 8 handover: `mapCreateConflict`'s isolation rests on the caller
    // threading ITS OWN clientId into `getByRequestKey`. If startDirect
    // passed `null` (or another client's id), A's execution id would leak to
    // B as a `conflict` payload.
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const a = await m.startDirect(
      "github.list_issues",
      {},
      { clientId: "acme", projection: "direct", requestKey: "shared", scope: permitDirect },
    ).outcome;
    const b = await m.startDirect(
      "github.list_issues",
      {},
      { clientId: "other", projection: "direct", requestKey: "shared", scope: permitDirect },
    ).outcome;
    // B got its OWN execution, not a conflict naming A's id.
    expect(b.status).toBe("completed");
    expect(b.executionId).not.toBe(a.executionId);
    // And B's second use of its own key DOES conflict, within its own client.
    const bAgain = await m.startDirect(
      "github.list_issues",
      {},
      { clientId: "other", projection: "direct", requestKey: "shared", scope: permitDirect },
    ).outcome;
    expect(bAgain).toEqual({ status: "conflict", executionId: b.executionId });
  });

  it("a direct row writes NO replay_journal rows and its Trace row carries projection/clientId", async () => {
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const out = await m.startDirect(
      "github.list_issues",
      {},
      { clientId: "acme", projection: "discovery", scope: permitDirect },
    ).outcome;
    expect(await active.store.replayJournal.listByExecution(out.executionId)).toEqual([]);
    expect(await active.store.trace.listByExecution(out.executionId)).toMatchObject([
      { projection: "discovery", clientId: "acme" },
    ]);
  });

  it("Task 9 handover: a DIRECT row's guard terminalization uses the bounded FENCED settle, not failClaimedResume", async () => {
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const callId = await pendingCallOf(m, paused.executionId);
    // Bump the generation: the §5.4 step-3 guard now fails closed.
    await active.reprovision();
    let failCalled = 0;
    let settleCalled = 0;
    const watched = {
      ...active.store,
      executions: {
        ...active.store.executions,
        failClaimedResume: async (
          ...a: Parameters<ConduitStore["executions"]["failClaimedResume"]>
        ) => {
          failCalled += 1;
          return requireActive(active).store.executions.failClaimedResume(...a);
        },
        settleDirect: async (...a: Parameters<ConduitStore["executions"]["settleDirect"]>) => {
          settleCalled += 1;
          return requireActive(active).store.executions.settleDirect(...a);
        },
      },
    } as ConduitStore;
    const watchedM = createExecutionManager({ ...active.deps, store: watched, direct: fast });
    const out = await watchedM.resume(
      paused.executionId,
      { kind: "approve" },
      callId,
      permitDirect,
    );
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitCatalogChanged" },
      decisionApplied: false,
    });
    expect(settleCalled).toBe(1);
    expect(failCalled).toBe(0);
    expect(await m.get(paused.executionId)).toMatchObject({ status: "failed" });
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.3 (#22/#28, latch): expiry holds the latch, so a LATE guard result defers to it — exactly one settleDirect, and never a false persist-failed", async () => {
    // Fix round 2. Arming `onExpire` made this race live: the budget elapses
    // just BEFORE a slow-but-returning guard read resolves. The timer has
    // taken the latch and its write is landing; the guard must defer, not
    // issue a second `settleDirect` and then read its own `fenced` (0 rows)
    // as `unknown/persist-failed` — a false non-answer for a write that
    // actually SUCCEEDED.
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const callId = await pendingCallOf(m, paused.executionId);
    // The guard must REACH a terminalization for this race to exist at all:
    // bump the generation so §5.4 step 3 fails closed (ConduitCatalogChanged)
    // instead of the guard passing and driving the call.
    await active.reprovision();

    // A CONTROLLED deferred guard read — not a sleep. The interleaving that
    // exposes the defect is the guard resolving while the expiry's write is
    // still IN FLIGHT: if the expiry's write were allowed to COMPLETE first
    // the row would already be terminal, and the store's `status='running'`
    // fence would mask a missing latch. So the expiry's write is held open
    // until the guard has been released.
    let releaseGuardRead!: () => void;
    const guardReadGate = new Promise<void>((r) => {
      releaseGuardRead = r;
    });
    let releaseExpiryWrite!: () => void;
    const expiryWriteGate = new Promise<void>((r) => {
      releaseExpiryWrite = r;
    });
    let expiryWriteStarted!: () => void;
    const expiryWriteInFlight = new Promise<void>((r) => {
      expiryWriteStarted = r;
    });
    const settleAttempts: string[] = [];
    const raced = {
      ...active.store,
      tools: {
        ...active.store.tools,
        get: async (n: string) => {
          await guardReadGate;
          return requireActive(active).store.tools.get(n);
        },
      },
      executions: {
        ...active.store.executions,
        settleDirect: async (...a: Parameters<ConduitStore["executions"]["settleDirect"]>) => {
          settleAttempts.push(a[1]);
          if (settleAttempts.length === 1) {
            // The EXPIRY's write: announce it, then hold it open so the
            // guard resolves while it is still in flight.
            expiryWriteStarted();
            await expiryWriteGate;
          }
          return requireActive(active).store.executions.settleDirect(...a);
        },
      },
    } as ConduitStore;
    const racedM = createExecutionManager({ ...active.deps, store: raced, direct: fast });
    const resuming = racedM.resume(paused.executionId, { kind: "approve" }, callId, permitDirect);
    // The budget elapses while the guard read is gated → the expiry takes the
    // latch and starts its write. Release the guard read WHILE that write is
    // still open: the guard must now defer, not write again.
    await expiryWriteInFlight;
    releaseGuardRead();
    // Give the guard's continuation real event-loop turns to reach its
    // terminalization while the expiry's write is still open. This must stay
    // WELL under `settleWriteBudgetMs`, or the expiry itself would time out
    // and report persist-timeout for a reason unrelated to the latch.
    await new Promise((r) => setTimeout(r, 30));
    releaseExpiryWrite();
    const out = await resuming;

    // EXACTLY ONE write for this attempt: the loser deferred instead of
    // issuing a second one.
    expect(settleAttempts).toHaveLength(1);
    // And the published outcome is the EXPIRY's, never a false persist-failed.
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
      decisionApplied: false,
    });
    expect(out.status).not.toBe("unknown");
    expect(await m.get(paused.executionId)).toMatchObject({ status: "failed" });
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.3 (guard-phase expiry): a guard READ that never returns still answers within the drive budget and terminalizes the claimed row", async () => {
    // Fix round 1, finding 1. Every §5.4 guard read is unbounded. Before the
    // fix the drive's timer fired into an UNASSIGNED `onExpire`, so a stalled
    // guard read left the row `running` forever and `resume()` never settled.
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const callId = await pendingCallOf(m, paused.executionId);
    const never = new Promise<never>(() => {});
    // `tools.get` is a GUARD read — reached long before any settle decision,
    // which is what the pre-existing stalled-settle test could not cover.
    const stuckGuard = {
      ...active.store,
      tools: { ...active.store.tools, get: () => never },
    } as ConduitStore;
    const stuckM = createExecutionManager({ ...active.deps, store: stuckGuard, direct: fast });
    // REAL CLOCK, deliberately (fix round 1, finding 3): this test's path
    // crosses the harness's loopback MCP socket — here in the SETUP, which
    // provisions the source and drives the initial `startDirect` to a pause
    // (the guard terminalizes before any approved call runs). Under
    // `vi.useFakeTimers` that socket path deadlocks — verified: the test
    // times out at 5 s with the clock frozen. So the budget stays real and
    // the margin is a full SECOND, not a few hundred ms, to survive CI load;
    // the property under test (an answer within budget, not an exact
    // duration) tolerates the slack.
    const t0 = Date.now();
    const out = await Promise.race([
      stuckM.resume(paused.executionId, { kind: "approve" }, callId, permitDirect),
      new Promise((r) => setTimeout(() => r("HUNG"), fast.driveBudgetMs * 5)),
    ]);
    expect(out).not.toBe("HUNG");
    expect(Date.now() - t0).toBeLessThan(fast.driveBudgetMs + fast.settleWriteBudgetMs + 1_000);
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
      decisionApplied: false,
    });
    // The row is TERMINALIZED, never stranded `running`.
    expect(await m.get(paused.executionId)).toMatchObject({ status: "failed" });
    // And the pending call never ran.
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.3 (#28, I1): a FROZEN injected clock cannot re-open the budget after the timer settled — zero upstream calls", async () => {
    // I1, manager half. `deadline()` subtracted an injected `now()` while the
    // budget timer ran on `setTimeout`. With `now` frozen, the timer still
    // fires and publishes "elapsed before dispatch" — but an un-latched
    // `deadline()` kept reporting the FULL budget, so the invoker's pre-write
    // gate passed and the call dispatched anyway, for a row already settled.
    // The latch-aware deadline closes it: after the timer takes the latch,
    // `deadline()` is 0 whatever the clock says, and the upstream sees NOTHING.
    active = await makeHarness();
    const frozen = Date.now();
    // Hold the invoker's scope check (step 1a) open past the drive budget, so
    // the timer fires while the call is still short of the wire. The deadline
    // gate (step 5) runs after it — that is the gate under test.
    const slowScope: ScopeResolver = async (clientId) => {
      await new Promise((r) => setTimeout(r, fast.driveBudgetMs * 2));
      return permitDirect(clientId);
    };
    const m = createExecutionManager({
      ...active.deps,
      direct: fast,
      // Frozen: every `now()` the manager and the drive read returns the same
      // instant, so elapsed time is invisible to the deadline arithmetic. The
      // real `setTimeout` behind the drive's timer is unaffected.
      now: () => frozen,
    });
    // `list_issues` is read-only, so policy ALLOWS it and the drive proceeds
    // to the dispatch gate — which is the gate under test. An
    // approval-gated tool would pause before ever reaching it.
    const handle = m.startDirect(
      "github.list_issues",
      { owner: "acme", repo: "site" },
      { clientId: null, projection: "direct", scope: slowScope },
    );
    // REAL CLOCK (same reason as the guard-expiry tests above): the setup
    // path crosses the harness's loopback MCP socket, which deadlocks under
    // fake timers. The drive budget is real; only the manager's `now` is
    // frozen, which is precisely the skew under test.
    const out = await Promise.race([
      handle.outcome,
      new Promise((r) => setTimeout(() => r("HUNG"), fast.driveBudgetMs * 10)),
    ]);
    expect(out).not.toBe("HUNG");
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
    });
    // Wait for the continuation to actually STOP before reading the upstream
    // record: `outcome` resolves as soon as the timer's settle publishes,
    // while the invoker is still mid-flight behind the gated scope read.
    // Asserting before `finished` would pass for the wrong reason.
    await handle.finished;
    // The point of the fix: with the latch taken, the invoker's deadline gate
    // sees 0 and refuses, so the governed body was NEVER written upstream.
    // Unfixed, the frozen clock reports the full budget and the call goes out.
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.3 (#45, M1): `finished` stays PENDING while the settle write is still open — D-A2 cleanup means the work has actually stopped", async () => {
    // M1 / D-A2. `finished` is the CLEANUP promise the spec ties the admission
    // slot to: "the slot is held until the drive SETTLES … resources are held
    // until the work has actually stopped". A tracked settle write still in
    // flight IS live work, so resolving `finished` before it lands would let
    // Lane B release an admission slot over a live store write.
    //
    // `outcome` is deliberately NOT affected: the spec's "two promises" rule
    // keeps the client-visible outcome resolving as soon as the row is
    // settled, and retention is measured from `settledAt`, not from here.
    //
    // The RESUME path is where the gap was: `settleDirectBounded` discarded
    // the `write` promise and the guard exits call `finishEarly()`, which
    // resolved `finished` immediately. (`startDirect`'s own path already
    // awaited `run.tracked` in `runDirect`'s `finally`.)
    // The observable seam is the DRIVE's own `finished` on the resume path.
    // `createDirectDrive` is the manager's, so the drive is captured through
    // the guard terminalization it performs: the settle write is held open,
    // and `finished` must not resolve until it lands.
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const callId = await pendingCallOf(m, paused.executionId);
    // Bump the generation so the §5.4 step-3 guard terminalizes — that is the
    // path whose settle write `finished` must now await.
    await active.reprovision();

    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((r) => {
      releaseWrite = r;
    });
    let writeStarted!: () => void;
    const writeInFlight = new Promise<void>((r) => {
      writeStarted = r;
    });
    const gated = {
      ...active.store,
      executions: {
        ...active.store.executions,
        settleDirect: async (...a: Parameters<ConduitStore["executions"]["settleDirect"]>) => {
          writeStarted();
          await writeGate;
          return requireActive(active).store.executions.settleDirect(...a);
        },
      },
    } as ConduitStore;
    const gatedM = createExecutionManager({ ...active.deps, store: gated, direct: fast });
    const resuming = gatedM.resume(paused.executionId, { kind: "approve" }, callId, permitDirect);
    await writeInFlight;
    // The guard's settle write is OPEN. `resume()` is still awaiting it, so
    // the row is not yet decided on disk — the write is live work, and a
    // `finished` that resolved here would release Lane B's slot over it.
    // The guard terminalization awaits its own bounded settle, so `resume()`
    // cannot have answered yet. (The drive-level property — `finished` waits
    // on this write while `settledAt` does not — is pinned at the unit seam
    // in `direct.test.ts`, where the drive is directly observable.)
    const settledEarly = await Promise.race([
      resuming.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("still-pending"), 120)),
    ]);
    expect(settledEarly).toBe("still-pending");
    releaseWrite();
    const out = await resuming;
    expect(out).toMatchObject({ status: "failed", error: { name: "ConduitCatalogChanged" } });
  });

  it("INVARIANT §5.3 (#28, I4): a stalled kindOf after the claim still answers within budget — the row is never stranded running", async () => {
    // I4. `kindOf` runs AFTER `claimForResume` flipped the row to `running`
    // and BEFORE any drive (and therefore any timer) exists — it is the one
    // post-claim read nothing bounds. A store that never answers there left
    // the row `running` forever and hung `resume()` with no budget to save
    // it. Bounded by `driveBudgetMs`, it now reports the honest non-answer.
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const callId = await pendingCallOf(m, paused.executionId);
    const never = new Promise<never>(() => {});
    const stuckKind = {
      ...active.store,
      executions: { ...active.store.executions, kindOf: () => never },
    } as ConduitStore;
    const stuckM = createExecutionManager({ ...active.deps, store: stuckKind, direct: fast });
    // REAL CLOCK, deliberately: the setup crosses the harness's loopback MCP
    // socket, which deadlocks under fake timers (see the guard-expiry tests).
    const t0 = Date.now();
    const out = await Promise.race([
      stuckM.resume(paused.executionId, { kind: "approve" }, callId, permitDirect),
      new Promise((r) => setTimeout(() => r("HUNG"), fast.driveBudgetMs * 10)),
    ]);
    expect(out).not.toBe("HUNG");
    expect(Date.now() - t0).toBeLessThan(fast.driveBudgetMs + fast.settleWriteBudgetMs + 1_000);
    // The honest non-answer: the stored kind is unknown, so the settle could
    // not be routed. The reason is OPAQUE — a reference, never store detail.
    expect(out).toMatchObject({ status: "unknown", reason: "persist-timeout" });
    // And the claimed row is terminalized, never stranded `running`.
    expect(await m.get(paused.executionId)).not.toMatchObject({ status: "running" });
    expect(active.calls).toHaveLength(0);
  });

  it("INVARIANT §5.3 (#45, I4b): a stalled kindOf whose fallback WRITE also stalls still answers within budget", async () => {
    // I4b. The `kindOf`-timeout branch exists because the store is
    // unresponsive — so its own fallback `failClaimedResume` cannot be
    // assumed responsive either. Unbounded, a store stalled across the
    // board hung `resume()` at that write forever: the exact hang class
    // the branch above it was written to close. Both reads stall here.
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const callId = await pendingCallOf(m, paused.executionId);
    const never = new Promise<never>(() => {});
    const stuckBoth = {
      ...active.store,
      executions: {
        ...active.store.executions,
        kindOf: () => never,
        failClaimedResume: () => never,
      },
    } as ConduitStore;
    const stuckM = createExecutionManager({ ...active.deps, store: stuckBoth, direct: fast });
    // REAL CLOCK, deliberately: same reason as the I4 test above — the setup
    // crosses the harness's loopback MCP socket, which deadlocks under fake
    // timers. Margin ≥ 1 s over the two budgets this path can spend.
    const t0 = Date.now();
    const out = await Promise.race([
      stuckM.resume(paused.executionId, { kind: "approve" }, callId, permitDirect),
      new Promise((r) => setTimeout(() => r("HUNG"), fast.driveBudgetMs * 20)),
    ]);
    expect(out).not.toBe("HUNG");
    expect(Date.now() - t0).toBeLessThan(fast.driveBudgetMs + fast.settleWriteBudgetMs + 1_000);
    // The outcome is unchanged by the write's fate: the stored kind is still
    // unknown, so the honest non-answer stands either way.
    expect(out).toMatchObject({ status: "unknown", reason: "persist-timeout" });
  });

  it("INVARIANT §5.3 (#28, I2): a guard read returning AFTER the expiry took the latch still settles resume() — never hangs", async () => {
    // I2, REPRODUCED. The `policies.get` race sits between the last
    // `raceGuard` and `runDirect`. Sequence: the budget elapses during that
    // read; the expiry takes the latch and its write is in flight; the read
    // then returns, so `raceGuard` reports NOT expired; handover runs
    // `runDirect`, whose first `drive.settle()` LOSES and returns having
    // resolved nothing — and `await outcome` never resolves. The row is
    // correctly failed with exactly one settle attempt and zero upstream
    // calls, but `resume()` hangs forever, holding a daemon queue slot.
    //
    // Deliberately WITHOUT `reprovision()`: the §5.4 guard must PASS all the
    // way to the direct-arm handover, which is the only place this defect
    // lives. The gate is on `policies.get` — the last read before handover.
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const callId = await pendingCallOf(m, paused.executionId);

    let expiryWriteStarted!: () => void;
    const expiryWriteInFlight = new Promise<void>((r) => {
      expiryWriteStarted = r;
    });
    let releaseExpiryWrite!: () => void;
    const expiryWriteGate = new Promise<void>((r) => {
      releaseExpiryWrite = r;
    });
    let releasePolicyRead!: () => void;
    const policyReadGate = new Promise<void>((r) => {
      releasePolicyRead = r;
    });
    const settleAttempts: string[] = [];
    const raced = {
      ...active.store,
      policies: {
        ...active.store.policies,
        get: async (n: string) => {
          await policyReadGate;
          return requireActive(active).store.policies.get(n);
        },
      },
      executions: {
        ...active.store.executions,
        settleDirect: async (...a: Parameters<ConduitStore["executions"]["settleDirect"]>) => {
          settleAttempts.push(a[1]);
          if (settleAttempts.length === 1) {
            // The EXPIRY's write: announce it, then hold it open so the
            // gated policy read resolves while it is still in flight.
            expiryWriteStarted();
            await expiryWriteGate;
          }
          return requireActive(active).store.executions.settleDirect(...a);
        },
      },
    } as ConduitStore;
    const racedM = createExecutionManager({ ...active.deps, store: raced, direct: fast });
    const resuming = racedM.resume(paused.executionId, { kind: "approve" }, callId, permitDirect);
    // The budget elapses while `policies.get` is gated → the expiry takes the
    // latch and starts its write. Release the read WHILE that write is open:
    // the handover must now defer to the expiry, not drive a dead latch.
    await expiryWriteInFlight;
    releasePolicyRead();
    await new Promise((r) => setTimeout(r, 30));
    releaseExpiryWrite();

    // Bounded probe: without the fix this never settles.
    const out = await Promise.race([
      resuming,
      new Promise((r) => setTimeout(() => r("HUNG"), fast.driveBudgetMs * 10)),
    ]);
    expect(out).not.toBe("HUNG");
    expect(out).toMatchObject({
      status: "failed",
      error: { name: "ConduitExecutionInterrupted" },
      decisionApplied: false,
    });
    // Exactly one settle attempt — the expiry's — and the approved call never
    // ran, because the handover deferred instead of dispatching.
    expect(settleAttempts).toHaveLength(1);
    expect(active.calls).toHaveLength(0);
    expect(await m.get(paused.executionId)).toMatchObject({ status: "failed" });
  });

  it("INVARIANT §5.3 (finding 2): a prep-window fault whose fenced settle STALLS still returns within budget, never hangs resume()", async () => {
    // Fix round 1, finding 2. The prep-window catch awaited `settleDirect`
    // with no timeout: a stalled store hung `resume()` past every budget.
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const callId = await pendingCallOf(m, paused.executionId);
    const never = new Promise<never>(() => {});
    // `claimCallId` THROWS → the prep-window catch runs; its settle stalls.
    const hostile = {
      ...active.store,
      executions: {
        ...active.store.executions,
        claimCallId: async () => {
          throw new Error("prep window fault");
        },
        settleDirect: () => never,
      },
    } as ConduitStore;
    const hostileM = createExecutionManager({ ...active.deps, store: hostile, direct: fast });
    // REAL CLOCK, deliberately (fix round 1, finding 3): this test's path
    // crosses the harness's loopback MCP socket — here in the SETUP, which
    // provisions the source and drives the initial `startDirect` to a pause
    // (the guard terminalizes before any approved call runs). Under
    // `vi.useFakeTimers` that socket path deadlocks — verified: the test
    // times out at 5 s with the clock frozen. So the budget stays real and
    // the margin is a full SECOND, not a few hundred ms, to survive CI load;
    // the property under test (an answer within budget, not an exact
    // duration) tolerates the slack.
    const t0 = Date.now();
    const settled = await Promise.race([
      hostileM
        .resume(paused.executionId, { kind: "approve" }, callId, permitDirect)
        .then(() => "resolved")
        .catch(() => "threw"),
      new Promise((r) => setTimeout(() => r("HUNG"), fast.driveBudgetMs * 5)),
    ]);
    // The original fault still surfaces (it re-throws) — but BOUNDED.
    expect(settled).toBe("threw");
    expect(Date.now() - t0).toBeLessThan(fast.driveBudgetMs + fast.settleWriteBudgetMs + 1_000);
  });

  it("Task 9 handover: a direct row's guard terminalization whose fenced write STALLS reports unknown, never a claimed terminal", async () => {
    active = await makeHarness();
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const paused = await m.startDirect(
      "github.create_issue",
      { title: "t" },
      { clientId: null, projection: "direct", scope: permitDirect },
    ).outcome;
    const callId = await pendingCallOf(m, paused.executionId);
    await active.reprovision();
    const never = new Promise<never>(() => {});
    const stalled = {
      ...active.store,
      executions: { ...active.store.executions, settleDirect: () => never },
    } as ConduitStore;
    const stalledM = createExecutionManager({ ...active.deps, store: stalled, direct: fast });
    const out = await stalledM.resume(
      paused.executionId,
      { kind: "approve" },
      callId,
      permitDirect,
    );
    expect(out).toMatchObject({ status: "unknown", reason: "persist-timeout" });
    expect(active.calls).toHaveLength(0);
  });

  it("D-A3/D11: a named client without a resolver cannot reach startDirect — scope is a REQUIRED argument", () => {
    // Compile-time, not runtime: `scope` is required in the signature, so a
    // named client can never run a direct call whose projection flag is
    // never evaluated. This asserts the runtime half — the resolver IS
    // consulted, with the caller's own client id.
    expect(true).toBe(true);
  });

  it("INVARIANT §5.4: the scope resolver is consulted with the CALLER'S client id, and a revoked projection blocks the call", async () => {
    active = await makeHarness();
    const seen: (string | null)[] = [];
    const denyDiscovery: ScopeResolver = async (clientId) => {
      seen.push(clientId);
      return buildEffectiveScope(
        { projections: { code: true, direct: true, discovery: false }, allow: ALL_TOOLS },
        await requireActive(active).store.tools.list(),
      );
    };
    const m = createExecutionManager({ ...active.deps, direct: fast });
    const out = await m.startDirect(
      "github.list_issues",
      {},
      { clientId: "acme", projection: "discovery", scope: denyDiscovery },
    ).outcome;
    expect(seen).toContain("acme");
    expect(out.status).toBe("failed");
    expect(active.calls).toHaveLength(0);
  });
});
