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

## Current handoff — written 2026-07-12 (§17 step 3 `conduit` CLI — LANE A MERGED (PR #31 → main `0e333b6`); NEXT = build Lane B, the CLI package, on `feat/conduit-cli-lane-b`)

### Where things stand

- **Lane A MERGED (squash) → main is `0e333b6`.** All 5 shared seams shipped:
  (Note: the squash commit was force-corrected from `49f9c4b` → `0e333b6` post-merge
  to strip an AI co-authorship trailer that GitHub scooped from two earlier-session
  commit messages; message-only change, identical tree. A `githooks/commit-msg`
  guard now blocks that trailer. See LEARNINGS 2026-07-12 #8.)
  T1 `listPaused` (deterministic approvals queue) + T2 `provisionSource` (atomic
  §5.3 chain, no policy rows) on the SDK store; T3 `runStdioServer` (+ M8 redirect
  folded in) + T4 `openStoreFromEnv` + T5 `createApprovalRuntime` (§9.3 egress +
  M6 preserved) extracted in `packages/mcp`. Suite at merge: **sdk 318/318 + mcp
  40/40**, tsc + biome clean, 2 new INVARIANT rows (approvals-queue determinism;
  add-mcp atomic + no-policy). Full load-bearing gauntlet passed: whole-branch opus
  review (0 Critical/Important), /security-review (0 findings), real codex exec
  (CONVERGED — SHIP), /explain-diff quiz
  (https://claude.ai/code/artifact/88d95622-e05e-4919-b57e-fa0515503ae0), 9 CI
  checks green (incl. CodeRabbit + Greptile). The 2 Greptile P2s were non-blocking,
  adjudicated in-thread, and FOLDED INTO THE PLAN (Lane B Tasks 7 & 9 — see below).
- **Branch hygiene done:** `docs/conduit-cli-design` (Lane A's branch) DELETED
  local + remote (merged, content on main). Local branches now: `main`,
  `feat/conduit-cli-lane-b`. No stray stashes.
- **SDD ledger `.superpowers/sdd/progress.md`** (git-ignored) is the fine-grained
  recovery map through Task 5 + the whole gauntlet. Resume Lane B from it.

### NEXT TASK — build Lane B (the CLI), Tasks 6-9, on `feat/conduit-cli-lane-b`

**The Lane B branch already exists** — `feat/conduit-cli-lane-b`, cut fresh off
merged main (`0e333b6`), carrying a few doc commits: the two Greptile P2
carry-overs folded into the plan (Tasks 7 & 9), this HANDOFF, the session
closeout, and the `githooks/commit-msg` guard. **Check it out first** (`git
checkout feat/conduit-cli-lane-b`). Do NOT reuse the deleted `docs/conduit-cli-design`.

Resume **superpowers:subagent-driven-development** at plan
`docs/superpowers/plans/2026-07-12-conduit-cli.md` **Task 6**. Lane B is purely
additive (a new `packages/cli` that only CALLS Lane A's merged seams — it can only
break itself):
- **T6** — `packages/cli` scaffold + `conduit` bin dispatch (`serve|add-mcp|approvals`
  + `--help`/`--version`). ZERO new third-party deps (workspace:* + existing
  versions). If the workspace needs `pnpm install` to link the new package, STOP
  and hand the USER the command (agent never installs).
- **T7** — `conduit serve` (calls `runStdioServer`). **Carry-over baked into the
  plan:** don't call `runStdioServer` in-process before asserting CLI stdout — its
  console.* redirect is process-permanent; drive serve only via the spawned bin.
- **T8** — `conduit add-mcp` (read-first, atomic, credential-safe; calls
  `provisionSource` + `normalizeMcp`). The security/edge unit tests are the point.
- **T9** — `conduit approvals list|approve|deny` (calls `listPaused` +
  `createApprovalRuntime` → `manager.resume`). **Carry-over baked into the plan:**
  add a DIRECT egress test at the `createApprovalRuntime` seam (currently pinned
  only transitively via server.test.ts) — Task 9 adds the second caller.

Per-task: fresh implementer → verify (mcp/cli suites via unsandboxed vitest — hook
covers sdk only) → two-verdict review → ledger. COMMIT WITH SANDBOX DISABLED (hook
mktemp is sandbox-denied; never --no-verify). **Rebuild `packages/sdk/dist` (tsup)
before Lane B verification** — Lane B consumes the merged sdk seams via dist.
After T9: whole-branch review → finishing-a-development-branch → Lane B PR (its own
load-bearing gauntlet: Tier 2 + /security-review + real codex exec + /explain-diff
quiz + HUMAN-NAMED merge — the agent does NOT merge).

### Two workflow LESSONS from this session (also going to LEARNINGS)

- **codex prompt must be passed INLINE** in the `codex exec` command, NOT via a
  `$TMPDIR` file read with `cat` — `$TMPDIR` differs across sandbox-disabled Bash
  invocations, so the file isn't found and codex gets an empty prompt (silent
  misfire: "What would you like to work on?"). First codex attempt this session
  misfired exactly this way; the inline re-run worked.
- **CI-watch `jq` on `gh pr checks --json state`**: the state token casing didn't
  match my filter, so the Monitor emitted nothing and timed out. Use
  `gh pr checks <n>` (plain, tab-delimited `pass/fail/pending`) or verify the
  `--json state` enum values before filtering.

### Session debrief (this session, full narrative)

https://claude.ai/code/artifact/a1e9fd6c-5930-47a1-947a-e67ecdd88d10

### ⚠️ Historical note — the OLD current handoff below (Lane A in-progress on the unmerged branch) is SUPERSEDED by the above. Kept for the session-quirks it still carries.

## Superseded handoff — written 2026-07-12 earlier (Lane A T1-T2 in progress on `docs/conduit-cli-design`, now MERGED as PR #31)

### ⚠️ READ FIRST — the build lives on an UNMERGED LOCAL branch (tripwire blind spot)

The CLI work is on branch **`docs/conduit-cli-design`** (ahead of `origin/main`,
PUSHED to `origin` with upstream tracking as a backup, but NO PR yet). `main` is
untouched, so the git staleness tripwire is SILENT about this work by design (the
LEARNINGS #21 blind spot). **At session start: check out
`docs/conduit-cli-design` (it exists on origin too); `gh pr list` will show
nothing — the branch is pushed but no PR is open.** Do NOT start the CLI on
`main` or a new branch, and do NOT open a PR yet. **Ship strategy (decided
2026-07-12): TWO PRs — Lane A (the SDK/mcp seams) merges FIRST, then Lane B (the
CLI package) on top.** Rationale: Lane A refactors already-shipped, security-
sensitive code (the SDK store + the live /mcp server's startup/manager
composition), so a regression there can break the SHIPPED server — it deserves
its own focused "did behavior change?" review, provable against the existing mcp
suite, before the additive CLI is layered on. Lane B is purely additive (a new
package that only CALLS the seams) and can only break itself. The design doc
rides with the Lane A PR (it's the whole feature's decision record). The SDD
ledger (`.superpowers/sdd/progress.md`) is
git-ignored so it did NOT push — it's reconstructable from `git log` on the
pushed branch, which is what the SDD resume step does.

### Where things stand

- **Design + plan COMMITTED** (on the branch): design
  `docs/superpowers/specs/2026-07-12-conduit-cli-design.md`; plan
  `docs/superpowers/plans/2026-07-12-conduit-cli.md`. Both went through
  brainstorming → grilling → plan-eng-review (+ real codex cross-model outside
  voice) → coherence audit. Read the design first — it is the authoritative
  decision record (D1-D5, E1-E4, C1-C7, the "Re-run/existing-state" §4).
- **Build IN PROGRESS via superpowers:subagent-driven-development.** The SDD
  ledger `.superpowers/sdd/progress.md` (git-ignored) is the RECOVERY MAP — it
  names every landed commit and the operational rules. Resume from it, not from
  memory. Prior PR#29 ledger archived alongside as `progress.mcp-stdio-pr29.archive.md`.
- **Landed clean (SPEC ✅ + QUALITY Approved each):**
  - **T1 `listPaused`** (commit `838109b`) — `ExecutionRepository.listPaused():
    Promise<Execution[]>`, `ORDER BY started_at ASC, id ASC`, via existing
    `hydrateExecutionRow`. INVARIANT pinned.
  - **T2 `provisionSource`** (commit `ccc237c`) — atomic §5.3 chain via one
    `client.batch(...,"write")`, seal-before-batch, NO policy rows; atomicity
    test violates `tools.risk_class` CHECK mid-batch → 0 rows. INVARIANT pinned.
  - Suite: **sdk 318/318**, tsc + biome clean.

### NEXT TASK — resume the SDD build at Lane A Task 3

The plan's 9 tasks, in TWO lanes (**Lane A MUST fully land before Lane B**):
- **Lane A (SDK/mcp seams) — remaining: T3, T4, T5.**
  - **T3** — extract `runStdioServer` in packages/mcp; fold the `console.*`→stderr
    M8 redirect INTO it as its first runtime action (not module top-level); the
    `conduit-mcp` bin drops its own redirect and becomes a shim. Existing ring-2
    M8 test must stay green.
  - **T4** — extract `openStoreFromEnv` (env→store) from the bin; shared by all.
  - **T5** — extract `createApprovalRuntime({store, allowPrivateEgress})` — the
    manager composition currently inlined at server.ts:184-200; server.ts + the
    CLI's approvals both call it.
- **Lane B (the CLI, consumes Lane A) — T6 scaffold+dispatch, T7 serve, T8
  add-mcp, T9 approvals.**
- After T9: final whole-branch review (most capable model) →
  superpowers:finishing-a-development-branch.

The three tweakable interface signatures (listPaused DONE, provisionSource DONE,
`createApprovalRuntime` — T5) are STOP-and-ask if reality forces a change.

### Session quirks worth inheriting (build-specific)

- **Commit with the sandbox DISABLED, never `--no-verify`.** The pre-commit hook
  calls `mktemp` (githooks/pre-commit:15), which the Bash sandbox denies → hook
  fails closed. T1's implementer reached for `--no-verify` (a documented
  incident); the FIX (in the ledger, carried in every dispatch T2+) is to
  disable the sandbox for the `git commit` so the hook runs the full sdk suite.
- **Hook covers packages/sdk ONLY.** For mcp/cli tasks (T3-T9): run that
  package's `node_modules/.bin/vitest run` with the sandbox disabled (hermetic
  local suite — the sanctioned exception), paste output for the reviewer. CI is
  the post-push authority for mcp/cli.
- **Rebuild `packages/sdk/dist` (tsup) after sdk source changes** a downstream
  task consumes — the workspace resolves against dist. (T1/T2 were sdk-internal;
  Lane B consumes the new sdk seams, so rebuild before Lane B verification.)
- SDD artifacts are namespaced `cli-task-N-*` (the bare `task-N-*` files in
  `.superpowers/sdd/` are the archived PR#29 set — don't confuse them).
- git network ops need the sandbox override; `grep -v certificate-25291` noise.
- Session-end docs push (`scripts/push-docs`) requires being ON main — but this
  session's HANDOFF/LEARNINGS edits are on the CLI branch with the build. See
  the routing note below.

### Doc-routing note for THIS handoff

HANDOFF.md/LEARNINGS.md are `.pushallowlist`ed (direct-push-to-main eligible),
but they're being edited on `docs/conduit-cli-design` alongside the build. They
ride with the **Lane A PR** (the first to merge) along with the design doc — no
separate docs-push needed; keeping them with the build keeps one coherent story
per PR.

### Carry-overs (unchanged from 2026-07-11, still valid)

- **§17 gate-one manual acceptance NOT done** (real Claude Desktop against the
  merged /mcp server). Human step before MVP is "shipped".
- **Tracked SDK design items surfaced by the CLI review (out of scope for the
  CLI PR):** C4 — MCP transport maturity (stateless POST vs init/session/
  pagination); C5 — normalizeMcp lossy non-round-trippable tool names (store
  upstreamName or reject). Both pre-existing SDK concerns; file properly when
  touched. Also C3-structural (re-key policies by source identity) — the CLI
  ships the `--replace` flag-gate as the MVP answer.
- **Minor roll-up for the CLI final review:** tools INSERT SQL now duplicated in
  `replaceNamespace` + `provisionSource` (T2) — extraction judged speculative at
  2 call sites; revisit at a 3rd.
- Aikido SAST MCP still not connected (`/aikido:setup` in the user's terminal).
- gstack update available — user-run, low priority.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Read HANDOFF.md first.
> **The §17 step-3 `conduit` CLI build is IN PROGRESS on local branch
> `docs/conduit-cli-design` (NOT main, NOT pushed) — check it out first; the git
> tripwire is silent because work is off main.** Design + plan are committed
> there; the SDD ledger `.superpowers/sdd/progress.md` is the recovery map.
> **Landed: Lane A T1 (listPaused) + T2 (provisionSource), sdk 318/318, both
> reviewed clean. Do NOT re-implement them.**
>
> **NEXT: resume superpowers:subagent-driven-development at Lane A Task 3**
> (extract runStdioServer + fold in the M8 redirect), then T4 (openStoreFromEnv),
> T5 (createApprovalRuntime) — Lane A MUST finish before Lane B (T6-T9 the CLI).
> Per-task: fresh implementer → verify → two-verdict review → ledger. COMMIT WITH
> SANDBOX DISABLED (never --no-verify — hook mktemp is sandbox-denied); mcp/cli
> tasks verify via unsandboxed vitest (hook covers sdk only). createApprovalRuntime
> (T5) is a STOP-and-ask frozen signature.
>
> **SHIP IN TWO PRs (decided 2026-07-12): Lane A (seams) merges FIRST, then Lane B
> (CLI) on top.** Lane A refactors shipped/security-sensitive code (SDK store +
> the live /mcp server) → its own focused behavior-preserving review, provable
> against the existing mcp suite. Lane B is additive-only. Each PR: final review →
> finishing-a-development-branch → load-bearing route (Tier 2 + /security-review +
> real codex exec + /explain-diff quiz + human-named merge). Design doc +
> HANDOFF/LEARNINGS ride with the Lane A PR. Practically: after T5, cut the Lane A
> PR from the branch (or split the branch); build Lane B on top of merged Lane A.

---

## Previous handoff — written 2026-07-11 (/mcp stdio server MERGED — PR #29 → main `c56ed7d`; next MVP step = §17 step 3, the `conduit` CLI; egress `::/96` fix MERGED — PR #30 → main `1d95074`)

### Where things stand

- **PR #29 MERGED (squash) → main is `c56ed7d`.** The /mcp stdio server (spec §17
  build order **step 2**) is landed: `packages/mcp` (two tools — `execute` +
  `check_execution`), the one SDK change (persisted outcome columns
  result/error/request_key + WAL + outcome-aware terminals + capped listing), demo
  scripts (`scripts/{seed-demo,approve-demo}.mjs`). Branch `feat/mcp-stdio-server`
  deleted. Suite: **sdk 313/313 + mcp 37/37**, tsc + biome clean, all prior
  INVARIANTS still ✅ plus new rows (M1 seam, M8 stdout purity, M4 outcome
  persistence, check_execution ≤256 tokens, §4.2 capped-listing).
- **Full build+review trail lives in `.superpowers/sdd/progress.md`** (this plan's
  section — 12 tasks, per-task two-verdict reviews, final whole-branch review, the
  POST-PR REVIEW GAUNTLET block). Design: `docs/superpowers/specs/2026-07-11-mcp-stdio-server-design.md`
  (M1-M9). Explainer artifact (quiz passed):
  https://claude.ai/code/artifact/dda68c25-6965-46d5-87c7-5cc595622ba6
- **Review gauntlet outcome (all clean or fixed):** Tier 2 (5 agents) — general
  review ready-to-merge; /security-review 0 findings; real codex pass found 1 High
  that was **out of scope** (NAT64 gap in egress.ts, which this branch never
  touched — filed as a follow-up, see below). Four in-scope findings fixed in the
  branch before merge (commits fae7e23..9ededd8): check_execution store-fault
  redaction (shared `internalErrorFor` helper), WAL-pragma made loud, INVARIANTS
  M1 label collision, bin flag/doctor exit-path tests. CI green.

### NEXT TASK — spec §17 step 3: the minimal `conduit` CLI

§17 build order after the /mcp server: **(3) a minimal `conduit` CLI** — `serve`,
`add-mcp`, `approvals list|approve|deny`. The merged execution manager's
`resume(execId, {approve|deny})` is the engine `approvals` drives; `scripts/approve-demo.mjs`
is the throwaway interim approver whose composition the CLI's `approvals approve`
formalizes (read it — it's char-identical to server.ts's pipeline wiring incl. the
egress env). This is a **§5.5-scale piece — START WITH BRAINSTORM + PLAN**
(`superpowers:brainstorming` → `writing-plans`); do NOT jump to code. Known surfaces:
where `serve` overlaps the existing `conduit-mcp` bin (reuse, don't duplicate the
env contract in `packages/mcp/src/env.ts`), how `add-mcp` writes source/integration/
connection/secret rows (mirror `scripts/seed-demo.mjs`), and the approvals TTL/expiry
presentation (the manager already lazily expires on resume).

**Then (spec §17):** (4) the §4.2 before/after token demo. Do NOT build the web
console, FTS5, Trace viewer, or Phases 2-5. **MVP is done only when BOTH §17 gates
pass** — gate one: built through the front door (real Claude Desktop manual
acceptance against the merged /mcp server — NOT yet done, see carry-overs); gate
two: converged edge-case pass on the running skeleton.

Each piece is load-bearing: branch from origin/main, PR per commit routing, Tier 2
+ /security-review + real `codex exec` pass, /explain-diff + full-pass quiz,
**human-named merge** (merge authority is the human's — a general "wrap up" is not a
merge instruction).

### Carry-overs (not blocking the CLI, but track them)

- **§17 gate-one manual acceptance NOT done:** nobody has yet driven the merged
  /mcp server from a real Claude Desktop/Cursor config end-to-end. The README
  (`packages/mcp/README.md`) has the onboarding; `scripts/seed-demo.mjs <url>`
  prints a ready config snippet. This is a human step — do it before calling the
  MVP shipped.
- **NAT64 egress hardening — DONE (PR #30 → main `1d95074`, merged 2026-07-11).**
  The filed finding (codex's out-of-scope High: `isPrivateAddress` handles only
  the well-known `64:ff9b::/96` prefix, not RFC 6052 custom prefixes) was
  evaluated and recorded in **spec §18 as out-of-scope** — a custom NAT64 prefix
  has no globally-fixed meaning, so reaching a private target needs the
  operator's OWN network translator, which Conduit cannot observe (and this is
  distinct from the `allowPrivate` opt-in). Evaluating it surfaced a REAL
  adjacent bug, which PR #30 fixed: IPv4-compatible `::/96` (`::127.0.0.1`,
  `::169.254.169.254`) was classified public while its v4-mapped twin was
  blocked. Full Tier-2 gauntlet (codex CONVERGED, /security-review clean,
  explainer+quiz, 9 CI checks). No egress carry-over remains.
- **Type-design follow-up (tracked, unfiled):** the Tier-2 type-design agent's
  theme — `ExecutePayload`/`CheckPayloadBody`/`Execution` status fields are flat
  interfaces, not discriminated unions, so illegal states (e.g. `status:"failed"`
  with no `error`) are representable and guarded by tests, not the compiler. A real
  quality improvement, deliberately NOT folded into PR #29 (broad cross-package
  refactor). Consider a dedicated PR mirroring `ExecutionOutcome`'s discrimination.
