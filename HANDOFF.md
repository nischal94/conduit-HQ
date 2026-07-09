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

## Current handoff — written 2026-07-09 (§5.5 execution-manager BUILT + reviewed + PR'd; gated on human quiz + merge of PR #26)

### Where things stand (2026-07-09 — end of build session)

- **Main is still `adb03ea`, 228/228 green — no product code on main yet.** The §5.5
  execution manager is **fully implemented + bot/cross-model-reviewed on branch
  `feat/execution-manager`**, PR **#26** (https://github.com/nischal94/conduit-HQ/pull/26).
  **~17 commits, 284/284 tests green, INVARIANT §5.5 flipped → ✅.** Not merged (human's call).
  - **BOT + CROSS-MODEL REVIEW ROUND DONE + CONVERGED (2026-07-10).** CodeRabbit (walkthrough
    only) + Greptile (3, 1 P1) + **real `codex exec` cross-model passes** found issues the
    self-review pipeline MISSED, fixed across 5 commits (36974b6, 9083f1d, 23b03c9, 02988e4,
    c71c859), narrowing **9 → 3 → 1 → 1(P1) → 0**. The substantive bugs: stranded-`running`
    on multiple paths; guest-catchable resume-divergence; and — the P1 the same-model stand-in
    MISSED but real cross-model caught — the `call_attempts` marker OVER-CLAIMED process-crash
    recovery it never delivered (marker only read on `paused` recovery; a real crash leaves
    `running`, which nothing recovers). **Fix: removed the marker over-claim** (kept the
    append-throw guarantee via `drive()`'s catch) and **explicitly DEFERRED process-crash
    recovery of `running` rows out of MVP scope** (needs multi-worker lease). MVP guarantee =
    no double-execution, NOT recovery. **CONVERGED:** the final Codex pass (0.144.0) + an
    independent reviewer BOTH returned zero in-scope findings — agreeing on the axis they
    previously split on. Full trail is a PR #26 comment; details in `.superpowers/sdd/progress.md`.
  - **✅ CROSS-MODEL GATE CLOSED (Aug-8 caveat DISCHARGED).** The real `codex exec` pass DID
    run on the final fixes — the earlier "Codex limited until Aug 8" blocker was resolved: quota
    came back, then the CLI needed upgrading (npm's `@openai/codex` lagged the server model
    rollout — 0.142.5 too old for `gpt-5.6-*`), and 0.144.0 was blocked by the user's Socket
    Firewall `minimumReleaseAge` gate until the user deliberately bypassed sfw for that one
    install. LEARNING: Codex CLI/model availability is a moving target — probe live
    (`codex exec` fails closed with the reason in stderr: quota vs. "requires newer version"
    vs. supply-chain age-gate); don't assume. No retroactive pass needed — cross-model closure
    is done.
  - **PR #25** (the design doc, branch `docs/execution-manager-design`) is still OPEN and
    superseded-in-practice: the design + plan it carries were ALSO copied onto the
    `feat/execution-manager` branch (commit `d899dfd`) and are in PR #26. **Decide whether
    to close PR #25** (its content rode into #26) or keep it as the design record. Not
    blocking.
- **What shipped in PR #26** (build order = the 9-task plan at
  `docs/superpowers/plans/2026-07-09-execution-manager.md`): `replay_journal` store
  separate from audit Trace (D4) · atomic `claimForResume` CAS (F4) · sandbox `paused` arm
  + pinned `new Date()` (D2) · request-bound one-shot `ApprovalDecisions`, fail-closed on
  mismatch (D6/F2) · best-effort credential scrub sharing one primitive with `upstream.ts`
  (D7) · replay-journal reconstruction + `pausedOn` identity (D4/F2) · the ExecutionManager
  itself (state machine, journaling ToolHost barrier, TTL, outcome-ambiguous) · e2e
  pause/resume + Phase-6 behavior fix (D2). **Spec §18 + §5.5 migration DONE** (supersedes
  "Trace doubles as replay journal"; `conduitspec.md` regenerated, no drift). INVARIANTS
  §5.5 row flipped ✅ in the same commit as the manager.
- **Behavior change (intended, in the PR):** `require_approval` now PAUSES the execution
  (human decides) instead of being handed to the agent as a catchable error (the old latent
  bug where the agent controlled the approval flow). Smoke-test Phase 6 updated.

### Review evidence (all done this session)

- **Subagent-driven build:** fresh implementer + independent reviewer per task. **2 tasks
  bounced once** (credential scrub mirror→shared-primitive; manager stranded-`running`) —
  fixed + re-reviewed clean. **Final whole-branch review found 2 Important integration bugs**
  per-task reviews missed (a `describe({path})` replay serialization divergence that would
  spuriously kill a resume; a post-sandbox store-write that could strand `running`) — both
  fixed in `673487a`, re-reviewed clean.
- **`/security-review`:** no high-confidence newly-introduced vulns (all 6 threat categories
  walked: SQL params, confused-deputy closed, atomic claim, credential boundary structural,
  safe deserialization, numbers-only bootstrap, policy-obliviousness).
- **`/explain-diff` explainer + 5-Q quiz published:**
  https://claude.ai/code/artifact/5281e33b-4fcb-42f6-942e-5002ee34899b (URL also on PR #26).
- **⚠️ Cross-model `codex exec` pass could NOT run** — Codex account usage-limited, resets
  **~Aug 8** (this CONTRADICTS the earlier-session "quota is back"; the account limit
  re-triggered). A local security-review sub-agent stood in and independently reproduced the
  2 whole-branch bugs. Re-run the real `codex exec` on the PR diff after Aug 8 if the
  cross-model signal is wanted retroactively. (Ledger: `.superpowers/sdd/progress.md`.)
- **One documented non-blocking residual:** a guest passing `includeSchemas: false` VERBATIM
  to `describe` would still diverge on resume — unreachable through the documented interface
  (no emitter in the SDK; the agent prompt only documents `true`; semantically = omitting).
  Documented in-code (`manager.ts:259`).

- **NEXT ACTION IS THE HUMAN'S — quiz + merge PR #26.** (1) Pass the `/explain-diff` quiz
  (link above) FULLY — a missed question means reread + retake. (2) Read the CodeRabbit
  review when it posts. (3) Name PR #26 for merge. **The agent does NOT merge** — merge
  authority is the human's. Optionally: run the real `codex exec` convergence pass after
  Aug 8; decide whether to close PR #25.

### After PR #26 merges — the rest of the MVP (spec §17 build order)

Phase 0 is COMPLETE once #26 lands (both §5.5 + §11… wait: §11 Trace redaction is still ⏳).
Next: (2) §11 Trace redaction [display-only; MUST NOT touch the replay `output` payload —
design D7], (3) `/mcp` server (stdio first), (4) minimal `conduit` CLI (`serve`, `add-mcp`,
`approvals list|approve|deny`), (5) the §4.2 before/after token demo. Do NOT build the web
console, FTS5, Trace viewer, or Phases 2–5 yet. MVP done only when BOTH §17 gates pass.

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
> --limit 5`. **State: the §5.5 execution manager is BUILT + reviewed and
> opened as PR #26 (https://github.com/nischal94/conduit-HQ/pull/26) —
> branch `feat/execution-manager`, 12 commits, 272/272 green, INVARIANT
> §5.5 ✅. Main is `adb03ea`, 228/228 (no product code on main yet). NOT
> merged — merge is the human's call. Do NOT re-implement it.**
>
> **FIRST: check PR #26's state.** `gh pr view 26` + `gh pr checks 26`.
> - If the human has NOT yet merged → they still owe the quiz
>   (https://claude.ai/code/artifact/5281e33b-4fcb-42f6-942e-5002ee34899b)
>   + reading CodeRabbit. If CodeRabbit/CI posted findings, ADDRESS them on
>   the branch (fix → re-review → push), then wait for the human to merge.
>   **The agent does NOT merge.** Optionally run the real `codex exec`
>   convergence pass on the PR diff **after ~Aug 8** (Codex account was
>   usage-limited this session — the earlier "quota is back" was wrong; it
>   re-triggered). Consider closing PR #25 (design doc; its content also
>   rode into #26).
> - If PR #26 is already MERGED → proceed to the rest of the MVP below.
>
> **After PR #26 merges — the rest of the MVP (spec §17 build order):**
> (2) **§11 Trace redaction** — display-only; MUST NOT touch the replay
> `output` payload (design D7); flips the last ⏳ invariant (§11). (3)
> `/mcp` server (stdio first) — the front door. (4) minimal `conduit` CLI
> (`serve`, `add-mcp`, `approvals list|approve|deny`). (5) the §4.2
> before/after token demo. Do NOT build the web console, FTS5, Trace
> viewer, or Phases 2–5 yet. Each is load-bearing on the security surface:
> branch from origin/main, PR per commit routing, Tier 2 + `/security-review`
> + (post-Aug-8) a real `codex exec` convergence pass, `/explain-diff` +
> full-pass quiz before merge, human-named merge. Consider
> `superpowers:brainstorming`/`writing-plans` for §5.5-scale pieces (the
> `/mcp` server). MVP done only when BOTH §17 gates pass (built end-to-end
> through the front door + a converged edge-case pass on the running
> skeleton). At session end, rewrite HANDOFF, append LEARNINGS, publish the
> debrief artifact.
