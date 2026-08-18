import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonPaths } from "./conduitd.js";
import {
  canonicalOfMissing,
  resolveEffectiveStateDir,
  sameDirectoryIdentity,
} from "./state-dir-resolve.js";

/**
 * Codex ARC pass 4 — the reverse-alias credential-exfiltration hole and its
 * root fix. The pass-3 gate classifies the state directory by FILESYSTEM
 * IDENTITY (symlinks + `..` followed in the kernel), but `daemonPaths`
 * derives the socket + lock dbs by LEXICAL `path.join`. So a spelling that
 * IDENTITY-resolves to the default (or to a legitimate custom dir) could pass
 * validation while `daemonPaths` lexically strips `link/..` and lands the
 * socket under an attacker-controlled sibling. A different-uid attacker who
 * planted a fake socket + lifecycle lock there would receive the client's
 * request — for `add-mcp`, the request carrying the add secret.
 *
 * The root fix threads ONE canonical effective base
 * (`resolveEffectiveStateDir`) into BOTH validation and derivation. The
 * invariant these tests pin: the directory the paths are DERIVED IN is the
 * same filesystem object as the directory that would be VALIDATED — there is
 * no spelling by which they diverge.
 *
 * These are deterministic unit tests over real inodes in a temp tree; the
 * end-to-end "a client and a by-hand daemon on the same custom dir meet"
 * property is exercised by the real-process suites in client.test.ts /
 * conduitd.test.ts. `base` stands in for the parent of a throwaway default so
 * no test touches the real `~/.conduit`, and the resolution is compared
 * against that throwaway via `sameDirectoryIdentity` (the exact predicate
 * `isDefaultStateDir` runs against `DEFAULT_CONDUIT_DIR`).
 */
