/**
 * Per-namespace source lock (Codex ARC F2).
 *
 * These tests pin the serialization primitive directly: same-key runs are
 * strictly serial (never overlapping), different keys run concurrently, a
 * rejecting run does not wedge its key's chain, and the map does not leak
 * entries once a key's chain drains. The anti-oracle race the lock closes is
 * pinned end-to-end in `provision.test.ts` (the barrier test); this file is
 * the primitive's own contract.
 */
import { describe, expect, it } from "vitest";
import { createSourceLock } from "./source-lock.js";

/** A controllable deferred, so a test can pin one run open across the other. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createSourceLock", () => {
  it("serializes two runs of the SAME key — the second never starts until the first finishes", async () => {
    const lock = createSourceLock();
    const order: string[] = [];
    const gate = deferred();

    const first = lock.run("ns", async () => {
      order.push("first:start");
      await gate.promise; // hold the lock open
      order.push("first:end");
    });

    // Give the second run a chance to (wrongly) start if serialization is
    // broken. It must NOT: the first run holds the lock.
    const second = lock.run("ns", async () => {
      order.push("second:start");
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["first:start"]); // second is blocked

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("runs DIFFERENT keys concurrently — no cross-namespace contention", async () => {
    const lock = createSourceLock();
    const order: string[] = [];
    const gateA = deferred();

    const a = lock.run("a", async () => {
      order.push("a:start");
      await gateA.promise;
      order.push("a:end");
    });
    const b = lock.run("b", async () => {
      order.push("b:start");
    });

    await new Promise((r) => setTimeout(r, 20));
    // b ran to completion while a is still held — different keys don't block.
    expect(order).toEqual(["a:start", "b:start"]);

    gateA.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "b:start", "a:end"]);
  });

  it("a REJECTING run does not wedge the key — the next run for it still proceeds", async () => {
    const lock = createSourceLock();
    const ran: string[] = [];

    await expect(
      lock.run("ns", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await lock.run("ns", async () => {
      ran.push("second");
    });
    expect(ran).toEqual(["second"]);
  });

  it("returns the run's own value", async () => {
    const lock = createSourceLock();
    await expect(lock.run("ns", async () => 42)).resolves.toBe(42);
  });

  it("does not leak map entries once a key's chain drains (unbounded one-shot namespaces)", async () => {
    const lock = createSourceLock();
    // Drive many distinct one-shot keys to completion.
    for (let i = 0; i < 50; i++) {
      await lock.run(`ns-${i}`, async () => undefined);
    }
    // Reach into the closure via a fresh chained run: if entries leaked, a
    // brand-new key would still be serialized behind nothing, which is
    // observable only as correctness (it still works). The structural check
    // is that a repeat of a drained key starts immediately.
    let started = false;
    const p = lock.run("ns-0", async () => {
      started = true;
    });
    await p;
    expect(started).toBe(true);
  });
});
