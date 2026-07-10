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

> Superseded 2026-07-03 (the "pending" remark only): the token-budget
> test landed 2026-07-02 (§4.2 row ✅ in INVARIANTS.md); the §9.2
> boundary invariant landed 2026-07-03. The lesson itself stands.

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

> Corrected 2026-07-02 (same day, while drafting the upstream report):
> the mechanism sentence above was itself an unverified inference, and
> minimal repros falsified it twice — first a bare asyncified call from
> a pumped `await`-continuation ran clean (killing "any continuation
> corrupts"), then an "argument-read is the trigger" theory from one
> bisect died on the next script shape. What survived every test: two
> sequential asyncified host calls from pending jobs crash reliably
> (varying signatures); the trivial single-call shape is clean; paranoid
> disposal doesn't help; both calls complete with correct data before
> death. Bisects giving inconsistent discriminators across shapes is
> itself the diagnosis — allocation-noise-dependent heap corruption, so
> "clean" configs may be silently corrupted too. The lesson's own
> rule caught its author twice: each plausible mechanism story felt like
> a finding until the next experiment. The decision this justified
> (sync build + replay) stands on §5.5 grounds regardless.
>
> Addendum (same day): a duplicate search before filing found the bug
> already reported as justjake/quickjs-emscripten#258 (still present in
> 0.32.0) — we corroborated there instead of filing. Upstream #239
> identifies the probable mechanism, matching our own dist grep: the
> release-asyncify FFI cwraps `QTS_ExecutePendingJob_MaybeAsync`
> without `{async: true}`, and the runtime never routes through it.
> Two more lessons for free: search the tracker before drafting the
> issue, and the original inference ("suspension from a pending job
> goes through a non-async-aware path") was directionally right — it
> failed as a *specific* mechanism claim, not as a diagnosis.

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

## 2026-07-03 — Phase 0 finale (CI pinning + credential resolver)

Shipped: CI actions/images pinned to SHAs/digests, repo-settings
verification, credential resolver + INVARIANT §9.2 boundary test.
100 tests, 8 invariants pinned. Phase 0 complete; milestone audit run
(Aikido clean; pnpm audit handed to the human — sfw shim can't run in
the agent sandbox by design).

### 13. A checklist written before contact with the platform is a hypothesis list

The CI activation checklist assumed branch protection was a settings
toggle away. Reality per `gh api`: fork-PR approval is *impossible* on
private repos (422), and branch protection AND rulesets both 403 on a
free-plan private repo. A checklist item you haven't executed is a
hypothesis, and the honest states are more than done/not-done — this one
now carries DONE / N-A-WHILE-PRIVATE / BLOCKED-BY-PLAN, each with its
verification date, in the checklist itself. Same session, same file: the
"four checks" count was stale against five actual jobs. Checklists drift
the moment they're written; verification results belong *in* the
checklist, not in the chat where they were discovered.

### 14. Pin with values that can't be mistranscribed

Two grades of pinning evidence this session: action SHAs came from
`git ls-remote` (exact bytes, no eyeballing a web page — and annotated
tags need the peeled `^{}` commit, or the pin points at a tag object),
while OCI digests are *self-verifying* — the digest IS the sha256 of the
manifest, so computing it locally against the registry's
`Docker-Content-Digest` header proves the value beyond transcription
error. When a value is load-bearing for supply-chain trust, prefer the
channel where a typo is structurally impossible over the one where it's
merely unlikely. (Sandbox sub-lesson: the agent's HTTP path was blocked
three ways — gh config denied, curl deny-ruled, Node fetch ignores the
proxy env — but `git ls-remote` honors the proxy and a manual CONNECT
tunnel covers registries; exact-value channels existed without touching
the sandbox config.)

### 15. Where the spec is silent, don't invent vocabulary — make the data carry it

The spec defines the §9.2 boundary but no auth-scheme taxonomy (bearer
vs token vs basic). Instead of adding a scheme enum to Connection (a
data-model change the spec never asked for), the stored secret carries
its own scheme prefix and the resolver mounts it verbatim as the
`Authorization` value: one mechanism, every header-based scheme, zero
new vocabulary (lesson 6 again). The seam holds the door open — richer
auth (query params, signing) extends `UpstreamAuth` without touching
call sites. Corollary from the invariant test: a boundary test needs a
*positive control* (the stub upstream DID receive the secret) or its
negative assertions also pass on a pipeline that's simply broken.

### 16. The decision point that matters sits after the CI evidence

First contact with live CI peeled back two failures the local hook could
never see: pnpm/action-setup had no version to install (the hook's
machine has pnpm; an empty VM must be told via `packageManager`), and
shellcheck flagged the pre-commit hook itself (a hook doesn't lint
itself). Hook green answers "is the code right on my machine"; CI green
answers "is the repo self-sufficient from a bare VM" — different claims,
and each caught what the other structurally cannot. Consequence, decided
the same day: PR route by default, because only a PR places the human
decision AFTER that clean-room evidence exists; direct push to main is
reserved for the inert-prose allowlist (HANDOFF.md, LEARNINGS.md).
Rule in CLAUDE.md "Commit routing"; tripwire in `githooks/pre-push`.
Design note: the allowlist is default-closed and file-based, never
per-commit judgment — judgment erodes exactly when risk perception is
worst.

### 17. Untracking a file is a two-machine operation — the pull deletes it

Incident (2026-07-04, recovered losslessly): to gitignore `assets/`,
the safe-looking sequence — `git rm --cached` on a branch, verify files
still on disk, merge the PR — deleted the files from disk anyway. The
trap: `rm --cached` protects the working tree only on the machine and
ref where it ran. Local main still *tracked* the files, so when the
merge was pulled into main (auto-pulled by `gh pr merge`), applying
"these paths leave tracking" to a tree that tracked them meant deleting
them. Mid-branch verification checked the wrong moment; the deletion
happened two commands later. Rules that follow: (1) before landing any
commit that removes paths from tracking, copy those paths outside the
repo first — restore after the pull; (2) a promise about file safety
must be evaluated against the whole command sequence, not the one
command it's about; (3) the end-state verification (files on disk,
`git ls-files` empty) is the only check that counts. Recovery, for the
record: committed bytes are never lost — `git show <commit>:<path>`
writes them back exactly.

