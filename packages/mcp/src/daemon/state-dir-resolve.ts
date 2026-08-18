/**
 * State-directory classification and canonical resolution (design §3.1/§3.2).
 *
 * One question runs through this module: given a `stateDir` string a caller
 * named, WHICH filesystem object does a real operation on it land on, and is
 * that object the canonical default? The answer must be by FILESYSTEM
 * IDENTITY (inodes, symlinks followed in the kernel), never by lexical string
 * arithmetic — because the socket, the lock dbs and the database are all
 * derived from this base, and a lexical answer that disagrees with the kernel
 * is a boundary hole (Codex ARC passes 3 and 4).
 *
 * It lives in its own module, depending on nothing but node stdlib and the
 * `DEFAULT_CONDUIT_DIR` constant, so BOTH the client (`client.ts`) and the
 * daemon (`conduitd.ts`, via `bin.ts`) resolve their effective base through
 * the SAME code with no import cycle between them. That shared base is what
 * makes the directory a client validates and the directory a daemon binds in
 * provably the same object.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DEFAULT_CONDUIT_DIR } from "../env.js";

/**
 * The `(device, inode)` identity of the DIRECTORY a real filesystem
 * operation on `target` would land on, or `undefined` if `target` does
 * not resolve to an existing directory.
 *
 * `statSync` (NOT `lstat`) follows every symlink and resolves the whole
 * path IN THE KERNEL, so its `dev`/`ino` name the actual on-disk object —
 * the one `assertStateDir`'s `lstat`/`daemonPaths`' file operations would
 * touch. That is the ONLY faithful identity here. A lexical `resolve`
 * collapses `<default>/s/..` to `<default>` by string arithmetic, and
 * `realpathSync` returns that same misleading string on macOS even though
 * the kernel resolves `s`→(custom dir)→`..`→(custom's PARENT); the inode
 * disagrees with both. Comparing inodes rather than strings is what makes
 * the check faithful to the filesystem instead of to `path`'s textual
 * rules (Codex ARC pass 3, Medium).
 *
 * `bigint: true` because a JS-number `ino` loses precision above 2^53, so
 * two distinct inodes could round to the same number and manufacture a
 * false identity; the BigInt form is exact. A non-directory (a file, a
 * socket) is not a state directory and reads as `undefined` — the gate
 * only ever means a real directory. A non-`ENOENT` error is NOT "absent"
 * and must never read as a match: an `EACCES` on a component means "could
 * not determine", so it propagates rather than silently classifying an
 * undeterminable path as the default.
 */
