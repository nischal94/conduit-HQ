import type { QuickJSContext, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten";
import { getQuickJS } from "quickjs-emscripten";
import type {
  ExecutionRequest,
  ExecutionSeeds,
  JournalEntry,
  Sandbox,
  SandboxError,
  SandboxLimits,
  SandboxResult,
} from "./sandbox.js";
import { DEFAULT_SANDBOX_LIMITS, generateSeeds } from "./sandbox.js";

/**
 * QuickJS sandbox (spec §16, §20) on quickjs-emscripten's plain SYNC
 * build, with tool-call suspension by deterministic replay (spec §5.5):
 *
 *   run the code → an un-journaled `tools.*` call aborts the run →
 *   perform the call host-side while the VM is idle → journal the
 *   result → re-run from the top; journaled calls return memoized
 *   results; execution proceeds live from the first un-journaled call.
 *
 * Why not the ASYNCIFY build's async host functions: in
 * quickjs-emscripten 0.31.0, a pending job (any `await` continuation)
 * that calls an asyncified host function suspends inside the synchronous
 * `executePendingJobs` FFI call, whose wrapper then reads unwound stack
 * garbage — heap corruption, not an error. There is no suspension-aware
 * job pump in the library. Replay avoids the entire class: the sync
 * build cannot suspend, and no VM ever waits on the host. It is also
 * what §5.5 demands anyway — a paused Execution must be pure data
 * (code + seeds + journal) that survives restarts, which a suspended
 * WASM stack never could.
 *
 * One context per run, one runtime per context: no state shared between
 * runs beyond the journal, which is host-owned data.
 *
 * Everything that crosses the membrane is a JSON string. That keeps the
 * marshalling surface auditable for the §9.2 credential boundary: the
 * host never has a channel through which a live object — or a secret —
 * could be handed into the sandbox heap.
 */
export class QuickJSSandbox implements Sandbox {
  async execute(request: ExecutionRequest): Promise<SandboxResult> {
    const limits: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...request.limits };
    const seeds = request.seeds ?? generateSeeds();
    if (!Number.isFinite(seeds.now) || !Number.isFinite(seeds.random)) {
      throw new RangeError(
        `[QuickJSSandbox] Invalid seeds: now/random must be finite numbers. Context: ${JSON.stringify(seeds)}`,
      );
    }

    const quickjs = await getQuickJS();
    const journal: JournalEntry[] = [...(request.journal ?? [])];
    const deadline = Date.now() + limits.wallClockMs;

    while (true) {
      const run = runOnce(quickjs, request.code, seeds, journal, limits, deadline);
      if (run.status !== "suspended") {
        return { ...run, seeds, journal };
      }
      // Tool-call boundary (spec §5.3 / §5.5): the VM is gone; the host
      // performs the call and the journal memoizes it for the replay.
      journal.push(await perform(request.tools, run.pending));
      if (Date.now() >= deadline) {
        return { status: "interrupted", reason: "wall_clock", seeds, journal };
      }
    }
  }
}

/** The § 5.5 suspension point: which bridge op the guest is waiting on. */
interface PendingToolCall {
  op: JournalEntry["op"];
  request: string;
}

type RunOutcome =
  | { status: "completed"; value: unknown }
  | { status: "failed"; error: SandboxError }
  | { status: "interrupted"; reason: "wall_clock" | "memory" | "output_size" }
  | { status: "suspended"; pending: PendingToolCall };

/**
 * One deterministic guest run against the journal. Fully synchronous:
 * the sync build's host functions cannot suspend, so pumping pending
 * jobs here is always safe.
 */
