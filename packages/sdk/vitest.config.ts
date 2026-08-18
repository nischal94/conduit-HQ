import { defineConfig } from "vitest/config";

// The sdk suite runs the QuickJS WASM sandbox, whose §16 DoS-resilience
// tests deliberately overflow the host stack in 150-iteration loops, each
// rebuilding the WASM module. Five test files touch the sandbox
// (quickjs, execute, manager, e2e.smoke, credentials). Under vitest's
// default forks pool with unbounded parallelism, these WASM-heavy files
// can land on the same constrained CI worker and exhaust its memory,
// killing the worker — which fails the whole run with a non-zero exit even
// though every test PASSED. This is a resource-contention flake, not a
// sandbox defect: the §16 stress block is 15/15 clean when run in
// isolation locally (2026-08-18 investigation).
//
// The fix is structural, not a blanket retry (a retry could mask a real
// assertion failure — a §16 boundary break must always be loud). We cap
// the fork pool so the memory-heavy WASM files cannot all pile onto one
// worker at once, giving the constrained CI runner headroom. `singleFork`
// is deliberately NOT used — that would serialize the whole ~50s suite;
// bounding maxForks keeps parallelism while removing the pile-up.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        // Bounded so WASM-heavy sandbox files spread across workers rather
        // than contending for one worker's heap. 2 keeps the suite parallel
        // (local wall-clock unchanged) while capping peak concurrent WASM
        // module instances on a constrained runner.
        maxForks: 2,
        minForks: 1,
      },
    },
  },
});
