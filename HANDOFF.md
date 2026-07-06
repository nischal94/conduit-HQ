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

## Current handoff — written 2026-07-07 (staleness-reconciliation session; updated same session after merging PR #14)

This handoff was reconstructed from PR #14's artifacts (PR body, Tier 2
findings comment, explainer), not written by the session that did the
work — that session ended without rewriting this file, and the commit
tripwire stayed silent because its work sits on an unmerged branch.
Mid-session discovery: a second parallel worktree session had opened
PR #15 minutes after the first reconciliation pass ran `gh pr list` —
parallel sessions can stale a handoff *while it is being written*.

### Where things stand

- **Policy engine v1 merged — PR #13 (`f5e0e8a`), the Phase 1 opener.**
  Quiz gate passed 5/5 before merge. Full detail in the 2026-07-06
  handoff (git history) and LEARNINGS #18–19. Consumption discipline:
  proceed only on `action === "allow"`; catalog lookup stays with the
  caller; store failures propagate as rejections.
- **PR #14 MERGED (`d2001dc`)** —
  `fix: validate stored policy/tool vocabularies at the sqlite boundary`
  (commits `b5c532f` + `8f74d44`), the store-side defense-in-depth
  layer flagged by PR #13's Tier 2 review. `rowToPolicy`/`rowToTool` no
  longer blind-cast: unrecognized `action`/`seeded_from`/`risk_class`
  values and `manual_override` outside 0/1 throw at deserialization
  (the `=== 1` demotion previously turned an operator's manual block
  into fail-open — corruption the engine can never catch, because it's
  erased before the engine runs). Write-side twin: CHECK constraints,
  which only bind fresh databases — read-side guards are the layer
  covering legacy files, and the tests pin exactly that. Deliberately
  independent from `policy.ts`'s fail-closed `default:` arms — do not
  merge or deduplicate the layers. Gate before merge: Tier 2 (3
  agents), CI 8/8 green, CodeRabbit, explainer + quiz
  (claude.ai/code/artifact/52134fa5-b154-4575-ab69-ec1c39da12ef);
  merge executed on the human's explicit instruction.
- **main is `d2001dc`** — 123/123 tests, INVARIANTS.md unchanged:
  9 pinned ✅, 3 ⏳ (§9.3 egress, §11 Trace redaction, §5.5 execution
  manager). PR #14 hardens an existing layer; it flips no ledger row.
- **PR #15 is OPEN** —
  `fix: validate remaining stored vocabularies (sources, executions, trace)`
  (branch `fix/sqlite-vocab-validation-remaining`, commits `72a25e6` +
  `f97df15`): the sibling blind casts deliberately fenced out of
  PR #14 (`source.type`, `execution.status`, `trace_events.policy_verdict`).
  Stacked on PR #14's branch (base is still
  `fix/sqlite-vocab-validation`, now fully contained in main — the
  shown diff is just its own two commits; retargeting base to main is
  optional housekeeping). CI green, CodeRabbit commented, Tier 2
  findings posted as a PR comment. **The explainer + quiz artifact is
  NOT yet posted** — either its authoring session is still running or
  it ended before that step; check the PR comments before acting.
- All prior decisions remain in force (PR-by-default routing, two-tier
  allowlist + protected floor, branch protection deferred, Dependabot
  alerts-only, esbuild low ACCEPTED — do not re-litigate).

### Waiting on the human

**PR #15's merge gate — this blocks feature work.** Load-bearing PR
(product code under `packages/`), so per commit routing it needs its
explainer + quiz before merge — and the explainer is not yet posted.
Steps: confirm the authoring worktree session finished (post the
explainer if it never did), read the CodeRabbit review, pass the quiz
FULLY, merge. CI is already green. The next task branches from
origin/main after #15 lands; don't stack feature work on the open
branch.

### Next task: §5.3 ToolInvoker pipeline v1 (with §9.3 egress defaults)

Unchanged from the previous handoff — PRs #14/#15 are review
follow-ups, not roadmap steps. Every part exists as a seam: resolver
(§9.2 ✓), policy engine (§10.2 ✓), store ✓ (guarded reads merged with
#14; the remaining vocabularies land with #15), sandbox + execute
mount point ✓. The pipeline is the connective
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
> whether PR #15 (remaining sqlite vocabularies) has merged; if it is
> still open, its explainer must be posted and the human must pass the
> quiz and merge before feature work starts (PR #14 already merged,
> `d2001dc`). Then the current task: §5.3 ToolInvoker pipeline
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
