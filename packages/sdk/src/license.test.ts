import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every package manifest must declare the license the repo actually ships.
 *
 * WHY THIS EXISTS. Apache-2.0 was decided 2026-08-03 (spec §18) and the
 * LICENSE file was replaced, but three manifests kept `"license": "MIT"`
 * until 2026-09-04 — a month of the wrong licence in the field that npm
 * publishes, registries index, and downstream licence scanners gate on.
 * MIT has no express patent grant, so the two are not interchangeable.
 *
 * The same drift had already happened once: the spec header still read
 * `License: MIT` five days after the decision (LEARNINGS, 2026-08-03), and
 * the sweep that fixed it did not reach the manifests. Nothing was pinning
 * either surface, so both rotted silently.
 *
 * The check reads the LICENSE FILE rather than hardcoding a name, so a
 * future relicence updates one place and this test follows. Hardcoding
 * "Apache-2.0" here would recreate the same problem one layer up.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** The SPDX id the repo's own LICENSE file represents. */
function licenseFromFile(): string {
  const text = readFileSync(join(REPO_ROOT, "LICENSE"), "utf8");
  if (/Apache License\s+Version 2\.0/.test(text)) return "Apache-2.0";
  if (/MIT License/.test(text)) return "MIT";
  throw new Error("[license.test] Unrecognised LICENSE file. Add its SPDX id here deliberately.");
}

/** Every workspace package manifest, found rather than listed. */
function manifests(): { name: string; path: string; json: Record<string, unknown> }[] {
  const pkgDir = join(REPO_ROOT, "packages");
  return readdirSync(pkgDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const path = join(pkgDir, e.name, "package.json");
      return { name: e.name, path, json: JSON.parse(readFileSync(path, "utf8")) };
    });
}

describe("package licences match the LICENSE file", () => {
  it("finds the workspace packages at all", () => {
    // An empty walk would make every assertion below pass while checking
    // nothing: "found no work" must not read as "everything is fine".
    expect(manifests().length).toBeGreaterThanOrEqual(3);
  });

  it("recognises the repo's LICENSE file", () => {
    expect(licenseFromFile()).toBe("Apache-2.0");
  });

  it.each(
    manifests().map((m) => [m.name, m] as const),
  )("%s declares the shipped licence", (_name, m) => {
    expect(
      m.json.license,
      `${m.path} declares "${m.json.license}" but the repo ships ${licenseFromFile()}`,
    ).toBe(licenseFromFile());
  });
});
