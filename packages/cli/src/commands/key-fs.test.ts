import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writtenChunks: Buffer[] = [];
const fsyncCalls: number[] = [];
let forceShortWrites = false;

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeSync: (fd: number, buffer: unknown, offset?: number, length?: number) => {
      if (!forceShortWrites) {
        return actual.writeSync(fd, buffer as Buffer, offset, length);
      }
      const buf = buffer as Buffer;
      const off = offset ?? 0;
      const len = length ?? buf.length - off;
      const chunk = Math.min(3, len); // force short writes, 3 bytes at a time
      writtenChunks.push(Buffer.from(buf.subarray(off, off + chunk)));
      return chunk;
    },
    fsyncSync: (fd: number) => {
      if (forceShortWrites) {
        fsyncCalls.push(fd);
        return;
      }
      actual.fsyncSync(fd);
    },
  };
});

const { writeAllAndFsync } = await import("./key-fs.js");

describe("writeAllAndFsync (F2 — short-write hole)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conduit-writeall-test-"));
    forceShortWrites = false;
    writtenChunks.length = 0;
    fsyncCalls.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the full buffer and fsyncs, on a normal single-syscall write", () => {
    const path = join(dir, "out");
    const fd = openSync(path, "w");
    try {
      writeAllAndFsync(fd, Buffer.from("hello world\n"));
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path, "utf8")).toBe("hello world\n");
  });

  it("INVARIANT §16.3: loops until every byte is written when writeSync returns a short count", () => {
    // Simulate POSIX short writes: writeSync's underlying fs binding can
    // legally write fewer bytes than requested. Force the mocked writeSync
    // to return partial counts, and assert the helper keeps calling it
    // (with the correct offset/remaining-length) until the whole buffer is
    // consumed, then fsyncs exactly once with all bytes down.
    forceShortWrites = true;
    const data = Buffer.from("0123456789"); // 10 bytes

    writeAllAndFsync(123, data);

    expect(Buffer.concat(writtenChunks)).toEqual(data); // every byte written, in order, no gaps/overlaps
    expect(writtenChunks.length).toBeGreaterThan(1); // proves it looped, not a single call
    expect(fsyncCalls).toEqual([123]); // fsynced exactly once, after all bytes were down
  });
});
