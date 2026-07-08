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

## Current handoff — written 2026-07-08 (§5.3 pipeline built, reviewed, MERGED)

### Where things stand

- **§5.3 ToolInvoker pipeline is DONE and on main.** PR #20 merged
  2026-07-08 (`c429376`), 15 commits, human-named for merge. Main is
  **`c429376`** — 219/219 tests, tsc + Biome clean, CI 8/8 green. The
  new `packages/sdk/src/pipeline/` module (errors, egress, upstream,
  invoker + tests) composes the existing seams into a live per-call
  path: tool lookup → policy → connection (A1) → credentials host-side →
  MCP upstream → Trace → return. The e2e smoke test drives the REAL
  pipeline (the inline stub from PR #19 is gone).
- **INVARIANTS.md: §9.3 flipped to ✅** (`pipeline/egress.test.ts`) — the
  first invariant this session pinned. §11 stays ⏳ and its scope now
  explicitly names `TraceEvent.output` (persisted unredacted for §5.5
  replay). §5.5 execution-manager and §5.5 replay-stripping still ⏳.
- **Three review rounds landed real fixes** (all pre-merge): Tier 2 (5
  agents), a security-review sub-agent, and TWO Codex adversarial passes.
  The adversarial passes were the highest-value rung — the first caught a
  HIGH §9.2 credential leak (a JSON-escaped echo bypassing the raw-body
  scan; independently verified exploitable) that all six other reviewers
  missed; the second caught short-token + NAT64 egress gaps. All fixed.
- **New spec §18 decisions this session** (in the merged spec pair):
  connection addressing v1 (A1), Trace-as-replay-log + A3 audit semantics
  (A3), MCP-only upstream (A5), per-connect egress pinning deferred to
  Phase 1, and **UpstreamCaller is a trusted dependency** (the invoker
  does not defend against a hostile custom caller — reopen condition
  documented).

### Global process infrastructure created this session (NOT project files)

These live in `~/.claude/` and load every session, every project. Named
here so the next session knows they exist:
- `rules/no-dead-ends.md` + `hooks/no-dead-ends-check.sh` — never end a
  turn on a blocker without a concrete way forward. Hook tuned after two
  false positives; verified live.
- `rules/codex-one-path.md` — ONE Codex invocation (raw `codex exec` in
  Bash, `dangerouslyDisableSandbox: true` for the auth file). Do NOT use
  the gstack `/codex` skill or `codex@openai-codex` plugin for passes.
- `rules/adversarial-convergence.md` — the stop-line for adversarial
  review: converged when every finding is out-of-scope or in a
  best-effort defense-in-depth layer. Fix denylist-shaped checks by
  SHAPE (canonicalize), don't add spellings.

### Waiting on the human

- **Branch cleanup (needs explicit OK per git-safety rules):** the local
  branch `feat/tool-invoker-pipeline` and the remote
  `origin/feat/tool-invoker-pipeline` both still exist (merge did not
  auto-delete the remote). Deleting either is a destructive git op — ask
  before running `git branch -d` / `git push origin --delete`.

### Next task: Issue #21 — stop the adversarial-review whack-a-mole

**GitHub Issue #21** (created this session). The two adversarial passes
each found the SAME class of bug: encoding-bypasses of the egress guard
(`isPrivateAddress`) and the credential-echo scan (`containsCredential`).
Both checks are denylist-shaped (scan for known-bad patterns) over an
unbounded input space, so they never converge — every pass finds another
spelling. The holistic fix (per `~/.claude/rules/adversarial-convergence.md`):

- **Egress → per-connect IP pinning** (canonicalize-then-check): resolve
  once, check the resolved binary address, force `fetch` to that IP. All
  textual encodings collapse; also closes the DNS-rebinding TOCTOU.
  Already the spec §18 Phase-1 answer. Needs a custom lookup/dispatch
  path — design + tests, not a one-liner.
- **Credential-echo scan → relabel as best-effort defense-in-depth**:
  scanning unbounded untrusted data can't be complete; document it as a
  tripwire and name the real guarantee (credential only in request
  scope; §11 at-rest redaction).
- **Acceptance:** one confirming adversarial pass returns ONLY
  out-of-scope or best-effort-layer findings (= converged, ship).

Also open, lower priority: PR #18 follow-ups (seeds/pausedOn validators
before §5.5 resume, etc. — listed in PR #18's Tier 2 comment); the §5.5
execution manager (the biggest unbuilt piece — replay stripping of
non-memoizable journal entries, approval queue).

### Session quirks worth inheriting

- Direct binaries from `packages/sdk/`: `node_modules/.bin/{vitest,tsc}`,
  `node_modules/.bin/biome` from repo root. `cd packages/sdk` first for
  vitest.
- **vitest tests using `node:http` loopback servers must run OUTSIDE the
  Bash sandbox** (`dangerouslyDisableSandbox: true`) — loopback listen
  hangs silently inside it and every test times out at `serve()`. The
  pre-commit hook runs them fine (it's not sandboxed).
- git network ops (`fetch`/`push`/`gh`) and `codex exec` need the sandbox
  override (auth files are denied). "certificate-25291" stderr noise is
  environmental — pipe through `grep -v certificate-25291`.
- `gh pr checks` polling: background `until` loop (foreground `sleep`
  chains are blocked).
- The pre-commit hook runs the full suite + Biome; a commit doubles as a
  verification run.
- Session-end docs must be written from a main checkout (`scripts/push-docs`
  requires being ON main).
- The `impeccable` hook flags em-dashes and "numbered section markers" in
  `conduitspec.html` — both are false positives (spec house style + real
  §-section numbers); leave them.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Read HANDOFF.md
> first and follow its protocol — including `gh pr list --state all
> --limit 5` (PR #20, §5.3 pipeline, MERGED 2026-07-08 — do not redo it).
> Main is `c429376`, 219/219 green. Then the next task: **GitHub Issue
> #21** — convert the egress guard and credential-echo scan from
> denylist-shaped to canonical-form so adversarial review converges (per
> `~/.claude/rules/adversarial-convergence.md`). Egress → per-connect IP
> pinning (the spec §18 Phase-1 answer, also closes DNS-rebinding);
> credential-echo → relabel as best-effort defense-in-depth. Acceptance:
> one confirming Codex adversarial pass (raw `codex exec` per
> `~/.claude/rules/codex-one-path.md`) returns only out-of-scope or
> best-effort findings. Branch from origin/main; PR per commit routing;
> Tier 2 + aikido + /security-review on the security surface; the ONE
> adversarial pass is the convergence gate, not an open-ended loop;
> /explain-diff + full-pass quiz before merge; merge only when the human
> names it. Ask before deleting the old feat/tool-invoker-pipeline
> branches (local + remote). At session end, rewrite HANDOFF, append
> LEARNINGS, publish the debrief artifact.
