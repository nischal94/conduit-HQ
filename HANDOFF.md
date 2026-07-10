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

## Current handoff — written 2026-07-10 (§11 Trace redaction MERGED — PHASE 0 COMPLETE; next MVP step = /mcp server, stdio)

### Where things stand

- **PR #27 MERGED (squash) → main is `4efbe5c`, 296/296 green, tsc + biome clean.
  §11 Trace redaction is landed; INVARIANT §11 ✅ — that was the last ⏳ row, so
  ALL 13 INVARIANTS ARE ✅ and Phase 0 is COMPLETE.** Branch `feat/trace-redaction`
  deleted. PR #25 was closed earlier (design content rode into #26) — no open PRs,
  no stray branches, repo clean.
- **What shipped (mechanism is recorded in spec §18; design record at
  `docs/superpowers/specs/2026-07-10-trace-redaction-design.md`, R1–R8):**
  write-time redaction at the `appendTrace` choke point (`pipeline/invoker.ts` —
  the only TraceEvent producer, refusals included); pure redactor
  `pipeline/redact.ts` (builtin key denylist incl. OAuth token names + per-tool
  additions, normalized exact matching, fail-closed depth/cycle guards, strictly
  NON-MUTATING — load-bearing for D7 replay fidelity, pinned by test);
  `Policy.redactFields` riding every `PolicyVerdict` (zero extra reads on the
  common path; one enrichment read on the D6 resume branch and on unknown-tool
  refusals with a surviving stale row); `TraceEvent.output` DROPPED, and a
  one-time migration masks pre-§11 rows then DROPs the legacy `output` column
  (column absence = migration-done marker). Replay journal + `pausedOn.input`
  deliberately raw (D7/R8).
- **Review trail (all on PR #27):** SDD build (fresh implementer + independent
  reviewer per task, 6 tasks, whole-branch opus review zero Critical/Important) →
  CI green → explainer + quiz (full human pass) → /security-review zero findings →
  five-lens code review zero ≥80 findings → CodeRabbit + Greptile (4/5, both
  minors addressed) → **real codex exec cross-model: pass 1 P2 (stale-policy-row
  redactFields on unknown-tool refusals, fixed e64c375), pass 2 NEW P2 (pre-§11
  rows raw, fixed d4cf235), pass 3 "CONVERGED — SHIP"**. Full ledger:
  `.superpowers/sdd/progress.md`; explainer artifact:
  https://claude.ai/code/artifact/3f81ef1a-d669-4c1c-b745-a2f0a22261f5
