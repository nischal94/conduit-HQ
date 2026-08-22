import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRotatingLog, LOG_LINE_MAX_BYTES, LOG_MAX_BYTES } from "./log-sink.js";
import { DAEMON_LOG } from "./spawn.js";

const dirs: string[] = [];

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sink-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    // A rotation-failure test leaves the directory read-only; restore the
    // mode before removing it, or the cleanup itself fails.
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* already writable, or already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

/**
 * `chmod` is a no-op for root and on some filesystems, so the
 * rotation-failure test would silently assert nothing there. Probe it: make
 * a scratch directory read-only and try to create a file inside. If the
 * write still succeeds, chmod did not bite and the test is skipped rather
 * than passing vacuously.
 */
function chmodBlocksWrites(): boolean {
  const probe = newDir();
  chmodSync(probe, 0o500);
  try {
    writeFileSync(join(probe, "canary"), "x");
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(probe, 0o700);
  }
}

const CHMOD_BITES = chmodBlocksWrites();

describe("createRotatingLog", () => {
  it("appends lines to conduitd.log in the state dir, 0600", () => {
    const dir = newDir();
    const sink = createRotatingLog(dir);
    sink.log("first");
    sink.log("second");
    sink.close();

    const path = join(dir, DAEMON_LOG);
    expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(sink.info().path).toBe(path);
  });

  it("counts existing bytes: a reopened sink continues the running total", () => {
    const dir = newDir();
    const existing = "already here\n";
    writeFileSync(join(dir, DAEMON_LOG), existing, { mode: 0o600 });

    const sink = createRotatingLog(dir);
    expect(sink.info().sizeBytes).toBe(Buffer.byteLength(existing));
    sink.log("more");
    expect(sink.info().sizeBytes).toBe(Buffer.byteLength(existing) + "more\n".length);
    sink.close();
  });

  it("rotates at the cap: current -> .1 (replacing any previous .1), fresh active file", () => {
    const dir = newDir();
    const path = join(dir, DAEMON_LOG);
    const rotated = `${path}.1`;
    // A previous rotation's file, which the next rotation must REPLACE
    // rather than append to — otherwise the on-disk worst case is unbounded.
    writeFileSync(rotated, "stale previous rotation\n", { mode: 0o600 });

    const sink = createRotatingLog(dir);
    // Lines just under the single-line cap, so filling to the byte cap takes
    // a bounded number of writes.
    const chunk = "y".repeat(LOG_LINE_MAX_BYTES - 1);
    while (sink.info().sizeBytes + chunk.length + 1 <= LOG_MAX_BYTES) sink.log(chunk);
    const beforeRotate = sink.info().sizeBytes;
    expect(beforeRotate).toBeLessThanOrEqual(LOG_MAX_BYTES);

    sink.log("the line that tips it over");
    expect(sink.info().sizeBytes).toBe("the line that tips it over\n".length);
    sink.close();

    expect(readFileSync(path, "utf8")).toBe("the line that tips it over\n");
    const rotatedContent = readFileSync(rotated, "utf8");
    expect(rotatedContent).not.toContain("stale previous rotation");
    expect(rotatedContent.length).toBe(beforeRotate);
  });

  it("truncates a single oversized line to LOG_LINE_MAX_BYTES", () => {
    const dir = newDir();
    const sink = createRotatingLog(dir);
    sink.log("x".repeat(LOG_LINE_MAX_BYTES * 2));
    sink.close();

    const content = readFileSync(join(dir, DAEMON_LOG), "utf8");
    expect(content.endsWith("…[truncated]\n")).toBe(true);
    // The suffix and its multi-byte ellipsis are the only allowance over the
    // line cap; the point is that one write cannot blow the byte budget.
    expect(statSync(join(dir, DAEMON_LOG)).size).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES + 64);
  });

  it.skipIf(!CHMOD_BITES)("keeps logging through a rotation failure", () => {
    const dir = newDir();
    const path = join(dir, DAEMON_LOG);
    const sink = createRotatingLog(dir);
    const chunk = "z".repeat(LOG_LINE_MAX_BYTES - 1);
    while (sink.info().sizeBytes + chunk.length + 1 <= LOG_MAX_BYTES) sink.log(chunk);

    // A read-only state directory makes `rename` fail while the already-open
    // fd stays writable — the exact shape of a rotation failure.
    chmodSync(dir, 0o500);
    expect(() => {
      sink.log("after the failed rotation");
    }).not.toThrow();
    sink.log("and another");
    sink.close();
    chmodSync(dir, 0o700);

    const content = readFileSync(path, "utf8");
    expect(content).toContain("after the failed rotation");
    expect(content).toContain("and another");
    expect(content).toContain("Log rotation failed");
    // Degraded, not rotated: the active file is now over the cap and there
    // is no `.1` beside it.
    expect(statSync(path).size).toBeGreaterThan(LOG_MAX_BYTES);
    expect(() => statSync(`${path}.1`)).toThrow();
  });
});
