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

## Current handoff — written 2026-07-02 (foundation session)

### Where things stand

- `main` @ `1963363` (13 commits), working tree clean. 69/69 tests,
  typecheck clean, Biome clean. Pre-commit hook gates tsc + vitest + lint.
- **Phase 0 complete except the sandbox pair:** data model, OpenAPI + MCP
  normalizers, catalog (lexical, behind `Catalog` seam), storage
  (`ConduitStore` seam + SQLite impl), `SecretBox` secrets-at-rest.
- INVARIANTS.md: 5 pinned ✅, 7 pending ⏳. CI draft exists at
  `.github/ci.draft.yml` (unactivated; activation checklist in its header).

### Next task: QuickJS sandbox + `execute` tool (Phase 0 finale)

Read before coding: spec §5.3–§5.5, §6, §8 (roadmap note), §9.2–§9.3,
§16, §20; INVARIANTS.md ⏳ rows; CLAUDE.md security posture.

Acceptance criteria:
- Sandbox behind an interface (same seam discipline as Catalog/ConduitStore),
  QuickJS implementation via `quickjs-emscripten` (already a dependency).
- Host-side bridge for `tools.search` / `tools.describe.tool` /
  `tools[path](input)` that suspends at tool-call boundaries (the §5.3
  pipeline mounts there; policy/credentials are NOT sandbox concerns).
- §16 resource limits: wall-clock interrupt, memory ceiling, output-size
  cap (60s / 128 MB / 1 MB defaults, configurable).
- §5.5 determinism seeds: `Date.now()` / `Math.random()` seeded per
  execution, recorded for replay.
- `execute` tool description text incl. connection prefixes and "search
  with concrete nouns/verbs; retry with synonyms if empty" (§8).
- Invariant tests flipped in the same commits: §16 runaway-code
  interruption; §4.2 token budget (serialize the execute surface, fail
  above threshold); groundwork for §5.5 replay.

Known trap to check first: async host functions in quickjs-emscripten
need the asyncified runtime variant — confirm which variant supports
async before designing the bridge.

### Waiting on the human

- GitHub repo creation (private recommended), then the CI activation
  checklist at the top of `.github/ci.draft.yml`.

### Session quirks worth inheriting

- Agent runs tools via direct binaries
  (`packages/sdk/node_modules/.bin/{tsc,vitest}`, `node_modules/.bin/biome`)
  — the `pnpm` shim routes through Socket Firewall, whose CA key the agent
  sandbox correctly denies. Installs are always the human's, in their
  terminal.
- Git commits need the sandbox override (`.git` is deny-listed);
  `git init`-class commands are human-reserved by permission rules.
- "certificate-25291" stderr noise in sandboxed commands is environmental;
  filter it, ignore it.

### Kickoff prompt for the next session

> Continue building Conduit in ~/projects/conduit-HQ. Start by reading
> HANDOFF.md and follow its protocol — it names the spec sections, the
> acceptance criteria, and the known trap for the current task (QuickJS
> sandbox + `execute` tool). Work autonomously per the project's memory:
> decide commonsensical things yourself; confirm only destructive,
> outward-facing, or scope-changing actions. Interface first, invariant
> tests in the same commit as the code that earns them, INVARIANTS.md
> rows flip in that commit, conventional commits, hook must stay green.
> At session end, rewrite HANDOFF.md and append LEARNINGS.md per the
> protocol.
