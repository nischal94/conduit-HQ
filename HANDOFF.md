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

## Current handoff — written 2026-07-02 (sandbox session)

### Where things stand

- `main` @ `beb8803` (15 commits), working tree clean except this
  handoff + LEARNINGS. 93/93 tests, typecheck clean, Biome clean.
  Pre-commit hook gates spec-drift + tsc + vitest + lint.
- **Sandbox pair landed:** `Sandbox` seam + `QuickJSSandbox`
  (`packages/sdk/src/sandbox/`), `execute` tool surface + catalog tool
  host (`packages/sdk/src/execute.ts`).
- **Load-bearing design decision this session** (full rationale in the
  `QuickJSSandbox` doc comment and LEARNINGS #9–11): the sandbox runs on
  quickjs-emscripten's **plain sync build**, and tool-call suspension is
  **§5.5 deterministic replay** (journal + seeded non-determinism), NOT
  asyncified host functions. The asyncify build is defective for our
  shape of use — two-plus asyncified host calls from pending jobs
  corrupt the WASM heap; repro'd minimally post-session on 0.31.0 and
  confirmed upstream as justjake/quickjs-emscripten#258 (still present
  in 0.32.0; our corroboration commented there). Probable mechanism is
  #239: release-asyncify FFI cwraps QTS_ExecutePendingJob_MaybeAsync
  without `{async: true}`. See LEARNINGS #9 correction. Do not
  "simplify" back to asyncify without re-verifying the library.
- INVARIANTS.md: 7 pinned ✅ (added §16 caps, §4.2 token budget),
  5 pending ⏳. §5.5's replay mechanism + seeds are implemented and
  tested (un-prefixed) in `quickjs.test.ts`; the row stays ⏳ for the
  execution manager's approval-pause wiring.
- CI draft still unactivated at `.github/ci.draft.yml`.

### Next task: credential resolver + §9.2 boundary invariant (Phase 0 finale)

The last unshipped §17 Phase 0 item. `SecretBox` (secrets-at-rest) and
the `SecretRepository` exist; what's missing is the piece that binds
`Connection.credentialRef → secret` at call time, host-side, and injects
it into the outbound request only.

Read before coding: spec §9.1–§9.2, §5.3 (step 3), §3 (Connection),
§16 item 2; INVARIANTS.md §9.2 row; `store/store.ts` + `secrets.ts`.

Acceptance criteria:
- Resolver behind an interface (seam discipline), consuming the
  `ConduitStore`/`SecretBox` pieces that already exist.
- Given a Connection, produce authenticated upstream-request material
  (e.g. headers) **host-side**; the `ToolInvoker` in `execute.ts` is
  where it mounts — policy and upstream calling remain Phase 1.
- INVARIANT §9.2 test in the same commit, ledger row flips: a secret in
  the store must never appear in (1) sandbox-reachable values — tool
  results, journal entries, execute results, (2) agent code, while a
  stub upstream request does receive it. Attack the claim beneath the
  API like the secrets-at-rest test does (LEARNINGS #3).
- Phase 0 then closes: run the CLAUDE.md milestone audit cadence —
  `pnpm audit` + `/aikido:scan` + LEARNINGS/HANDOFF freshness sweep.
  Note: `pnpm` routes through sfw; the audit may need the human's
  terminal if the agent sandbox blocks it.

### First item next session: CI activation (repo now exists)

Repo is live: https://github.com/nischal94/conduit-HQ (private, main
pushed). Upstream asyncify bug corroborated on
justjake/quickjs-emscripten#258. Pre-flight for CI activation already
verified: `.nvmrc` exists; root package.json has lint / typecheck /
test / build scripts. Remaining, in order:

1. Agent: pin `uses:` actions + docker images in `.github/ci.draft.yml`
   to commit SHAs / digests (gh api for action SHAs), commit.
2. Agent via `gh api`: default GITHUB_TOKEN read-only
   (actions/permissions/workflow), first-contributor approval, branch
   protection on main — require the CI checks but leave
   enforce_admins OFF so the solo direct-push flow keeps working.
   NOTE: checklist says "four checks" but the workflow has FIVE jobs
   (quality, meta, test, build, security) — stale count, require all 5.
3. Human, in own terminal (workflow dir is deliberately
   agent-unwritable):
   `mkdir -p .github/workflows && git mv .github/ci.draft.yml .github/workflows/ci.yml`
   then commit + push, and watch the first run go green.

### Waiting on the human

- Step 3 above (the git mv) when the agent has finished steps 1–2.
- Possibly the `pnpm audit` half of the Phase 0 milestone audit (above).

### Session quirks worth inheriting

- Agent runs tools via direct binaries
  (`packages/sdk/node_modules/.bin/{tsc,vitest}`, `node_modules/.bin/biome`
  from the repo root) — the `pnpm` shim routes through Socket Firewall,
  whose CA key the agent sandbox correctly denies. Installs are always
  the human's, in their terminal.
- Git commits need the sandbox override (`.git` is deny-listed);
  `git init`-class commands are human-reserved by permission rules.
- "certificate-25291" stderr noise in sandboxed commands is environmental;
  filter it, ignore it.
- zsh eats words starting with `=` (e.g. `echo ===`) — use quotes in
  Bash one-liners.
- Ground truth about quickjs-emscripten behavior is its shipped dist in
  `node_modules/.pnpm/quickjs-emscripten-core@0.31.0/...` — docs and
  single-pass spikes both lied this session (LEARNINGS #9).

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Start by reading
> HANDOFF.md and follow its protocol — it names the spec sections, the
> acceptance criteria, and the prior session's design decisions for the
> current task (credential resolver + §9.2 boundary invariant, the
> Phase 0 finale). Work autonomously per the project's memory: decide
> commonsensical things yourself; confirm only destructive,
> outward-facing, or scope-changing actions. Interface first, invariant
> tests in the same commit as the code that earns them, INVARIANTS.md
> rows flip in that commit, conventional commits, hook must stay green.
> When Phase 0 closes, run the milestone audit cadence from CLAUDE.md.
> At session end, rewrite HANDOFF.md and append LEARNINGS.md per the
> protocol.