## 2026-07-06 — Policy engine v1 (Phase 1 opener, PR #13)

### 18. TypeScript exhaustiveness ends where untyped storage begins

The engine's verdict switches were compile-time-exhaustive over
`RiskClass`/`PolicyAction` and had no `default` arms — Biome and tsc
both content. Two of three Tier 2 reviewers independently traced the
same hole: SQLite stores those fields as bare TEXT, `rowToPolicy`
blind-casts, so an out-of-vocabulary value (schema drift, rollback,
hand edit) walks past every `case` and the function returns
`undefined` — making `evaluate` resolve `undefined` instead of a
verdict. A caller checking `verdict?.action \!== "block"` reads that as
proceed: fail-open at the fail-closed seam. My own suite was green
because every test fed well-typed inputs — the invariant test pinned
the table, not the edges where the table's inputs are corrupt. The
pattern that keeps both guarantees: a `default` arm that binds the
value to `never` (a legitimate new union member still breaks the
build) and returns `block` with a reason naming the corrupt value.
Corollary for review discipline: self-verified green is not reviewed —
tests written by the author share the author's type-system blind spot.

### 19. Interfaces are cheapest at zero callers — review them exactly then

The Tier 2 pass landed between "seam exported" and "first consumer
wired," and every interface finding was free to take: the two-argument
signature (`toolName`, `tool`) that could disagree became a
discriminated-union request; `input` joined as a required field before
anything reads it (optional input on a security decision is fail-open
by shape — a §10.3 caller that forgot it would silently skip every
rule); `PolicyVerdictSource` shipped its full vocabulary (`"rule"`
reserved, `"unknown_tool"` honest) so exhaustive consumers never
break. A week later each of these is a consumer-breaking change.
Extends #7: interfaces are where rewrites go to die — so schedule the
adversarial interface review at the moment the interface has no
dependents, not at the next milestone.

## 2026-07-07 — Staleness reconciliation (PR #14 in flight)

The session that produced PR #14 (sqlite vocabulary validation,
2026-07-06, still open) ended without rewriting HANDOFF.md or appending
here; this section was reconstructed from its durable artifacts — the
PR body and the Tier 2 findings comment — by the follow-up session that
caught the gap. Lesson #20 is distilled from that record; #21 is this
session's own.

### 20. Some corruption is erased before the fail-closed layer runs

