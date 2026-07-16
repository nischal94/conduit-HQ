# C4 + C5 — Upstream-client transport compatibility (design)

**Date:** 2026-07-16 · **Spec authority:** conduitspec §18 "Upstream-client
transport compatibility (C4)" (PR #37) and §18 "Upstream scope (v1)" (C5
known-limitation clause) · **Evidence base:** the 2026-07-16 dogfood sessions
(HANDOFF "Dogfood ROUND 2", LEARNINGS 2026-07-16 ×2 entries).

## Problem

The MVP's upstream caller (`packages/sdk/src/pipeline/upstream.ts`) and the
`add-mcp` onboarding fetch (`packages/cli/src/mcp-fetch.ts`) speak a bare
JSON-RPC POST dialect that 0 of 3 real public MCP servers accept (GitHub,
Context7, Vercel — verified live). Independently, C5 makes the first real
upstream's tools uncallable even with a working transport: `normalizeMcp`
rewrites hyphenated tool names (`resolve-library-id` → `resolve_library_id`)
and serve-time derives the upstream name by prefix-stripping the display
name — 2/2 Context7 tools failed live with "Tool not found". Both fixes ship
together: a working transport to an uncallable catalog is still an adoption
blocker.

## Decisions

### D1 — One dialect: drop bare JSON-RPC upstream support

No fallback, no per-source flag. A failed handshake is a clean, specific
error. The demo upstream (`scripts/token-demo-upstream.mjs`) upgrades to
minimal streamable HTTP and becomes the real-protocol test fixture, gaining
`tools/call` (discharges the "call-capable demo upstream" carry-over).
`scripts/seed-demo.mjs` carries its own bare-dialect copy and is superseded
by `conduit add-mcp`: Lane B retires it (and updates the README references)
or upgrades it — retirement is the default unless a README flow still needs
it. Rationale: a second dialect is a second code path through the §9.3
boundary, a downgrade path for an adversarial reviewer, and permanent
double-testing — for hypothetical servers never observed in the wild.

### D2 — One shared client module: `packages/sdk/src/pipeline/mcp-client.ts`

Hand-rolled minimal streamable-HTTP client over the EXISTING pinned-egress
machinery (approach B; the official `@modelcontextprotocol/sdk` client was
rejected because its fetch-based transport would re-plumb the §9.3 pinned
lookup, §9.2 header scoping, byte caps, redirect refusal, and timeout
classification — rewriting the mechanism of the most security-sensitive
file for no incremental value; two parallel implementations, one official +
one hand-rolled, were rejected for drift risk).

The client implements exactly:

- `initialize` — the client holds an explicit **supported-version
  allowlist** (`2025-06-18`, `2025-03-26`); it sends the newest, and a
  counter-offer outside the allowlist is a handshake failure (fail loud,
  named versions in the error). The full initialize shape is sent
  (`protocolVersion`, `capabilities`, `clientInfo`), the result is
  validated against the expected shape, and the server MUST advertise
  `capabilities.tools` — otherwise fail loud before any list/call.
  `Mcp-Session-Id` is captured from the response headers when present
  (servers MAY omit it — sessionless servers like GitHub's stay supported
  by simply not sending the header back).
- **`MCP-Protocol-Version` header carries the negotiated version on every
  post-initialize request** (notifications/initialized, tools/list,
  tools/call, DELETE) — it lives in the session scope next to the session
  id.
- `notifications/initialized` — the spec requires exactly `202 Accepted`
  with no body (same for ping-response POSTs); anything else is a
  handshake failure, fail loud. The (empty) body still goes through the
  capped reader.
- `tools/list` — paginate via `nextCursor` until absent; byte cap and
  tool-count cap enforced across the SUM of pages, streaming, per the
  existing cap semantics (see caller profiles below).
- `tools/call`.
- Response parsing — a **minimal id-correlating dispatcher**, not a bare
  "last event wins": `application/json` and `text/event-stream` both
  accepted (`Accept: application/json, text/event-stream` sent always);
  SSE events are parsed incrementally and the response is matched by
  JSON-RPC id; interleaved server notifications are ignored; a server
  `ping` request is answered (empty-result response POSTed) so long-lived
  streams aren't dropped; under a negotiated `2025-03-26`, batched arrays
  are accepted and searched for the matching id (`2025-06-18` forbids
  batching — an array there is a malformed body). Reading stops as soon as
  the matching response is parsed. **Every** response in the flow —
  initialize included — is read through the capped reader; the handshake
  must not become the unbounded-ingestion hole the caps exist to close.
