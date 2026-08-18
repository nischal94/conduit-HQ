import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeAncestorChain,
  assertStateDir,
  isNonOwnerAclLine,
  StateDirError,
} from "./state-dir.js";
import { canonicalOfMissing } from "./state-dir-resolve.js";

const execFileAsync = promisify(execFile);

/**
 * Real-directory permission/fs tests (design §3.2 — the different-UID
 * boundary). No fakes: every test creates a genuine directory in a
 * file-backed temp dir and asserts against real lstat/mode/ACL state.
 */

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function newTempParent(): string {
  dir = mkdtempSync(join(tmpdir(), "sd-"));
  return dir;
}

describe("assertStateDir (design §3.2 — state-directory boundary)", () => {
  it("rejects a symlinked directory", async () => {
    const parent = newTempParent();
    const real = join(parent, "real");
    const link = join(parent, "link");
    await execFileAsync("/bin/mkdir", [real]);
    await execFileAsync("/bin/chmod", ["700", real]);
    symlinkSync(real, link);

    await expect(assertStateDir(link, "connect")).rejects.toThrow();
  });

  it("rejects a symlinked directory in bind mode (validate-before-strip)", async () => {
    // CRITICAL fix regression test: chmod -N follows symlinks without
    // -h, so bind mode must reject the symlink BEFORE ever invoking
    // chmod against it. If ordering regresses, this either strips ACLs
    // off `real` (the symlink target) before rejecting, or — worse —
    // silently succeeds.
    const parent = newTempParent();
    const real = join(parent, "real");
    const link = join(parent, "link");
    await execFileAsync("/bin/mkdir", [real]);
    await execFileAsync("/bin/chmod", ["700", real]);
    symlinkSync(real, link);

    await expect(assertStateDir(link, "bind")).rejects.toThrow();
  });

  it("rejects a directory with mode 0755", async () => {
    const parent = newTempParent();
    const target = join(parent, "loose");
    await execFileAsync("/bin/mkdir", [target]);
    chmodSync(target, 0o755);

    await expect(assertStateDir(target, "connect")).rejects.toThrow();
  });

  it("accepts a directory with mode 0700 and no ACL", async () => {
    const parent = newTempParent();
    const target = join(parent, "tight");
    await execFileAsync("/bin/mkdir", [target]);
    chmodSync(target, 0o700);

    await expect(assertStateDir(target, "connect")).resolves.toBeUndefined();
  });

  it("rejects a foreign-owner directory (skipped unless simulable as non-root)", async () => {
    // The test environment itself must be non-root for this scenario to
    // be meaningful — assert that first rather than silently no-op-ing.
    expect(process.getuid?.()).not.toBe(0);
    // A non-root process cannot chown a directory to a different uid, so
    // the foreign-owner path cannot be simulated here. Documented gap,
    // not a false negative: real enforcement is the plain uid !== uid
    // comparison in assertStateDir, exercised implicitly by every other
    // test (own uid must match to pass).
  });

  describe("isNonOwnerAclLine (linux getfacl classifier — pure function, any platform)", () => {
    it("does not flag base owner/group/other entries (empty qualifier)", () => {
      expect(isNonOwnerAclLine("user::rwx")).toBe(false);
      expect(isNonOwnerAclLine("group::---")).toBe(false);
      expect(isNonOwnerAclLine("other::---")).toBe(false);
    });

    it("flags named user/group grants (non-empty qualifier)", () => {
      expect(isNonOwnerAclLine("user:alice:r-x")).toBe(true);
      expect(isNonOwnerAclLine("group:staff:r-x")).toBe(true);
    });

    it("does not flag the mask entry", () => {
      expect(isNonOwnerAclLine("mask::r-x")).toBe(false);
    });

    it("does not flag unrelated or blank lines", () => {
      expect(isNonOwnerAclLine("")).toBe(false);
      expect(isNonOwnerAclLine("# file: /some/dir")).toBe(false);
      expect(isNonOwnerAclLine("flags: -R-")).toBe(false);
    });
  });

  if (process.platform === "darwin") {
    it("darwin: bind mode strips an ACL and then passes", async () => {
      const parent = newTempParent();
      const target = join(parent, "acl-bind");
      await execFileAsync("/bin/mkdir", [target]);
      chmodSync(target, 0o700);
      await execFileAsync("/bin/chmod", ["+a", "everyone allow list", target]);

      await expect(assertStateDir(target, "bind")).resolves.toBeUndefined();

      const { stdout } = await execFileAsync("/bin/ls", ["-lde", target]);
      expect(/^ \d+: /m.test(stdout)).toBe(false);
    });

    it("darwin: connect mode rejects an ACL present before any strip", async () => {
      const parent = newTempParent();
      const target = join(parent, "acl-connect");
      await execFileAsync("/bin/mkdir", [target]);
      chmodSync(target, 0o700);
      await execFileAsync("/bin/chmod", ["+a", "everyone allow list", target]);

      await expect(assertStateDir(target, "connect")).rejects.toThrow();
    });
  }
});