- **Known consideration (documented in PR #27 body, deliberately not fixed):**
  opening a READONLY pre-§11 legacy DB fails startup closed (the migration writes).
  Dead data, not a live leak; revisit only if readonly opens become a product
  surface.

### NEXT TASK — /mcp server, stdio transport first (spec §17 build order step 2)

The front door: a real MCP agent (Claude Desktop / Cursor form) connects over
stdio and drives search/describe/execute through the real §9.2/§9.3 boundary.
This is a §5.5-scale piece — **START WITH BRAINSTORM + PLAN**
(`superpowers:brainstorming` → `writing-plans`), do NOT jump to code. Known
design surfaces to expect: MCP protocol framing over stdio, mapping the §4.1
tool surface (search/describe/execute + exec_id pause contract) onto MCP
tools/list + tools/call, how a paused execution's `exec_id` round-trips to the
agent, startup/reload behavior (§14 caveat), and where the manager's
`resume(execId, {approve|deny})` engine surfaces (CLI comes next as step 3).

**Then (spec §17):** (3) minimal `conduit` CLI — `serve`, `add-mcp`,
`approvals list|approve|deny`; (4) the §4.2 before/after token demo. Do NOT
build the web console, FTS5, Trace viewer, or Phases 2–5. MVP done only when
BOTH §17 gates pass (built through the front door + converged edge-case pass
on the running skeleton).

Each piece is load-bearing: branch from origin/main, PR per commit routing,
Tier 2 + /security-review + real `codex exec` pass (0.144.0 works; probe live —
LEARNINGS 2026-07-10 #4), /explain-diff + full-pass quiz, human-named merge.

### Housekeeping carry-overs (optional, not blocking)

- **spec §18 list labeling:** three fully-locked decisions (egress pinning,
  UpstreamCaller trust, §11 mechanism) sit under the "Deferred" `<ol>` — move
  them to "Resolved (locked)" or retitle (prose-only spec edit + `html2md.py`,
  PR route since the spec pair is protected-floor). A session chip was spawned
  for this (task_0a726531) but chips don't survive restarts — this line is the
  durable record.
- Aikido SAST MCP still not connected (needs `/aikido:setup` in the user's
  terminal) — CI Socket + secrets scan cover supply-chain/secrets meanwhile.

### Session quirks worth inheriting

- Binaries: `packages/sdk/node_modules/.bin/{vitest,tsc}` (cd packages/sdk);
  `node_modules/.bin/biome` from repo root.
- vitest loopback suites (manager, e2e.smoke, upstream) HANG in the Bash
  sandbox — run unsandboxed; the pre-commit hook (unsandboxed, full suite +
  biome + spec-drift) is the authoritative verification run on every commit.
- **`codex exec` (updated):** foreground positional-arg runs can hit the
  600s Bash cap with zero output on big diffs — run in BACKGROUND with the
  prompt via stdin redirect (`< promptfile`) and stdout/stderr to scratchpad
  files. Still needs `dangerouslyDisableSandbox` (auth file). Re-pass prompts
  must list already-fixed findings and demand an explicit
  "CONVERGED — SHIP"/"NOT CONVERGED" line.
- **Subagent dispatches: forbid `git stash` explicitly.** An implementer
  stashed mid-task and the permission guard blocked `stash pop` for it AND the
  controller (user chose `git stash apply` + hook-approved drop after commit).
  All later dispatches carried "do NOT use git stash" — keep doing that.
- git network ops (fetch/push/gh) need the sandbox override;
  `grep -v certificate-25291` the stderr noise.
- The impeccable hook: em-dashes/section-markers in conduitspec.html are
  false positives (leave them); side-tab borders on HTML explainers are legit
  (use a bordered card instead).
- Session-end docs are written from a main checkout (`scripts/push-docs`
  requires being ON main) — after a squash-merge with `--delete-branch`, gh
  already leaves you on fast-forwarded main.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Read HANDOFF.md first
> and follow its protocol — including `gh pr list --state all --limit 5`.
> **State: §11 Trace redaction is MERGED (PR #27, squash) → main is `4efbe5c`,
> 296/296 green, ALL 13 INVARIANTS ✅ — Phase 0 COMPLETE. Do NOT re-implement
> §11.** Note: the pre-§11 trace migration and its readonly-DB fail-closed
> behavior are deliberate (PR #27 body); policy-change non-retroactivity is a
> spec §18 decision — don't "fix" either.
>
> **NEXT TASK: the /mcp server, stdio transport first (spec §17 step 2)** —
> the front door Claude Desktop/Cursor use. It's a §5.5-scale piece: START
> WITH `superpowers:brainstorming` then `writing-plans`; surface the unknowns
> first (MCP framing over stdio, §4.1 surface mapping, exec_id pause contract
> round-trip, §14 startup-reload, where resume(execId,…) surfaces). Then
> subagent-driven build per the plan.
>
> **Then (spec §17):** (3) minimal `conduit` CLI (`serve`, `add-mcp`,
> `approvals list|approve|deny` — the merged manager's resume() is the
> engine). (4) the §4.2 token demo. Do NOT build the web console, FTS5, Trace
> viewer, or Phases 2–5. Each piece: branch from origin/main, PR routing,
> Tier 2 + /security-review + real codex exec pass (probe live), /explain-diff
> + full-pass quiz, human-named merge. MVP done only when BOTH §17 gates pass.
> At session end, rewrite HANDOFF, append LEARNINGS, publish the debrief.
