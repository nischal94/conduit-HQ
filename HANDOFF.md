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

## Current handoff — written 2026-07-07 (sourceSemantics validation session)

### Where things stand

- **sourceSemantics boundary validation COMPLETE — PR #18 merged
  (`95f325b`, quiz passed + merge named by the human 2026-07-07).**
  `fix: validate stored source_semantics at the sqlite boundary`
  (commits `c0c0eb4` + `4561730` + `bd3669d`). This closed the highest-priority
  residual gap from PR #15's Tier 2 review: `rowToTool`'s
  `JSON.parse(...) as SourceSemantics` blind cast smuggled three
  vocabularies (`kind`, graphql `operation`, custom_js `declaredRisk`)
  past the #14/#15 column guards. A JSON blob has no CHECK twin —
  SQLite can't see inside it — so the new `parseSourceSemantics`
  read-side guard is the ONLY enforcement layer for those, fresh
  schemas included. It rebuilds the union field-by-field (unknown keys
  drop; absent mcp hints stay absent). All six JSON columns now route
  through `parseJson`, which wraps corruption in the `[SqliteStore]`
  format and carries the original SyntaxError as `cause` (its parse
  position locates corruption in a large blob). `deriveRiskClass`
  (risk.ts, exported public API) fails closed: never-bound `default`
  arm, `declaredRisk` vocabulary check, boolean-or-absent mcp hints,
  string-checked openapi method — all → `"destructive"` on garbage.
- **PR #18 gate status:** CI 8/8 green on `bd3669d`; Tier 2 ran
  (3 agents; findings + resolutions posted as a PR comment — the
  review caught a real fail-OPEN defect in my own first version:
  truthiness mcp hints let `readOnlyHint: "false"`, a truthy string,
  classify "safe"; fixed + pinned same day, LEARNINGS #25); explainer +
  quiz artifact posted
  (claude.ai/code/artifact/90242521-9530-4617-bbc4-6ce680d21a39).
  151/151 tests, tsc + Biome clean.
- **main is `95f325b`** — 151/151 tests, INVARIANTS.md unchanged:
  9 pinned ✅, 3 ⏳ (§9.3 egress, §11 Trace redaction, §5.5 execution
  manager). PR #18 hardened an existing layer; no ledger row flipped.
- **Follow-ups spawned by PR #18's Tier 2 (listed in the PR comment,
  deliberately out of scope):** (1) `seeds`/`pausedOn` shape validators
  mirroring `parseSourceSemantics` — corrupt seeds silently diverge
  §5.5 replay, and `"null"` in `paused_on` loads as a null
  `PendingApproval`; must-fix before §5.5 resume ships, together with
  (2) `maybeText`/`maybeInteger` NULL-vs-corruption conflation and
  (3) the unenforced `status === "paused"` ⟺ `paused_on IS NOT NULL`
  invariant. NEW: (4) cross-field drift — `risk_class = "safe"` beside
  `declaredRisk = "destructive"` passes both guards independently;
  consider re-deriving on read. (5) LOW, pre-existing: a corrupt
  identity column throws without row identity.
- Policy engine v1 (PR #13) consumption discipline unchanged — proceed
  only on `action === "allow"`; catalog lookup stays with the caller;
  store failures propagate as rejections (LEARNINGS #18–19).
- All prior decisions remain in force (PR-by-default routing, two-tier
  allowlist + protected floor, branch protection deferred, Dependabot
  alerts-only, esbuild low ACCEPTED, `delete_branch_on_merge` ON,
  merge authority is the human's — do not re-litigate).

### Waiting on the human

Nothing blocking. PR #18's full gate closed 2026-07-07: CI 8/8,
Tier 2 findings resolved, explainer quiz passed, merge named
explicitly, merged as `95f325b` (branch auto-deleted).

### Next task: §5.3 ToolInvoker pipeline v1 (with §9.3 egress defaults)

Unchanged — the sqlite PRs were review follow-ups, not roadmap steps.
Every part exists as a seam: resolver (§9.2 ✓), policy engine
(§10.2 ✓), store ✓ (all vocabulary reads guarded, semantics blob
included), sandbox + execute mount point ✓. The
pipeline is the connective tissue: resolve connection → enforce policy
→ attach credentials host-side → call upstream → append Trace event →
return.

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
- Write-tool control bytes: the Edit tool can materialize a `\uXXXX`
  escape you *typed as text* into a raw control byte — even in a plain
  test-string edit. Verify with `cat -v` after any edit meant to
  contain escape sequences; repair via a python script file.
- `gh pr checks` polling: background `until` loop (foreground `sleep`
  chains are blocked by the harness).
- A fresh worktree lacks `node_modules` — symlink the main checkout's
  install in rather than running installs. libsql's types reject the
  `{ sql }` object form for raw statements — use parameterized `args`.
- Stacked-PR retargeting (LEARNINGS #22) has a cheap degenerate case:
  if a task must start while its base PR is open, branch from the base
  PR's head but DELAY committing; if the base merges first, a single
  `git merge --ff-only origin/main` moves the commit-less branch onto
  main and the stack dissolves — the PR opens against main directly.
- Session-end docs from a feature-branch worktree: `scripts/push-docs`
  requires being ON main — write HANDOFF/LEARNINGS in the main
  checkout (`~/projects/conduit-HQ`), not the worktree branch, or the
  handoff itself becomes invisible to the tripwire (LEARNINGS #21's
  exact failure mode).

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Start by reading
> HANDOFF.md and follow its protocol — including the PR check the
> tripwire can't do: `gh pr list --state all --limit 5` (PR #18,
> sourceSemantics validation, merged 2026-07-07 — do not redo its
> work). Then the current task: §5.3 ToolInvoker
> pipeline v1 with §9.3 egress defaults. The blindspot pass for this
> task has NOT been run yet: run /blindspot first, then the tweakable
> plan, then implement. Work autonomously per the project's memory:
> decide commonsensical things yourself; confirm only destructive,
> outward-facing, or scope-changing actions. Interface first, invariant
> tests in the same commit as the code that earns them, INVARIANTS.md
> rows flip in that commit, conventional commits, hook must stay green.
> Feature work runs on a branch from origin/main and lands by PR per
> CLAUDE.md "Commit routing"; Tier 2 review + explainer + full-pass
> quiz before merge. At session end, rewrite HANDOFF.md, append
> LEARNINGS.md, and publish the session debrief artifact.