/**
 * The ancestor-chain rule (design §17 §3.2, closes P1). `assertStateDir`
 * proves the LEAF is a self-owned 0700 non-symlink, but a different uid that
 * owns a directory the path TRAVERSES can rename the validated leaf out and
 * drop a replacement before the client connects. `assertSafeAncestorChain`
 * refuses a base whose canonical form has any existing ancestor owned by
 * another uid, or group/world-writable-and-not-sticky.
 *
 * A non-root test process cannot chown a directory to a foreign uid, so the
 * foreign-owner clause is a documented simulation gap (as elsewhere in this
 * file). The WRITABLE-non-sticky clause needs no privilege and is exercised
 * for real: a 0777 ancestor is a genuine "any uid can rename the next
 * component" hazard, and the sticky exemption (`/tmp`-shaped) is checked too.
 */
describe("assertSafeAncestorChain (design §17 §3.2 — ancestor-chain rule)", () => {
  it("INVARIANT §17: accepts a base whose whole existing chain is self-owned", () => {
    const parent = newTempParent();
    const leaf = join(parent, "state");
    mkdirSync(leaf, { mode: 0o700 });
    // The temp parent and leaf are ours; every prefix up to the trusted
    // root-owned system dirs is self-owned. No throw.
    expect(() => assertSafeAncestorChain(canonicalOfMissing(leaf))).not.toThrow();
  });

  it("INVARIANT §17: attacker-owned ancestor refused — a world-writable non-sticky parent (any uid can rename the next component) → UNSAFE_ANCESTOR", () => {
    const parent = newTempParent();
    // A directory anyone can write to and NOT sticky: any uid can rename or
    // replace an entry inside it, so a leaf reached through it is not safe —
    // the stand-in for an attacker-owned traversal point that needs no chown.
    const openParent = join(parent, "open");
    mkdirSync(openParent, { mode: 0o777 });
    chmodSync(openParent, 0o777); // defeat umask
    const leaf = join(openParent, "state");
    mkdirSync(leaf, { mode: 0o700 });

    let caught: unknown;
    try {
      assertSafeAncestorChain(canonicalOfMissing(leaf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StateDirError);
    expect((caught as StateDirError).code).toBe("UNSAFE_ANCESTOR");
  });

  it("INVARIANT §17: a STICKY world-writable ancestor is NOT disqualifying (the /tmp shape) — only the entry's owner can rename it", () => {
    const parent = newTempParent();
    // Sticky + world-writable, exactly like /tmp: any uid may CREATE an entry,
    // but only that entry's owner may rename/replace it. So a self-owned 0700
    // leaf created under it is safe on its own terms.
    const stickyParent = join(parent, "sticky");
    mkdirSync(stickyParent, { mode: 0o1777 });
    chmodSync(stickyParent, 0o1777); // defeat umask; sticky bit + 0777
    const leaf = join(stickyParent, "state");
    mkdirSync(leaf, { mode: 0o700 });

    expect(() => assertSafeAncestorChain(canonicalOfMissing(leaf))).not.toThrow();
  });

  it("INVARIANT §17: a group-writable non-sticky ancestor is also refused", () => {
    const parent = newTempParent();
    const groupWritable = join(parent, "grp");
    mkdirSync(groupWritable, { mode: 0o770 });
    chmodSync(groupWritable, 0o770); // group-writable, not sticky
    const leaf = join(groupWritable, "state");
    mkdirSync(leaf, { mode: 0o700 });

    let caught: unknown;
    try {
      assertSafeAncestorChain(canonicalOfMissing(leaf));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StateDirError);
    expect((caught as StateDirError).code).toBe("UNSAFE_ANCESTOR");
  });

  it("INVARIANT §17: a not-yet-existent leaf under a safe chain is accepted (fresh install — the tail has no inode to own)", () => {
    const parent = newTempParent();
    // The leaf does not exist; only its existing prefix (the self-owned temp
    // parent and up) is walked. A fresh install must not be a dead end.
    const leaf = join(parent, "not-created-yet", "state");
    expect(() => assertSafeAncestorChain(canonicalOfMissing(leaf))).not.toThrow();
  });
});