function runOnce(
  quickjs: QuickJSWASMModule,
  code: string,
  seeds: ExecutionSeeds,
  journal: readonly JournalEntry[],
  limits: SandboxLimits,
  deadline: number,
): RunOutcome {
  const runtime = quickjs.newRuntime();
  const context = runtime.newContext();

  // Host-side truth about how the run ended. Guest code cannot fake
  // these: a thrown look-alike error changes neither flag.
  let suspendRequested: PendingToolCall | undefined;
  let nondeterminism: string | undefined;
  let wallClockTripped = false;

  runtime.setInterruptHandler(() => {
    // Once suspension or a determinism fault is flagged, the run's
    // remaining work is garbage — kill it even if the guest caught the
    // sentinel exception. Interrupts cannot be caught in the sandbox.
    if (suspendRequested !== undefined || nondeterminism !== undefined) {
      return true;
    }
    if (Date.now() >= deadline) {
      wallClockTripped = true;
      return true;
    }
    return false;
  });
  runtime.setMemoryLimit(limits.memoryBytes);

  try {
    let cursor = 0;
    const bridge = context.newFunction("__conduit_host", (opHandle, payloadHandle) => {
      if (suspendRequested !== undefined || nondeterminism !== undefined) {
        throw suspendSentinel();
      }
      const op = context.getString(opHandle) as JournalEntry["op"];
      const payload = context.getString(payloadHandle);
      const entry = journal[cursor];
      if (entry !== undefined) {
        if (entry.op !== op || entry.request !== payload) {
          nondeterminism =
            `replay diverged at call #${cursor}: journaled ${entry.op}(${entry.request}), ` +
            `code emitted ${op}(${payload})`;
          throw suspendSentinel();
        }
        cursor += 1;
        return context.newString(JSON.stringify(entry.outcome));
      }
      suspendRequested = { op, request: payload };
      throw suspendSentinel();
    });
    bridge.consume((handle) => context.setProp(context.global, "__conduit_host", handle));

    const bootResult = context.evalCode(bootstrapSource(seeds), "bootstrap.js");
    if (bootResult.error) {
      const detail: unknown = context.dump(bootResult.error);
      bootResult.error.dispose();
      throw new Error(
        `[QuickJSSandbox] Bootstrap failed: sandbox prelude threw. Context: ${JSON.stringify(detail)}`,
      );
    }
    bootResult.value.dispose();

    const outcome = drive(context, runtime, code);
    if (suspendRequested !== undefined) {
      return { status: "suspended", pending: suspendRequested };
    }
    if (nondeterminism !== undefined) {
      return {
        status: "failed",
        error: {
          name: "NondeterministicExecutionError",
          message: `[QuickJSSandbox] Replay failed: ${nondeterminism}. Code must be deterministic between tool calls (spec §5.5).`,
        },
      };
    }
    if (outcome.kind === "error") {
      if (wallClockTripped) {
        return { status: "interrupted", reason: "wall_clock" };
      }
      if (
        outcome.error.name === "InternalError" &&
        outcome.error.message.includes("out of memory")
      ) {
        return { status: "interrupted", reason: "memory" };
      }
      return { status: "failed", error: outcome.error };
    }
    if (outcome.kind === "stalled" || wallClockTripped) {
      return { status: "interrupted", reason: "wall_clock" };
    }
    return capOutput(outcome.value, limits);
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

type DriveOutcome =
  | { kind: "value"; value: unknown }
  | { kind: "error"; error: SandboxError }
  | { kind: "stalled" };

/** Evaluate the wrapped code and pump jobs until its promise settles. */
function drive(context: QuickJSContext, runtime: QuickJSRuntime, code: string): DriveOutcome {
  const evalResult = context.evalCode(`(async () => {\n${code}\n})()`, "execution.js");
  if (evalResult.error) {
    const detail: unknown = context.dump(evalResult.error);
    evalResult.error.dispose();
    return { kind: "error", error: toSandboxError(detail) };
  }
  const promiseHandle = evalResult.value;
  try {
    while (true) {
      const state = context.getPromiseState(promiseHandle);
      if (state.type === "fulfilled") {
        const value: unknown = context.dump(state.value);
        if (state.notAPromise !== true) {
          state.value.dispose();
        }
        return { kind: "value", value };
      }
      if (state.type === "rejected") {
        const detail: unknown = context.dump(state.error);
        state.error.dispose();
        return { kind: "error", error: toSandboxError(detail) };
      }
      if (!runtime.hasPendingJob()) {
        // Nothing can ever settle this promise: the sync build has no
        // host-driven wakeups. `await new Promise(() => {})` lands here.
        return { kind: "stalled" };
      }
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        const detail: unknown = context.dump(jobs.error);
        jobs.error.dispose();
        return { kind: "error", error: toSandboxError(detail) };
      }
    }
  } finally {
    promiseHandle.dispose();
  }
}

/** Perform one tool call host-side and reduce it to a journal entry. */
async function perform(
  tools: ExecutionRequest["tools"],
  pending: PendingToolCall,
): Promise<JournalEntry> {
  const base = { op: pending.op, request: pending.request };
  try {
    const payload: unknown = JSON.parse(pending.request);
    const value = await dispatchOp(tools, pending.op, payload);
    return { ...base, outcome: { ok: true, value: value === undefined ? null : value } };
  } catch (error) {
    return { ...base, outcome: { ok: false, error: toSandboxError(error) } };
  }
}

async function dispatchOp(
  tools: ExecutionRequest["tools"],
  op: JournalEntry["op"],
  payload: unknown,
): Promise<unknown> {
  switch (op) {
    case "search": {
      const options = payload as { query: string; limit?: number };
      return tools.search(options);
    }
    case "describe": {
      const options = payload as { path: string; includeSchemas?: boolean };
      return tools.describe(
        options.path,
        options.includeSchemas === true ? { includeSchemas: true } : {},
      );
    }
    case "call": {
      const options = payload as { path: string; input: unknown };
      return tools.call(options.path, options.input);
    }
  }
}

function capOutput(value: unknown, limits: SandboxLimits): RunOutcome {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    return { status: "failed", error: toSandboxError(error) };
  }
  const bytes = serialized === undefined ? 0 : new TextEncoder().encode(serialized).length;
  if (bytes > limits.maxOutputBytes) {
    return { status: "interrupted", reason: "output_size" };
  }
  return { status: "completed", value };
}

