# Learnings

Engineering lessons from building Conduit — one dated section per working
session, appended as part of the session-end handoff (see HANDOFF.md).
Division of labor: the spec's §18 records *what* was decided, CLAUDE.md
records *the rules*, this file records *what almost went wrong, what
pattern caught it, and what we'd repeat*.

**This file is history, not instructions.** Entries record what was true
at their date. Anything an agent must act on has been promoted to an
enforcement point that IS kept current — a CLAUDE.md rule, a spec
section, a hook, a CI job, or an invariant test. Never execute from this
file; execute from the enforcement points.

**When a lesson is superseded:** the old entry stays, gaining a one-line
`> Superseded <date>: <what changed, where the current rule lives>` note.
Silent rewrites of past entries are forbidden — a journal that edits its
own history can't be trusted about anything. Freshness sweep happens at
each phase milestone (see CLAUDE.md audit cadence).

## 2026-07-02 — Foundation session (spec review → Phase 0 core)

Shipped: spec v0.1 hardening (7 gaps closed, incl. deterministic-replay
pause/resume), monorepo + full quality loop (hook, Biome, CI draft),
OpenAPI + MCP normalizers, catalog, storage seam + SQLite implementation,
secrets-at-rest, invariants ledger. 69 tests, 5 invariants pinned.

### 1. Relevance-checking is not threat-modeling

Adopting well-regarded CI advice after asking "does this apply to us?"
still missed three real issues (no `permissions:` block, a token reference
in PR context, PR-tamperable `allowBuilds` executing install scripts in
CI). The question that found them: **"what does the attacker control, and
what's the blast radius?"** — asked from the adversary's seat, per item.
Corollary: an audit that finds nothing should itself be suspicious — the
first pass said "Adopted" eleven times with zero findings.

### 2. A decision that lives only in chat does not exist

"I recommend X for later" is vapor: a fresh session reinvents or
contradicts it. Every decision now lands in a durable home **in the same
turn it's made** — product/architecture decisions in the spec (§18 or the
owning section), working rules in CLAUDE.md, session state in HANDOFF.md.
Chat is where decisions get made, never where they get stored.

### 3. Product claims become tests, or they rot into marketing

INVARIANTS.md maps every load-bearing spec claim to the test that pins it;
unpinned claims stay visibly ⏳. The strongest invariant tests attack the
claim *beneath* the abstraction: the §9.2 secrets-at-rest test reads raw
database rows rather than trusting the repository API, because that's
where an attacker would look. Pending crown jewel: the token-budget test
that makes "1 tool / ~1,044 tokens" build-breaking.

### 4. Silent policy is indistinguishable from malfunction

Three consecutive `git init` "failures" were actually a standing
permission deny-rule working exactly as designed — but they read as
malfunction and got retried. This fed the product directly: §10.2
approvals return the `exec_id` plus a human-readable reason, because a
policy engine that blocks silently trains its users to retry and distrust
it.

### 5. "Best practice" describes the median product — check the axes

Semantic search is better *for human users, large corpora, and
unconstrained egress*. Conduit's search caller is a model (reformulates
for free), the corpus is ~1,600 tools, and egress is a security promise.
The staged outcome (lexical → FTS5 → embeddings only if Trace zero-hit
data demands, opt-in only) is recorded in spec §8. The general pattern:
ship the interface, instrument the cheap option, let production data cast
the deciding vote.

### 6. One mechanism doing two jobs beats two mechanisms

The Trace journal doubles as the deterministic-replay log — audit
differentiator and pause/resume correctness from a single artifact.
Likewise, WebCrypto-only SecretBox makes the crypto itself the proof of
Worker portability. When a constraint does design work for free, keep the
constraint.

### 7. Interfaces are where future rewrites go to die

`Catalog` and `ConduitStore` were designed as contracts before their first
implementations. The payoff is already scheduled: FTS5 and D1 land as new
files satisfying old interfaces, not refactors. SQL and search-engine
details are not allowed to leak past their seams.

### 8. The supply-chain rails are real — we watched all four work

In one install: the sfw shim (`pnpm` *is* `sfw pnpm` — verified, not
assumed), the `allowBuilds` allowlist (esbuild's scripts ran because we
approved them; Biome needed none — its binary ships as inert platform
data), `minimumReleaseAge` (3-day quarantine accepted), and the
write-denied, review-required lockfile. Also learned: *deprecated* ≠
*vulnerable* — `node-domexception` is an obsolete polyfill under libsql,
not an exploit.
