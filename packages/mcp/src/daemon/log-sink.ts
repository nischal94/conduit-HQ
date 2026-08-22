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
 * not a path an unprivileged process can interpose on. The sink opens
 * BEFORE that verification runs, which is why the open itself carries
 * `O_NOFOLLOW` (see `LOG_OPEN_FLAGS`) rather than resting on it.
 *
 * Concurrent appenders are possible and correct: the spawning client's
 * failure line and a losing auto-start child both hold their own append fds
 * on the same inode, and after a rotation they follow that inode into
 * `.1`. The single-writer claim is deliberately NOT made here — the byte
 * counter below tracks what THIS sink wrote, which is what the cap governs.
 */
import { closeSync, constants, fstatSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_LOG } from "./spawn.js";

/**
 * The append-open, spelled numerically so `O_NOFOLLOW` can join it.
 *
 * `"a"` is `O_WRONLY|O_CREAT|O_APPEND`; the added flag refuses to open the
 * log when the final path component is a symlink. The state directory is a
 * 0700 boundary (§3.2), but this open happens BEFORE `ensureStateDir` has
 * lstat-verified it — a daemon started by hand against a directory that is
 * not yet blessed would otherwise follow a planted `conduitd.log` link and
 * append daemon diagnostics to a file outside the boundary. Applies to the
 * post-rotation reopen for the same reason: the rename leaves the name free
 * for exactly that plant.
 */
const LOG_OPEN_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;

/** Normative-local (spec §5): active-file cap; worst case on disk ~2x. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Normative-local (spec §5): single-line cap so one write cannot blow the budget. */
export const LOG_LINE_MAX_BYTES = 8 * 1024;
/** Retry a failed rotation only after this much MORE has been written. */
const ROTATE_RETRY_BYTES = 64 * 1024;

export interface RotatingLog {
  log: (line: string) => void;
  info: () => { path: string; sizeBytes: number };
  close: () => void;
}

export function createRotatingLog(stateDir: string): RotatingLog {
  const path = join(stateDir, DAEMON_LOG);
  let fd = openSync(path, LOG_OPEN_FLAGS, 0o600);
  let bytes = fstatSync(fd).size;
  let nextRotateAttempt = LOG_MAX_BYTES;

  const rotate = (): void => {
    try {
      renameSync(path, `${path}.1`);
      const fresh = openSync(path, LOG_OPEN_FLAGS, 0o600);
      closeSync(fd);
      fd = fresh;
      bytes = 0;
      nextRotateAttempt = LOG_MAX_BYTES;
    } catch (err) {
      // Keep the old fd; logging degrades, the daemon never dies for its
      // log (spec §5/§8). Retry only after ROTATE_RETRY_BYTES more.
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
    }
  };

  return {
    log(line: string): void {
      let text = line;
      if (Buffer.byteLength(text) > LOG_LINE_MAX_BYTES) {
        text = `${Buffer.from(text).subarray(0, LOG_LINE_MAX_BYTES).toString()}…[truncated]`;
      }
      const buf = Buffer.from(`${text}\n`);
      if (bytes + buf.length > nextRotateAttempt) rotate();
      try {
        writeSync(fd, buf);
        bytes += buf.length;
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
