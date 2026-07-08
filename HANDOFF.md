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

## Current handoff — written 2026-07-08 (Issue #21 MERGED; §5.5 execution manager is next)

### Where things stand

- **Main is `64f6553`, 228/228 green, in sync with origin.** Issue #21
  (per-connect IP pinning) is DONE — **PR #22 MERGED** (squash) 2026-07-08,
  human-named for merge + quiz passed; **Issue #21 CLOSED**. No open PRs,
  no stray branches, no stashes — repo is clean.
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

### Next task: §5.5 execution manager

The biggest unbuilt piece. Replay stripping of non-memoizable journal
entries (`search`/`describe`), the approval queue, seeds/pausedOn
validators (PR #18 follow-ups). §11 Trace redaction still ⏳ and its scope
names `TraceEvent.output` (persisted unredacted for §5.5 replay). Both
§5.5 rows in INVARIANTS.md still ⏳.

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
> --limit 5`. **Issue #21 (per-connect IP pinning) is DONE — PR #22 MERGED
> 2026-07-08, main is `64f6553`, 228/228 green. Do NOT redo it.** Next
> task: **the §5.5 execution manager** — replay stripping of
> non-memoizable journal entries (`search`/`describe`), the approval
> queue, seeds/pausedOn validators (PR #18 follow-ups), and §11 Trace
> redaction (scope includes `TraceEvent.output`, persisted unredacted for
> §5.5 replay). Both §5.5 rows in INVARIANTS.md are ⏳. Branch from
> origin/main; PR per commit routing; Tier 2 + /security-review on the
> security surface; ONE adversarial pass as the convergence gate (real
> `codex exec` if quota is back post-Aug-1, else the sub-agent stand-in);
> /explain-diff + full-pass quiz before merge; merge only when the human
> names it. Optional retroactive carry-over: the Codex cross-model pass on
> Issue #21 can still run after Aug 1 if wanted. At session end, rewrite
> HANDOFF, append LEARNINGS, publish the debrief artifact.