- **One logical-operation budget**: a single absolute deadline and a
  single cumulative byte counter span the WHOLE logical operation
  (handshake + pagination + call + any retry). A hostile server cannot
  multiply the timeout with tiny pages or slow handshake steps — this
  preserves `makeInvoker`'s remaining-drive-budget contract at serve-time
  and the 5s onboarding timeout's meaning.
- Session-expiry retry, precisely scoped: **only a 404 on a request that
  actually carried a session id** classifies as expiry → one re-handshake
  + one retry of that operation, inside the same logical budget, then fail
  loud. 400s, sessionless 404s, and initialize/DELETE 404s never
  re-handshake. A 404 mid-`tools/list` pagination restarts pagination from
  page one (old cursor and partial pages discarded) while KEEPING the
  original deadline and cumulative byte counter. Within one scope, lazy
  initialization is **single-flighted** so concurrent first calls (or
  simultaneous expiries) in the same drive share one handshake instead of
  racing.
- Best-effort session teardown: the session scope is **disposable**; on
  scope end a capped, deadline-bounded `DELETE` is sent when a session id
  exists (404/405 non-fatal, errors swallowed into diagnostics — teardown
  never fails a drive).
- Redirects refused (unchanged §9.3 posture; node:http does not follow).

**Caller profiles (caps are NOT unified):** serve-time keeps its 1 MiB
response budget (`DEFAULT_MAX_RESPONSE_BYTES`, upstream.ts) and the
per-call `timeoutMs`; onboarding keeps 5 MiB / 1,024 tools / 5s
(mcp-fetch.ts's `MAX_RESPONSE_BYTES` / `MAX_TOOLS`). The shared client
takes the budget as an argument; neither boundary weakens.

Egress is a per-call option: serve-time always pins
(`createPinnedLookup`, exactly as today); `add-mcp` passes
`allowPrivate: true` — the URL is operator-typed, preserving today's
behavior (documented decision; SSRF protections target agent-driven URLs).
Auth headers ride request-scoped exactly as today (§9.2). **Onboarding
auth + retarget credential-leak guard (supersedes C2's preserve-not-remove
for the retarget case only):** the stored row is read FIRST;
`CONDUIT_ADD_SECRET` (this run's env) always wins; a stored credential is
reused for the fetch ONLY when the URL is unchanged from the stored row.
A `--replace` retarget to a NEW URL with a stored credential and no fresh
env secret is **refused outright** (fail loud: pass `CONDUIT_ADD_SECRET`
or `--clear-credential`) — NOT merely fetched unauthenticated, because
preserving the old `credentialRef` (today's C2 behavior,
add-mcp.ts:~194) would leak the old credential to the new URL on the
next serve-time call. Same-URL re-sync keeps C2's preserve-not-remove
semantics unchanged. Also validated at initialize: an `Mcp-Session-Id`
header that is empty or contains non-visible-ASCII is a handshake failure
(the protocol restricts the id to non-empty visible ASCII).

### D3 — Session strategy: per-drive session scope

A session scope is created at `makeInvoker` time (the manager's per-drive
factory, manager.ts:608/:717) and threaded to the upstream caller — NOT
cached in `createMcpUpstreamCaller`'s closure (that instance is constructed
once at server startup, runtime.ts:44, and is shared). Within one drive, the
first call to a source performs the handshake lazily (single-flighted, per
D2); chained calls reuse the session; the scope is disposed with the drive.
The disposal seam is explicit: `makeInvoker`'s return becomes
`{ invoke, dispose }` (or an equivalent disposer registration), and every
drive exit path — success, failure, pause — runs `dispose` in a `finally`
(best-effort DELETE, per D2; never fails the drive).

**Cache binding (the in-drive invalidation guard):** cached session state
(session id + negotiated version) is keyed by the EXACT resolved URL plus
a **per-drive salted digest of the resolved auth material** (HMAC with a
random salt minted at scope creation; the digest is non-reversible, lives
only in the drive-scoped cache, and the material itself is never stored —
§9.2's request-scope-only posture holds). `credentialRef` alone is NOT a
sufficient key: the ref is deterministic (`cred_${namespace}`,
add-mcp.ts:~150), so a rotation overwrites the same ref without changing
it. Because the invoker resolves source and credentials fresh per call
(invoker.ts:167), an operator retargeting OR rotating a credential
mid-drive changes the key, and the stale session is invalidated and
re-handshaken instead of being reused against a different target or under
a stale authority. No cross-execution session state exists.

Two precision notes for the plan: the auth digest is computed over a
canonical serialization (length-prefixed, name-normalized, sorted header
sequence, with an explicit no-auth representation); and an operation that
observes a stale-generation 404 completes by retrying once through an
UNCACHED session bound to its own original URL/auth — it neither publishes
into nor invalidates the current cache generation.

**Resume semantics — documented limitation, not "correct by
construction":** a resumed execution gets a FRESH session scope. Replayed
calls are served from the journal and never reach the upstream; the first
NEW call after resume runs in a new upstream session that did not observe
the pre-pause calls. If an upstream's tools/call semantics depend on
server-side session state accumulated across calls, post-resume behavior
can differ from an unpaused run. This is consistent with the existing §5.5
replay contract — which already accepts that the upstream's state may
drift during an hours-long pause and guarantees deterministic replay of
LOCAL results only, never upstream-side state — and preserving a server
session across a pause measured in hours is not realistic (server-side
expiry). Recorded as an accepted limitation; upstreams whose tool
semantics require session affinity across an approval pause are out of
scope for v1.

### D4 — C5: store the upstream tool name; never derive it

`tools` gains an `upstream_name` column. `normalizeMcp` records the
original upstream name alongside the transformed display name. Serve-time
sends `upstream_name` — the prefix-strip derivation is deleted. A one-time
migration backfills existing rows using that same prefix-strip derivation
(migration precedent: the §11 trace migration).

**The backfill is knowingly lossy, and that is documented, not hidden:** a
stored `resolve_library_id` cannot reveal whether the upstream name was
`resolve-library-id` or `resolve_library_id`, so a backfilled row whose
name the normalizer transformed carries a possibly-wrong `upstream_name`.
This is accepted deliberately because (a) those rows are EXACTLY the rows
that are already uncallable today (the C5 bug) — the backfill regresses
nothing and fixes the untransformed majority; (b) there are no production
deployments (pre-launch; the only known db is the demo db slated for
deletion at key rotation); (c) `add-mcp` re-sync fully repairs a catalog.
The migration note and CLI README say: pre-C5 catalogs with transformed
names need one `add-mcp --replace` re-sync. The fail-closed alternative
(NULL upstream_name + serve-time refusal until re-sync) was considered and
rejected as machinery for a user base of zero.

Both `INSERT INTO tools` sites (sqlite.ts:362 `replaceNamespace`, :683
`provisionSource`) change — that is the tracked "3rd-site" trigger for the
SQL duplication: extract the shared tools-INSERT helper in the same change.

### D5 — CLI frictions (same files, same PRs)

- `add-mcp` propagates the client's specific errors: a 401 says auth
  (naming `CONDUIT_ADD_SECRET`), cap breaches say caps, "unreachable" is
  reserved for actual network failure. The single error-discarding catch
  (commands/add-mcp.ts:127) is replaced by error mapping.
- Flag validation reports ALL missing/invalid flags in one run;
  `add-mcp --help` prints usage (and the top-level help gains the flag
  summary).
- `approvals deny` whose resume lands `failed` with `ConduitPolicyBlocked`
  (i.e., failed BECAUSE we denied) prints `denied` and exits 0; non-zero
  stays for conflict / expired / store faults / any other failure class.
  Exit codes track the verb, not the downstream object (LEARNINGS
  2026-07-16 #2).

### D6 — Deferred out (recorded, deliberate)

- Pre-flight input validation against the stored inputSchema (Ajv is
  already a dep; upstream rejection is the current behavior — real design
  question, not a compat blocker; tracked in HANDOFF carry-overs).
- OAuth-flow upstreams (spec §18: static-secret model is the v1 story).
- `isError:true` tool-level-failure filter — a v1 trace-viewer nicety
  (trace rows already record it faithfully; verified live).
- **SSE stream resumption (`GET` + `Last-Event-ID` + `retry`)**: a server
  that closes the SSE stream before delivering the response is treated as
  an upstream failure — fail loud, the agent may re-issue the call. v1
  does not resume interrupted streams. Recorded non-goal; revisit if
  dogfooding ever hits it.
- **Standing server-initiated GET stream** (unsolicited notifications such
  as `tools/list_changed`): explicit non-goal — the catalog refreshes via
  `add-mcp` re-sync, not live notifications. (Distinct from resumption
  GET, which is also out, above.)
- **Server-initiated requests other than `ping`** (sampling, elicitation,
  roots): the client answers `ping` and rejects the rest with a JSON-RPC
  method-not-found error — Conduit's upstream client is a tool caller,
  not a full MCP host.

## Error handling

Handshake failures map into the existing fail-loud taxonomy: upstream error
with status context, never a silent fallback or dialect downgrade. SSE
parse failures are malformed-body errors (same class as today's
missing-result.tools). Cap semantics unchanged. Timeout classification
unchanged (TimeoutError name contract). All error text crossing to the
agent remains ref-free and passes the existing §9.2 sanitization.

## Testing

- Existing invariant pins stay green untouched in meaning: §9.3 egress
  (pinning, redirects, private-target refusal), §9.2 redaction, caps,
  outcome persistence.
- New invariants: handshake-before-call ordering; the version allowlist
  rejects an out-of-set counter-offer; `MCP-Protocol-Version` present on
  every post-initialize request; ONE logical-operation budget across
  handshake + pagination + call + retry (a many-tiny-pages server cannot
  multiply the deadline); caps enforced across paginated pages AND on
  handshake responses; id-correlation ignores interleaved notifications
  and answers ping; 404-retry fires ONLY when the failed request carried a
  session id, at most once; single-flighted handshake under concurrent
  first calls in one scope; best-effort DELETE on scope disposal never
  fails a drive; C5 round-trip on a hyphenated-name fixture (the Context7
  shape, end-to-end through normalize → store → call); per-drive session
  lifecycle (fresh scope on resume; no cross-drive reuse); sessionless
  servers (no Mcp-Session-Id header) work; retargeted `--replace` with a
  stored credential and no fresh env secret is REFUSED (neither fetch nor
  persistence carries the old credential to the new URL — including the
  next serve-time call); an in-drive URL change invalidates the cached
  session; **same-URL same-ref secret rotation mid-drive forces a
  re-handshake** (the auth-digest key component); **a delayed 404 arriving
  from the OLD session generation cannot invalidate a newly established
  session** (generation check under single-flight); the mid-pagination
  404 matrix (restart from page one, cursor + partial pages discarded,
  exactly one retry, original deadline and cumulative byte counter kept);
  the Mcp-Session-Id validation matrix (empty / whitespace-control /
  non-ASCII rejected, visible-ASCII boundary values accepted); dispose
  runs on every drive exit path including pause.
- The upgraded `token-demo-upstream.mjs` doubles as the integration
  fixture. The checked-in demo artifacts (`demo/token-demo.json/html`)
  must re-run byte-identical — they embed no wire dialect (verified:
  zero `jsonrpc` occurrences), and the tool surface is unchanged.

## Ship strategy — two PRs (Lane A/B precedent)

- **Lane A (sdk core, full load-bearing gauntlet):** `mcp-client.ts`,
  serve-time rewiring in `upstream.ts`, D3 session scope through
  `makeInvoker`, D4 schema change + migration + INSERT-helper extraction.
  Touches the §9.3 boundary → Tier 2 + /security-review + real cross-model
  pass (correctness framing) + /explain-diff quiz + human-named merge.
- **Lane B (CLI + fixtures, on merged Lane A):** `add-mcp` onboarding via
  the shared client + auth-at-onboarding, D5 frictions, demo-script
  upgrade/retirement, README updates.
- **Step 0 of Lane-B verification (hard prerequisite):** rotate the
  gate-one demo key — delete `~/.conduit`'s demo db + key, mint fresh,
  update the desktop snippet + MCP config — BEFORE any real PAT is stored
  (the old key was exposed in a session transcript; HANDOFF housekeeping).

## Degrees of freedom (for the implementation plan)

- Free: internal shape of `mcp-client.ts` (function vs class), SSE parser
  internals, exact error-message wording (within the taxonomy), test file
  organization.
- STOP-and-ask: any change to `UpstreamCaller`'s public interface beyond
  adding the session scope; any new dependency; any change to cap values;
  any schema change beyond `tools.upstream_name`.
