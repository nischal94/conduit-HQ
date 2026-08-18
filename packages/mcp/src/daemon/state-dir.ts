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
import { lstatSync, type Stats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type StateDirMode = "bind" | "connect";

export type StateDirErrorCode =
  | "NOT_FOUND"
  | "SYMLINK"
  | "NOT_DIRECTORY"
  | "WRONG_OWNER"
  | "WRONG_MODE"
  | "EXTENDED_ACL"
  | "UNSAFE_ANCESTOR";

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
  let stat: Stats;
  try {
    stat = await lstat(dir);
  } catch (err) {
    // A missing state directory is a NAMED condition, not a raw errno
    // escaping the boundary. On a fresh install nothing has created
    // `~/.conduit` yet, and every caller needs to branch on it: the
    // daemon creates the directory and re-asserts, the client treats it
    // as "no daemon, no rotation" and spawns one. A bare ENOENT
    // `Error` forces both to string-match an errno to tell "not there
    // yet" from "there and unsafe" — the two outcomes with opposite
    // correct responses.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StateDirError("NOT_FOUND", `state directory does not exist: ${dir}`);
    }
    throw err;
  }

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

/**
 * The `(device, inode)` identity of `path`'s OWN directory entry, via
 * `lstatSync` (which does NOT follow a final symlink). Used to pin "the leaf
 * I validated is the leaf I connect to" (design §17 §3.3): captured after
 * `assertStateDir` blesses the leaf, re-checked after `connect()` succeeds
 * and before the first request byte. A `bigint` `ino` is exact above 2^53,
 * so two distinct inodes can never collide into a false match.
 *
 * `assertStateDir` has already proven the leaf is a non-symlink self-owned
 * 0700 directory, so `lstatSync` here reads that same object; the re-check's
 * job is only to detect that the ENTRY was swapped (a parent-owner rename
 * dropping a different inode at the same name) between the two moments.
 */
export interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

export function leafIdentity(path: string): DirectoryIdentity {
  const s = lstatSync(path, { bigint: true });
  return { dev: s.dev, ino: s.ino };
}

/**
 * True iff `a` and `b` name the same on-disk object by `(dev, ino)`.
 * A cross-device hard link to a directory is impossible on our platforms,
 * so `(dev, ino)` is a total identity for directories.
 */