function directoryIdentity(target: string): { dev: bigint; ino: bigint } | undefined {
  try {
    const s = statSync(target, { bigint: true });
    if (!s.isDirectory()) return undefined;
    return { dev: s.dev, ino: s.ino };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * True iff `target` has NO directory entry at all — a genuine absence, as
 * opposed to a DANGLING symlink. `statSync` cannot tell them apart (it
 * follows the link and reports `ENOENT` for both), so the fresh-install
 * branch — which trusts "absent means no symlink to resolve" — must
 * confirm the stronger condition with `lstatSync`, which does NOT follow
 * the final component. A dangling symlink IS a symlink and could be
 * retargeted, so it must not be treated as a plain missing path.
 */
function isGenuinelyAbsent(target: string): boolean {
  try {
    lstatSync(target);
    return false; // an entry exists (a dangling symlink lands here)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
}

/**
 * The canonical, symlink-resolved absolute path of `target`, faithful
 * whether the path fully exists, partly exists, or is entirely
 * not-yet-created.
 *
 * The walk is KERNEL-FAITHFUL and left-to-right, NOT a lexical `resolve`
 * followed by realpath. A `resolve` up front would collapse `lk/../x`
 * (where `lk` is a symlink) by string arithmetic, losing the symlink
 * exactly as the string bug in the identity check does — so `..` is resolved
 * against the REAL (realpath'd) prefix instead: every existing component
 * is realpath'd as it is consumed (following a symlink there in the
 * kernel), and a `..` pops the already-resolved base. Once the walk
 * passes into the not-yet-existent tail, segments (including `..`) are
 * handled lexically, which is faithful because a component that does not
 * exist cannot be a symlink and cannot alias anything. Two paths are "the
 * same" only when this canonical form is identical, which no symlink can
 * forge — and a fully-existing directory canonicalizes to its own realpath,
 * which is exactly the base its socket and locks must derive from.
 */
export function canonicalOfMissing(target: string): string {
  const abs = isAbsolute(target) ? target : resolve(target);
  const segments = abs.split(sep).filter((s) => s.length > 0);
  let base = realpathSync(sep); // the root always exists
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      base = dirname(base);
      continue;
    }
    const next = join(base, seg);
    try {
      // Follows a symlink AT this component in the kernel.
      base = realpathSync(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Into the not-yet-existent tail: lexical from here is faithful.
      base = next;
    }
  }
  return base;
}

/**
 * True iff `stateDir` names the canonical default state directory — the
 * ONE directory a production auto-start may target (Codex ARC F5) — by
 * FILESYSTEM IDENTITY, not lexical string equality.
 *
 * `spawnDaemon` is zero-argument and derives the default directory from
 * the child's own uid, so an auto-start is only ever correct when the
 * client is itself pointed at that same default. The old check compared
 * `resolve()`d strings, which a symlink + `..` defeats: `<default>/s/..`
 * (with `<default>/s` a symlink into a 0700 custom dir) string-collapses
 * to `<default>` and classified as default, while a real filesystem op on
 * that same path resolves through the symlink to a DIFFERENT directory —
 * so a custom state dir reached the production zero-argument spawn / the
 * default-daemon path the pass-2 gate was meant to close (Codex ARC pass
 * 3, Medium). The gate now compares FILESYSTEM identity.
 *
 * Trailing slashes, `.`, and other trivial spellings of the REAL default
 * still classify as default, because identity is by the resolved on-disk
 * object, not by the string. A non-`ENOENT` fault (`EACCES`, `ELOOP`)
 * propagates rather than being read as either match or absence.
 */
export function isDefaultStateDir(stateDir: string): boolean {
  return sameDirectoryIdentity(stateDir, DEFAULT_CONDUIT_DIR);
}

/**
 * The identity comparison behind `isDefaultStateDir`, factored out ONLY so
 * a test can exercise it against a throwaway `defaultDir` — production has
 * exactly one default (`DEFAULT_CONDUIT_DIR`, a load-time constant) and no
 * caller passes another. Every role (serve/approvals/add-mcp/doctor)
 * routes through `isDefaultStateDir`, which routes here, so the gate lives
 * in one place with no bypass. Exported for the ARC regression tests; not
 * part of the client's public surface.
 *
 *  - Both the default and `candidate` resolve to existing directories →
 *    compare `(dev, ino)`. This is what the kernel would act on, so no
 *    symlink/`..` spelling can make a non-default directory match. A
 *    cross-device hard link to a directory is impossible on our
 *    platforms, so `(dev, ino)` is a total identity.
 *  - Exactly one resolves to a directory → they cannot be the same
 *    directory (an alternate spelling of an existing directory
 *    necessarily exists) → not the same. This also covers a dangling
 *    symlink or a non-directory on one side.
 *  - Neither resolves (fresh install) → require BOTH genuinely absent
 *    (no directory entry at all, `lstat` so a DANGLING symlink does not
 *    qualify) and compare the kernel-faithful canonical forms.
 */
export function sameDirectoryIdentity(candidate: string, defaultDir: string): boolean {
  const defaultId = directoryIdentity(defaultDir);
  const candidateId = directoryIdentity(candidate);

  if (defaultId !== undefined && candidateId !== undefined) {
    return defaultId.dev === candidateId.dev && defaultId.ino === candidateId.ino;
  }
  // Exactly one resolves to a directory: an alternate spelling of an
  // existing directory necessarily exists too, so a present/absent split
  // is proof they are different directories.
  if (defaultId !== undefined || candidateId !== undefined) return false;
  // Neither resolves to a directory — the fresh-install case. Require BOTH
  // to be GENUINELY absent (no directory entry at all), so a dangling
  // symlink cannot slip into the tail-is-lexical reasoning; then compare
  // the kernel-faithful canonical forms of the not-yet-existent paths.
  if (!isGenuinelyAbsent(defaultDir) || !isGenuinelyAbsent(candidate)) return false;
  return canonicalOfMissing(candidate) === canonicalOfMissing(defaultDir);
}

/**
 * The ONE canonical effective base a caller derives everything from — the
 * value threaded into BOTH `assertStateDir` (validation) and `daemonPaths`
 * (socket + lock-db + db derivation), so the directory that is VALIDATED and
 * the directory the paths are DERIVED IN are the same filesystem object
 * (Codex ARC pass 4).
 *
 * The unfixed defect it closes: `isDefaultStateDir`/`assertStateDir` classify
 * and validate by FILESYSTEM IDENTITY (they follow symlinks and `..` in the
 * kernel), while `daemonPaths` joins by LEXICAL string arithmetic. A raw
 * `<attacker>/link/../.conduit` (with `link` → the real default) resolves
 * through the symlink to the default's inode — so the gate and the validation
 * both pass on the REAL default — yet `daemonPaths` lexically strips
 * `link/..` and derives the socket/lock paths under `<attacker>/.conduit`.
 * A different-uid attacker who planted a fake socket + lifecycle lock there
 * would then receive the client's request (for `add-mcp`, the request that
 * carries the add secret). Deriving from THIS resolved base instead removes
 * every path by which the validated dir and the derived-paths dir can differ.
 *
 * Two branches, matching the two ways a directory is classified:
 *
 *  - **Default** (`isDefaultStateDir`) → the trusted `DEFAULT_CONDUIT_DIR`
 *    CONSTANT, never the caller's spelling. This is Codex's minimum: a
 *    path classified as the default derives against the constant the
 *    zero-argument `spawnDaemon` and the daemon's own startup both use, so
 *    client and daemon reach the same socket, and no attacker spelling that
 *    merely resolves to the default can steer derivation elsewhere.
 *  - **Custom** → the directory's OWN kernel-faithful canonical path
 *    (`canonicalOfMissing`: every existing component realpath'd, `..`
 *    applied to the resolved prefix, a not-yet-existent tail lexical and
 *    thus unforgeable). A legitimate custom dir still derives its socket and
 *    locks inside itself; the raw lexical spelling never reaches
 *    `daemonPaths`, so the reverse-alias attack has no lexical residue to
 *    exploit.
 *
 * Idempotent by construction: the default constant and an already-canonical
 * custom path both map to themselves, so resolving twice is a no-op.
 */
export function resolveEffectiveStateDir(stateDir: string): string {
  if (isDefaultStateDir(stateDir)) return DEFAULT_CONDUIT_DIR;
  return canonicalOfMissing(stateDir);
}