The policy engine's `default:` arms (lesson #18) catch out-of-vocabulary
values that *reach* it — but `rowToPolicy`'s `manual_override === 1`
check silently demoted any other integer to an inert row at
deserialization, turning an operator's manual **block** into fail-open
relative to operator intent. The engine can never catch this one: the
corruption is normalized away before the engine sees the row. The
general shape: a fail-closed guard only covers inputs that arrive as
*recognizably* corrupt; a boundary that quietly coerces ("=== 1 means
manual, everything else means inert") destroys the evidence. Validation
must live at the deserialization boundary itself, throwing on anything
outside the vocabulary. Corollary from the same PR: write-side CHECK
constraints only bind fresh databases (`CREATE TABLE IF NOT EXISTS`
leaves existing tables untouched), so read-side guards are the layer
that covers legacy files — the two layers are deliberately independent,
and the tests pin each separately.

### 21. The staleness tripwire only sees main — open PRs are invisible to it

The tripwire compares `git log -1` against `git log -1 -- HANDOFF.md`,
which detects any session that committed to main and died before the
handoff rewrite. But a session whose entire output is an unmerged PR
branch leaves main untouched: this session ran the tripwire, got
"fresh" (both `f9e6731`), while PR #14 — two commits, 12 new tests, a
Tier 2 review, an explainer — sat open on GitHub, and the handoff still
described its subject matter as a maybe-someday task chip. The fix is
not a cleverer commit comparison; branch state lives outside the
repo's main history by design. Pair the tripwire with
`gh pr list --state all --limit 5` at session start (now in the HANDOFF
protocol block), and treat "session ends with an open PR" as exactly
the case where rewriting HANDOFF matters most — the PR's merge gate is
a human obligation that otherwise lives nowhere except a chat log.

## 2026-07-07 — PR #15: the remaining sqlite vocabularies (merge + close)

### 22. A stacked PR does not follow its base to main — retarget before merging

GitHub only retargets a stacked PR when the base branch is *deleted*;
merging the base PR alone changes nothing. After #14 merged, PR #15
still had `base: fix/sqlite-vocab-validation`, and `gh pr merge` would
have "merged" it into the already-merged, now-dead feature branch —
green checks, MERGED badge, and not one byte of it on main. The
previous handoff had called retargeting "optional housekeeping"; it is
a merge-correctness requirement. The move: `gh pr edit N --base main`,
re-verify the shown diff is still just the stack's own commits and CI
is green against the new base, then merge. (Deleting merged base
branches would also prevent this — but branch deletion needs explicit
human approval, so the retarget check is the layer the agent owns.)

### 23. A pin test can check agreement among copies while pinning nothing to the source

PR #15's exhaustiveness test round-tripped every vocabulary member and
proved the production arrays and the CHECK constraints agreed — with
the *test's own hand-copied list*. Nothing tied that list to the union
in types.ts: a union gaining `"cancelled"` would compile everywhere,
pass every test, and leave the new member unwritable until first use.
The chain was union → (unchecked) → test list → (runtime-pinned) →
array + CHECK. Fix: make the test list `Record<Union, true>`-keyed, so
the compiler owns the unchecked link — and verify the negative
(deleting a member must break the build; it did). General shape: when
N copies of a fact must agree, count the links back to the source of
truth — a test that only compares copies to each other rides along
happily as they all drift together.

### 24. `node_modules/` with a trailing slash ignores directories, not symlinks

The worktree trick (symlink the main checkout's `node_modules` in,
never install) collides with a gitignore subtlety: `node_modules/`
matches *directories only*, and a symlink is not a directory, so the
symlinks show up as untracked — one `git add -A` away from committing
machine-local absolute-path links into the repo. In symlinked
worktrees, stage files explicitly by path; treat `git add -A`/`.` as
off-limits there.

## 2026-07-07 — PR #18: source_semantics validation (the blob past the columns)

### 25. A fail-closed guarantee is only as strong as its weakest arm

The whole point of this PR was fail-closed discipline, and the first
version of it contained a fail-OPEN path: the mcp arm of
`deriveRiskClass` kept its truthiness checks
(`if (semantics.readOnlyHint) return "safe"`), so an untyped caller
passing `readOnlyHint: "false"` — a truthy *string*, exactly the
corruption class the PR is about — earned the least restrictive class
from the very function whose new doc comment advertised "values
outside the compile-time unions fail closed to destructive." The
PR's own Tier 2 pass caught it (silent-failure-hunter, MEDIUM).
Lesson: when you write a comment that promises a guarantee, audit
every arm of the code beneath it against that promise before
believing your own diff — truthiness on a `boolean | undefined` field
is compile-time-sound and runtime-open. And run the review even when
the diff is "just hardening"; hardening code is where fail-open bugs
hide best, because every reader is primed to see safety.

### 26. A JSON blob smuggles vocabularies that CHECK constraints can never see

Vocabulary columns got two layers in PRs #14/#15 (read-side guards +
CHECK twins). `source_semantics` carried three vocabularies —
`kind`, graphql `operation`, custom_js `declaredRisk` — inside a JSON
TEXT column, where SQLite CHECK cannot reach. Structural consequence:
the read-side guard is not defense-in-depth there, it is the ONLY
layer, on fresh schemas as much as legacy ones. When auditing a
schema for enum-shaped data, grep the *serialized* shapes too; a
column-by-column audit will systematically miss vocabularies nested
in blobs, and those are precisely the ones with no write-side twin.
Corollary on the fix shape: validate by REBUILDING the value
field-by-field (unknown keys drop, absent optionals stay absent),
never by blessing the parsed object with a cast.

### 27. Wrap errors without discarding them — the cause chain is free

First version of `parseJson` did `catch { throw onError(); }` — the
classic wrap-and-destroy: the new error gained entity + row identity
but silently discarded the SyntaxError's parse position, the one
datum that locates corruption inside a multi-KB blob. ES2022's
`new Error(msg, { cause })` makes keeping it free, and Node prints
the chain. Rule of thumb: a `catch` that throws a fresh error must
pass the original as `cause` unless there is a stated reason not to
(e.g. the original could carry secrets). Cheap to pin:
`expect(err.cause).toBeInstanceOf(SyntaxError)`.

### 28. Unit-green everywhere still says nothing about the seams agreeing

