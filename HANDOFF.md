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
**Known blind spot (LEARNINGS #21): the tripwire only sees main.** Work
that lives on an unmerged PR branch leaves main untouched and the
tripwire silent. Always pair it with `gh pr list --state all --limit 5`
at session start.

---

## Current handoff — written 2026-07-07 (PR #15 merge + handoff refresh)

### Where things stand

- **Sqlite vocabulary hardening COMPLETE — PR #14 (`d2001dc`) and
  PR #15 (`9b1bbc2`) both merged.** Every enum-shaped TEXT column in
  `packages/sdk/src/store/sqlite.ts` is now double-gated: read-side
  `isOneOf` guards (throw `[SqliteStore] Failed to read ...` with the
  stringified bad value + row identity) and write-side CHECK
  constraints. CHECKs bind fresh schemas only — `CREATE TABLE IF NOT
  EXISTS` never retrofits, so the read guards are the enforcement
  layer for legacy files; sqlite.ts now says so above `SCHEMA`.
  PR #15 covered the last three casts: `sources.type`,
  `executions.status` (feeds §5.5 pause/resume), and
  `trace_events.policy_verdict` (the §11 audit surface; it reuses
  `POLICY_ACTIONS` because `TraceEvent["policyVerdict"]` IS
  `PolicyAction` — one constant, no drift). Exhaustiveness pins are
  now compiler-checked: the test lists are `Record<Union, true>`-keyed
  (`vocabulary()` helper in sqlite.test.ts), so union growth fails the
  test file's compilation. Gates passed: Tier 2 ×3 agents (no
  must-fix; the two applied considers landed as `f97df15`), CI 8/8,
  explainer + quiz
  (claude.ai/code/artifact/db3b3b3b-03eb-4889-8682-9c0523faa3b8)
  passed in full by the human; merged on the human's explicit
  instruction after retargeting base to main.
- **main is `9b1bbc2`** — 130/130 tests, INVARIANTS.md unchanged:
  9 pinned ✅, 3 ⏳ (§9.3 egress, §11 Trace redaction, §5.5 execution
  manager). Both PRs harden an existing layer; no ledger row flips.
