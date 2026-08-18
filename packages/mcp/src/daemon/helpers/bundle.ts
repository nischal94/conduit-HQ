import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared test-harness bundler for the spawnable daemon helper.
 *
 * The daemon is spawned as a real child, which means Node loads it
 * directly — and Node's strip-only TypeScript mode cannot resolve the
 * `.js` specifiers product code correctly uses for its tsup build. So the
 * helper and everything it imports are bundled once into a temp `.mjs`
 * that Node runs natively. Bundling rather than loosening the product's
 * import style keeps `conduitd.ts` idiomatic with the rest of
 * `packages/mcp`; the test harness absorbs the mismatch.
 *
 * esbuild is reached through the JS API of the declared `tsup` devDep
 * rather than a `node_modules/.bin/esbuild` shim: that shim is a
 * transitive artifact of the local install layout and does not exist
 * under CI's `pnpm install --frozen-lockfile --ignore-scripts`, where it
 * failed test collection with ENOENT. Resolving the package keeps the
 * dependency declared (spec §17) and adds no manifest entry.
 */

const requireFromHere = createRequire(import.meta.url);
const requireFromTsup = createRequire(requireFromHere.resolve("tsup"));

type EsbuildModule = {
  build(options: Record<string, unknown>): Promise<unknown>;
};

const DAEMON_SRC = fileURLToPath(new URL("./run-daemon.ts", import.meta.url));
const SERVE_SRC = fileURLToPath(new URL("./run-serve.ts", import.meta.url));

export type HelperBundle = {
  /** Absolute path of the bundled `run-daemon.mjs`. */
  helper: string;
  /** Absolute path of the bundled `run-serve.mjs` (the stdio server fixture). */
  serve: string;
  /** Removes the temp bundle directory. Safe to call more than once. */
  cleanup(): void;
};

/**
 * Bundles the spawnable helpers into a fresh temp directory and returns
 * their paths plus a cleanup callback.
 *
 * The bundle is emitted inside the package, not the OS temp dir:
 * dependencies are left external, so it must sit somewhere `node_modules`
 * resolution still reaches @conduithq/sdk and @libsql/client.
 */
export async function bundleDaemonHelper(): Promise<HelperBundle> {
  const bundleDir = mkdtempSync(fileURLToPath(new URL("../../../.daemon-test-", import.meta.url)));
  const helper = join(bundleDir, "run-daemon.mjs");
  const serve = join(bundleDir, "run-serve.mjs");

  const esbuild = requireFromTsup("esbuild") as EsbuildModule;
  await esbuild.build({
    entryPoints: [DAEMON_SRC, SERVE_SRC],
    bundle: true,
    platform: "node",
    format: "esm",
    // Leave real dependencies external — only first-party TypeScript
    // needs rewriting, and bundling native/WASM-backed deps would change
    // the runtime under test.
    packages: "external",
    outdir: bundleDir,
    outExtension: { ".js": ".mjs" },
  });

  return {
    helper,
    serve,
    cleanup: () => rmSync(bundleDir, { recursive: true, force: true }),
  };
}