/**
 * The guest-visible face of a suspension. Its identity carries no
 * authority — the host trusts only its own flags — so guest code that
 * fakes or swallows one changes nothing.
 */
function suspendSentinel(): Error {
  const error = new Error("execution suspended at tool-call boundary");
  error.name = "ConduitSuspend";
  return error;
}

function toSandboxError(detail: unknown): SandboxError {
  if (detail instanceof Error) {
    return { name: detail.name, message: detail.message };
  }
  if (typeof detail === "object" && detail !== null) {
    const record = detail as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : "Error",
      message: typeof record.message === "string" ? record.message : JSON.stringify(detail),
    };
  }
  return { name: "Error", message: String(detail) };
}

/**
 * Guest prelude. Interpolation is numbers-only (validated finite), so no
 * code can be injected through it.
 *
 * - `Math.random()` — mulberry32 over `seeds.random`: the recorded seed
 *   replays the exact sequence (spec §5.5).
 * - `Date.now()` — `seeds.now` plus a 1ms-per-call tick: deterministic,
 *   monotonic, replayable. Only `Date.now` is pinned; the spec names
 *   exactly `Date.now()` and `Math.random()` as the enforced boundary.
 * - `tools` — search/describe verbs plus a path proxy, so both
 *   `tools["github.issues.list"](input)` and typed-style
 *   `tools.github.issues.list(input)` resolve to the same bridge call.
 *   Search returns `{ items }` to match the spec §6 workflow shape.
 *   Results come back synchronously (journaled), but every verb returns
 *   a value the spec's `await`-based workflow consumes unchanged.
 */
function bootstrapSource(seeds: ExecutionSeeds): string {
  return `
(function bootstrap() {
  "use strict";
  var host = globalThis.__conduit_host;
  delete globalThis.__conduit_host;

  var tick = 0;
  Date.now = function () { return ${seeds.now} + tick++; };

  var state = ${seeds.random} >>> 0;
  Math.random = function () {
    state = (state + 0x6d2b79f5) | 0;
    var t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  function bridge(op, payload) {
    var response = JSON.parse(host(op, JSON.stringify(payload === undefined ? null : payload)));
    if (!response.ok) {
      var error = new Error(response.error.message);
      error.name = response.error.name;
      throw error;
    }
    return response.value;
  }

  function pathProxy(path) {
    return new Proxy(function () {}, {
      get: function (_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return pathProxy(path + "." + prop);
      },
      apply: function (_target, _thisArg, args) {
        return bridge("call", { path: path, input: args.length > 0 ? args[0] : null });
      },
    });
  }

  var verbs = {
    search: function (options) {
      return { items: bridge("search", options) };
    },
    describe: {
      tool: function (options) {
        return bridge("describe", options);
      },
    },
  };

  Object.defineProperty(globalThis, "tools", {
    value: new Proxy(verbs, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== "string" || prop === "then") return undefined;
        return pathProxy(prop);
      },
    }),
    writable: false,
    configurable: false,
  });
})();
`;
}