- **IN FLIGHT: sourceSemantics boundary validation** — a spawned
  follow-up session (from PR #15's Tier 2 findings) is running
  independently in its own worktree. Scope: `rowToTool`'s
  `JSON.parse(...) as SourceSemantics` blob smuggles three vocabulary
  strings (`kind`, `operation`, `declaredRisk`) past the new guards
  and feeds `deriveRiskClass`'s default-less switch (risk.ts); plus,
  if cheap: the `seeds`/`pausedOn` casts, `maybeText`/`maybeInteger`
  conflating NULL with type corruption (reviewer-rated must-fix before
  §5.5 resume ships), the `status === "paused"` ⟺ `paused_on IS NOT
  NULL` invariant, and `[SqliteStore]` context on `JSON.parse` throws.
  Expect a PR needing the full merge gate. Check `gh pr list` before
  assuming its state.
- Policy engine v1 (PR #13, `f5e0e8a`) and its consumption discipline
  are unchanged — proceed only on `action === "allow"`; catalog lookup
  stays with the caller; store failures propagate as rejections.
  Detail in the 2026-07-06 handoff (git history) and LEARNINGS #18–19.
- All prior decisions remain in force (PR-by-default routing, two-tier
  allowlist + protected floor, branch protection deferred, Dependabot
  alerts-only, esbuild low ACCEPTED — do not re-litigate). NEW
  2026-07-07: `delete_branch_on_merge` ON (merged PR branches
  auto-delete; stacked PRs auto-retarget); **merge authority is the
  human's** — no PR merges without the human naming it, housekeeping
  included (CLAUDE.md "Commit routing" has the full rule and the
  PR #16 incident behind it).

### Waiting on the human

Nothing blocking. Open items: the in-flight sourceSemantics PR needs
its quiz + explicit merge instruction when it lands; the leftover
merged branch `feat/policy-engine-v1` predates the new auto-delete
setting — delete on the human's say-so (remote branch deletion always
needs explicit approval). Resolved 2026-07-07: the two sqlite-PR
branches were deleted on explicit confirmation;
`delete_branch_on_merge` is now ON repo-wide (verified live — PR #16's
branch auto-deleted); PR #16 (gitignore symlink fix, LEARNINGS #24)
merged and accepted by the human after the fact — see the new merge
authority rule in CLAUDE.md "Commit routing".

### Next task: §5.3 ToolInvoker pipeline v1 (with §9.3 egress defaults)

Unchanged — the sqlite PRs were review follow-ups, not roadmap steps.
Every part exists as a seam: resolver (§9.2 ✓), policy engine
(§10.2 ✓), store ✓ (all vocabulary reads guarded), sandbox + execute
mount point ✓. The pipeline is the connective tissue: resolve
connection → enforce policy → attach credentials host-side → call
upstream → append Trace event → return.

**Protocol first (CLAUDE.md "Finding unknowns"): the blindspot pass
for this task has still NOT been run.** Run `/blindspot` before
planning — likely unknown-unknowns: upstream HTTP client choice
(fetch, timeouts per CLAUDE.md security), §9.3 SSRF defaults
(loopback/private egress OFF — this ⏳ invariant should flip with the
pipeline), what a require_approval verdict does pre-§5.5 (probably:
fail the call with the reason; pause/resume comes with the execution
manager), Trace event shape vs §11 redaction (redaction is its own ⏳
row — don't accidentally claim it), streaming/binary upstream
responses, retry semantics.

**Carried from PR #14's Tier 2 review (silent-failure finding,
deferred to this PR):** when the pipeline wires the policy engine into
a ToolInvoker, `quickjs.ts` `perform()`'s broad catch needs
infra-vs-upstream error classification — store-corruption rejections
(the `[SqliteStore]` guard throws) must be logged host-side and must
NOT leak `[SqliteStore]` internals to guest code.

Acceptance criteria (refine after the blindspot pass):
- Pipeline behind a seam, composing the existing interfaces; mounted as
  the ToolInvoker callback (`execute.ts`).
- Policy enforced via the engine; allow-list consumption discipline
  (proceed only on `action === "allow"` — documented in policy.ts).
- §9.3 egress defaults implemented + INVARIANT §9.3 test in the same
  commit; ledger row flips.
- Trace events appended per call (§11 fields as data; redaction stays ⏳
  and honestly marked).
- Infra-vs-upstream error classification at the sandbox boundary (see
  the carried finding above).
- Same routing: branch from origin/main, PR, Tier 2 review (load-bearing),
  explainer + quiz before merge.

### Session quirks worth inheriting

- Everything from the 2026-07-03/04 list still applies: direct binaries
  (`packages/sdk/node_modules/.bin/{tsc,vitest}`, `node_modules/.bin/biome`
  from repo root); sandbox override needed for git writes and `gh`;
  "certificate-25291" stderr noise is environmental; zsh eats `=`-prefixed
  words; quickjs ground truth is the shipped dist (LEARNINGS #9).
- Write-tool control bytes: after writing source with `\uXXXX`-class
  content, verify with `cat -v`; repair via a python script file.
- `gh pr checks` polling: background `until` loop (foreground `sleep`
  chains are blocked by the harness).
- A fresh worktree lacks `node_modules` — symlink the main checkout's
  install in rather than running installs. libsql's types reject the
  `{ sql }` object form for raw statements — use parameterized `args`.
- NEW (PR #15 session): GitHub does NOT retarget a stacked PR when its
  base PR merges unless the base branch is deleted — `gh pr edit N
  --base main`, re-verify diff + CI, then merge; otherwise the merge
  lands in the dead feature branch. (The previous handoff called
  retargeting "optional housekeeping" — it is a merge-correctness
  requirement.)
- Fixed by PR #16 (merged 2026-07-07): `.gitignore` now uses bare
  `node_modules` — the trailing-slash form matched directories only,
  leaving worktree *symlinks* untracked and addable (LEARNINGS #24).
  The stage-explicitly habit still applies as defense in depth.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Start by reading
> HANDOFF.md and follow its protocol — including the PR check the
> tripwire can't do: `gh pr list --state all --limit 5`. First check
> whether the in-flight sourceSemantics-validation session landed its
> PR: if open, it needs the full merge gate (Tier 2 + explainer +
> quiz) before merging; do not redo its work. Then the current task:
> §5.3 ToolInvoker pipeline v1 with §9.3 egress defaults. The
> blindspot pass for this task has NOT been run yet: run /blindspot
> first, then the tweakable plan, then implement. Work autonomously
> per the project's memory: decide commonsensical things yourself;
> confirm only destructive, outward-facing, or scope-changing actions.
> Interface first, invariant tests in the same commit as the code that
> earns them, INVARIANTS.md rows flip in that commit, conventional
> commits, hook must stay green. Feature work runs on a branch from
> origin/main and lands by PR per CLAUDE.md "Commit routing"; Tier 2
> review + explainer + full-pass quiz before merge. At session end,
> rewrite HANDOFF.md, append LEARNINGS.md, and publish the session
> debrief artifact.
