import { afterEach, describe, expect, it } from "vitest";
import type { SearchHit, ToolDescription } from "../catalog.js";
import {
  isHostStackOverflow,
  moduleRecoveries,
  QuickJSSandbox,
  setSandboxDiagnostic,
} from "./quickjs.js";
import type { ToolHost } from "./sandbox.js";

const NOOP_HOST: ToolHost = {
  search: async () => [],
  describe: async () => undefined,
  call: async () => null,
};

// A host whose every verb throws if reached — for tests that must make
// no tool calls, so a stray call fails loudly instead of silently.
const THROWING_HOST: ToolHost = {
  search: async () => {
    throw new Error("THROWING_HOST.search must not be called");
  },
  describe: async () => {
    throw new Error("THROWING_HOST.describe must not be called");
  },
  call: async () => {
    throw new Error("THROWING_HOST.call must not be called");
  },
};

function recordingHost(overrides: Partial<ToolHost> = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const host: ToolHost = {
    search: async (options) => {
      calls.push({ op: "search", args: [options] });
      return (await overrides.search?.(options)) ?? [];
    },
    describe: async (path, options) => {
      calls.push({ op: "describe", args: [path, options] });
      return overrides.describe?.(path, options);
    },
    call: async (path, input) => {
      calls.push({ op: "call", args: [path, input] });
      return (await overrides.call?.(path, input)) ?? null;
    },
  };
  return { host, calls };
}

const sandbox = new QuickJSSandbox();

