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
    expect(deliverableBytes("ÿ")).toBe(4);
    expect(deliverableBytes(undefined)).toBe(4);
    expect(deliverableBytes({ a: "€" })).toBe(11);
  });
});
