import { fsyncSync, writeSync } from "node:fs";

/**
 * Write the ENTIRE buffer to an already-open fd, then fsync it — a single
 * `writeSync` call is allowed by POSIX to write fewer bytes than requested
 * (a short write), and a truncated key file that gets fsynced and later
 * promoted would silently lose bytes of the real key (F2). Loops on
 * `writeSync`'s return value until every byte is down before fsyncing.
 * Does NOT open, close, or set the mode of the fd — callers own that (wx +
 * 0600), this only owns making the write itself all-or-nothing.
 */
export function writeAllAndFsync(fd: number, data: Buffer | string): void {
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
  fsyncSync(fd);
}
