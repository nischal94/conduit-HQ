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

---

## Current handoff — written 2026-07-03 (Phase 0 finale session)

### Where things stand

- **Phase 0 is complete.** Every §17 Phase 0 item shipped: data model,
  OpenAPI + MCP normalizers, catalog, QuickJS sandbox + execute tool,
  SQLite storage, secrets-at-rest, and (this session) the credential
  resolver + §9.2 boundary invariant.
- `main` @ `4997ba5` + this handoff/LEARNINGS commit. 100/100 tests,
  typecheck clean, Biome clean. INVARIANTS.md: 8 pinned ✅, 4 ⏳
  (§9.3 egress, §11 Trace redaction, §5.5 execution manager, §10.2
  policy defaults).
- **Credential resolver** (`packages/sdk/src/credentials.ts`):
  `CredentialResolver` seam; store-backed impl binds
  `Connection.credentialRef → secret` at call time, host-side, emitting
  Authorization-header material. Stored secret carries its own scheme
  prefix (spec has no auth-scheme vocabulary — LEARNINGS #15); dangling
  refs fail closed; no caching, so rotation is live next call. The
  INVARIANT §9.2 test in `credentials.test.ts` runs the real stack with
  adversarial guest code + a positive control on a stub upstream.
- **CI is ACTIVE** (`.github/workflows/ci.yml`, moved by the human,
  commit `daffd92`): all `uses:` at commit SHAs, both docker images at
  digests. The activation checklist in the file header records verified
  per-item state.
- **Milestone audit: complete.** Aikido scan clean (0 findings on
  session files). `pnpm audit` run in the human's terminal: found
  vitest critical (GHSA-5xrq-8626-4rwp) + vite high
  (GHSA-fx2h-pf6j-xcff), fixed same day by `09c3610` (vitest 3.2.6 +
  vite 7.3.6); audit now reports **1 low only**, triaged and ACCEPTED
  2026-07-03: esbuild GHSA-g7r4-m6w7-qqqr (dev-server file read,
  Windows-only) — unreachable here (tsup uses esbuild's build API only,
  no server, no Windows; devDependency, not in the published tree).
  tsup latest (8.5.1) still pins esbuild ^0.27.0, so no in-range patch
  exists; forcing 0.28.1 out-of-range is riskier than the finding.
  Revisit when tsup widens its esbuild range — the milestone audit
  cadence re-surfaces it automatically. Do NOT re-litigate from scratch.
  LEARNINGS/HANDOFF freshness sweep done (one supersede note on #3).
- **DECIDED 2026-07-03: branch protection is DEFERRED.** Free-plan
  private repo → GitHub 403s branch protection and rulesets; the human
  chose defer over Pro/going-public. Consequence: CI checks run but are
  not *required* — acceptable while there's a single committer.
  Revisit trigger: a second committer, or the repo going public
  (which also mandates first-contributor approval, see the ci.yml
  checklist items 2–3). Default GITHUB_TOKEN read-only: verified done.

- **DECIDED 2026-07-03: commit routing is PR-by-default.** Rule and
  rationale live in CLAUDE.md "Commit routing" + LEARNINGS #16; tripwire
  in `githooks/pre-push`. Direct push to main only for HANDOFF.md /
  LEARNINGS.md. CodeRabbit is installed and reviews PRs. Feature work
  starts on a `feat/…` branch, never on main.

- **Commit-routing PR #2: MERGED 2026-07-03** (`974eaf9`) — main's CI
  is green (first green run), the pre-push gate is live, CodeRabbit's
  first review passed with zero findings.
- **Dependabot policy (2026-07-03): fully implemented and verified.**
  Alerts + malware alerts ON; security-update auto-PRs OFF (repo
  setting confirmed `enabled:false` via API); version updates OFF.
  Rule in CLAUDE.md via merged PR #3. esbuild alert dismissed as
  tolerable risk with rationale.
- **Guarded docs push landed (PR #4, merged 2026-07-04):**
  `scripts/push-docs` verifies the inert-prose allowlist then pushes
  main; agent-side allow rule in `.claude/settings.local.json` is
  verified live (script runs promptless). The global deny on agent
  `git push origin main` stays intact everywhere else.
- **DECIDED 2026-07-04: HANDOFF.md and LEARNINGS.md stay git-tracked.**
  Considered gitignoring them; rejected because the staleness tripwire,
  LEARNINGS' tamper-evidence, fresh-clone continuity, and the entire
  inert-prose push machinery depend on tracking. Instead, "strip or
  relocate session docs" joins the going-public checklist — a one-line
  comment the human should add to the ci.yml ACTIVATION CHECKLIST
  (workflow file is agent-unwritable) next time it's open for editing.
- **Branching discipline (2026-07-04):** cut feature branches from
  `origin/main` after a fetch, never from local main — two PR branches
  this session carried an unpushed local-main commit into their PRs
  (benign, reviewed, but untidy).

### Waiting on the human

Nothing. All session items closed and verified.

### Next task: policy engine v1 (spec §10.1–§10.2) — Phase 1 opener

The §5.3 pipeline's step 2. riskClass derivation exists (`risk.ts`,
§10.1 pinned); the `PolicyRepository` exists with override-persistence
pinned. Missing: the engine that seeds per-tool policies from riskClass
defaults and produces allow / require-approval / block verdicts for the
ToolInvoker.

Read before coding: spec §10.1–§10.2, §5.3 (step 2), §5.5 (what a
require-approval verdict must eventually trigger); INVARIANTS.md §10.2
row; `risk.ts`, `store/store.ts` (PolicyRepository), `execute.ts`
(ToolInvoker mount point), LEARNINGS #4 (verdicts must carry reasons).

Acceptance criteria:
- Engine behind an interface (seam discipline), consuming
  PolicyRepository + Tool.riskClass.
- Seeding per §10.2: safe→Allow, review/destructive→Require approval;
  manual overrides win and are never silently reverted (already pinned
  at store level — the engine must respect it).
- Verdicts are data with a human-readable reason (LEARNINGS #4: silent
  policy reads as malfunction).
- INVARIANT §10.2 test in the same commit; ledger row flips in that
  commit.
- Input-aware rules (§10.3) are Phase 2 — do NOT build them; leave the
  seam able to grow them.

### Session quirks worth inheriting

- Agent runs tools via direct binaries
  (`packages/sdk/node_modules/.bin/{tsc,vitest}`, `node_modules/.bin/biome`
  from the repo root) — the `pnpm` shim routes through Socket Firewall,
  whose CA key the agent sandbox correctly denies. Installs are always
  the human's, in their terminal.
- Git commits need the sandbox override (`.git` is deny-listed);
  `git init`-class commands are human-reserved by permission rules.
- Network from inside the sandbox: `curl` is deny-ruled, `gh` can't read
  its config (credential file, correctly denied), and Node's `fetch`
  ignores the proxy env. What works sandboxed: `git ls-remote` (honors
  proxy; exact SHAs) and a manual CONNECT tunnel via `HTTPS_PROXY` for
  anything else (see LEARNINGS #14). `gh api` works with the sandbox
  override when genuinely needed.
- "certificate-25291" stderr noise in sandboxed commands is environmental;
  filter it, ignore it.
- zsh eats words starting with `=` (e.g. `echo ===`) — use quotes in
  Bash one-liners.
- Ground truth about quickjs-emscripten behavior is its shipped dist in
  `node_modules/.pnpm/quickjs-emscripten-core@0.31.0/...` — docs and
  single-pass spikes both lied (LEARNINGS #9). Do not "simplify" the
  sandbox back to asyncify; upstream justjake/quickjs-emscripten#258.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Start by reading
> HANDOFF.md and follow its protocol — it names the spec sections, the
> acceptance criteria, and the prior sessions' design decisions for the
> current task (policy engine v1, the Phase 1 opener). Check the
> "waiting on the human" list first and ask about anything still open.
> Work autonomously per the project's memory: decide commonsensical
> things yourself; confirm only destructive, outward-facing, or
> scope-changing actions. Interface first, invariant tests in the same
> commit as the code that earns them, INVARIANTS.md rows flip in that
> commit, conventional commits, hook must stay green. Feature work runs
> on a branch and lands by PR per CLAUDE.md "Commit routing" — never
> commit features to main directly. At session end,
> rewrite HANDOFF.md and append LEARNINGS.md per the protocol.
