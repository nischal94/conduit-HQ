import { describe, expect, it } from "vitest";
import type { SearchHit, ToolDescription } from "../catalog.js";
import { QuickJSSandbox } from "./quickjs.js";
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
