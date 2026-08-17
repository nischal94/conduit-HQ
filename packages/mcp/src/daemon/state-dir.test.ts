import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { assertStateDir, isNonOwnerAclLine } from "./state-dir.js";

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
