/**
 * State-directory boundary checks (design §3.2). Enforces the
 * different-UID security boundary one level up from the socket: a
 * different-UID process cannot traverse a 0700 directory on macOS or
 * Linux, so it can never reach the socket pathname at all. Node stdlib
 * exposes no getpeereid()/SO_PEERCRED, so this directory check is the
 * actual enforcement mechanism, not defense-in-depth.
 *
 * Node's fs stdlib reads no ACLs, so extended ACLs (which can grant
 * another user directory-search rights invisible to st_mode) are
 * checked out-of-band via `/bin/ls -lde` on darwin. `mode="bind"`
 * additionally strips any ACL first via `/bin/chmod -N` (the daemon
 * owns the directory and may mutate it); `mode="connect"` only verifies
 * (clients never mutate the state directory). All binaries are invoked
 * by absolute path — never a PATH lookup.
 */
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type StateDirMode = "bind" | "connect";

export type StateDirErrorCode =
  | "SYMLINK"
  | "NOT_DIRECTORY"
  | "WRONG_OWNER"
  | "WRONG_MODE"
  | "EXTENDED_ACL";

export class StateDirError extends Error {
  readonly code: StateDirErrorCode;

  constructor(code: StateDirErrorCode, message: string) {
    super(message);
    this.name = "StateDirError";
    this.code = code;
  }
}

const REQUIRED_MODE = 0o700;

/**
 * lstat (no symlink), owner uid === process uid, mode 0700, no extended
 * ACL. mode="bind" strips ACLs before verifying (daemon side);
 * mode="connect" only verifies (clients never mutate).
 *
 * Ordering is deliberate and security-load-bearing: the full
 * lstat/symlink/owner/mode validation runs FIRST, entirely before any
 * mutation. Only after the target is confirmed to be a real,
 * self-owned, 0700 directory does bind mode strip ACLs — and the
 * final verify runs last. `chmod` without `-h` follows symlinks, so
 * stripping before validating would let a symlink planted at the
 * state-dir path use bind mode as an ACL-clearing primitive against an
 * arbitrary target, before rejection ever triggers. Running strip only
 * after ownership/mode are confirmed leaves a narrow strip-then-verify
 * window that is owner-only: a 0700 parent means only the owning uid
 * can race the target between those two calls, which is inside this
 * module's own trust boundary, not a boundary break. Do not reorder
 * this without re-reading that reasoning.
 */
export async function assertStateDir(dir: string, mode: StateDirMode): Promise<void> {
  const stat = await lstat(dir);

  if (stat.isSymbolicLink()) {
    throw new StateDirError("SYMLINK", `state directory is a symlink: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new StateDirError("NOT_DIRECTORY", `state directory path is not a directory: ${dir}`);
  }
  if (stat.uid !== process.getuid?.()) {
    throw new StateDirError(
      "WRONG_OWNER",
      `state directory owner uid ${stat.uid} does not match process uid: ${dir}`,
    );
  }
  const actualMode = stat.mode & 0o777;
  if (actualMode !== REQUIRED_MODE) {
    throw new StateDirError(
      "WRONG_MODE",
      `state directory mode ${actualMode.toString(8)} must be 0700: ${dir}`,
    );
  }

  if (process.platform === "darwin") {
    if (mode === "bind") {
      await stripDarwinAcl(dir);
    }
    await assertNoDarwinAcl(dir);
  } else if (process.platform === "linux") {
    await assertNoLinuxAcl(dir);
  }
}

async function stripDarwinAcl(dir: string): Promise<void> {
  await execFileAsync("/bin/chmod", ["-N", dir]);
}

/** Any `/bin/ls -lde` output line matching /^ \d+: / is an ACL entry. */
async function assertNoDarwinAcl(dir: string): Promise<void> {
  const { stdout } = await execFileAsync("/bin/ls", ["-lde", dir]);
  if (/^ \d+: /m.test(stdout)) {
    throw new StateDirError("EXTENDED_ACL", `state directory has an extended ACL: ${dir}`);
  }
}

/**
 * Classifies a single `getfacl --omit-header` output line as a
 * non-owner ACL grant. Base entries (`user::rwx`, `group::rwx`,
 * `other::rwx`) carry an EMPTY qualifier between the two colons and
 * are not grants — every POSIX-permissioned file has them. Named
 * entries (`user:alice:r-x`, `group:staff:r-x`) carry a non-empty
 * qualifier and ARE grants. `mask::` bounds effective permissions for
 * named entries; it is not itself a grant and is ignored. Extracted as
 * a pure function so the classifier has unit coverage even on
 * platforms (darwin) that never execute the getfacl call path.
 */
export function isNonOwnerAclLine(line: string): boolean {
  return /^(user|group):[^:]+:/.test(line);
}

/**
 * POSIX-ACL grants surface in the group-class bits of st_mode, so the
 * 0700 check above already covers it. If getfacl is present, verify no
 * non-owner entries as an additional best-effort layer. Absence of the
 * binary (ENOENT) is a documented best-effort skip; any other failure
 * (permission denied, unexpected exit) is NOT silently swallowed — it
 * surfaces as a typed error rather than disabling the layer.
 */
async function assertNoLinuxAcl(dir: string): Promise<void> {
  const GETFACL = "/usr/bin/getfacl";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(GETFACL, ["--omit-header", dir]));
  } catch (err) {
    if (isEnoent(err)) return; // getfacl not installed — best-effort layer, skipped
    throw new StateDirError(
      "EXTENDED_ACL",
      `state directory ACL check failed (getfacl): ${dir}: ${String(err)}`,
    );
  }
  const nonOwnerEntry = stdout.split("\n").some(isNonOwnerAclLine);
  if (nonOwnerEntry) {
    throw new StateDirError("EXTENDED_ACL", `state directory has a POSIX ACL grant: ${dir}`);
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
