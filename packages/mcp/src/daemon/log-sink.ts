/**
 * The daemon's OWN log file descriptor and the rotation over it (spec §5).
 *
 * The spawn path hands the child an inherited append fd (`spawn.ts`:
 * `stdio: ["ignore", logFd, logFd]`), and rename-and-reopen CANNOT bound
 * that file: an append fd follows the INODE, so after a rename the child
 * keeps writing into the renamed file, and Node offers no `dup2` to point
 * fd 1/2 at a fresh one. The only way to bound the daemon's own log is for
 * the daemon to own the descriptor it writes through — which is what this
 * module is.
 *
 * Residual fd-2 traffic — Node warnings, uncaught stack traces — still
 * follows the inherited descriptor and is NOT rotated. That is accepted as
 * bounded-in-practice best effort rather than claimed as a guarantee.
 *
 * Rotation stays inside the state directory, whose 0700 mode the daemon
 * verifies by lstat at startup (`ensureStateDir`), so the rename target is
 * not a path an unprivileged process can interpose on. The entry point now
 * runs that validation BEFORE building this sink (CX2), so the sink opens
 * inside a blessed directory — but the open still carries `O_NOFOLLOW` (see
 * `LOG_OPEN_FLAGS`) and fstat-verifies the fd is a regular self-owned file
 * (`openVerifiedLogFd`) to close the residual micro-window between the
 * boundary check and the open, rather than resting on the check alone.
 *
 * Concurrent appenders are possible and correct: the spawning client's
 * failure line and a losing auto-start child both hold their own append fds
 * on the same inode, and after a rotation they follow that inode into
 * `.1`. The single-writer claim is deliberately NOT made here — the byte
 * counter below is SEEDED from the file's current size at open (the fstat
 * in `createRotatingLog`) and thereafter tracks only what THIS sink writes.
 * So it accounts for what was on disk when this sink opened, plus this
 * sink's own output; a concurrent appender's bytes after that point are not
 * counted, which is what makes the cap a per-sink budget rather than a
 * guarantee about the file.
 */
import { closeSync, constants, fstatSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_LOG } from "./spawn.js";

/**
 * The append-open, spelled numerically so `O_NOFOLLOW` can join it.
 *
 * `"a"` is `O_WRONLY|O_CREAT|O_APPEND`; the added flag refuses to open the
 * log when the final path component is a symlink. The state directory is a
 * 0700 boundary (§3.2), now boundary-validated before this sink is built
 * (CX2) — but a residual micro-window remains between that validation and
 * this open, so the flag still refuses a planted `conduitd.log` symlink
 * rather than resting on the check. Applies to the post-rotation reopen for
 * the same reason: the rename leaves the name free for exactly that plant.
 * A regular-file swap (not a symlink) passes `O_NOFOLLOW`, so it is caught
 * separately by the fstat check in `openVerifiedLogFd`.
 */
export const LOG_OPEN_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;

/**
 * A log-open refused because the opened fd is not a safe file to write daemon
 * diagnostics into: it is not a regular file, or it is owned by another uid,
 * or it is group/world-accessible.
 *
 * `O_NOFOLLOW` alone is not enough. It refuses a symlink at the final
 * component, but a swapped-in directory holding an attacker-owned REGULAR
 * `conduitd.log` opens fine under it. On the daemon startup path the sink
 * opens while the state directory is only just created and not yet
 * boundary-validated, so an ancestor-owning uid can, in that window, swap the
 * leaf for a directory it controls with a regular file at the log path. The
 * fstat check below (CX2) closes that: it fails a fd that is not a regular,
 * self-owned, non-group/world-accessible file, so the daemon never writes its
 * diagnostics into an attacker-readable fd.
 */
export class LogOpenRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogOpenRefused";
  }
}

/**
 * Opens the log path with `LOG_OPEN_FLAGS` and REJECTS the fd unless it is a
 * regular, self-owned file whose mode grants nothing to group or world (CX2).
 *
 * The order is load-bearing: the fd is fstat'd (the object actually opened,
 * not a path re-resolved and vulnerable to a second swap), and on any failed
 * check the fd is closed before throwing so a refusal never leaks a
 * descriptor. Used for BOTH the initial open and the post-rotation reopen,
 * because the rename frees the name for the same plant.
 */
function openVerifiedLogFd(path: string): number {
  const fd = openSync(path, LOG_OPEN_FLAGS, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new LogOpenRefused(
        `[log-sink] refusing log fd: not a regular file. Context: {path: ${path}}`,
      );
    }
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) {
      throw new LogOpenRefused(
        `[log-sink] refusing log fd: owner uid ${st.uid} is not this process's uid ${uid}. ` +
          `Context: {path: ${path}}`,
      );
    }
    if ((st.mode & 0o077) !== 0) {
      throw new LogOpenRefused(
        `[log-sink] refusing log fd: mode ${(st.mode & 0o777).toString(8)} grants access beyond ` +
          `the owner. Context: {path: ${path}}`,
      );
    }
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/**
 * Normative-local (spec §5): active-file cap. Worst case on disk is ~2x
 * across the two files (the active one plus `.1`), plus the residual-stderr
 * allowance named in the module docblock — traffic on the inherited fd 2 is
 * not written through this sink and is therefore outside this budget.
 */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Normative-local (spec §5): single-line cap so one write cannot blow the budget. */
