import { describe, expect, it, vi } from "vitest";
import { createDirectDrive, deliverableBytes } from "./direct.js";

describe("DirectDrive (row #28)", () => {
  it("settle() is taken exactly once", () => {
    const drive = createDirectDrive({
      executionId: "e",
      attempt: "a",
      now: Date.now,
      budgetMs: 10_000,
      onExpire: () => {},
    });
    expect(drive.settled).toBe(false);
    expect(drive.settle()).toBe(true);
    expect(drive.settle()).toBe(false);
    expect(drive.settled).toBe(true);
    drive.dispose();
  });

  it("onExpire fires once at the budget and never after settle()", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const drive = createDirectDrive({
        executionId: "e",
        attempt: "a",
        now: Date.now,
        budgetMs: 50,
        onExpire,
      });
      vi.advanceTimersByTime(49);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(200);
      expect(onExpire).toHaveBeenCalledTimes(1);
      drive.dispose();

      const settledFirst = createDirectDrive({
        executionId: "f",
        attempt: "a",
        now: Date.now,
        budgetMs: 50,
        onExpire,
      });
      settledFirst.settle();
      vi.advanceTimersByTime(100);
      expect(onExpire).toHaveBeenCalledTimes(1);
      settledFirst.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose() cancels the timer; deadline() counts down from construction", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const drive = createDirectDrive({
        executionId: "e",
        attempt: "a",
        now: Date.now,
        budgetMs: 50,
        onExpire,
      });
      vi.advanceTimersByTime(20);
      expect(drive.deadline()).toBe(30);
      drive.dispose();
      vi.advanceTimersByTime(100);
      expect(onExpire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("onExpire is read at FIRE time, so a drive built before its run can still settle it", () => {
    vi.useFakeTimers();
    try {
      const late = vi.fn();
      const drive = createDirectDrive({
        executionId: "e",
        attempt: "a",
        now: Date.now,
        budgetMs: 50,
      });
      drive.onExpire = late;
      vi.advanceTimersByTime(50);
      expect(late).toHaveBeenCalledTimes(1);
      drive.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishEarly() settles both lifecycle promises and cancels the timer", async () => {
    const onExpire = vi.fn();
    const drive = createDirectDrive({
      executionId: "e",
      attempt: "a",
      now: Date.now,
      budgetMs: 10_000,
      onExpire,
    });
    drive.finishEarly();
    await expect(drive.finished).resolves.toBeUndefined();
    await expect(drive.settledAt).resolves.toBeUndefined();
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("INVARIANT §5.3 (#28): deadline() is LATCH-AWARE — once settled it is <= 0 even with a frozen clock", () => {
    // I1. The budget timer runs on `setTimeout` while `deadline()` subtracts an
    // INJECTABLE `now()`: two clocks. If the timer fires (or any other settler
    // takes the latch) before `now()` reaches `end`, an un-latched `deadline()`
    // still reports budget remaining, and the invoker's pre-write gate
    // (`remaining <= 0`) passes — so a call can dispatch for an execution the
    // expiry has already published as "elapsed before dispatch". Under default
    // clocks that window is ~1 ms; with an injected clock it is the whole skew.
    // The latch is the authority, so it decides this too.
    const frozen = 1_000;
    const drive = createDirectDrive({
      executionId: "e",
      attempt: "a",
      now: () => frozen,
      budgetMs: 10_000,
      onExpire: () => {},
    });
    expect(drive.deadline()).toBe(10_000);
    expect(drive.settle()).toBe(true);
    expect(drive.deadline()).toBeLessThanOrEqual(0);
    drive.dispose();
  });

  it("INVARIANT §5.3 (#45, M1): settleEarly() starts RETENTION but leaves `finished` for the settle write", async () => {
    // M1 / D-A2. The guard exits that issue a settle WRITE must not resolve
    // `finished` — the write is still live work, and Lane B holds an admission
    // slot on `finished`. `settledAt` DOES resolve: the spec measures slot
    // retention from the moment the row is settled, not from the write's
    // completion, so retention must start here.
    const onExpire = vi.fn();
    const drive = createDirectDrive({
      executionId: "e",
      attempt: "a",
      now: Date.now,
      budgetMs: 10_000,
      onExpire,
    });
    let landWrite!: () => void;
    const write = new Promise<void>((r) => {
      landWrite = r;
    });
    drive.settle();
    drive.settleEarly();
    // Retention starts immediately.
    await expect(drive.settledAt).resolves.toBeUndefined();
    // …but the work has not stopped.
    const pending = await Promise.race([
      drive.finished.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("still-pending"), 50)),
    ]);
    expect(pending).toBe("still-pending");
    // The caller wires `finished` to the write; landing it finishes the drive.
    drive.resolveFinished(write);
    landWrite();
    await expect(drive.finished).resolves.toBeUndefined();
    // The timer was cancelled, exactly as `finishEarly` does.
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("resolveFinished absorbs a REJECTED continuation — `finished` never rejects", async () => {
    const drive = createDirectDrive({
      executionId: "e",
      attempt: "a",
      now: Date.now,
      budgetMs: 10_000,
    });
    drive.resolveFinished(Promise.reject(new Error("boom")));
    await expect(drive.finished).resolves.toBeUndefined();
    drive.dispose();
  });

  it("deliverableBytes measures UTF-8, not string length; undefined measures as null", () => {
    // A DISTINGUISHABLE string: "ÿ" also measures 4, the same as the
    // `undefined`→null case below, so it proved nothing about either.
    expect(deliverableBytes("€")).toBe(5);
    expect(deliverableBytes(undefined)).toBe(4);
    expect(deliverableBytes(null)).toBe(4);
    expect(deliverableBytes({ a: "€" })).toBe(11);
  });
});
