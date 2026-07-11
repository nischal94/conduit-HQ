import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", bin: "src/bin.ts" },
  format: "esm",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
});
