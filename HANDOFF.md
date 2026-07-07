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

## Current handoff — written 2026-07-07 (verification-pause + §5.3 planning session)

### Where things stand

- **Verification pause COMPLETE — the user called a stop-and-verify
  before §5.3, and it paid.** Baseline re-proven on-machine (151/151,
  tsc, Biome), then an end-to-end smoke test was written composing every
  shipped module across its real seams: normalize → sqlite on disk →
  reopen → catalog rehydrate → policy + credentials + QuickJS sandbox
  through an inline ToolInvoker stand-in. It passed on the first run —
  seam discipline held. **PR #19 merged (`bbe7726`, merge named by the
  human 2026-07-07):** `test: add end-to-end smoke test composing all
  modules across their seams` (`56f265c`). Gate: CI 8/8, CodeRabbit
  clean, Tier 1 agent review pass (findings comment on the PR). Main is
  **`bbe7726`** — 152/152 tests. The smoke test is now the standing
  integration guard; **the §5.3 PR's acceptance criterion is to replace
  its inline stub with the real pipeline and keep every assertion
  green.**
- **INVARIANTS.md unchanged:** 9 pinned ✅, 3 ⏳ (§9.3 egress — flips
  with the §5.3 PR, §11 Trace redaction, §5.5 execution manager).
- **Blindspot pass for §5.3 RUN (protocol debt cleared).** Artifact:
  claude.ai/code/artifact/3c6b05e7-ac8c-47a9-a385-1d92dde85097 — nine
  cards, file:line evidence. Sharpest findings: (1) `credentials.ts:63`
  interpolates the credentialRef into its own error message and
  `quickjs.ts:254` forwards any host error to the guest + journal — a
  §9.2 zone violation the moment the pipeline wires `resolve()` in;
  (2) journaling a policy denial as `{ok:false}` would poison §5.5
  replay (memoized denial survives approval).
- **Tweakable plan WRITTEN and decisions LOCKED (human delegated).**
  Artifact: claude.ai/code/artifact/9f539fdb-cd1a-4904-9c63-d628cc4ef9ba
  — decisions A1–A7 first, file map, tasks T1–T7 (TDD, one commit each).
  Locked: A1 connection addressing v1 = single-connection-per-namespace,
  fail closed on multiple, prefix param reserved on the seam; A3
  TraceEvent gains capped `output` field, Trace = durable replay log for
  call ops, search/describe persistence deferred to §5.5; A5 MCP-only
  upstream behind a per-source-type seam, prefix-stripped names (known
  limitation documented). Error vocabulary: ConduitPolicyDenied /
  ConduitPolicyBlocked (non-memoizable, §5.5 contract) /
  ConduitUpstreamError / ConduitInternalError (opaque + correlation id).
  These three decisions land in spec §18 in the §5.3 PR (plan task T7).
- **PR-review tiering rules were updated mid-session (global CLAUDE.md +
  memory, re-read from disk 2026-07-07):** Tier 2 splits along the PR
  lifecycle (`/pr-review-toolkit:review-pr all parallel` pre-PR;
  `code-review:code-review <PR#>` post-PR), `aikido:scan` +
  `/security-review` on security-touching PRs, `/codex:adversarial-review`
  cross-model rung on the highest-stakes, `/code-review ultra` NOT in the
  default ladder. The §5.3 PR is highest-stakes: all rungs apply, plus
  explainer + quiz.
- **PR #18 follow-ups still open** (listed in that PR's Tier 2 comment):
  seeds/pausedOn shape validators (must-fix before §5.5 resume),
  maybeText/maybeInteger NULL-vs-corruption conflation, the
  status⟺paused_on invariant, cross-field risk_class/declaredRisk drift,
  corrupt-identity-column row identity. None block §5.3.