- Aikido SAST MCP still not connected (needs `/aikido:setup` in the user's
  terminal) — CI Socket + secrets scan cover supply-chain/secrets meanwhile.
- gstack update available (1.5.1→1.60.1) — user-run, low priority.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Read HANDOFF.md first and
> follow its protocol (including `gh pr list --state all --limit 5`). **State: the
> /mcp stdio server is MERGED (PR #29, squash) → main `c56ed7d`; sdk 313/313 + mcp
> 37/37 green. Do NOT re-implement it.**
>
> **NEXT TASK: spec §17 step 3 — the minimal `conduit` CLI** (`serve`, `add-mcp`,
> `approvals list|approve|deny`). It's a §5.5-scale piece: START WITH
> `superpowers:brainstorming` then `writing-plans`; surface unknowns first (overlap
> with the conduit-mcp bin's env contract, how add-mcp writes store rows à la
> seed-demo.mjs, approvals expiry presentation). The merged manager's
> resume(execId,{approve|deny}) is the approvals engine; approve-demo.mjs is the
> interim approver to formalize. Then subagent-driven build per the plan.
>
> **Then (spec §17):** (4) the §4.2 token demo. Do NOT build the web console, FTS5,
> Trace viewer, or Phases 2-5. Each piece: branch from origin/main, PR routing,
> Tier 2 + /security-review + real codex exec pass, /explain-diff + full-pass quiz,
> **human-named merge**. Before declaring the MVP shipped: do §17 gate-one (real
> Claude Desktop acceptance against the merged /mcp server — see carry-overs).
> (The NAT64 egress follow-up is DONE — PR #30 merged.)

---

## Previous handoff (2026-07-10, superseded but quirks still valid)

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

- ~~spec §18 list labeling~~ **DONE** — PR #28 (merged 2026-07-10, separate
  spawned session) moved the locked decisions out of the "Deferred" list.
  All residue from that work is CLEANED (verified 2026-07-10, same session):
  the spawned worktree, its registration, and its session branch are gone;
  `docs/execution-manager-design` (closed PR #25) was deleted with the
  user's explicit OK; orphaned `branch.*` git-config sections removed. Local
  branches are exactly `main`. Nothing left to clean from this item —
  workflow lessons recorded in LEARNINGS 2026-07-10 (§18 list hygiene).
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