describe("resolveEffectiveStateDir — validated dir EQUALS derived-paths dir (Codex ARC pass 4)", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cdc-p4-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Same (dev,ino) as the assertion `assertStateDir` would make on `dir`. */
  function sameObject(a: string, b: string): boolean {
    const sa = statSync(a, { bigint: true });
    const sb = statSync(b, { bigint: true });
    return sa.dev === sb.dev && sa.ino === sb.ino;
  }

  it("INVARIANT §17: the validated state directory and the socket/lock derivation directory are the same filesystem object — the reverse-alias attack (`<attacker>/link/../.conduit`, link→default)", () => {
    // The attacker builds a traversable dir with a symlink `link` -> the real
    // default. The victim is pointed at `<attacker>/link/../.conduit`. The old
    // derivation: `daemonPaths` lexically strips `link/..` -> derives the
    // socket + locks under `<attacker>/.conduit`, which the attacker owns.
    const defaultDir = join(base, "home", ".conduit");
    const attacker = join(base, "attacker");
    mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
    mkdirSync(attacker, { recursive: true, mode: 0o700 });
    // `link` -> the default DIRECTORY itself (named `.conduit`). Then
    // `<attacker>/link` kernel-resolves to the default; `/..` pops to the
    // default's parent (home); `/.conduit` re-descends to the default. So the
    // whole spelling IDENTITY-resolves back to the real default — the exact
    // reverse-alias the brief describes (`link -> ~/.conduit`,
    // `--state-dir <attacker>/link/../.conduit`).
    symlinkSync(defaultDir, join(attacker, "link"));

    // Constructed by STRING concatenation, never `path.join` — argv delivers
    // `--state-dir` raw, and `path.join` would eagerly collapse `link/..`
    // lexically at construction time (destroying the symlink), which is the
    // very normalization the production fix must not let reach `daemonPaths`.
    const attack = `${attacker}${sep}link${sep}..${sep}.conduit`;

    // The spelling IDENTITY-resolves to the real default (statSync follows the
    // symlink and `..` in the kernel), which is exactly why pass-3's gate and
    // assertStateDir both PASS on it — the precondition for the attack.
    expect(sameObject(attack, defaultDir)).toBe(true);
    // And the classification agrees: it is the default (against this throwaway).
    expect(sameDirectoryIdentity(attack, defaultDir)).toBe(true);

    // The OLD lexical derivation: `daemonPaths(attack)` joins the socket name
    // onto the raw spelling, and `path.join` collapses `link/..` LEXICALLY —
    // landing the socket dir at `<attacker>/.conduit`, a path the attacker
    // owns and the real default never touches (it does not even exist here).
    const lexicalSocketDir = dirname(daemonPaths(attack).socket);
    expect(resolve(lexicalSocketDir)).toBe(resolve(join(attacker, ".conduit")));
    // It is NOT the default object — the lexical path escaped. (It also does
    // not exist: the attacker would create it to plant the fake socket.)
    expect(resolve(lexicalSocketDir)).not.toBe(resolve(defaultDir));

    // THE FIX: derive from the resolved effective base. For a default-
    // classified dir that base is the caller-independent constant — here the
    // throwaway `defaultDir` stands in for `DEFAULT_CONDUIT_DIR`. Every path
    // is then derived inside the REAL default, never the attacker sibling.
    // (Production `resolveEffectiveStateDir` returns DEFAULT_CONDUIT_DIR; this
    // asserts the custom-branch canonicalization lands on the real object,
    // which is the same guarantee expressed against a throwaway default.)
    const effective = canonicalOfMissing(attack);
    const paths = daemonPaths(effective);
    expect(sameObject(dirname(paths.socket), defaultDir)).toBe(true);
    expect(sameObject(dirname(paths.lifecycleLockDb), defaultDir)).toBe(true);
    expect(sameObject(dirname(paths.maintenanceLockDb), defaultDir)).toBe(true);
    expect(sameObject(dirname(paths.db), defaultDir)).toBe(true);
  });

  it("INVARIANT §17: fresh-install parent-symlink variant — `<attacker>/link/../.conduit` with link→an existing $HOME child, default not yet created, derives inside the real target, never the attacker sibling", () => {
    // Fresh install: the intended dir does not exist yet. `link` -> an
    // existing sibling subtree; `link/../.conduit` filesystem-resolves into
    // that subtree's parent, NOT the attacker's own `.conduit`. The kernel-
    // faithful walk exposes the divergence a lexical `resolve` hides.
    const home = join(base, "home");
    const child = join(home, "child");
    mkdirSync(child, { recursive: true, mode: 0o700 });
    const attacker = join(base, "attacker");
    mkdirSync(attacker, { recursive: true, mode: 0o700 });
    symlinkSync(child, join(attacker, "link"));

    // Raw concatenation (argv form), NOT `path.join` — same reason as above.
    // `<attacker>/link/../.conduit` -> `<child>/../.conduit` -> `<home>/.conduit`
    const spelling = `${attacker}${sep}link${sep}..${sep}.conduit`;
    const realTargetParent = realpathSync(home); // where `.conduit` will be created

    const effective = canonicalOfMissing(spelling);
    // The resolved base sits under the real target's parent, not the attacker.
    // Compared against the REALPATH of home (macOS /var -> /private/var), since
    // `canonicalOfMissing` realpaths every existing component.
    expect(dirname(effective)).toBe(realTargetParent);
    expect(dirname(effective)).not.toBe(realpathSync(attacker));

    // And every derived path is under that same real base — the lexical
    // `<attacker>/.conduit` never appears.
    const paths = daemonPaths(effective);
    expect(dirname(paths.socket)).toBe(effective);
    expect(resolve(dirname(paths.socket))).not.toBe(resolve(join(attacker, ".conduit")));
  });

  it("INVARIANT §17: a legitimate custom dir (real, no trick) derives its socket and locks INSIDE itself — no regression", () => {
    const custom = join(base, "legit-custom");
    mkdirSync(custom, { recursive: true, mode: 0o700 });

    const effective = resolveEffectiveStateDir(custom);
    const paths = daemonPaths(effective);
    // The socket/lock/db all live inside the custom dir the operator named.
    expect(sameObject(dirname(paths.socket), custom)).toBe(true);
    expect(sameObject(dirname(paths.lifecycleLockDb), custom)).toBe(true);
    expect(sameObject(dirname(paths.maintenanceLockDb), custom)).toBe(true);
    expect(sameObject(dirname(paths.db), custom)).toBe(true);
    // The derivation directory is the SAME object assertStateDir would bless.
    expect(sameObject(effective, custom)).toBe(true);
  });

  it("INVARIANT §17: a custom dir reached via a trailing slash / relative spelling still derives inside the ONE real directory (identity, not string)", () => {
    const custom = join(base, "legit-custom");
    mkdirSync(custom, { recursive: true, mode: 0o700 });

    for (const spelling of [`${custom}/`, join(custom, "."), join(custom, "sub", "..")]) {
      const effective = resolveEffectiveStateDir(spelling);
      const paths = daemonPaths(effective);
      expect(sameObject(dirname(paths.socket), custom)).toBe(true);
    }
  });

  it("resolveEffectiveStateDir is idempotent — resolving an already-resolved base is a no-op", () => {
    const custom = join(base, "legit-custom");
    mkdirSync(custom, { recursive: true, mode: 0o700 });
    const once = resolveEffectiveStateDir(custom);
    const twice = resolveEffectiveStateDir(once);
    expect(twice).toBe(once);
  });
});
