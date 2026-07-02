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

## 2026-07-02 — Sandbox session (QuickJS + execute tool)

Shipped: Sandbox seam + QuickJS implementation (sync build, §16 limits,
§5.5 seeds + journal replay), `execute` tool surface + catalog tool host.
93 tests, 7 invariants pinned (§16, §4.2 flipped this session).

### 9. A spike that passes once proves the API exists, not that it's sound

The asyncify spike ran clean, so the bridge got built on it — then the
invariant tests failed *differently on every run* (timeout, refcount
abort, OOB read). The handoff's "known trap" note asked which variant
supports async host functions; the true question was whether the
suspension machinery survives contact with the job queue. It does not:
in quickjs-emscripten 0.31.0, any `await`-continuation that calls an
asyncified host function suspends inside the synchronous
`executePendingJobs` FFI wrapper, which then reads unwound stack garbage.
The proof came from reading the library's *shipped dist* in node_modules
(the sync binding is `assertSync`-wrapped; the `_MaybeAsync` binding is
never used; `QuickJSAsyncRuntime` never overrides the job pump) — not
from docs, and not from more spiking. Ground truth about a dependency
lives in `node_modules`, and one green run is not evidence of soundness
where probabilistic corruption is on the table.

### 10. Nondeterministic failure *modes* mean corruption, not flaky tests

Same suite, three runs, three different failures. The reflex reading is
"flaky tests — add retries/timeouts"; the correct reading was "something
is corrupting shared memory, and the test that dies is whoever touches
it next." In WASM-land there is no segfault to make this obvious. The
tell: assertion failures *inside the dependency's own invariants*
(`gc_decref`, `free_zero_refcount`) rather than in our assertions.

### 11. When a workaround fights the spec's own mechanism, re-read the spec

The fix for the asyncify defect was already designed in §5.5:
deterministic replay — run to the first un-journaled tool call, perform
it while the VM is idle, journal, re-run. Asyncify was a *second*
suspension mechanism the product never needed (a suspended WASM stack
can't survive a restart or a 72h approval anyway). Deleting it removed
the inflight-tracking/disposal-race machinery, made every guest run
fully synchronous, and cut the sandbox suite from ~6s to ~0.4s. Lesson 6
(one mechanism doing two jobs) keeps earning: replay now powers pause,
resume, *and* the host bridge.

### 12. Authority for security state lives host-side, never in guest values

The suspension sentinel the guest sees is a plain catchable Error — and
that's fine, because the host decides "this run suspended" from its own
flags, set before the sentinel is thrown. Guest code that fakes a
look-alike error, or swallows the real one in a try/catch, changes
nothing: the interrupt handler kills the run on the host's say-so. The
general rule mirrors §9.2: anything security-relevant is host-side state
the sandbox can neither read nor forge; what crosses the membrane is
data, not authority.