describe("QuickJSSandbox", () => {
  describe("execution", () => {
    it("runs code as an async function body and returns its return value", async () => {
      const result = await sandbox.execute({
        code: "const x = 40; return x + 2;",
        tools: NOOP_HOST,
      });
      expect(result).toMatchObject({ status: "completed", value: 42 });
    });

    it("marshals structured return values as plain data", async () => {
      const result = await sandbox.execute({
        code: 'return { list: [1, "two", null], nested: { ok: true } };',
        tools: NOOP_HOST,
      });
      expect(result).toMatchObject({
        status: "completed",
        value: { list: [1, "two", null], nested: { ok: true } },
      });
    });

    it("reports guest exceptions as failed with plain error data", async () => {
      const result = await sandbox.execute({
        code: 'throw new TypeError("boom");',
        tools: NOOP_HOST,
      });
      expect(result).toMatchObject({
        status: "failed",
        error: { name: "TypeError", message: "boom" },
      });
    });
  });

  describe("tools bridge", () => {
    it("routes tools.search and returns the spec §6 { items } shape", async () => {
      const hits: SearchHit[] = [{ path: "github.issues.list", riskClass: "safe", score: 3 }];
      const { host, calls } = recordingHost({ search: async () => hits });
      const result = await sandbox.execute({
        code: `
          const { items } = await tools.search({ query: "list issues", limit: 5 });
          return items[0].path;
        `,
        tools: host,
      });
      expect(result).toMatchObject({ status: "completed", value: "github.issues.list" });
      expect(calls).toEqual([{ op: "search", args: [{ query: "list issues", limit: 5 }] }]);
    });

    it("routes tools.describe.tool with lazy schema loading", async () => {
      const description: ToolDescription = {
        path: "github.issues.list",
        namespace: "github",
        riskClass: "safe",
        inputSchema: { type: "object" },
        outputSchema: {},
      };
      const { host, calls } = recordingHost({ describe: async () => description });
      const result = await sandbox.execute({
        code: `
          const details = await tools.describe.tool({ path: "github.issues.list", includeSchemas: true });
          return details.inputSchema.type;
        `,
        tools: host,
      });
      expect(result).toMatchObject({ status: "completed", value: "object" });
      expect(calls).toEqual([
        { op: "describe", args: ["github.issues.list", { includeSchemas: true }] },
      ]);
    });

    it("invokes tools[path](input) by literal path string", async () => {
      const { host, calls } = recordingHost({ call: async () => ({ id: "re_1" }) });
      const result = await sandbox.execute({
        code: 'return await tools["stripe.refunds.create"]({ charge: "ch_1" });',
        tools: host,
      });
      expect(result).toMatchObject({ status: "completed", value: { id: "re_1" } });
      expect(calls).toEqual([{ op: "call", args: ["stripe.refunds.create", { charge: "ch_1" }] }]);
    });

    it("invokes typed dotted-path calls, e.g. tools.github.issues.list(input)", async () => {
      const { host, calls } = recordingHost({ call: async () => [] });
      const result = await sandbox.execute({
        code: 'return await tools.github.issues.list({ owner: "acme", repo: "site" });',
        tools: host,
      });
      expect(result).toMatchObject({ status: "completed", value: [] });
      expect(calls).toEqual([
        { op: "call", args: ["github.issues.list", { owner: "acme", repo: "site" }] },
      ]);
    });

    it("rethrows host-side failures as catchable guest errors", async () => {
      const { host } = recordingHost({
        call: async () => {
          const error = new Error("blocked by policy");
          error.name = "PolicyError";
          throw error;
        },
      });
      const result = await sandbox.execute({
        code: `
          try {
            await tools.github.issues.create({ title: "x" });
            return "unreachable";
          } catch (error) {
            return error.name + ": " + error.message;
          }
        `,
        tools: host,
      });
      expect(result).toMatchObject({
        status: "completed",
        value: "PolicyError: blocked by policy",
      });
    });
  });

  describe("resource limits (spec §16)", () => {
    it("INVARIANT §16: a runaway while(true) is interrupted at the wall clock, not babysat", async () => {
      const result = await sandbox.execute({
        code: "while (true) {}",
        tools: NOOP_HOST,
        limits: { wallClockMs: 150 },
      });
      expect(result).toMatchObject({ status: "interrupted", reason: "wall_clock" });
    });

    it("INVARIANT §16: a runaway loop after an await is still interrupted", async () => {
      const { host } = recordingHost({ call: async () => null });
      const result = await sandbox.execute({
        code: "await tools.noop.tick({}); while (true) {}",
        tools: host,
        limits: { wallClockMs: 200 },
      });
      expect(result).toMatchObject({ status: "interrupted", reason: "wall_clock" });
    });

    it("INVARIANT §16: a never-settling await cannot outlive the wall clock", async () => {
      const result = await sandbox.execute({
        code: "await new Promise(() => {});",
        tools: NOOP_HOST,
        limits: { wallClockMs: 150 },
      });
      expect(result).toMatchObject({ status: "interrupted", reason: "wall_clock" });
    });

    it("INVARIANT §16: allocation past the memory ceiling is interrupted", async () => {
      const result = await sandbox.execute({
        code: 'let s = "x"; while (true) { s += s; }',
        tools: NOOP_HOST,
        limits: { memoryBytes: 8 * 1024 * 1024, wallClockMs: 5_000 },
      });
      expect(result).toMatchObject({ status: "interrupted", reason: "memory" });
    });

    it("INVARIANT §16: output past the serialized-size cap is interrupted", async () => {
      const result = await sandbox.execute({
        code: 'return "x".repeat(100_000);',
        tools: NOOP_HOST,
        limits: { maxOutputBytes: 1024 },
      });
      expect(result).toMatchObject({ status: "interrupted", reason: "output_size" });
    });

    it("INVARIANT §16: a pathologically deep source literal fails cleanly, never crashes the host", async () => {
      // A guest literal nested deep enough to overflow the host stack while
      // the WASM engine parses it (gate-two finding #1). The throw must be
      // caught inside the sandbox and surfaced as a `failed` result — NOT
      // propagate out of execute() as an opaque host RangeError (which the
      // manager would raise to the agent as an internal error). Depth is set
      // far past the overflow threshold (~500 here) so the test is robust to
      // host-stack size differences across environments; at this depth the
      // fault is guaranteed at parse OR at the return-value dump.
      let deep = "0";
      for (let i = 0; i < 100_000; i++) deep = `[${deep}]`;
      const result = await sandbox.execute({
        code: `return ${deep};`,
        tools: NOOP_HOST,
      });
      expect(result.status).toBe("failed");
    });

    it("INVARIANT §16: a pathologically deep RETURN value fails cleanly, never crashes the host", async () => {
      // The overflow can also strike when dumping a deep value back to the
      // host (context.dump), not only at parse. The value is BUILT in the
      // guest (a shallow source that loops), so this exercises the dump path
      // specifically. Same guarantee: `failed`, not a thrown host error.
      const result = await sandbox.execute({
        code: "let d = { v: 0 }; for (let i = 0; i < 100000; i++) d = { n: d }; return d;",
        tools: NOOP_HOST,
      });
      expect(result.status).toBe("failed");
    });
  });

  // Gate-two DoS fix: a host-stack overflow abandons QuickJS objects, so the
  // shared WASM module accumulates damage and would eventually fail to
  // bootstrap for EVERY execution. These pin that a detected overflow rebuilds
  // the module, so repeated pathological executions can never poison a later
  // one — while ordinary faults neither poison nor trigger a rebuild.
  describe("shared-module recovery after host-stack overflow (spec §16 DoS)", () => {
    // Depth far past the overflow threshold (~500 in this vitest worker) so it
    // reliably faults, but small enough that a 150-iteration stress loop —
    // each iteration rebuilds the module — stays well under its timeout. The
    // single-shot robustness tests above use 100k for stack-size independence;
    // these repetition tests only need a reliable fault in-environment.
    const OVERFLOW = "let x = { v: 0 }; for (let i = 0; i < 20000; i++) x = { n: x }; return x;";
    // The old (unfixed) module poisoned at ~101 accumulated overflows, so a
    // count comfortably past that is what proves the rebuild prevents it.
    const PAST_POISON_THRESHOLD = 150;
    // 90s: the 150-iteration loops run ~20s alone but have hit 30s+ under
    // full-suite parallel load; the margin bounds a hang, not a slow pass.
    const STRESS_TIMEOUT_MS = 90_000;
    afterEach(() => setSandboxDiagnostic(undefined));

    it(
      "INVARIANT §16: sequential overflows past the old poison threshold cannot poison a later benign execution",
      async () => {
        const sandbox = new QuickJSSandbox();
        for (let n = 0; n < PAST_POISON_THRESHOLD; n++) {
          expect((await sandbox.execute({ code: OVERFLOW, tools: NOOP_HOST })).status).toBe(
            "failed",
          );
        }
        const benign = await sandbox.execute({ code: "return 1 + 1;", tools: NOOP_HOST });
        expect(benign).toMatchObject({ status: "completed", value: 2 });
      },
      STRESS_TIMEOUT_MS,
    );

    it("INVARIANT §16: a benign execution succeeds immediately after every overflow", async () => {
      const sandbox = new QuickJSSandbox();
      for (let n = 0; n < 25; n++) {
        expect((await sandbox.execute({ code: OVERFLOW, tools: NOOP_HOST })).status).toBe("failed");
        const benign = await sandbox.execute({ code: "return 42;", tools: NOOP_HOST });
        expect(benign).toMatchObject({ status: "completed", value: 42 });
      }
    });

    it(
      "INVARIANT §16: an overflow on one sandbox cannot poison a DIFFERENT instance (shared module)",
      async () => {
        const attacker = new QuickJSSandbox();
        const victim = new QuickJSSandbox();
        for (let n = 0; n < PAST_POISON_THRESHOLD; n++) {
          await attacker.execute({ code: OVERFLOW, tools: NOOP_HOST });
        }
        const benign = await victim.execute({ code: "return 7 * 6;", tools: NOOP_HOST });
        expect(benign).toMatchObject({ status: "completed", value: 42 });
      },
      STRESS_TIMEOUT_MS,
    );

    it(
      "INVARIANT §16: concurrent overflows PAST the poison threshold cannot fail an interleaved benign call",
      async () => {
        // Count is past the old ~101 accumulation threshold: several executions
        // awaiting one coalesced build all receive the same module, so without a
        // pre-run poison re-check the first overflow would doom the rest of the
        // burst (they hold a reference that gets poisoned then broken). Every
        // benign call in the burst must still complete correctly.
        const sandbox = new QuickJSSandbox();
        const results = await Promise.allSettled([
          ...Array.from({ length: PAST_POISON_THRESHOLD }, () =>
            sandbox.execute({ code: OVERFLOW, tools: NOOP_HOST }),
          ),
          ...Array.from({ length: 20 }, () =>
            sandbox.execute({ code: "return 7 * 6;", tools: NOOP_HOST }),
          ),
        ]);
        for (const r of results.slice(PAST_POISON_THRESHOLD)) {
          expect(r.status).toBe("fulfilled");
          if (r.status === "fulfilled") {
            expect(r.value).toMatchObject({ status: "completed", value: 42 });
          }
        }
        // No overflow rejected either — each settled as a clean `failed`.
        for (const r of results.slice(0, PAST_POISON_THRESHOLD)) {
          expect(r.status).toBe("fulfilled");
          if (r.status === "fulfilled") expect(r.value.status).toBe("failed");
        }
      },
      STRESS_TIMEOUT_MS,
    );

    it("INVARIANT §16: a throwing diagnostics sink cannot wedge module recovery", async () => {
      // Diagnostics are observability, never control flow: a buggy operator
      // logger that throws must not break poison/rebuild.
      setSandboxDiagnostic(() => {
        throw new Error("logger unavailable");
      });
      const sandbox = new QuickJSSandbox();
      expect((await sandbox.execute({ code: OVERFLOW, tools: NOOP_HOST })).status).toBe("failed");
      // Recovery still happens despite every diagnostic call throwing.
      expect(await sandbox.execute({ code: "return 1;", tools: NOOP_HOST })).toMatchObject({
        status: "completed",
        value: 1,
      });
    });

    it(
      "INVARIANT §16: module recoveries are bounded — coalesced, not one per benign call",
      async () => {
        const sandbox = new QuickJSSandbox();
        const before = moduleRecoveries();
        for (let n = 0; n < 30; n++) {
          await sandbox.execute({ code: OVERFLOW, tools: NOOP_HOST });
          await sandbox.execute({ code: "return 1;", tools: NOOP_HOST });
        }
        const recoveries = moduleRecoveries() - before;
        // Each overflow triggers at most one rebuild; benign calls trigger none.
        // So recoveries stay ≤ the overflow count (never grow with total calls).
        expect(recoveries).toBeGreaterThan(0);
        expect(recoveries).toBeLessThanOrEqual(30);
      },
      STRESS_TIMEOUT_MS,
    );

    it("INVARIANT §16: the recovery path emits operator-visible diagnostics (no guest code)", async () => {
      const events: string[] = [];
      setSandboxDiagnostic((event, detail) => {
        events.push(event);
        // Diagnostics must never carry guest code or values.
        expect(JSON.stringify(detail ?? {})).not.toContain("n:");
      });
      const sandbox = new QuickJSSandbox();
      await sandbox.execute({ code: OVERFLOW, tools: NOOP_HOST });
      await sandbox.execute({ code: "return 1;", tools: NOOP_HOST }); // triggers the rebuild
      expect(events).toContain("sandbox.module.poisoned");
      expect(events).toContain("sandbox.module.recovery.ok");
    });

    it("INVARIANT §16: only a host-stack overflow is classified poison-capable", () => {
      expect(isHostStackOverflow(new RangeError("Maximum call stack size exceeded"))).toBe(true);
      // A genuine engine defect of another shape must NOT be masked as guest
      // input — it stays an infra fault (re-thrown by drive()).
      expect(isHostStackOverflow(new RangeError("Invalid array length"))).toBe(false);
      expect(isHostStackOverflow(new TypeError("x is not a function"))).toBe(false);
      expect(isHostStackOverflow(new Error("boom"))).toBe(false);
      expect(isHostStackOverflow("not an error")).toBe(false);
    });
  });

  describe("determinism seeds (spec §5.5 groundwork)", () => {
    const probe = `
      const randoms = [Math.random(), Math.random(), Math.random()];
      const times = [Date.now(), Date.now()];
      return { randoms, times };
    `;

    it("replays Math.random and Date.now verbatim from recorded seeds", async () => {
      const seeds = { now: 1_700_000_000_000, random: 42 };
      const first = await sandbox.execute({ code: probe, tools: NOOP_HOST, seeds });
      const second = await sandbox.execute({ code: probe, tools: NOOP_HOST, seeds });
      expect(first.status).toBe("completed");
      expect(first).toEqual(second);
      expect(first.seeds).toEqual(seeds);
      if (first.status === "completed") {
        const value = first.value as { times: number[] };
        expect(value.times).toEqual([1_700_000_000_000, 1_700_000_000_001]);
      }
    });

    it("generates fresh seeds when none are supplied and returns them for recording", async () => {
      const result = await sandbox.execute({ code: probe, tools: NOOP_HOST });
      expect(result.status).toBe("completed");
      expect(Number.isFinite(result.seeds.now)).toBe(true);
      expect(Number.isFinite(result.seeds.random)).toBe(true);
      if (result.status === "completed") {
        const value = result.value as { times: number[] };
        expect(value.times[0]).toBe(result.seeds.now);
      }
    });
  });

  describe("deterministic replay (spec §5.5 groundwork)", () => {
    const seeds = { now: 1_700_000_000_000, random: 7 };

    it("journals tool calls in call order and returns the journal for recording", async () => {
      const { host } = recordingHost({
        search: async () => [{ path: "github.issues.list", riskClass: "safe", score: 3 }],
        call: async () => [{ id: 1 }],
      });
      const result = await sandbox.execute({
        code: `
          const { items } = await tools.search({ query: "issues" });
          return await tools[items[0].path]({ owner: "acme" });
        `,
        tools: host,
        seeds,
      });
      expect(result).toMatchObject({ status: "completed", value: [{ id: 1 }] });
      expect(result.journal.map((entry) => entry.op)).toEqual(["search", "call"]);
      expect(result.journal.every((entry) => entry.outcome.ok)).toBe(true);
    });

    it("replays journaled results verbatim without re-hitting the host", async () => {
      const code = 'return await tools.github.issues.list({ owner: "acme" });';
      const { host: firstHost, calls: firstCalls } = recordingHost({
        call: async () => ({ issues: 7 }),
      });
      const first = await sandbox.execute({ code, tools: firstHost, seeds });
      expect(first).toMatchObject({ status: "completed", value: { issues: 7 } });
      expect(firstCalls).toHaveLength(1);

      // A different host answering differently must not matter: the
      // journal, not upstream, is the source of truth on replay.
      const { host: replayHost, calls: replayCalls } = recordingHost({
        call: async () => ({ issues: 999 }),
      });
      const replay = await sandbox.execute({
        code,
        tools: replayHost,
        seeds: first.seeds,
        journal: first.journal,
      });
      expect(replay).toMatchObject({ status: "completed", value: { issues: 7 } });
      expect(replayCalls).toHaveLength(0);
    });

    it("fails as nondeterministic when the code diverges from its journal", async () => {
      const { host } = recordingHost({ call: async () => 1 });
      const first = await sandbox.execute({
        code: "return await tools.a.b({ x: 1 });",
        tools: host,
        seeds,
      });
      expect(first.status).toBe("completed");

      const diverged = await sandbox.execute({
        code: "return await tools.a.b({ x: 2 });",
        tools: NOOP_HOST,
        seeds: first.seeds,
        journal: first.journal,
      });
      expect(diverged).toMatchObject({
        status: "failed",
        error: { name: "NondeterministicExecutionError" },
      });
    });
  });

  describe("approval-pause suspension (spec §5.5)", () => {
    it("INVARIANT §5.5: a tool call that signals approval-pause suspends without journaling it", async () => {
      const tools: ToolHost = {
        search: async () => [{ path: "github.delete_repo", riskClass: "destructive", score: 1 }],
        describe: async () => ({
          path: "github.delete_repo",
          namespace: "github",
          riskClass: "destructive",
        }),
        call: async () => {
          const error = new Error("approval required");
          error.name = "ConduitApprovalPause";
          throw error;
        },
      };
      const result = await sandbox.execute({
        code: `const { items } = await tools.search({ query: "delete" }); return await tools[items[0].path]({ repo: "x" });`,
        tools,
      });
      expect(result.status).toBe("paused");
      if (result.status === "paused") {
        expect(result.pending.op).toBe("call");
        // the search IS journaled (prefix), the paused call is NOT
        expect(result.journal.map((entry) => entry.op)).toEqual(["search"]);
      }
    });
  });

  describe("new Date() determinism (spec §5.5)", () => {
    it("§5.5: new Date() is deterministic across replays (pinned like Date.now)", async () => {
      const code = "return new Date().getTime();";
      const seeds = { now: 1000, random: 5 };
      const r1 = await sandbox.execute({ code, tools: THROWING_HOST, seeds });
      const r2 = await sandbox.execute({ code, tools: THROWING_HOST, seeds });
      expect(r1.status).toBe("completed");
      expect(r2.status).toBe("completed");
      if (r1.status === "completed" && r2.status === "completed") {
        expect(r1.value).toEqual(r2.value);
        // Pinned to the seeded clock, not real wall-clock: the sole
        // `new Date()` call reads the seed's first tick.
        expect(r1.value).toBe(seeds.now);
      }
    });

    it("§5.5: Date() called as a function (no `new`) is pinned to the seeded clock across replays", async () => {
      // `Date()` without `new` returns a STRING of the current time. The real
      // one reads the wall clock — a guest branching on it could reach a
      // different first-live call on resume. It must route through the same
      // seeded clock so two runs with identical seeds behave identically.
      const code = "return typeof Date() === 'string' ? Date() : 'not-a-string';";
      const seeds = { now: 1000, random: 5 };
      const r1 = await sandbox.execute({ code, tools: THROWING_HOST, seeds });
      const r2 = await sandbox.execute({ code, tools: THROWING_HOST, seeds });
      expect(r1.status).toBe("completed");
      expect(r2.status).toBe("completed");
      if (r1.status === "completed" && r2.status === "completed") {
        // Identical across replays (the divergence this closes) AND derived
        // from the seeded clock, not the real wall clock. The exact toString
        // format is the engine's; what matters is that it renders the 1970
        // seed epoch, never "now". (QuickJS omits Node's timezone-name suffix,
        // so compare on the seeded year rather than byte-for-byte.)
        expect(r1.value).toEqual(r2.value);
        expect(r1.value).toContain("1970");
        expect(r1.value).not.toContain(`${new Date().getFullYear()}`);
      }
    });

    it("§5.5: parameterized new Date(y, m, d, ...) is unaffected by the pin", async () => {
      const result = await sandbox.execute({
        code: "return new Date(2020, 0, 15).getFullYear();",
        tools: THROWING_HOST,
        seeds: { now: 1000, random: 5 },
      });
      expect(result).toMatchObject({ status: "completed", value: 2020 });
    });
  });
});
