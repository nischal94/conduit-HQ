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

## Current handoff — written 2026-07-09 (§5.5 execution-manager DESIGN done + PR'd; gated on human review of PR #25)

### Where things stand (2026-07-09 update)

- **Main is still `29021c9`, 228/228 green.** No product code changed this session.
  The work was **design**: the §5.5 execution manager (MVP build step 1, the largest
  unbuilt piece) was brainstormed and **adversarially reviewed to convergence**, then
  committed as a design doc and opened as **PR #25**
  (https://github.com/nischal94/conduit-HQ/pull/25) on branch
  `docs/execution-manager-design` (commit `6144160`, docs-only, inert prose).
  - Doc: `docs/superpowers/specs/2026-07-09-execution-manager-design.md`.
  - **Review provenance:** 1 author adversarial pass (found the naive model UNSOUND —
    positional replay cursor ⇒ journals must be prefixes) + **3 cross-model Codex passes**
    (`codex exec`, high reasoning; quota is BACK — the user confirmed the Aug-1 block is
    lifted) + interactive grilling. Trajectory: pass1 → 7 findings (3 structural the author
    missed: trace-before-pause, cursor-grant confused-deputy, concurrent-resume double-exec)
    · pass2 → 5 · **pass3 → 0 new in-scope → CONVERGED**.
  - **Nine decisions (D1–D9) recorded** in the doc; three were user-delegated (F5
    crash-window → fail-closed w/ visible ambiguity; storage → separate `replay_journal`
    table not a projection; §18 edit timing → in the implementation PR).
  - **Carries a spec-migration obligation:** the design SUPERSEDES the locked spec §18
    decision "Trace doubles as replay journal". Doc §11 says the §18 edit + `html2md.py`
    regen + the flipped INVARIANTS §5.5 row all land ATOMICALLY in the implementation PR.

- **NEXT ACTION IS THE HUMAN'S:** review/redline PR #25
  (https://github.com/nischal94/conduit-HQ/pull/25) — the design. Do NOT write the
  implementation plan or any code until PR #25 is settled — the user explicitly chose
  "wait for my PR review" before planning. After it's settled: invoke
  `superpowers:writing-plans` against the FINAL design, then implement.

### Prior state (2026-07-08 — Issue #21, still true for the codebase)

- **Issue #21** (per-connect IP pinning) is DONE — PR #22 MERGED. Four PRs merged that
  session: #22, #23, #24. Main was `e1a26f4` at that handoff; it is now `29021c9` after
  the 2026-07-08 HANDOFF commit. Issue #21
  (per-connect IP pinning) is DONE — **PR #22 MERGED** (squash) 2026-07-08,
  human-named for merge + quiz passed; **Issue #21 CLOSED**. Four PRs
  merged this session: #22 (pinning), #23 (spec: desktop out of launch),
  #24 (spec: MVP checkpoint). No open PRs, no stray branches, no stashes —
  repo is clean.
- **Two product decisions locked in the spec this session** (§18 + §17):
  (1) the **desktop app is OUT of launch scope** (§18) — a UI surface, not
  a capability; Phases 4–5 don't depend on it. (2) The **MVP Prototype
  Checkpoint** (§17, the "walking skeleton") is now a named milestone —
  the next build target. See the completion-map artifact + §17.
- **What landed (PR #22):** egress converted denylist → canonical-form.
  `createPinnedLookup` in `packages/sdk/src/pipeline/egress.ts` resolves
  once and hands the socket only §9.3-vetted IPs (spec §18 Phase-1; closes
  DNS-rebinding TOCTOU). `isPrivateAddress` unchanged — now a classifier
  fed resolved IPs, not the boundary. Transport moved `fetch()` →
  `node:https/http` request in `pipeline/upstream.ts` (undici can't inject
  a custom lookup). Credential-echo scan relabeled best-effort. Convergence
  stop-line folded into CLAUDE.md + INVARIANTS.md (§9.3 row updated).
  - **Tier 2 review (3 agents) returned ZERO boundary breaks**; the
    security agent empirically verified on Node 22 that happy-eyeballs
    spawns no second un-pinned resolution and that literal-IP hosts skip
    the custom lookup (so the pre-flight is load-bearing — see LEARNINGS
    #35). Four real transport bugs found + fixed pre-merge (uncleared
    timer, message→structural-tag, `opts.family`, HTTP-0 msg); two refuted
    by probe; two coverage gaps closed with new tests.

### Carry-overs (optional, NOT blocking — Issue #21 already shipped)

- **Codex cross-model adversarial pass never ran** — Codex usage quota
  exhausted, **resets Aug 1 2026**. Stand-in was the dedicated adversarial
  security-review agent (zero boundary breaks, Node-22-verified). The
  change is merged; if the cross-model signal is wanted *retroactively*,
  run the real `codex exec` pass after Aug 1. (LEARNINGS #36.)
- **Aikido SAST MCP is not connected** — needs `/aikido:setup` (MCP login)
  in the user's terminal if you want pattern-based SAST. CI Socket Security
  + secrets scan cover supply-chain/secrets.

### New global capability this session (persists across projects)

- **`~/.claude/hooks/git-safe-cleanup-guard.sh`** — a PreToolUse/Bash hook
  that auto-approves `git branch -D` / `push --delete` / `stash drop`
  ONLY when provably safe (branch fully merged incl. squash-merge; stash
  content already on base/HEAD) and fails closed (`ask`) otherwise. The
  three verbs were removed from `permissions.deny` in
  `~/.claude/settings.json` so the hook can govern them (deny beats hooks);
  catastrophic ops (`reset --hard`, force-push, `clean -fd`, …) stay
  denied. Proven live this session. **Fresh-session verification pending:**
  run `git branch -D <a-merged-branch>` and confirm it auto-approves with
  no prompt. (LEARNINGS #37.)

### Next task: BUILD THE WALKING-SKELETON MVP (spec §17 milestone)

The goal is the thinnest slice testable AS A PRODUCT: a real MCP agent
(Claude Desktop / Cursor) drives a real tool call through the real
§9.2/§9.3 boundary. **Read spec §17 "MVP Prototype Checkpoint" first — it
is the authoritative definition (scope, what's deferred, the two-gate
done).** Build order (each is a candidate PR; the security surface still
gets Tier 2 + /security-review + an adversarial pass):

1. **Finish Phase 0 — §5.5 execution manager.** The biggest unbuilt piece
   and the prerequisite for safe multi-step agent code. **START WITH A
   BRAINSTORM + PLAN, do NOT jump to code** (`superpowers:brainstorming`
   then `writing-plans`) — this is the largest and most design-heavy piece
   in the whole MVP, so surface the unknowns first (replay determinism,
   what's memoizable vs. must-re-run, the approval-queue state machine,
   how pause/resume interacts with the §11 redaction in step 2). Then
   build: replay stripping of non-memoizable journal entries
   (`search`/`describe`), the approval queue, seeds/pausedOn validators
   (PR #18 follow-ups). Flips one §5.5 INVARIANTS row.
2. **Finish Phase 0 — §11 Trace redaction.** Scope names `TraceEvent.output`
   (persisted unredacted for §5.5 replay). Flips the §11 INVARIANTS row.
   (After 1+2, all 13 invariants are ✅ and Phase 0 is complete.)
3. **`/mcp` server — stdio transport first** (the form Claude Desktop /
   Cursor use; HTTP streamable is a later add). This is the front door.
4. **Minimal `conduit` CLI** — `serve`, `add-mcp`, add a source +
   connection. Enough to set up and drive without a UI.
5. **The §4.2 before/after token demo** — the spec's designated QA
   artifact (~1,600 tools → 1 tool / ~1,044 tokens).

**Deferred OUT of the MVP** (do NOT build yet): web console, FTS5/BM25
search, Trace viewer/export, all of Phases 2–5.

**MVP definition of done — BOTH gates (spec §17):** (1) Built — the
skeleton runs end-to-end through the front door; (2) Verified — a
deliberate edge-case / adversarial pass on the RUNNING skeleton has
converged (malformed schemas, hostile upstream echoes, credential 401s,
tool-call timeouts, resume-after-pause, redaction paths, the §14
startup-reload UX caveat — each handled or documented out-of-scope). The
happy path is the entry ticket to the test phase, not the finish line.
Build the rest of the product only AFTER both gates pass.

### Session quirks worth inheriting

- Binaries: **`packages/sdk/node_modules/.bin/{vitest,tsc}`** (NOT repo
  root — the prior HANDOFF was slightly off); `node_modules/.bin/biome`
  from repo root. `cd packages/sdk` for tsc/vitest.
- **vitest loopback-server tests must run OUTSIDE the Bash sandbox**
  (`dangerouslyDisableSandbox: true`) — loopback listen hangs silently
  inside it. Pre-commit hook runs them fine (unsandboxed) and doubles as
  the verification run.
- **`codex exec` gotchas learned the hard way:** (a) needs
  `dangerouslyDisableSandbox` (auth file denied); (b) in a background/
  detached shell, pass the prompt via **stdin redirect** (`< promptfile`),
  NOT a positional arg — the positional form blocks on "Reading additional
  input from stdin"; (c) `$TMPDIR` differs per Bash-tool invocation — write
  shared files to the session scratchpad (stable absolute path), not
  `$TMPDIR`; (d) quota errors surface in **stderr** ("hit your usage
  limit"), so capture and read stderr.
- git network ops (`fetch`/`push`/`gh`) need the sandbox override.
  "certificate-25291" stderr noise is environmental — `grep -v
  certificate-25291`.
- `gh pr checks` polling: background `until` loop (foreground `sleep`
  blocked).
- Session-end docs written from a main checkout (`scripts/push-docs`
  requires being ON main). If a feature branch is checked out, stash any
  doc edits, `git switch main`, `git checkout stash@{0} -- <docs>`,
  commit, `scripts/push-docs` — then switch back. (`git stash pop` and
  the branch-delete verbs are now governed by the new cleanup guard, but
  `stash pop` onto a dirty tree still prompts.)
- The `impeccable` hook flags em-dashes / "numbered section markers" in
  `conduitspec.html` — false positives; leave them. On HTML explainers it
  flags thick side-tab borders — legit; use a thin label marker instead.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Read HANDOFF.md
> first and follow its protocol — including `gh pr list --state all
> --limit 5`. **State: the §5.5 execution-manager DESIGN is done and
> opened as PR #25 (https://github.com/nischal94/conduit-HQ/pull/25),
> adversarially reviewed to convergence. Main is `29021c9`, 228/228 green,
> no product code changed yet.**
>
> **FIRST: check whether the human has reviewed PR #25.** The user chose
> "wait for my PR review" before any implementation planning.
> - If PR #25 is still open / has redlines → address the human's + any
>   CodeRabbit feedback on the design doc, re-run a consistency + (if a
>   decision changed) a `codex exec` convergence pass, and wait again. Do
>   NOT start the plan or code until the design is settled.
> - Once PR #25 is settled (merged or the design is agreed) → invoke
>   `superpowers:writing-plans` against the FINAL design
>   (`docs/superpowers/specs/2026-07-09-execution-manager-design.md`) to
>   produce the tweakable implementation plan, then implement.
>
> **Implementation must-dos (from the design doc):** it touches the
> credential/policy boundary, so it is fully load-bearing — Tier 2 +
> `/security-review` + a `codex exec` convergence pass on the security
> surface, `/explain-diff` + full-pass quiz before merge, human-named
> merge. **The implementation PR must ALSO edit spec §18** (supersede
> "Trace doubles as replay journal"), regenerate `conduitspec.md` via
> `python3 html2md.py`, and flip the INVARIANTS §5.5 row — all atomically
> in that PR. Codex quota is BACK (user confirmed the Aug-1 block lifted),
> so the real `codex exec` path is the adversarial gate.
>
> **After the execution manager (the rest of MVP build order, spec §17):**
> (2) §11 Trace redaction [display-only; must NOT touch the replay payload —
> design D7], (3) `/mcp` server (stdio first), (4) minimal `conduit` CLI
> (`serve`, `add-mcp`, `approvals list|approve|deny`), (5) the §4.2
> before/after token demo. Do NOT build the web console, FTS5, Trace
> viewer, or Phases 2–5 yet. MVP done only when BOTH §17 gates pass. At
> session end, rewrite HANDOFF, append LEARNINGS, publish the debrief
> artifact.
