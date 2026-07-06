# Handoff

The baton between sessions. **Protocol:**

1. **Session start:** read this file first, then whatever it tells you to
   read. Do not re-derive project state from scratch.
2. **Session end:** rewrite this file — repo state, next task with
   acceptance criteria, kickoff prompt. Append the session's lessons to
   LEARNINGS.md. Decisions belong in the spec / CLAUDE.md, not here.
3. This file only *points*; it never duplicates spec content. Git history
   is the archive of past handoffs.

**Staleness tripwire (run before trusting anything below):** compare
`git log -1 --format=%h` with `git log -1 --format=%h -- HANDOFF.md`.
If they differ, work happened after this handoff was written — it is
stale by exactly the commits between them. Reconstruct state from
`git log` over that range, rewrite this file FIRST, then start the task.
A session that ends abnormally can't lie here; git tells on it.

---

## Current handoff — written 2026-07-06 (policy engine v1 session)

### Where things stand

- **Policy engine v1 SHIPPED — PR #13 merged (`f5e0e8a`), the Phase 1
  opener.** Quiz gate passed 5/5 by the human before merge. `main` is
  green: 112/112 tests, typecheck + Biome clean, CI all 8 checks
  (CodeRabbit + both Socket gates included). INVARIANTS.md: 9 pinned ✅,
  3 ⏳ (§9.3 egress, §11 Trace redaction, §5.5 execution manager).
- **The engine** (`packages/sdk/src/policy.ts`): `PolicyEngine` seam +
  `createStorePolicyEngine(policies)`. `evaluate(request)` takes a
  discriminated target (`known` Tool | `unknown` toolName — catalog
  lookup stays with the caller) plus a required-but-ignored-in-v1
  `input` field (the §10.3 seam; optional input would be fail-open by
  shape). Verdicts are readonly `{ action, reason, source }`;
  `PolicyVerdictSource` ships its full vocabulary now (`"rule"` reserved
  for §10.3, `"unknown_tool"` for the fail-closed catalog miss).
  Lazy seeding — the engine never writes rows; non-manual rows are
  INERT (live riskClass governs; only manual overrides are
  storage-authoritative). Out-of-vocabulary riskClass/action from
  storage blocks with a diagnostic reason (never resolves undefined);
  store failures propagate as rejections, never laundered into
  verdicts. Reasons are product copy, pinned verbatim in tests.
- **Tier 2 review ran per the three-tier rule** (load-bearing by file
  location): 3 adversarial agents (correctness/security, type-design,
  silent-failure), all initially FIX-FIRST; consolidated findings +
  resolutions live as a PR #13 comment (audit trail). The Critical:
  compile-time-exhaustive switches fail open at runtime on
  out-of-vocabulary storage values — fixed with fail-closed `default`
  arms + `never` bindings, pinned by corrupt-vocabulary tests.
- **Artifacts this session:** plan
  claude.ai/code/artifact/50ba08cb-7dfd-4749-8999-3248752fd886 ·
  explainer + quiz
  claude.ai/code/artifact/5bcaaed1-e617-4e45-8a76-621a08462765 ·
  debrief claude.ai/code/artifact/7f529f82-10e1-411f-98ac-cd6e0001dfae.
  Blindspot pass for this task was
  claude.ai/code/artifact/911c178e-b63d-4162-8458-5917e708e60d.
- **Follow-up spawned (task chip, may already be running/dismissed):**
  vocabulary validation at the sqlite deserialization boundary —
  `rowToPolicy`/`rowToTool` blind-cast action/riskClass; any
  `manual_override ≠ 1` silently demotes to inert (fail-open vs
  operator intent). Engine-side containment exists; store-side is the
  second layer. Check `gh pr list` / ask the human before redoing it.
- All prior decisions in the 2026-07-03/04 handoff remain in force
  (PR-by-default routing, two-tier allowlist + protected floor,
  branch protection deferred, Dependabot alerts-only, esbuild low
  ACCEPTED — do not re-litigate).

### Waiting on the human

Nothing blocking. Optional: the spawned sqlite-boundary task chip.

### Next task: §5.3 ToolInvoker pipeline v1 (with §9.3 egress defaults)

Every part now exists as a seam: resolver (§9.2 ✓), policy engine
(§10.2 ✓), store ✓, sandbox + execute mount point ✓. The pipeline is
the connective tissue: resolve connection → enforce policy → attach
credentials host-side → call upstream → append Trace event → return.

**Protocol first (CLAUDE.md "Finding unknowns"): the blindspot pass for
this task has NOT been run.** Run `/blindspot` before planning — likely
unknown-unknowns: upstream HTTP client choice (fetch, timeouts per
CLAUDE.md security), §9.3 SSRF defaults (loopback/private egress OFF —
this ⏳ invariant should flip with the pipeline), what a require_approval
verdict does pre-§5.5 (probably: fail the call with the reason,
pause/resume comes with the execution manager), Trace event shape vs
§11 redaction (redaction is its own ⏳ row — don't accidentally claim
it), streaming/binary upstream responses, retry semantics.

Acceptance criteria (refine after the blindspot pass):
- Pipeline behind a seam, composing the existing interfaces; mounted as
  the ToolInvoker callback (`execute.ts`).
- Policy enforced via the engine; allow-list consumption discipline
  (proceed only on `action === "allow"` — documented in policy.ts).
- §9.3 egress defaults implemented + INVARIANT §9.3 test in the same
  commit; ledger row flips.
- Trace events appended per call (§11 fields as data; redaction stays ⏳
  and honestly marked).
- Same routing: branch from origin/main, PR, Tier 2 review (load-bearing),
  explainer + quiz before merge.

### Session quirks worth inheriting

- Everything from the 2026-07-03/04 list still applies: direct binaries
  (`packages/sdk/node_modules/.bin/{tsc,vitest}`, `node_modules/.bin/biome`
  from repo root); sandbox override needed for git writes and `gh`;
  "certificate-25291" stderr noise is environmental; zsh eats `=`-prefixed
  words; quickjs ground truth is the shipped dist (LEARNINGS #9).
- NEW: the Write tool can embed literal control bytes (DEL, BEL) when
  composing strings that mix escapes and punctuation — after writing
  source with `\uXXXX`-class content, verify with `cat -v` and repair
  via a python script file (shell one-liners mangle `!` under zsh).
- `gh pr checks` polling: use a background `until` loop (foreground
  `sleep` chains are blocked by the harness).

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Start by reading
> HANDOFF.md and follow its protocol — current task: §5.3 ToolInvoker
> pipeline v1 with §9.3 egress defaults. The blindspot pass for this
> task has NOT been run yet: run /blindspot first, then the tweakable
> plan, then implement. Check "waiting on the human" first. Work
> autonomously per the project's memory: decide commonsensical things
> yourself; confirm only destructive, outward-facing, or scope-changing
> actions. Interface first, invariant tests in the same commit as the
> code that earns them, INVARIANTS.md rows flip in that commit,
> conventional commits, hook must stay green. Feature work runs on a
> branch from origin/main and lands by PR per CLAUDE.md "Commit
> routing"; Tier 2 review + explainer + full-pass quiz before merge.
> At session end, rewrite HANDOFF.md, append LEARNINGS.md, and publish
> the session debrief artifact.
