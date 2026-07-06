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
  artifact URL — before any merge talk. The human passes the quiz before
  merging (Storey: one human fully understands each change before it
  ships). Housekeeping PRs (config one-liners, checklist comments) are
  exempt.
- Merge discipline is self-enforced until branch protection is available
  (see the ci.yml activation checklist): merge only on green, after
  reading the review — and for load-bearing PRs, after passing the
  explainer quiz.
- Enforced mechanically by `githooks/pre-push` — a tripwire, not a wall.
  A `--no-verify` bypass is an incident worth a LEARNINGS note.
- When branch protection becomes available (Pro or public repo), turn on
  required checks; this routing rule itself does not change.

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