Every module was individually tested (151/151) and Tier-2 reviewed, yet
the system had never once been composed and run. The verification pause
produced an e2e smoke test that passed on the FIRST run — the seam
discipline (interface-first, vocabulary policing in review) is what made
that possible. But the same session's blindspot pass then found two
cross-module semantic violations that no amount of composition-wiring
tests would catch: credentials.ts's helpful error message (carrying the
credentialRef) meets quickjs.ts's honest error forwarding, and together
they violate §9.2 — each side individually correct and reviewed. Two
lessons in one: (a) add the composition smoke test EARLY, it's cheap
insurance and becomes the harness the next feature slots into; (b)
integration tests catch wiring mismatches, but *reading two modules'
contracts side by side* is what catches semantic interactions — budget
for both, they are not substitutes.

### 29. "Resolved" in a decisions ledger can mean the grammar, not the decision

Spec §18 lists "Connection-prefix grammar: ✅ resolved" — and that
reads like connection addressing is settled. It isn't: the grammar of
prefixes is locked, but HOW a guest call (which carries only a
namespace) selects among multiple connections of one integration is
nowhere decided; §5.3 step 1 says "by namespace + connection prefix"
without saying where the prefix comes from. A checked-off ledger row
adjacent to an unmade decision is camouflage — the blindspot pass caught
it only because it traced the call path end-to-end asking "where does
each input come from?". When auditing a decisions list, test each ✅ by
asking what a caller would concretely do, not whether the row's topic
sounds covered.

### 30. Flagging a blocker is half a response; the fix is the deliverable

During the §5.3 gate, the Codex CLI wouldn't run (its native binary was
missing). I reported "the adversarial pass could not run" and moved on —
leaving the user holding a dead end. The user's correction was sharp and
repeated: never end on an open-ended blocker; always hand over the way
forward. And the fix must be a *mechanism*, not a one-time apology —
because the same shape recurs on every future snag, in any project.

What we built (permanent, global, not project-specific):
- `~/.claude/rules/no-dead-ends.md` — loads every session. Redefines
  "done": a turn may not end on an unresolved blocker without a concrete
  way forward. Crucially, that way forward is NOT limited to a terminal
  command — it's whichever actually clears the block: a command, a code
  change I make, a workaround/alternative route, an escalation that names
  who/what resolves it, or 2–3 options with a recommendation when it's
  the user's call. Root cause before remedy, always (verify, don't
  guess).
- `~/.claude/hooks/no-dead-ends-check.sh` — a Stop-hook tripwire that
  scans my closing text for blocker-language with no way-forward signal
  and nudges me to finish. The rule changes intent; the hook catches the
  lapse when intent fails — which is exactly what happened, so the
  pairing is the point.

Two meta-lessons the same episode taught, both about talking to the user
rather than about code:
- **Don't ask permission for the obviously-right thing.** I kept asking
  "want me to also…?" for actions I should have just taken (recording
  this incident; deciding a global rule needs no per-project pointer).
  Asking is itself a mini dead-end — it hands the user a decision that
  isn't theirs to make. Decide and state it.
- **Jargon is a dead end too.** "The reinstall command is staged," "not
  a code finding," "this catches blockers I name" — each left the user
  parsing my hedge instead of understanding the state. Say the plain
  thing: what's broken, in one sentence, and the exact next action.

This entry is history; the enforcement lives in the rule + hook above.

### 31. The cross-model adversarial pass earns its rung — it catches a class the same-model reviewers can't

Five specialized review agents plus a dedicated security sub-agent — all
the same model family as the author — reviewed the §5.3 pipeline and
passed it. The Codex adversarial pass (a different model) then found a
HIGH §9.2 credential leak they all missed: a hostile MCP server
JSON-escapes the credential (`ghp_x`), the raw-body echo scan
misses the escaped bytes, and `JSON.parse` decodes it back to plaintext
into the sandbox/journal/Trace. Verified exploitable with a harness
before fixing. The lesson isn't "review more" — it's that a reviewer
sharing the author's blind spots will systematically miss the same
things the author missed. A genuinely DIFFERENT model is not redundancy;
it covers a different region of the error space. Keep the cross-model
rung; it paid for itself in one run. (Enforcement: it's a named rung in
the global PR-review rule; the ONE invocation path is now
`~/.claude/rules/codex-one-path.md`.)

### 32. Repeated adversarial findings of the SAME class mean the check is the wrong shape, not that the product is broken