- Housekeeping: local branch `test/e2e-smoke` still exists (deletion
  needs the human's confirmation per git-safety rules); remote branch
  auto-deleted.
- All prior decisions remain in force (PR-by-default routing, two-tier
  allowlist + protected floor, Dependabot alerts-only, merge authority
  is the human's — do not re-litigate).

### Waiting on the human

Nothing blocking. The plan is approved-by-delegation ("decide what you
think is best"); execution route chosen: fresh session.

### Next task: EXECUTE the §5.3 plan (T1–T7)

The thinking is done — do not re-plan. Read the plan artifact, run its
Ground-truth checks, then execute in order:

- T1 `pipeline/errors.ts` — guest-safe error vocabulary.
- T2 `pipeline/egress.ts` — §9.3 guard; INVARIANT test + ledger flip in
  the same commit.
- T3 `pipeline/upstream.ts` — MCP caller: egress-guarded fetch, manual
  redirects (refused v1), AbortSignal timeout, stream-capped JSON-only
  responses.
- T4 TraceEvent.output + sqlite column (ALTER-if-missing migration).
- T5 `pipeline/invoker.ts` — the §5.3 composition; §9.2 leak tests
  (failing reveal leaks nothing).
- T6 wire-up: exports, sandbox.ts non-memoizable doc note, smoke-test
  stub → real pipeline (+ §9.3-blocks-by-default, 401-echo, and
  denied-journal-name tests).
- T7 spec §18 decisions + `python3 html2md.py` + PR bookkeeping.

Stop-and-ask triggers (from the plan): any new dependency, any change to
parseSourceSemantics or the ToolInvoker signature, any softening of a
fail-closed default.

Gate: branch `feat/tool-invoker-pipeline` from origin/main; PR; Tier 2
per the updated lifecycle split + aikido + /security-review +
/codex:adversarial-review; /explain-diff + full-pass quiz; merge only
when the human names it.

### Session quirks worth inheriting

- Everything from prior lists still applies: direct binaries
  (`packages/sdk/node_modules/.bin/{tsc,vitest}`, `node_modules/.bin/biome`
  from repo root); sandbox override needed for git network ops and `gh`;
  "certificate-25291" stderr noise is environmental (pipe through
  `grep -v certificate-25291`); zsh eats `=`-prefixed words; quickjs
  ground truth is the shipped dist (LEARNINGS #9); fresh worktrees lack
  node_modules — symlink, don't install; libsql rejects `{ sql }` object
  form — use parameterized `args`.
- The pre-commit hook runs the full suite + Biome; a commit doubles as a
  verification run.
- `gh pr checks` polling: background `until` loop (foreground `sleep`
  chains are blocked).
- Session-end docs from a feature-branch worktree: `scripts/push-docs`
  requires being ON main — write HANDOFF/LEARNINGS in the main checkout.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Start by reading
> HANDOFF.md and follow its protocol — including
> `gh pr list --state all --limit 5` (PR #19, e2e smoke test, merged
> 2026-07-07 — do not redo its work). Then the current task: EXECUTE the
> §5.3 ToolInvoker pipeline plan — the blindspot pass and tweakable plan
> are DONE, decisions A1–A7 are locked, do not re-plan. Plan artifact:
> claude.ai/code/artifact/9f539fdb-cd1a-4904-9c63-d628cc4ef9ba (blindspot
> companion: claude.ai/code/artifact/3c6b05e7-ac8c-47a9-a385-1d92dde85097).
> Run the plan's Ground-truth checks, then tasks T1→T7 in order — TDD,
> one commit per task, INVARIANT §9.3 test + ledger flip in T2's commit,
> smoke-test stub replaced in T6 with every assertion green. Stop and ask
> before: any new dependency, any change to parseSourceSemantics or the
> ToolInvoker signature, any softening of a fail-closed default. Keep a
> deviations log in the scratchpad from T1 onward. Branch
> feat/tool-invoker-pipeline from origin/main; PR per commit routing;
> Tier 2 (review-pr pre-PR, code-review:code-review post-PR) + aikido +
> /security-review + /codex:adversarial-review at the gate; /explain-diff
> + full-pass quiz before merge; merge only when the human names it. At
> session end, rewrite HANDOFF.md, append LEARNINGS.md, and publish the
> session debrief artifact.
