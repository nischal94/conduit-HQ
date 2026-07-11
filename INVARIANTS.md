# Invariants ledger

The spec's load-bearing claims — security invariants and product promises —
are pinned by named tests, not by convention or reviewer vigilance. When one
of these tests fails, the failure output names the spec section being
violated.

**Naming:** invariant tests carry an `INVARIANT §x.y:` prefix in their
test name.

**Rule (see CLAUDE.md):** a module that implements a spec invariant may not
land without its invariant test in the same commit, and this ledger's row
flips in that same commit. Unpinned claims stay visibly ⏳ — a ⏳ row is a
promise the product makes but does not yet enforce.

| Spec claim | Pinning test | Status |
| --- | --- | --- |
| §4.2 / §8 — search hits never carry schemas | `packages/sdk/src/catalog.test.ts` | ✅ pinned |
| §8 — schemas load only on explicit describe (lazy) | `packages/sdk/src/catalog.test.ts` | ✅ pinned |
| §10.1 — riskClass default mapping table | `packages/sdk/src/risk.test.ts` | ✅ pinned |
| §7 — policies persist across source refresh; manual overrides never silently reverted | `packages/sdk/src/store/sqlite.test.ts` | ✅ pinned |
| §9.2 — secrets encrypted at rest (master key) | `packages/sdk/src/store/sqlite.test.ts` + `secrets.test.ts` | ✅ pinned |
| §4.2 — execute surface ≈ 1 tool / ~1,044 tokens | `packages/sdk/src/execute.test.ts` | ✅ pinned |
| §9.2 — a secret never enters sandbox heap / agent code / agent / model | `packages/sdk/src/credentials.test.ts` | ✅ pinned |
| §9.3 — loopback/private egress off by default (authoritative check: per-connect IP pinning, `createPinnedLookup` — canonicalize-then-check, closes DNS-rebinding TOCTOU per spec §18) | `packages/sdk/src/pipeline/egress.test.ts` (redirect refusal covered in `pipeline/upstream.test.ts`) | ✅ pinned |
| §11 — Trace stores no raw credentials; inputs redacted per policy (write-time; full `output` dropped from Trace — replay journal deliberately unredacted per §5.5 D7) | `packages/sdk/src/pipeline/invoker.test.ts` (+ D7 guard in `execution/manager.test.ts`) | ✅ pinned |
| §16 — runaway executions interrupted (time / memory / output caps) | `packages/sdk/src/sandbox/quickjs.test.ts` | ✅ pinned |
| §5.5 — pause/resume via deterministic replay (journaled results, seeded non-determinism) | `packages/sdk/src/execution/manager.test.ts` | ✅ pinned |
| §10.2 — policy defaults: safe→Allow, review/destructive→Require approval; block never seeded | `packages/sdk/src/policy.test.ts` | ✅ pinned |
| /mcp M1 — the human-only approval seam: no resume/approve tool on the MCP surface | `packages/mcp/src/server.test.ts` | ✅ pinned |
| /mcp M8 — stdout purity: every stdout byte the client transport did NOT consume is protocol-framed | `packages/mcp/src/integration.test.ts` | ✅ pinned |
| §4.2 — `check_execution` definition stays ≤ 256 estimated tokens (the M1 design's status-check counterpart to the execute token pin above) | `packages/mcp/src/payloads.test.ts` | ✅ pinned |
| /mcp M4 — outcome persistence: a stored `failed` row always explains itself (synthetic `ConduitPersistError` fallback on a faulted settle write) | `packages/sdk/src/execution/manager.test.ts` (credential-echo persisted-outcome facet covered in `packages/sdk/src/e2e.smoke.test.ts` — "runs the whole prototype flow with no secret leakage", Phase 11) | ✅ pinned |
| §4.2 — execute surface stays within the one-tool token budget (~1,044) with a capped connection listing | `packages/sdk/src/execute.test.ts` | ✅ pinned |
| /mcp CLI — approvals queue lists paused executions oldest-first (deterministic (started_at, id)) | `packages/sdk/src/store/sqlite.test.ts` | ✅ pinned |

---

**Adversarial review has a stop line.** A cross-model pass over these
invariants has converged (ship) when every finding is either out-of-scope by a
spec §18 decision, or against a layer labeled best-effort defense-in-depth
(e.g. the §9.2 credential-echo scan). Do not extend a denylist-shaped check per
finding — fix the shape (canonicalize, as §9.3 egress now does via
`createPinnedLookup`) or relabel it best-effort. See CLAUDE.md → "Adversarial
review has a stop line" and `~/.claude/rules/adversarial-convergence.md`.
