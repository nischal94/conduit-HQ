import {
  chmodSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRotatingLog,
  LOG_LINE_MAX_BYTES,
  LOG_MAX_BYTES,
  LOG_OPEN_FLAGS,
} from "./log-sink.js";
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
    // EXACT, not an allowance: the suffix's byte length is subtracted from
    // the slice bound, so a truncated line is at most the line cap itself.
    // The only byte over it is the newline every line carries.
    expect(statSync(join(dir, DAEMON_LOG)).size).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES + 1);
  });

  it("holds the cap when the slice cuts a 4-byte character in half", () => {
    // The exact arithmetic that broke the cap. The suffix "…[truncated]" is
    // 14 bytes, so room = 8192 - 14 = 8178, and 8178 % 4 == 2: the byte
    // slice ends two bytes into a 4-byte character. Node decodes those two
    // orphaned bytes to U+FFFD, which costs 3 — one byte MORE than the
    // slice they came from — so the finished line ran to 8193 and the
    // "single line cannot blow the budget" guarantee (spec §5) was off by
    // one for exactly this input class.
    //
    // A pure-ASCII line can never produce this: every character is one
    // byte, so the slice always lands on a boundary. Only a multi-byte
    // line whose width does not divide `room` reaches the defect, which is
    // why the ASCII case above passed throughout.
    const dir = newDir();
    const sink = createRotatingLog(dir);
    // U+1F600 is 4 bytes in UTF-8. Well over the cap, so it truncates.
    sink.log("\u{1F600}".repeat(LOG_LINE_MAX_BYTES));
    sink.close();

    const content = readFileSync(join(dir, DAEMON_LOG), "utf8");
    expect(content.endsWith("…[truncated]\n")).toBe(true);
    // The same bound the ASCII case asserts: the cap, plus the one newline
    // every line carries. No allowance for the replacement character.
    expect(statSync(join(dir, DAEMON_LOG)).size).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES + 1);
  });

  it("holds the cap across every 1..4-byte character width", () => {
    // Widths 1, 2, 3 and 4 all appear, and each is combined with a shifting
    // one-byte prefix so the slice boundary lands at a different offset
    // within the repeated character on every run. That sweeps all four
    // residues of `room % width` rather than testing the one alignment a
    // single fixture happens to produce.
    const widths = ["a", "é", "中", "\u{1F600}"];
    for (const char of widths) {
      for (let pad = 0; pad < 4; pad += 1) {
        const dir = newDir();
        const sink = createRotatingLog(dir);
        sink.log("a".repeat(pad) + char.repeat(LOG_LINE_MAX_BYTES));
        sink.close();
        expect(statSync(join(dir, DAEMON_LOG)).size).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES + 1);
      }
    }
  });

  it("refuses to open through a symlink at the log path, leaving the target unwritten", () => {
    // The state directory is a 0700 boundary (§3.2), but the sink opens
    // BEFORE `ensureStateDir` has lstat-verified it — so a daemon started by
    // hand against a not-yet-blessed directory would follow a planted
    // `conduitd.log` link and append its diagnostics to a file OUTSIDE the
    // boundary. `O_NOFOLLOW` is what refuses that, and this pins it.
    const dir = newDir();
    const outside = newDir();
    const target = join(outside, "victim");
    writeFileSync(target, "original\n", { mode: 0o600 });
    symlinkSync(target, join(dir, DAEMON_LOG));

    // Refused outright — a daemon that cannot open its log honestly is
    // better than one that writes through a link it does not own.
    expect(() => createRotatingLog(dir)).toThrow();
    // THE ASSERTION that makes it non-vacuous: not one byte reached the
    // link's target. A throw from some other cause would leave this true
    // too, but a followed symlink could not.
    expect(readFileSync(target, "utf8")).toBe("original\n");
  });

  it("rotates without writing through a symlink planted at either rotation path", () => {
    // The post-rotation reopen is the SECOND place `O_NOFOLLOW` matters: the
    // rename frees the log's own name, which is exactly the window a plant
    // wants — the reopen creates a file at a name an attacker may have just
    // claimed.
    //
    // WHAT THIS TEST DOES NOT DO, stated plainly: it does not pin the
    // reopen's flags. Planting strictly BETWEEN `renameSync` and the reopen
    // is unreachable from a test — they are adjacent synchronous statements
    // in one tick with no seam. And a plant at either path before rotation
    // is defused by `rename` itself, which was MEASURED rather than assumed:
    // `renameSync` onto a symlink destination replaces the link by name and
    // leaves its target untouched. So the outcome below would hold with or
    // without the flag, and the flag assertion at the end of this file is
    // what actually covers the reopen call site.
    //
    // It is kept because the end-to-end property is still worth pinning: a
    // rotation run against planted links writes nothing outside the 0700
    // boundary and never throws at the caller.
    const dir = newDir();
    const outside = newDir();
    const activeVictim = join(outside, "active-victim");
    const rotatedVictim = join(outside, "rotated-victim");
    writeFileSync(activeVictim, "active original\n", { mode: 0o600 });
    writeFileSync(rotatedVictim, "rotated original\n", { mode: 0o600 });

    const sink = createRotatingLog(dir);
    const chunk = "w".repeat(LOG_LINE_MAX_BYTES - 1);
    while (sink.info().sizeBytes + chunk.length + 1 <= LOG_MAX_BYTES) sink.log(chunk);

    const path = join(dir, DAEMON_LOG);
    rmSync(path);
    symlinkSync(activeVictim, path);
    symlinkSync(rotatedVictim, `${path}.1`);

    expect(() => {
      sink.log("the line that tips it over");
    }).not.toThrow();
    sink.log("and another after the rotation attempt");
    sink.close();

    expect(readFileSync(activeVictim, "utf8")).toBe("active original\n");
    expect(readFileSync(rotatedVictim, "utf8")).toBe("rotated original\n");
  });

  it("opens the log with O_NOFOLLOW on both the initial open and the reopen", () => {
    // The direct pin for the reopen call site, which no filesystem
    // arrangement can reach (see the rotation test above). Both `openSync`
    // calls in `log-sink.ts` take the SAME `LOG_OPEN_FLAGS` constant, so
    // asserting the constant covers both — and this fails the moment
    // someone drops the flag from it.
    expect(LOG_OPEN_FLAGS & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
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
