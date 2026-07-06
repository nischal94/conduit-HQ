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

## Current handoff — written 2026-07-07 (staleness-reconciliation session)

This handoff was reconstructed from PR #14's artifacts (PR body, Tier 2
findings comment, explainer), not written by the session that did the
work — that session ended without rewriting this file, and the commit
tripwire stayed silent because its work sits on an unmerged branch.

### Where things stand

- **Policy engine v1 merged — PR #13 (`f5e0e8a`), the Phase 1 opener.**
  Quiz gate passed 5/5 before merge. Full detail in the 2026-07-06
  handoff (git history) and LEARNINGS #18–19. Consumption discipline:
  proceed only on `action === "allow"`; catalog lookup stays with the
  caller; store failures propagate as rejections.
- **PR #14 is OPEN, not merged** —
  `fix: validate stored policy/tool vocabularies at the sqlite boundary`
  (branch `fix/sqlite-vocab-validation`, commits `b5c532f` + `8f74d44`),
  the store-side defense-in-depth layer flagged by PR #13's Tier 2
  review. `rowToPolicy`/`rowToTool` no longer blind-cast: unrecognized
  `action`/`seeded_from`/`risk_class` values and `manual_override`
  outside 0/1 throw at deserialization (the `=== 1` demotion previously
  turned an operator's manual block into fail-open — corruption the
  engine can never catch, because it's erased before the engine runs).
  Write-side twin: CHECK constraints, which only bind fresh databases —
  read-side guards are the layer covering legacy files, and the tests
  pin exactly that. Deliberately independent from `policy.ts`'s
  fail-closed `default:` arms — do not merge or deduplicate the layers.
- **PR #14 review state:** Tier 2 ran (3 agents; findings + resolutions
  in a PR comment). All CI checks green, CodeRabbit has commented, and
  the explainer + quiz artifact is posted
  (claude.ai/code/artifact/52134fa5-b154-4575-ab69-ec1c39da12ef).
  On the branch: 123/123 tests, tsc + Biome clean.
- **main is still `f9e6731`** — 112/112 tests, INVARIANTS.md unchanged:
  9 pinned ✅, 3 ⏳ (§9.3 egress, §11 Trace redaction, §5.5 execution
  manager). PR #14 hardens an existing layer; it flips no ledger row.
- **Follow-up spawned by PR #14 (task chip):** the same blind-cast
  pattern remains for `source.type`, `execution.status`, and
  `trace_events.policy_verdict` in `sqlite.ts` — deliberately out of
  PR #14's scope fence; different blast radius, its own pass. Check
  `gh pr list` / ask the human before redoing it. Also deferred with
  rationale (LOW): upsert-side vocabulary mirroring for legacy DBs.
- All prior decisions remain in force (PR-by-default routing, two-tier
  allowlist + protected floor, branch protection deferred, Dependabot
  alerts-only, esbuild low ACCEPTED — do not re-litigate).

### Waiting on the human

**PR #14's merge gate — this blocks feature work.** Merge waits on the
human reading the CodeRabbit review and passing the explainer quiz
FULLY (a missed question means reread and retake), then merging. CI is
already green. The next task branches from origin/main and builds on
the merged state; don't stack it on the open branch.

### Next task: §5.3 ToolInvoker pipeline v1 (with §9.3 egress defaults)

Unchanged from the previous handoff — PR #14 was a review follow-up,
not a roadmap step. Every part exists as a seam: resolver (§9.2 ✓),
policy engine (§10.2 ✓), store ✓ (now with guarded reads once #14
lands), sandbox + execute mount point ✓. The pipeline is the connective
tissue: resolve connection → enforce policy → attach credentials
host-side → call upstream → append Trace event → return.

**Protocol first (CLAUDE.md "Finding unknowns"): the blindspot pass for
this task has still NOT been run.** Run `/blindspot` before planning —
likely unknown-unknowns: upstream HTTP client choice (fetch, timeouts
per CLAUDE.md security), §9.3 SSRF defaults (loopback/private egress
OFF — this ⏳ invariant should flip with the pipeline), what a
require_approval verdict does pre-§5.5 (probably: fail the call with
the reason; pause/resume comes with the execution manager), Trace event
shape vs §11 redaction (redaction is its own ⏳ row — don't accidentally
claim it), streaming/binary upstream responses, retry semantics.

**Carried from PR #14's Tier 2 review (silent-failure finding, deferred
to this PR):** when the pipeline wires the policy engine into a
ToolInvoker, `quickjs.ts` `perform()`'s broad catch needs
infra-vs-upstream error classification — store-corruption rejections
(the new `[SqliteStore]` guard throws) must be logged host-side and
must NOT leak `[SqliteStore]` internals to guest code.

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
- NEW (PR #14 session): a fresh worktree lacks `node_modules` — symlink
  the main checkout's install in rather than running installs. libsql's
  types reject the `{ sql }` object form for raw statements — use
  parameterized `args`.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Start by reading
> HANDOFF.md and follow its protocol — including the PR check the
> tripwire can't do: `gh pr list --state all --limit 5`. First check
> whether PR #14 (sqlite vocabulary validation) has merged; if it is
> still open, the human must pass its explainer quiz and merge before
> feature work starts. Then the current task: §5.3 ToolInvoker pipeline
> v1 with §9.3 egress defaults. The blindspot pass for this task has
> NOT been run yet: run /blindspot first, then the tweakable plan, then
> implement. Work autonomously per the project's memory: decide
> commonsensical things yourself; confirm only destructive,
> outward-facing, or scope-changing actions. Interface first, invariant
> tests in the same commit as the code that earns them, INVARIANTS.md
> rows flip in that commit, conventional commits, hook must stay green.
> Feature work runs on a branch from origin/main and lands by PR per
> CLAUDE.md "Commit routing"; Tier 2 review + explainer + full-pass quiz
> before merge. At session end, rewrite HANDOFF.md, append LEARNINGS.md,
> and publish the session debrief artifact.
