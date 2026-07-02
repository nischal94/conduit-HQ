# conduit-HQ — Project Instructions

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
  before each phase milestone and before anything ships.
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

### Product code

- The spec's security invariants are hard requirements in code review: the
  §9.2 credential boundary (secrets never in sandbox heap / agent code /
  agent / model), §9.3 SSRF defaults, §16 sandbox resource limits, secret
  redaction in Trace.
- No secrets in the repo, ever — env vars only; `.env*` is gitignored.
- Timeouts on every external call; parameterized queries only; validate at
  system boundaries.
