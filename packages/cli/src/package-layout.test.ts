import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "./dispatch.js";

/**
 * Pins the D-R6 layout the daemon auto-start depends on: `daemonEntryPoint()`
 * resolves "./bin.js" beside the running code, so in this package's dist
 * `bin.js` MUST be mcp's daemon entry and the dispatcher MUST live elsewhere.
 * Requires a fresh `pnpm -r build`.
 */
const dist = join(process.cwd(), "dist");

describe("packed CLI layout", () => {
  it("dist/bin.js is the daemon entry, not the dispatcher", () => {
    const bin = readFileSync(join(dist, "bin.js"), "utf8");
    expect(bin.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(bin).toContain('"--daemon"');
    expect(bin).not.toContain("Usage: conduit <command>");
  });

  it("dist/conduit.js is the Node-version guard in front of the dispatcher", () => {
    const conduit = readFileSync(join(dist, "conduit.js"), "utf8");
    expect(conduit.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(conduit).toContain("is not supported");
    // It must never reach the daemon entry at runtime.
    expect(conduit).not.toMatch(/import\(\s*["']\.\/bin\.js["']\s*\)/);
  });

  it("running dist/conduit.js reaches the DISPATCHER, not mcp's entry", () => {
    // --help, not --version: mcp's entry also answers --version with the
    // same string, so a version check passes when the wrong module loads.
    const out = execFileSync(process.execPath, [join(dist, "conduit.js"), "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(out).toContain("Usage: conduit <command>");
  });

  it("no emitted file imports a workspace package", () => {
    const offenders = (readdirSync(dist, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))
      // Every specifier form: `from "..."` (import and re-export), bare
      // side-effect `import "..."`, dynamic `import("...")`, and `require("...")`.
      .filter((f) =>
        /(?:\bfrom|\bimport|\bimport\(|\brequire\()\s*["']@conduithq\//.test(
          readFileSync(join(dist, f), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("manifest bins, version, and dependencies match the packed layout", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.version).toBe(VERSION);
    expect(pkg.bin).toEqual({ conduit: "./dist/conduit.js", "conduit-mcp": "./dist/bin.js" });
    expect(Object.keys(pkg.dependencies).filter((d) => d.startsWith("@conduithq/"))).toEqual([]);
  });
});