export function sameLeaf(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Refuses a canonical base whose ancestor chain a DIFFERENT uid could rename
 * or replace (design §17 §3.2, closes P1). `assertStateDir` proves the LEAF
 * is a self-owned 0700 non-symlink, but says nothing about the chain of
 * ancestors the path traverses to reach it — and the threat model grants the
 * attacker ownership of a directory that chain crosses. A parent owner can
 * `rename()` the validated leaf out and drop a replacement (their own 0700
 * dir holding a fake socket) at the same path before the client connects; the
 * 0700 mode on the original leaf never stopped that, because renaming the
 * entry is the parent's right, not the leaf's.
 *
 * `canonicalBase` MUST be the kernel-faithful resolved path
 * (`canonicalOfMissing` in `state-dir-resolve.ts`) — the canonicalize half of
 * canonicalize-then-check. Do NOT pass a raw caller spelling: a symlink in it
 * would make the walk check the wrong chain. Only the EXISTING prefix is
 * walked (a not-yet-existent tail has no inode to own and, being purely
 * lexical past the last real component, cannot alias anything).
 *
 * A component is disqualifying when EITHER (§3.2):
 *   1. it is owned by a uid that is neither ours NOR root. Under the same-UID
 *      threat model the only adversary shares neither our uid nor root, so a
 *      ROOT-owned ancestor is trusted (it is exactly the `/`, `/Users`,
 *      `/home`, `/private`, `/var`, `/private/tmp` chain every home path
 *      necessarily traverses) while any other foreign owner is an
 *      attacker-owned traversal point → refuse. Ownership is the trust
 *      criterion, not a hardcoded name set — a uid comparison converges where
 *      an enumerated denylist of paths never could.
 *   2. it is group- or world-WRITABLE (`mode & 0o022`) and NOT sticky
 *      (`mode & 0o1000`) — a writable non-sticky ancestor lets any uid
 *      rename/replace the next component, EVEN IF it is root-owned. (A sticky
 *      world-writable dir like `/tmp` only lets an entry's OWNER rename it, so
 *      `/tmp` itself is not disqualifying; the self-owned 0700 leaf under it is
 *      checked on its own terms by `assertStateDir`.) Clause 2 is applied
 *      independently of clause 1, so a root-owned but world-writable-non-sticky
 *      dir is still refused.
 *
 * `lstatSync` (bigint) is used on each existing prefix: a symlink component
 * would already have been followed by the canonical walk, so a symlink still
 * present at a canonical prefix is itself suspect and its own lstat'd owner is
 * what we judge.
 */
export function assertSafeAncestorChain(canonicalBase: string): void {
  const ourUid = process.getuid?.();
  // No uid concept (non-POSIX): the same-UID boundary this rule enforces is
  // not meaningful, so there is nothing to check. Every other consumer of
  // this module already assumes POSIX ownership semantics.
  if (ourUid === undefined) return;

  // Walk from the leaf up to the root, checking every EXISTING component.
  let current = canonicalBase;
  while (true) {
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (err) {
      // A not-yet-existent component (the fresh-install tail) has no inode to
      // own — skip it and keep walking toward the root, where existing
      // ancestors live. Any non-ENOENT fault is a real inability to vouch for
      // the chain and must not read as "safe".
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
        continue;
      }
      throw new StateDirError(
        "UNSAFE_ANCESTOR",
        `state directory ancestor could not be checked: ${current}: ${String(err)}`,
      );
    }

    const uid = stat.uid;
    const mode = stat.mode;
    // Root-owned ancestors are trusted (root is not the same-UID adversary);
    // only a foreign NON-root owner is an attacker-owned traversal point.
    if (uid !== ourUid && uid !== 0) {
      throw new StateDirError(
        "UNSAFE_ANCESTOR",
        `state directory ancestor ${current} is owned by uid ${uid}, neither this process nor root — a ` +
          `different uid that owns a traversed directory can rename or replace the state directory: ${canonicalBase}`,
      );
    }
    const worldOrGroupWritable = (mode & 0o022) !== 0;
    const sticky = (mode & 0o1000) !== 0;
    if (worldOrGroupWritable && !sticky) {
      throw new StateDirError(
        "UNSAFE_ANCESTOR",
        `state directory ancestor ${current} is group/world-writable and not sticky (mode ` +
          `${(mode & 0o7777).toString(8)}) — any uid can rename or replace the next path component: ${canonicalBase}`,
      );
    }

    const parent = dirname(current);
    if (parent === current) break; // reached the filesystem root
    current = parent;
  }
}

/**
 * Creates the state directory if it is absent, then runs the FULL bind
 * validation over it. The order is the whole point: `mkdir` is
 * best-effort and its own mode argument is not trusted (umask masks it,
 * and an attacker may have won the race to create the path first), so
 * nothing is assumed from a successful create — `assertStateDir` still
 * proves ownership, mode, symlink-freedom and ACL-freedom afterwards,
 * exactly as it would for a directory that already existed. Creating
 * without re-asserting would turn the §3.2 boundary into a first-run
 * exemption.
 *
 * `recursive: true` also makes the create idempotent, so two daemons
 * racing a fresh install both proceed to validation rather than one
 * failing EEXIST; the lifecycle lock, not this call, is what makes them
 * a singleton.
 */
export async function ensureStateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: REQUIRED_MODE });
  await assertStateDir(dir, "bind");
}

/**
 * Typed like the linux getfacl path: an exec failure here is a failure of
 * the ACL layer itself, and surfacing it as a raw `ExecFileException`
 * would let a caller that catches `StateDirError` (the type this module
 * documents as its failure mode) miss it entirely and treat an unchecked
 * directory as validated.
 */
async function stripDarwinAcl(dir: string): Promise<void> {
  try {
    await execFileAsync("/bin/chmod", ["-N", dir]);
  } catch (err) {
    throw new StateDirError(
      "EXTENDED_ACL",
      `state directory ACL strip failed (chmod -N): ${dir}: ${String(err)}`,
    );
  }
}

/** Any `/bin/ls -lde` output line matching /^ \d+: / is an ACL entry. */
async function assertNoDarwinAcl(dir: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("/bin/ls", ["-lde", dir]));
  } catch (err) {
    throw new StateDirError(
      "EXTENDED_ACL",
      `state directory ACL check failed (ls -lde): ${dir}: ${String(err)}`,
    );
  }
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