export const LOG_LINE_MAX_BYTES = 8 * 1024;
/**
 * Marks a line the truncation shortened. Its own byte length is subtracted
 * from the slice bound, so a truncated line lands at or below
 * `LOG_LINE_MAX_BYTES` rather than at the cap PLUS this suffix.
 *
 * At or below, never exactly: a byte slice can land mid-character, and
 * decoding an incomplete UTF-8 sequence EXPANDS it to U+FFFD (3 bytes) —
 * so a slice ending 2 bytes into a 4-byte character decodes 1 byte LARGER
 * than the slice. The truncation below therefore re-measures the decoded
 * text rather than trusting the slice bound.
 */
const TRUNC_SUFFIX = "…[truncated]";
/** Retry a failed rotation only after this much MORE has been written. */
const ROTATE_RETRY_BYTES = 64 * 1024;

export interface RotatingLog {
  log: (line: string) => void;
  info: () => { path: string; sizeBytes: number };
  close: () => void;
}

/**
 * Test-only seams. `openFd` defaults to the real `openVerifiedLogFd` — a test
 * substitutes it to inject a transient open failure at the post-rename reopen
 * (the CX4 wedge), which no filesystem arrangement can reach (rename and
 * reopen are adjacent synchronous statements with no seam between them).
 * Production never passes it.
 */
export interface RotatingLogDeps {
  openFd?: (path: string) => number;
}

export function createRotatingLog(stateDir: string, deps: RotatingLogDeps = {}): RotatingLog {
  const path = join(stateDir, DAEMON_LOG);
  const openFd = deps.openFd ?? openVerifiedLogFd;
  let fd = openFd(path);
  let bytes = fstatSync(fd).size;
  let nextRotateAttempt = LOG_MAX_BYTES;

  // Records a degraded rotation to the still-open fd and backs off the retry.
  // Never throws: the daemon must not die for its log (spec §5/§8).
  const degrade = (err: unknown): void => {
    nextRotateAttempt = bytes + ROTATE_RETRY_BYTES;
    try {
      const note = `[conduitd] Log rotation failed: keeping the current file. Context: {cause: ${
        err instanceof Error ? err.message : String(err)
      }}\n`;
      writeSync(fd, note);
      bytes += Buffer.byteLength(note);
    } catch {
      /* nothing left to report through */
    }
  };

  const rotate = (): void => {
    // Pre-rename failure and post-rename failure are DIFFERENT states and
    // must be handled apart (CX4). A rename that fails leaves everything as it
    // was — the active path and `fd` still agree, so degrade in place. A
    // rename that SUCCEEDS but whose fresh open then fails transiently
    // (EMFILE/ENFILE, inode exhaustion) is the wedge: the active pathname is
    // now gone, `fd` points at `.1`, and every later attempt renames a missing
    // active path (ENOENT) forever while `.1` grows unbounded. So on a
    // post-rename open failure we roll `.1` back to the active path, restoring
    // the invariant that the active pathname exists and `fd` writes to it; the
    // NEXT cap-hit retries the whole rotation cleanly.
    try {
      renameSync(path, `${path}.1`);
    } catch (err) {
      // Pre-rename: nothing moved, `fd` still writes to the active file.
      degrade(err);
      return;
    }
    let fresh: number;
    try {
      fresh = openFd(path);
    } catch (err) {
      // Post-rename: undo the rename so the active pathname is not left
      // dangling. `fd` still points at the same inode (now back at the active
      // path), so it keeps writing to the file the operator reads.
      try {
        renameSync(`${path}.1`, path);
      } catch {
        // Rollback itself failed: `fd` still targets the renamed inode by
        // descriptor, so logging continues into `.1` for now; the ENOSPC-class
        // condition that broke the reopen is what to fix. Degrade and back off.
      }
      degrade(err);
      return;
    }
    closeSync(fd);
    fd = fresh;
    bytes = 0;
    nextRotateAttempt = LOG_MAX_BYTES;
  };

  return {
    log(line: string): void {
      let text = line;
      if (Buffer.byteLength(text) > LOG_LINE_MAX_BYTES) {
        // The slice bound leaves room for the suffix, so the result is at
        // most LOG_LINE_MAX_BYTES rather than that plus the marker. The
        // multi-byte ellipsis is why the allowance is a BYTE length, not a
        // character count.
        const room = LOG_LINE_MAX_BYTES - Buffer.byteLength(TRUNC_SUFFIX);
        let head = Buffer.from(text).subarray(0, room).toString();
        // The slice is a BYTE bound and can cut a character in half. Node
        // decodes the orphaned bytes to U+FFFD, which costs 3 bytes each
        // and can therefore EXCEED the slice it came from: a 4-byte
        // character cut after 2 bytes decodes to 3, one byte over.
        //
        // Dropping UTF-16 units from the end converges to a value at or
        // below `room` for every 1..4-byte character. Each drop strictly
        // shrinks the encoding: removing a BMP character frees its 1-3
        // bytes, and splitting a surrogate pair replaces its 4 bytes with
        // a 3-byte U+FFFD for the orphaned lead. The empty string measures
        // 0, so the loop always terminates.
        while (Buffer.byteLength(head) > room) head = head.slice(0, -1);
        text = `${head}${TRUNC_SUFFIX}`;
      }
      const buf = Buffer.from(`${text}\n`);
      if (bytes + buf.length > nextRotateAttempt) rotate();
      try {
        // Count what was WRITTEN, not what was requested: a short write
        // leaves fewer bytes on disk than `buf.length`, and crediting the
        // full buffer would drift the counter above the file's real size —
        // rotating early and misreporting through `info()`.
        bytes += writeSync(fd, buf);
      } catch {
        /* ENOSPC-class: degrade best-effort (spec §5) */
      }
    },
    info: () => ({ path, sizeBytes: bytes }),
    close: () => {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}
