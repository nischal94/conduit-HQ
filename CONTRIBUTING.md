# Contributing to Conduit

Thanks for your interest. Conduit is early and moves through a deliberately
strict pipeline — this file tells you what to expect so your time is well
spent.

## Ground rules

- **Read `conduitspec.md` first.** It is the product's source of truth;
  PRs that contradict a recorded spec decision (§18) will be redirected to
  a discussion rather than reviewed as code.
- **Security bar:** Conduit is a credential boundary. Changes touching
  `packages/sdk/src/pipeline/`, the sandbox, credentials, or egress get
  reviewed as security-critical, and every load-bearing spec claim must
  keep its pinned invariant test (`INVARIANTS.md` — an invariant-implementing
  change lands with its `INVARIANT §x.y:` test in the same commit).
- **Vulnerabilities:** never in a public issue — see [SECURITY.md](SECURITY.md).

## Practicalities

- **Toolchain:** Node (version in `.nvmrc`), pnpm. `pnpm install
  --frozen-lockfile --ignore-scripts` — install-time build scripts are
  default-deny (`allowBuilds` in `pnpm-workspace.yaml` is a reviewed
  allowlist).
- **Checks that must be green:** `pnpm lint` (Biome), `pnpm typecheck`,
  `pnpm build`, package test suites (`pnpm -r test`), and the spec-drift
  check (`conduitspec.md` is generated from `conduitspec.html` via
  `python3 html2md.py` — never hand-edit the `.md`).
- **Dependencies:** new runtime dependencies need written justification
  (what it's for, why not stdlib/existing deps, maintenance profile).
  Expect pushback; the dependency count is deliberately small.
  `pnpm-lock.yaml` is authoritative — lockfile diffs are reviewed like code.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, …), messages
  explain intent. Branches: `feat/`, `fix/`, `docs/`, `refactor/`.
- **Route:** branch → PR → CI green → review → maintainer merges. Direct
  pushes to `main` are reserved for maintainer prose housekeeping.

## Working in the open

`HANDOFF.md` and `LEARNINGS.md` are the project's live session log and
lessons ledger, kept public on purpose. They are maintainer-owned working
documents, not contribution surfaces — interesting reading, but PRs against
them will generally be declined.

## License

By contributing, you agree your contributions are licensed under the
[Apache License 2.0](LICENSE) (see its §5).
