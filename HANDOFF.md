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

## Current handoff — written 2026-07-08 (Issue #21 built + reviewed; PR #22 OPEN, awaiting human quiz + merge)

### Where things stand

- **Main is `a61001b`, 219/219 green** — UNCHANGED this session. All Issue
  #21 work lives on the OPEN PR branch `feat/egress-ip-pinning`; nothing
  merged. The staleness tripwire only sees main, so it will read "fresh"
  even though real work exists — **pair it with `gh pr list --state all
  --limit 5` (PR #22 is the live one).**
- **PR #22 — Issue #21 (per-connect IP pinning) — DONE, reviewed, OPEN.**
  Two commits: `a8bdfa8` (feature) + `61f21be` (review fixes). **231 tests
  green** (219 → +12), tsc + Biome clean, CI fully green (unit, lint,
  Socket Security, secrets, CodeRabbit). Closes #21.
  - Egress converted denylist → canonical-form: `createPinnedLookup` in
    `packages/sdk/src/pipeline/egress.ts` resolves once and hands the
    socket only §9.3-vetted IPs (spec §18 Phase-1; closes DNS-rebinding
    TOCTOU). `isPrivateAddress` unchanged — now a classifier fed resolved
    IPs, not the boundary. Transport moved `fetch()` → `node:https/http`
    request in `pipeline/upstream.ts` (undici can't inject a custom
    lookup). Credential-echo scan relabeled best-effort. Convergence
    stop-line folded into CLAUDE.md + INVARIANTS.md (§9.3 row updated).
  - **Tier 2 review (3 agents) returned ZERO boundary breaks**; the
    security agent empirically verified on Node 22 that happy-eyeballs
    spawns no second un-pinned resolution and that literal-IP hosts skip
    the custom lookup (so the pre-flight is load-bearing — see LEARNINGS
    #35). Four real transport bugs found + fixed in `61f21be` (uncleared
    timer, message→structural-tag, `opts.family`, HTTP-0 msg); two refuted
    by probe; two coverage gaps closed with new tests.

### Waiting on the human (BOTH are the human's authority, not the agent's)

1. **Pass the explainer quiz** — the merge gate for this load-bearing
   change. Explainer + quiz artifact:
   https://claude.ai/code/artifact/baa77764-0eb2-4c2a-8f07-dde68b2c7ae0
   (also posted as a PR #22 comment). A missed question → reread + retake.
2. **Name PR #22 for merge** — the agent never merges on its own
   authority. Merge only on green + after the quiz passes.

### Deferred / blocked (surfaced, not buried)

- **Codex cross-model adversarial pass could NOT run** — ChatGPT/Codex
  usage quota exhausted, **resets Aug 1 2026**. This was the originally-
  specified convergence gate. Stand-in per `~/.claude/rules/no-dead-ends.md`:
  the dedicated adversarial security-review agent (zero boundary breaks,
  Node-22-verified). If the cross-model signal is wanted specifically,
  run the real `codex exec` pass after Aug 1 before final merge — NOT
  blocking, human's call. (LEARNINGS #36.)
- **Aikido SAST MCP is not connected** — needs `/aikido:setup` (MCP login)
  in the user's terminal. CI Socket Security + secrets scan cover
  supply-chain/secrets in the meantime.
- **Old `feat/tool-invoker-pipeline` branches: already gone.** HANDOFF
  said they needed cleanup; verified this session via `git ls-remote` —
  remote has only `main`, local branch absent. Nothing to delete. (The
  prior HANDOFF was stale on this point; corrected here.)

### Next task (after PR #22 lands): §5.5 execution manager

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
  requires being ON main) — but PR #22's branch is still checked out;
  switch to main first for the docs push.
- The `impeccable` hook flags em-dashes / "numbered section markers" in
  `conduitspec.html` — false positives; leave them. On HTML explainers it
  flags thick side-tab borders — legit; use a thin label marker instead.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Read HANDOFF.md
> first and follow its protocol — including `gh pr list --state all
> --limit 5`. **PR #22 (Issue #21, per-connect IP pinning) is OPEN, fully
> built + reviewed (231 green, CI green, Tier 2 zero boundary breaks),
> awaiting the human's quiz pass + merge — do NOT redo it, do NOT merge it
> yourself.** If the human has since merged it, main will have moved past
> `a61001b`; reconcile from `git log`. Two carry-overs on PR #22: the
> Codex cross-model pass is deferred to Aug 1 (quota) — optional before
> final merge; Aikido needs `/aikido:setup`. Then the next task: **the
> §5.5 execution manager** — replay stripping of non-memoizable journal
> entries, the approval queue, seeds/pausedOn validators (PR #18
> follow-ups), and §11 Trace redaction (scope includes `TraceEvent.output`).
> Branch from origin/main; PR per commit routing; Tier 2 +
> /security-review on the security surface; ONE adversarial pass as the
> convergence gate (real `codex exec` if quota is back, else the sub-agent
> stand-in); /explain-diff + full-pass quiz before merge; merge only when
> the human names it. At session end, rewrite HANDOFF, append LEARNINGS,
> publish the debrief artifact.