Two adversarial passes each found encoding-bypasses of the egress guard
and the credential-echo scan — JSON-escape, short-token, NAT64, plus the
earlier hex-form and decimal-IP. It *felt* like the product was
crumbling ("every pass finds bugs → everything is broken"). It wasn't.
Two diagnostics separate rot from a bounded weakness: (a) severity
trajectory — these DROPPED each pass (round 1 broke the boundary; round
2 found narrow gaps in defenses already mostly working), a convergence
signature, not a rot one; (b) class — every finding was ONE bug ("encode
the dangerous value in a form the check doesn't recognize; it's decoded
later"), which is a single design weakness in two checks, not N random
defects. The root cause: both checks are **denylist-shaped** (scan for
known-bad patterns) over an unbounded input space, so they never
converge — there is always another spelling. The fix is to change the
check SHAPE (canonicalize-then-check, e.g. per-connect IP pinning that
checks the resolved binary address; or relabel an un-completable scan as
best-effort defense-in-depth), NOT to add spellings. This also yields a
STOP LINE for adversarial review — converged when every finding is
out-of-scope or best-effort — which is what turns "infinite whack-a-mole"
into a finite gate. (Enforcement: `~/.claude/rules/adversarial-convergence.md`;
the concrete shape-fix is tracked in Issue #21.)

### 33. Two-front git safety: a parallel session's writes are ground truth to be audited, not narrative to be trusted

A concurrent/forked session ran against the same repo while this one
worked, pushing hardening commits and refreshing the explainer artifact.
The right move was NOT to trust its self-reported summary and NOT to
blindly re-do its work — it was to audit its claims against ground truth:
read the actual commit diffs, re-run its exploit harness independently
(the JSON-escape bypass reproduced; the fix genuinely closed it), and
confirm tests green on the merged result. A forked session's chat is a
paraphrase; its commits are the source. Audit the commits. (This sits
with the source-faithfulness discipline: verify against the artifact,
not the story about it.)

## 2026-07-08 (later) — Issue #21: per-connect IP pinning (PR #22)

### 34. Probe the runtime API contract before designing on it — never assume Node behavior

Building per-connect pinning meant reaching for Node's networking API,
and three assumptions that "felt obvious" were all wrong or load-bearing
enough to sink the design if guessed. Each was settled by a throwaway
probe (`node -e` / a scratch `.mjs`), not memory:
(a) **`undici` is not requirable** as a module, so Node's global `fetch`
cannot take a custom `lookup` — this is what *forces* the move to
`https.request` + `Agent`, the whole shape of the change. (b) **Node 22's
`Agent.lookup` demands the array shape** `cb(null, [{address,family}])`
when `opts.all===true`; the legacy `(err,addr,family)` throws
`ERR_INVALID_IP_ADDRESS`. Guessing the legacy shape would have been a
runtime crash the types don't catch. (c) **Node skips the custom `lookup`
entirely for literal-IP hosts** — see #35. The rule: when a change rests
on how a platform primitive behaves, write the five-line probe first. The
type signatures don't tell you the callback arity contract, and the docs
don't tell you the literal-IP skip.

### 35. A "redundant" defense-in-depth layer can be the ONLY thing covering a case — verify before deleting it

The pinned lookup is the authoritative §9.3 check, so the pre-flight
`assertEgressAllowed` looked redundant — the kind of thing a cleanup pass
deletes. The security review caught (and a probe confirmed) that Node
**does not invoke the custom `lookup` for a URL whose host is already an
IP literal** like `http://169.254.169.254/`. So for literal private IPs
the pinning is a no-op and the pre-flight is the *only* layer that
blocks them. "Redundant with the real check" was false for exactly the
inputs that matter most (a literal metadata IP). Lesson: before removing
a defense-in-depth layer as redundant, enumerate the inputs each layer
actually covers — two layers checking "the same thing" may cover
*disjoint* input sets. Kept the pre-flight; documented why it is
load-bearing so a future cleanup doesn't re-litigate it.

### 36. When the cross-model gate is unavailable, a dedicated adversarial sub-agent is the sanctioned stand-in — name it, don't skip

The Codex convergence pass could not run — usage quota exhausted (resets
Aug 1), a hard environmental block, not a code problem. Aikido SAST was
also unavailable (MCP not connected). Rather than either skip the gate or
strand the PR, the way forward (per `~/.claude/rules/no-dead-ends.md`,
which names this exact workaround) was a dedicated adversarial
security-review sub-agent carrying the same threat model and
already-fixed list. It returned zero boundary breaks AND empirically
verified the Node-22 connect behavior — arguably deeper than the CLI pass
would have. The residual gap (it's same-model, not cross-model) was
surfaced explicitly to the human as a deferrable item, not buried. Two
process notes worth repeating: the `codex exec` failures were diagnosed
to root cause before retrying (first a `$TMPDIR`-differs-per-shell prompt
path, then the real quota block surfaced in stderr) — never retried
blind; and the three review agents found four *real* transport bugs
(chief among them a timer that was never cleared) that all existing tests
passed over, which is the case for running the review gauntlet even when
CI is green.

### 37. A "loose end" the human has to clear is a TOOLING gap, not a judgment gap — fix the guardrail, not the behavior

After the merge, I left the human two trivial cleanups (delete the merged
branch, drop a now-redundant stash) as end-of-session "loose ends." The
human pushed back hard: if a thing is harmless, reversible, and unrelated
to any guardrail, why is it their problem? The honest root cause wasn't
"I should decide better" — it was that `permissions.deny` in
`~/.claude/settings.json` HARD-blocked those verbs (`git branch -D`,
`git push --delete`, `git stash drop`) at a layer my judgment couldn't
reach, so every safe instance became a dead end handed to the human. A
static deny-list can't tell "delete a MERGED branch" (safe) from "delete
an UNMERGED branch" (destructive) — it blocks the verb and offloads the
distinction. The durable fix was to move that distinction into code:
`~/.claude/hooks/git-safe-cleanup-guard.sh`, a PreToolUse/Bash hook that
auto-`allow`s only when it PROVES nothing is lost and `ask`s otherwise
(fail-closed on errors, bad refs, compound commands). Key correctness
catch during its own testing: **squash-merge defeats the obvious
"is it merged" check** — `git cherry` / ancestor tests compare per-commit
patch-ids, but a squash collapses N commits into one new commit, so none
of the originals match; the branch reads as "not merged" when its work is
fully landed. The right test is content-level: every file the branch
changed vs the merge-base is byte-identical on the base. Three lessons
that generalize: (a) when the human is annoyed by having to approve
trivial things, look for a config layer forcing the ask, not just your
own caution; (b) `deny` beats hooks in the permission order, so a hook
can't loosen a denied verb — you must remove it from `deny` AND add the
hook (a bigger, security-adjacent change the human must explicitly
approve, which the auto-mode classifier correctly caught and stopped
until I surfaced it fully); (c) the replacement is STRICTER than the
blunt deny for the dangerous case (it actually verifies) while
frictionless for the safe case — guardrails should encode the real risk,
not a proxy that offloads the judgment. Settings changes still need
fresh-session verification: the hook proved live this session, but the
durable confirm is a next-session `git branch -D <merged-branch>`
auto-approving with no prompt.

## 2026-07-09 — §5.5 execution manager: design → subagent-driven build → PR #26

Shipped: the §5.5 execution manager (pause/resume by deterministic replay) —
brainstormed + adversarially reviewed to convergence, then built via
subagent-driven development (9-task plan), reviewed per-task + whole-branch,
security-reviewed, opened as PR #26. 12 commits, 272 tests, INVARIANT §5.5 ✅.
Not merged (human gate). Design doc + plan: `docs/superpowers/{specs,plans}/
2026-07-09-execution-manager-*.md`; SDD ledger: `.superpowers/sdd/progress.md`.

### 1. The whole-branch review catches a class per-task reviews structurally cannot

Every one of the 8 tasks passed its own independent review. The final
whole-branch review still found **two Important integration bugs** — a
`describe({path})` replay-serialization divergence that would spuriously kill
a resume, and a post-sandbox store-write that could strand an execution in
`running`. Both share a signature: **correct against the task's own tests,
wrong against a shape those tests didn't exercise.** Bug #1 hid behind an
invariant test that used `includeSchemas: true` (the one input value where the
buggy reconstruction coincided with the guest's bytes); bug #2 hid because the
prior fix guarded the sandbox-throw path but not its sibling store-write path.
The lesson: a per-task review verifies a task against *its own* contract; only
a fresh pass over the integrated whole asks "what shape did none of the tests
cover?" Budget for the whole-branch review to find real bugs even when every
task is green — that's its job, not a formality. Two independent analyses
(the reviewer + a local security sub-agent) converging on the same two bugs
was the confidence signal they were real.

### 2. A test that passes for the wrong reason is worse than no test

Bug #1's invariant test asserted `describe`+approval+resume works — and passed
— but only because `includeSchemas: true` was the single value where the
reconstruction `{path, includeSchemas: false}` didn't diverge from the guest's
`{path}`. The test gave false confidence in exactly the serialization that was
broken. The fix added the **positive control** the plan's design already
implied: a resume test with `describe({path})` (no `includeSchemas`) that
*fails* without the fix. When a test exercises one value of a parameter that
has a meaningfully different other value, test the other value too — the
"happy" value can be the one that accidentally works.

### 3. Serialization is a boundary; single-source it or it drifts

Three separate concerns needed "are these two calls the same call?": the
approval identity check (invoker), the journal reconstruction (manager), and
the decision seam. Two subagents independently flagged that if these used
different serializations, every approved resume would fail closed. The
resolution that held: export ONE `identitiesMatch` and ONE
`JSON.stringify(input)` convention and reuse it everywhere (Task 6 exported it
visibility-only; the manager reuses it). Same lesson recurred for the
credential scrub: it started as a *copy* of `upstream.ts`'s echo-scan and
immediately diverged (missed bare-token echoes), fixed by extracting a shared
`redactionTokens`/`redactTokens` primitive both call. **A copied security
check is a divergence waiting to happen; a shared primitive makes divergence
structurally impossible.** When two code paths must agree on a security-
relevant comparison, don't write it twice — extract it once.

### 4. A claimed resource must always reach a terminal state

`claimForResume` flips a row to `running` (an atomic CAS). Any failure after
that — sandbox throw OR store-write throw — must finalize a terminal state,
or the row is stranded `running` and, because the claim only matches `paused`,
permanently un-resumable. The first fix covered the sandbox path; the review
found the store-write sibling. The general rule for any claim/CAS: the code
between "claim the resource" and "settle it terminally" must have NO unguarded
throw path — wrap all of them so a failure releases the resource to a visible
terminal state. Fail-safe (stranded, visible, recoverable) beats fail-unsafe
(double-executed, silent, irreversible), but "stranded forever with no way
out" is its own bug worth closing.

### 5. Codex quota status is not durable — verify it, don't trust a prior claim

Mid-session the user said "Codex quota is back" (contradicting the prior
HANDOFF's "resets Aug 1"). Acting on that, the design-phase `codex exec`
passes ran fine (3 of them). But at the security-gate step the account was
usage-limited again (now "resets ~Aug 8"). The lesson: an external quota/limit
is stateful and can re-trigger; a claim that it's "back" is true at a moment,
not durably. The `codex exec` invocation already fails closed with an auth/
limit line in stderr — trust that live signal over any remembered status, and
record the limit in HANDOFF so the next session doesn't assume availability.
The local security-review sub-agent remained the sanctioned stand-in and
independently reproduced the whole-branch bugs, so the cross-analysis signal
wasn't lost.

### 6. An implementer honoring the design over the plan is correct — verify completeness, not obedience

Task 7's implementer folded Task 9's spec §18/§5.5 migration into its own
commit (the plan had them separate), reasoning that the design §11 required
the spec+code+invariant to land atomically or spec-drift CI would pass over a
now-false claim. That was *right* — the design's correctness requirement beats
the plan's organizational split, and the implementer flagged it rather than
doing it silently. The controller's job there was NOT to enforce the plan's
structure but to verify the fold was *complete*: a grep for "doubles as" found
one survivor, which on inspection was the legitimate "we supersede X" quote in
the new §18 text, not a missed edit. Plan structure is a scaffold; the design
is the contract. When they conflict, verify the design is satisfied, not that
the plan was obeyed.

## 2026-07-10 — §5.5 execution manager: bot + real cross-model review round (PR #26)

After the §5.5 manager was built + self-reviewed (per-task + whole-branch +
/security-review) and opened as PR #26, CodeRabbit + Greptile + real `codex exec`
cross-model passes reviewed it. They found issues the self-review pipeline missed;
fixing them ran a fix→confirm loop that converged **9 → 3 → 1 → 1(P1) → 0** across
5 commits. Final state: 284/284, both cross-model Codex and an independent reviewer
returned zero in-scope findings.

### 1. Cross-model review catches what same-model structurally cannot — the sharpest instance yet

The decisive moment: my same-model stand-in reviewer (a Claude sub-agent, when
Codex was down) verified a fix "clean, no double-exec window, tests preserve-intent"
— competently, tracing carefully. The real cross-model Codex pass, on the same
diff, found a **P1 the stand-in missed**: the `call_attempts` marker guarded a state
(`paused` recovery) that the hazard it was built for (`running` process-crash) never
lands in — an over-claim delivering nothing. The stand-in reasoned *within the
author's framing* ("the marker protects against the crash"); Codex stepped outside
and asked *which state the crash actually lands in*. **A reviewer sharing your model
shares your blind spot about which question to ask.** That is why "cross-model" is a
distinct signal, not just "one more reviewer." Corollary: the strongest convergence
signal is not "a pass found nothing" but "cross-model and same-model AGREE on the
exact axis they previously SPLIT on" — agreement after a tested disagreement.

### 2. A safety mechanism must be reachable in the state the hazard occurs, or it's an over-claim

The `call_attempts` marker was added (itself in response to an earlier Codex finding)
to detect a fired-but-unjournaled side effect on recovery. But: a real crash leaves
the row `running`; `resume()` only claims `paused` rows; the marker is only ever read
during `paused` recovery. So the marker for a real side effect is **never read** — it
guards a state that never occurs. The append-*throw* case it seemed to help was
already handled by the live-drive catch. The right fix was **removal, not more
mechanism**: a mechanism wired to an unreachable state isn't defense-in-depth, it's
false confidence (the convergence rule's "relabel/remove the over-claim, don't pile
on"). When reviewing a safety mechanism, always ask: *in the state where the hazard
actually happens, does this code even run?*

### 3. Honest scope-deferral beats a fake guarantee

Process-crash recovery of `running` executions genuinely can't be done safely in a
single-process MVP (you can't distinguish "crashed" from "legitimately running" without
a heartbeat/lease — the deferred multi-worker infra). So the correct move was to
**delete the over-claim and document the deferral**: the MVP guarantees no
double-execution (a stranded `running` row is never re-run — `resume` only claims
`paused`), NOT recovery. Building the "recovery sweep" would have been *worse* than
nothing — a naive sweep terminalizes live executions. "We don't do X, here's why, and
here's the weaker thing we DO guarantee" is a stronger position than machinery that
pretends to do X.

### 4. Codex CLI/model availability is a moving target — probe live, don't trust a prior claim

Running the cross-model pass hit a three-layer obstacle course, each masquerading as
the previous: (a) usage quota exhausted; (b) quota came back but the installed CLI
(0.142.5) was too old for the account's new default model (`gpt-5.6-luna`/`terra` →
400 "requires a newer version of Codex"); (c) the model-supporting CLI (0.144.0) was
blocked by the user's own Socket Firewall `minimumReleaseAge` supply-chain gate (npm's
published CLI was newer than the age cutoff). Each layer produced a *different* error;
`codex exec` fails closed with the reason in stderr (usage-limit line vs. version-400
vs. sfw ETARGET-with-date). **Lesson: probe the live signal, never trust a remembered
"Codex is back."** And note the real tension in (c): a supply-chain age-gate correctly
blocking a bleeding-edge CLI is the defense working — bypassing it (which the user did,
deliberately, for one first-party install) is a human decision the agent hands over,
never performs. Supersedes the 2026-07-09 #5 "quota is stateful" note with the fuller
picture: quota is only one of three moving parts.

### 5. The bot review gate earns its place even after an exhaustive self-review

This PR went through per-task reviews (fresh implementer + independent reviewer each),
a whole-branch review, and /security-review — genuinely rigorous — and STILL had 9
findings when CodeRabbit/Greptile/Codex looked. Every self-review verifies the paths
*it* considers; the misses were always in paths it didn't (an infra throw, a
marker-store fault, a `Date()` function call, a state the mechanism can't reach). The
bots/cross-model are not a formality after a thorough self-review — they are the
independent-eyes layer that finds the class of bug self-review is structurally blind
to. Budget for them to find real things; treat "opened the PR" as the START of review,
not the end.

## 2026-07-10 — §11 Trace redaction (PR #27): design → SDD build → converged cross-model round, one session

### 1. The recurring cross-model blind spot has a name: lifecycle edges

Same-model review (five lenses + a whole-branch opus pass + /security-review) cleared
the branch; the real codex passes then found two P2s, and both were the same SHAPE:
reasoning covered the write path forward in time, and missed data that ALREADY EXISTS
— a policy row surviving its deleted tool (§7 makes rows outlive tools), and pre-§11
trace rows written before redaction existed. PR #26's cross-model catch (crash leaves
`running`, not `paused`) was the same shape. When prompting any future adversarial
pass, explicitly ask: "what about rows/state that predate this change or outlive
their parent?" — lifecycle edges beat logic edges as this codebase's blind spot.

### 2. Make migrations one-time by construction, not by guard

The pre-§11 fix's key move: after masking legacy rows, DROP the legacy column — its
absence IS the completion marker. No schema-version counter, no re-scan on every
open, no "is it done?" guard that can drift. Same family as the convergence rule's
canonicalize-then-check: encode the state transition in the structure itself.
(Corollary honestly documented in PR #27: a READONLY legacy DB now fails open()
closed — fail-closed posture, dead data, revisit only if readonly opens become a
product surface.)

### 3. Aliasing is a design-review question, not a code-review question

The one hard integration hazard — the manager journals the SAME object reference
after appendTrace runs, so an in-place-mutating redactor would silently poison the
replay journal (D7 violation) — was caught at DESIGN time by tracing execution order
against reference flow, then pinned as an explicit non-mutation contract + test.
Every later reviewer verified it in minutes because the contract was named. Passing
shared references through a "display-only" transform is where display concerns become
data corruption; name the non-mutation requirement in the spec, don't leave it as
"pure is good style".

### 4. `codex exec` operational update: background + stdin, and feed re-passes the fix list

A foreground positional-arg run on this branch's diff hit the Bash 600s cap with zero
output. The reliable shape: background run, prompt via stdin redirect, stdout/stderr
to stable scratchpad files, and a re-pass prompt that (a) lists already-fixed findings
so it hunts NEW issues, (b) demands a literal "CONVERGED — SHIP"/"NOT CONVERGED"
final line. Three passes ran clean this way (find → fix → find → fix → converge),
closing the loop the convergence rule requires.

### 5. Tell subagents what NOT to do with git — specifically, no stash

An SDD implementer stashed mid-task to check baseline behavior; the permission guard
then blocked `stash pop` for the subagent AND the controller (correctly — pop is on
the confirm list), stalling the task on a human decision (`git stash apply`, drop
after commit). Cost: one interrupted task and a user interrupt. Since then every
dispatch carries "do NOT use git stash — work directly on the tree", and none
recurred. Generalization: subagent briefs should preempt the permission-gated verbs
the task might tempt them into, not just describe the happy path.

### 6. Bounded-claim curation is allowed to grow the list — deliberately

Greptile flagged access_token/refresh_token missing from the builtin denylist. Under
adversarial-convergence discipline the reflex is "never extend a denylist per
finding" — but that rule targets unbounded ENCODING chases. This was list CURATION
at review time (ubiquitous names, exact-match semantics, safe-by-default posture):
we added them with an explicit sign-off note. The distinction to keep: extending
against a new *spelling of the same value* = whack-a-mole (refuse); extending
against a newly-recognized *field name in the bounded vocabulary* = curation (fine,
deliberate, test-pinned).
