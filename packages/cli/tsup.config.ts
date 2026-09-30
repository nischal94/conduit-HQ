import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // The Node-version guard (DX review D5). It statically imports only the
    // dependency-free src/node-support.ts, checks the version, and only then
    // dynamic-imports ./cli.js, so an unsupported Node gets one clear line
    // instead of a failure inside some dependency.
    conduit: "src/entry.ts",
    // mcp's daemon entry, emitted as dist/bin.js: daemonEntryPoint()
    // resolves "./bin.js" beside the running code, so an auto-started
    // daemon runs this file. Built from mcp's dist so both entries share
    // one copy of mcp's chunks.
    bin: "../mcp/dist/bin.js",
  },
  format: "esm",
  // The CLI's index exports only dispatch symbols, so its types reference
  // no workspace package and need no cross-package type bundling.
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  noExternal: [/^@conduithq\//],
});
