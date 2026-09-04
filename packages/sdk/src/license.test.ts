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

function publishableManifests(): Array<{ path: string; manifest: Manifest }> {
  const packagesDir = join(REPO_ROOT, "packages");
  return (
    readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(packagesDir, d.name, "package.json"))
      // A workspace member IS a directory with a manifest; tool caches and
      // editor state directories under packages/ (dot-dirs) are not members.
      .filter((path) => existsSync(path))
      .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, "utf8")) as Manifest }))
      .filter(({ manifest }) => manifest.private !== true)
  );
}

describe("license identity (LICENSE file ↔ package manifests)", () => {
  it("the LICENSE file is one this test recognizes", () => {
    expect(spdxIdOfLicenseFile()).toMatch(/^[A-Za-z0-9.-]+$/);
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
