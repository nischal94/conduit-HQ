import type { ConduitStore, Execution } from "@conduithq/sdk";
import { openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { sweepOrphanedExecutions } from "./sweep.js";

/**
 * The crash-terminal sweep (design §3.5 "durable execution state after a
 * crash"). These are in-memory store tests: WHAT the sweep does to rows.
 * WHERE it runs in the startup order is a separate, already-pinned
 * property (`conduitd.test.ts`), and the end-to-end kill/restart proof
 * lives in `client.test.ts` with real processes.
 */

async function newStore(): Promise<ConduitStore> {
  return openSqliteStore({
    client: createClient({ url: ":memory:" }),
    secretBox: await SecretBox.fromKeyBytes(Buffer.alloc(32, 7)),
  });
}

const base: Omit<Execution, "id" | "status"> = {
  code: "return 1",
  seeds: { now: 1000, random: 0.5 },
  startedAt: 1000,
};

async function seed(store: ConduitStore, rows: Array<Pick<Execution, "id" | "status">>) {
  for (const row of rows) await store.executions.put({ ...base, ...row });
}

describe("sweepOrphanedExecutions", () => {
  it("INVARIANT §17: a running execution left by a killed daemon is terminalized, and nothing else is touched", async () => {
    const store = await newStore();
    await seed(store, [
      { id: "exec_running_a", status: "running" },
      { id: "exec_running_b", status: "running" },
      { id: "exec_paused", status: "paused" },
      { id: "exec_done", status: "completed" },
      { id: "exec_failed", status: "failed" },
      { id: "exec_expired", status: "expired" },
    ]);

    const swept = await sweepOrphanedExecutions(store);

    expect(swept).toBe(2);
    for (const id of ["exec_running_a", "exec_running_b"]) {
      const row = await store.executions.get(id);
      expect(row?.status).toBe("failed");
      // The row must carry WHY it is failed — a bare `failed` is
      // indistinguishable from an ordinary execution failure, and the
      // whole point is that this outcome is ambiguous, not observed.
      expect(row?.error?.name).toBe("ConduitOutcomeAmbiguous");
      expect(row?.endedAt).toBeTypeOf("number");
    }
    // Every non-running status is left exactly as it was: the sweep is a
    // recovery of provably-dead rows, not a general reconciliation pass.
    expect((await store.executions.get("exec_paused"))?.status).toBe("paused");
    expect((await store.executions.get("exec_done"))?.status).toBe("completed");
    expect((await store.executions.get("exec_failed"))?.status).toBe("failed");
    expect((await store.executions.get("exec_expired"))?.status).toBe("expired");
  });

  it("INVARIANT §17: the sweep never replays — the swept row's code is not re-executed and its result stays absent", async () => {
    const store = await newStore();
    await seed(store, [{ id: "exec_orphan", status: "running" }]);

    await sweepOrphanedExecutions(store);

    const row = await store.executions.get("exec_orphan");
    // A replay would have produced a result and a `completed` status.
    // Terminalizing without replay is the §3.5 requirement: the outcome
    // is unknown, and inventing one is worse than admitting it.
    expect(row?.status).toBe("failed");
    expect(row?.result ?? null).toBeNull();
  });

  it("is idempotent — a second sweep finds nothing, so an abandoned sweep can safely re-run", async () => {
    const store = await newStore();
    await seed(store, [{ id: "exec_orphan", status: "running" }]);

    expect(await sweepOrphanedExecutions(store)).toBe(1);
    expect(await sweepOrphanedExecutions(store)).toBe(0);
  });

  it("returns 0 and writes nothing on a clean database", async () => {
    const store = await newStore();
    await seed(store, [{ id: "exec_done", status: "completed" }]);
    expect(await sweepOrphanedExecutions(store)).toBe(0);
    expect((await store.executions.get("exec_done"))?.status).toBe("completed");
  });

  it("emits one log line per swept row, naming the execution", async () => {
    const store = await newStore();
    await seed(store, [
      { id: "exec_one", status: "running" },
      { id: "exec_two", status: "running" },
    ]);

    const lines: string[] = [];
    await sweepOrphanedExecutions(store, (line) => lines.push(line));

    const perRow = lines.filter((line) => line.includes("execution terminalized"));
    expect(perRow).toHaveLength(2);
    expect(perRow[0]).toContain("exec_one");
    expect(perRow[1]).toContain("exec_two");
    // Plus a single summary line, so an operator scanning the log sees the
    // total without counting rows.
    expect(lines.filter((line) => line.includes("sweep complete"))).toHaveLength(1);
  });
});
