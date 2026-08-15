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
 */
export async function assertStateDir(dir: string, mode: StateDirMode): Promise<void> {
  if (mode === "bind" && process.platform === "darwin") {
    await stripDarwinAcl(dir);
  }

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
 * POSIX-ACL grants surface in the group-class bits of st_mode, so the
 * 0700 check above already covers it. If getfacl is present, verify no
 * non-owner entries as an additional best-effort layer; if absent,
 * skip — this is documented best-effort, not the primary boundary.
 */
async function assertNoLinuxAcl(dir: string): Promise<void> {
  const GETFACL = "/usr/bin/getfacl";
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(GETFACL, ["--omit-header", dir]));
  } catch {
    return; // getfacl unavailable — best-effort layer, silently skipped
  }
  const nonOwnerEntry = stdout
    .split("\n")
    .some((line) => /^(user:.+|group:.+|mask::)/.test(line) && !line.startsWith("mask::"));
  if (nonOwnerEntry) {
    throw new StateDirError("EXTENDED_ACL", `state directory has a POSIX ACL grant: ${dir}`);
  }
}
