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
| §4.2 — execute surface ≈ 1 tool / ~1,044 tokens | — | ⏳ awaits `execute` tool |
| §9.2 — a secret never enters sandbox heap / agent code / agent / model | — | ⏳ awaits credential resolver + sandbox |
| §9.3 — loopback/private egress off by default | — | ⏳ awaits egress gateway |
| §11 — Trace stores no raw credentials; inputs redacted per policy | — | ⏳ awaits Trace redaction |
| §16 — runaway executions interrupted (time / memory / output caps) | — | ⏳ awaits sandbox |
| §5.5 — pause/resume via deterministic replay (journaled results, seeded non-determinism) | — | ⏳ awaits execution manager |
| §10.2 — policy defaults: safe→Allow, review/destructive→Require approval | — | ⏳ awaits policy engine |
