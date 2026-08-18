# conduit-HQ — Project Instructions

## Session protocol

- **Start of session:** read `HANDOFF.md` first — it carries repo state,
  the current task with acceptance criteria, and session quirks. Don't
  re-derive project state from scratch.
- **End of session:** rewrite `HANDOFF.md` (state, next task, kickoff
  prompt), append the session's lessons to `LEARNINGS.md`, and publish
  the **session debrief artifact** — the complete record of what
  happened: acts, decisions with codification pointers, incidents named
  honestly, verification evidence. Three tenses: HANDOFF is the baton
  (future), LEARNINGS the distilled lessons (past), the debrief the full
  narrative (past, complete). A decision or recommendation that lives
  only in chat does not exist — spec §18 for product decisions, this
  file for rules, HANDOFF.md for state.

## Public-safe writing (repo is public from the 2026-08 flip onward)

Everything committed here — HANDOFF.md, LEARNINGS.md, commit messages,
docs — is published. From the visibility flip onward (§18 decision,
2026-08-03):

- **No machine-specific paths.** Write `~/.conduit/...` or
  `<repo>/packages/...`, never an absolute `/Users/<name>/...` path or
  other host-layout detail beyond the product's documented defaults.
- **No personal URLs.** No `claude.ai/code/artifact/...` links or other
  private/session URLs in committed files or commit messages — session
  debrief artifacts are referenced by title/date only ("debrief published
  2026-08-03"), with the URL kept in chat or private notes.
- **No personal-operational narrative** that maps the maintainer's real
  machine or accounts: where live keys/backups/PATs sit on the dev box,
  local client wiring specifics, schedule details. Incident write-ups stay
  (honesty is the point) but are written product-relative, not
  machine-relative.
- History predating the flip was audited and consciously accepted as-is
  (2026-08-03 privacy audit); the rule is forward-looking, not a license
  to rewrite history.

## Spec files: HTML is the source of truth

`conduitspec.html` is the source. `conduitspec.md` is a derived, text-only copy
of it (same words, no styling).

**Rule:** Whenever I edit `conduitspec.html`, I MUST immediately regenerate
`conduitspec.md` in the same turn by running:

```
python3 html2md.py
```

This keeps the two files text-identical. The HTML keeps all visual styling;
the `.md` carries only the text. Never hand-edit `conduitspec.md` directly —
always regenerate it from the HTML.

## Commit routing: PR by default, direct push for inert prose only

Decided 2026-07-03 (rationale: LEARNINGS #13 and #16). Only the PR route
puts the human decision AFTER the clean-room CI evidence exists.

- **Direct push to main is allowed only when every file in every pushed
  commit is on `.pushallowlist`** (prose and housekeeping config that no
  CI check or reviewer can evaluate — their only real review is the chat
  where they're written). The agent pushes via `scripts/push-docs` — the
  sanctioned narrow exception to the machine-level deny on agent pushes
  to main. Extending the list is a direct-pushable one-line edit.
- **The protected floor cannot be allowlisted.** `scripts/routing-lib.sh`
  hardcodes the paths that always take the PR route — `packages/`,
  `githooks/`, `scripts/`, `.github/`, dependency manifests + lockfile,
  `biome.json`, `.nvmrc`, the spec pair + `html2md.py`, `INVARIANTS.md` —
  and ignores (loudly) any allowlist entry under them. The list can grow
  for prose; it structurally cannot open code, gates, or supply chain.
  Widening the floor itself is a code change → PR by definition.
- **Everything on the floor goes branch → PR → CI green + CodeRabbit
  review → merge.** A mixed commit takes the stricter route.
- **Load-bearing PRs ship with an explainer, unprompted.** Immediately
  after opening a PR that touches product code, the sandbox boundary, or
  the supply chain, the agent runs `/explain-diff` on it and posts the
  artifact URL — before any merge talk. The human passes the quiz FULLY
  before merging — a missed question means reread and retake (Storey:
  one human fully understands each change before it ships).
  Housekeeping PRs (config one-liners, checklist comments) are exempt.
- Merge discipline is self-enforced until branch protection is available
  (see the ci.yml activation checklist): merge only on green, after
  reading the review — and for load-bearing PRs, after passing the
  explainer quiz.
- **Merge authority is the human's to grant; the agent asks, then acts.**
  The flow is simple: the agent asks "should I merge PR #N?", and once
  the human answers to merge that specific PR, the agent merges it —
  immediately, without re-asking or deferring. A direct instruction to
  merge a named PR ("merge", "merge #48", "yes merge it") **IS** the
  authorization — treat it as a green light and execute. What the agent
  must NOT do is merge on its own initiative or on a vague signal
  ("wrap things up", "decide what's best") that names no PR — that
  needs a confirming ask first. The rule is a guard against merging
  WITHOUT the human's word, never a reason to refuse or stall a merge
  the human HAS asked for, and never a claim that the human lacks
  authority (they always have it). Review can be delegated to agents
  and CI; the go-ahead to land on main comes from the human.
  (Added 2026-07-07 after the agent merged housekeeping PR #16 on the
  tier exemption alone; reworded 2026-08-18 after the agent over-read
  "never merges" and repeatedly refused/deferred a merge the human had
  explicitly named — the review was the point, not blocking an
  authorized merge.)
- Enforced mechanically by `githooks/pre-push` — a tripwire, not a wall.
  A `--no-verify` bypass is an incident worth a LEARNINGS note.
- When branch protection becomes available (Pro or public repo), turn on
  required checks; this routing rule itself does not change.

## Finding unknowns (the map–territory protocol)

The gap between the prompt and reality is the unknowns; surface them
before they get expensive (Thariq Shihipar's framework). Route by
quadrant first, then follow the phase rules.

**By quadrant:**
- *Unknown unknowns* (never considered) → `/blindspot` — codebase mode
  or teach-me domain mode.
- *Unknown knowns* ("I'll know it when I see it") → brainstorm +
  throwaway HTML prototypes and design variants BEFORE wiring anything
  (`superpowers:brainstorming`, `design-shotgun`, mock artifacts).
- *Known unknowns* (questions you know to ask) → interview via
  `grilling`: one question at a time, ordered by architectural blast
  radius.
- References beat descriptions: point at real source code (any
  language) instead of explaining behavior in prose.

**By phase:**
- *Before:* plans are TWEAKABLE — lead with the decisions likeliest to
  change (data models, type interfaces, anything user-facing), bury
  mechanical work at the bottom, and mark degrees of freedom: where the
  agent may improvise vs. must stop and ask. Implementation starts
  fresh with the plan artifacts passed in.
- *During:* keep an implementation-notes deviations log in the
  scratchpad — per entry: what forced the deviation, the conservative
  call taken, what to fold into attempt #2. Summarize under a
  "Deviations" heading in the PR description and in the session
  debrief.
- *After:* explainer + quiz per Commit routing (merge only on a full
  pass); `/pitch` when buy-in beyond yourself is needed.

**Artifact medium:** anything meant to be READ — plans, explainers,
reports, prototypes, debriefs — is an HTML artifact, not markdown:
richer, actually read, shareable. Markdown remains for git-tracked
prose (HANDOFF, LEARNINGS, this file) where diff reviewability wins.
For anything painful to express in text (ordering, tuning, tagging,
picking values), build a throwaway HTML editor with a "copy back as
prompt/JSON" button — purpose-built, single-use, then discarded.

## Security posture: enterprise-grade, non-negotiable

Conduit is a security product (credential boundary, policy engine, sandbox).
Its own supply chain and code must hold the same bar it sells.

### Supply chain

- **The agent NEVER installs packages.** All installs run in the user's own
  terminal, where they route through Socket Firewall. The agent hands over the
  exact command and stops.
- **Install-time build scripts are default-deny.** `allowBuilds` in
  `pnpm-workspace.yaml` is a reviewed allowlist; adding a package to it
  requires explicit user approval. Currently: `esbuild` only.
- **`pnpm-lock.yaml` is committed and authoritative.** Never regenerate or
  delete it casually; lockfile diffs get reviewed like code.
- **New dependencies require justification before adding**: what it's for, why
  it can't be stdlib/existing deps, and its maintenance profile. Prefer zero
  new deps; the SDK's direct dependency count stays deliberately small.
- **`minimumReleaseAge` is set** in `pnpm-workspace.yaml` so freshly published
  versions (the compromised-maintainer window) age before we'll install them.
- **Audit cadence**: run `pnpm audit` and an Aikido scan (`/aikido:scan`)
  before each phase milestone and before anything ships — plus a freshness
  sweep of HANDOFF.md and LEARNINGS.md (mark superseded lessons; never
  silently rewrite them).
- **Dependabot: alerts ON, auto-PRs OFF** (decided 2026-07-03). Security
  findings route through the audit triage — threat-model first, then fix
  deliberately — never bot-generated lockfile merges, which land inside
  the `minimumReleaseAge` window and bypass the human install path.
  Accepted findings get a per-advisory dismissal carrying the rationale
  (never a package-wide ignore, which would blind future advisories).

### Coverage beyond Biome

- Biome owns JS/TS/JSON. Everything else gets a fit-for-purpose check,
  not a linter by reflex: **spec drift** (pre-commit hook + CI regenerate
  `conduitspec.md` and fail on mismatch — this also exercises
  `html2md.py`'s behavior on every commit), **shellcheck** on `githooks/`
  and **actionlint** on workflows (both in CI).
- Deliberately NOT adopted: markdownlint, Python linting. Revisit if the
  Python surface grows beyond `html2md.py` or the docs sprawl.
- **CI is an unprivileged validation surface.** PR-triggered workflows run
  untrusted code: `permissions: contents: read`, zero `secrets.*` references,
  installs with `--ignore-scripts`, checkout with
  `persist-credentials: false`, and NEVER `pull_request_target`. Privileged
  workflows (publish, deploy) are separate, push/tag-triggered, and never
  execute PR-modified code. Actions get pinned to commit SHAs before enabling.
  The repo-settings hardening that can't live in workflow files
  (first-contributor approval, branch protection, org-wide read-only token)
  is the ACTIVATION CHECKLIST at the top of `.github/ci.draft.yml` — work it
  when the GitHub repo goes live.

### Invariants ledger

- `INVARIANTS.md` maps every load-bearing spec claim to the test that pins
  it. Invariant tests carry an `INVARIANT §x.y:` prefix in the test name.
- A module implementing a spec invariant may NOT land without its invariant
  test in the same commit — and the ledger row flips in that commit too.
- A ⏳ row is a promise the product makes but does not yet enforce; never
  describe an unpinned invariant as "done".

### Product code

- The spec's security invariants are hard requirements in code review: the
  §9.2 credential boundary (secrets never in sandbox heap / agent code /
  agent / model), §9.3 SSRF defaults, §16 sandbox resource limits, secret
  redaction in Trace.
- No secrets in the repo, ever — env vars only; `.env*` is gitignored.
- Timeouts on every external call; parameterized queries only; validate at
  system boundaries.

### Adversarial review has a stop line

An adversarial/cross-model pass (§18: `codex exec` per
`~/.claude/rules/codex-one-path.md`) is NOT an open-ended loop. It has
**converged** — ship — when every finding it returns is either (a)
out-of-scope by a documented spec §18 decision, or (b) against a layer
explicitly labeled best-effort defense-in-depth. A genuine in-scope boundary
break has NOT converged: fix it and re-run once. Full criterion:
`~/.claude/rules/adversarial-convergence.md`.

- **Do not extend a denylist-shaped check per finding.** If a pass keeps
  finding the same *class* (another address encoding, another way to spell the
  secret), the check is a denylist over unbounded input and will never
  converge. Fix the SHAPE, not the spelling: **canonicalize-then-check** (the
  §9.3 egress guard resolves once via `createPinnedLookup` and checks the
  resolved binary IP — spec §18 Phase-1, closes DNS-rebinding too), or
  **relabel as best-effort** (the §9.2 credential-echo scan in
  `pipeline/upstream.ts` is a tripwire, not a boundary; the real guarantee is
  request-scope-only credentials + §11 at-rest redaction).
- Codified after Issue #21 (2026-07-08): two passes each found encoding
  bypasses of these two checks — same class, dropping severity. The fix was
  the shape change above, not more patterns.
