import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The license a package DECLARES (`package.json` `license`, an SPDX id that
 * npm displays and downstream license scanners gate on) must be the license
 * the repo actually GRANTS (the LICENSE file). Twice now a surface drifted
 * after the 2026-08-03 Apache-2.0 decision — the spec header (fixed
 * 2026-08-03) and the three manifests (still MIT on 2026-09-04) — because
 * nothing pinned any of them to the file.
 *
 * The expected id is DERIVED from the LICENSE text, never hardcoded: a
 * hardcoded "Apache-2.0" here would recreate the same drift one layer up,
 * with this test happily green after someone swapped the LICENSE file.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function spdxIdOfLicenseFile(): string {
  const text = readFileSync(join(REPO_ROOT, "LICENSE"), "utf8");
  const head = text.split("\n").slice(0, 3).join(" ").replace(/\s+/g, " ").trim();
  if (/^Apache License Version 2\.0/.test(head)) return "Apache-2.0";
  if (/^MIT License/.test(head)) return "MIT";
  // Refuse to guess: an unrecognized LICENSE text is a decision this test
  // must not silently classify. Extend the table when the license changes.
  throw new Error(`license.test: unrecognized LICENSE header: ${JSON.stringify(head)}`);
}

interface Manifest {
  name?: string;
  private?: boolean;
  license?: string;
}

/**
 * The workspace's own member globs (`pnpm-workspace.yaml` → `packages:`),
 * so a member root added later (the file already lists `apps/*`) is
 * scanned without anyone remembering to update this test. Only the
 * `<dir>/*` shape is supported — the only shape the file uses; anything
 * else fails loudly rather than being silently skipped.
 */
function workspaceMemberRoots(): string[] {
  const lines = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8").split("\n");
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (start < 0) throw new Error("license.test: pnpm-workspace.yaml has no `packages:` list");
  const roots: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // Blank lines and comments inside the list are not its end — stopping
    // there would silently drop every later root.
    if (/^\s*(#.*)?$/.test(line)) continue;
    const glob = /^\s+-\s+(.+?)\s*$/.exec(line)?.[1];
    if (glob === undefined) break;
    const dir = /^([A-Za-z0-9_-]+)\/\*$/.exec(glob)?.[1];
    if (!dir) throw new Error(`license.test: unsupported workspace glob ${JSON.stringify(glob)}`);
    roots.push(dir);
  }
  return roots;
}

function publishableManifests(): Array<{ path: string; manifest: Manifest }> {
  return (
    workspaceMemberRoots()
      .map((root) => join(REPO_ROOT, root))
      // A root the file names but that does not exist yet (`apps/`) is not an
      // error — it is simply empty until the first member lands.
      .filter((rootDir) => existsSync(rootDir))
      .flatMap((rootDir) =>
        readdirSync(rootDir, { withFileTypes: true })
          // Tool caches and editor state directories under a root (dot-dirs)
          // are not members — pnpm's own globs never match them either — and
          // a `.cache/package.json` must not be mistaken for a publishable one.
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => join(rootDir, d.name, "package.json")),
      )
      // A workspace member IS a directory with a manifest.
      .filter((path) => existsSync(path))
      .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, "utf8")) as Manifest }))
      .filter(({ manifest }) => manifest.private !== true)
  );
}

describe("license identity (LICENSE file ↔ package manifests)", () => {
  it("the LICENSE file is one this test recognizes", () => {
    expect(spdxIdOfLicenseFile()).toMatch(/^[A-Za-z0-9.-]+$/);
  });

  it("the member roots are exactly the ones pnpm-workspace.yaml declares", () => {
    // Pinned to the file's full list, not a subset: a parser regression that
    // returns only the first root would otherwise pass while skipping the
    // rest of the workspace.
    expect(workspaceMemberRoots()).toEqual(["packages", "apps"]);
  });

  it("every publishable manifest declares exactly the license the LICENSE file grants", () => {
    const expected = spdxIdOfLicenseFile();
    const manifests = publishableManifests();
    // Non-vacuous: a broken walk (moved packages dir, everything private)
    // must fail loudly rather than pass on an empty set.
    expect(manifests.length).toBeGreaterThan(0);
    for (const { path, manifest } of manifests) {
      expect(manifest.license, `${path} declares "${manifest.license}"`).toBe(expected);
    }
  });

  it("the workspace root is private, so its (absent) license field is out of scope by design", () => {
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Manifest;
    expect(root.private).toBe(true);
  });
});
