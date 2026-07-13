# §4.2 Before/After Token Demo — Design

**Date:** 2026-07-13
**Spec anchor:** conduitspec §4.2 (progressive disclosure target metric) + §17
step 4 ("the spec's designated QA artifact").
**Scope:** a demo, not a product surface. MVP build-order item 4 of 4.

## 1. Purpose & identity

One demo serving both identities the spec assigns it:

- **QA artifact (§17):** a reproducible script run that measures, through the
  real front door, the token cost of N raw upstream tool schemas vs. Conduit's
  two-tool surface — and fails loud if the claim doesn't hold.
- **Marketing artifact seed (§4.2):** a self-contained interactive HTML
  before/after page generated from those measured numbers.

**Honesty stance (decided in brainstorm):** all headline numbers are
live-measured at bundled-demo scale. The spec's ~1,600-tool / ~278,800-token
figure appears ONLY as a clearly-labeled extrapolation from the measured
per-tool average. Nothing is hand-computed; both sides of the comparison are
measured by the same operation (`tools/list`) with the same counter.

## 2. Decisions

- **D1 — Live-measured, small scale.** Real measurement through `conduit
  add-mcp` and `conduit serve`; no fixture-only numbers. (Alternatives
  rejected: spec-scale synthetic fixture — marketing-strong but QA-weak;
  hybrid — extra scope.)
- **D2 — Bundled demo upstream.** A minimal `node:http` MCP upstream shipped
  in `scripts/`, serving a deterministic catalog of 800 realistic tool
  schemas. Offline, repeatable forever, and exercises `add-mcp`'s real caps
  (streaming byte cap, 1,024-tool cap) at a scale no existing test does.
  (Rejected: real public MCP servers — fragile external dependency.)
- **D3 — Script → numbers + HTML page.** One orchestrator script prints the
  measured table (QA gate) and renders the checked-in interactive HTML page
  (marketing seed). (Rejected: script-only — defers the spec's "interactive"
  language; HTML-with-baked-numbers — not reproducible.)
- **D4 — Same yardstick as the invariants.** Token counting uses
  `estimateDefinitionTokens` (the ~4 chars/token heuristic that pins the
  ≤1,044 / ≤256 INVARIANT §4.2 rows), imported from `@conduithq/mcp`'s built
  dist — NOT reimplemented. This requires adding `estimateDefinitionTokens`
  to `packages/mcp/src/index.ts`'s export block: a one-line pure re-export,
  zero behavior change, the only product-package edit in this work.
- **D5 — Deterministic, checked-in artifacts.** `demo/token-demo.json` and
  `demo/token-demo.html` are committed. No timestamps or other run-varying
  fields anywhere in the output: a re-run on an unchanged surface is
  byte-identical, so a diff in these files MEANS the measured surface
  changed. Staleness policy: regenerate when the tool surface changes; the
  pre-milestone audit cadence and §17 gate-two re-run the script.
- **D6 — Catalog size 800.** Under the 1,024-tool ingestion cap (the demo
  flows through the cap, not around it) and the 5 MB byte cap. Templates
  sized to ~174 tokens/tool (the density the spec's own 1,600 ≈ 278,800
  figure implies), giving a ~140k-token before-number and a ~107× measured
  ratio.

## 3. Components

All demo scaffolding; zero new third-party dependencies.

### 3.1 `scripts/token-demo-upstream.mjs` — the bundled upstream

- Minimal `node:http` server answering JSON-RPC POST `tools/list` with the
  same bare shape `fetchToolsList` (packages/cli/src/mcp-fetch.ts) and
  `seed-demo.mjs` speak. No MCP SDK, no sessions, no other methods.
- Serves a deterministic catalog of exactly 800 tools generated in-file from
  realistic templates (GitHub/Stripe/Jira/Sentry-shaped names, descriptions,
  and JSON-schema inputs of varying complexity). Same catalog every run — a
  pure function of the template tables, no RNG seeded from time.
- Listens on `127.0.0.1` port 0 (OS-assigned); prints the bound port on
  stderr as `PORT=<n>` for the orchestrator to scrape. Stdout: nothing.
- Runnable standalone (for gate-one-style manual poking) but normally
  spawned by the orchestrator.

### 3.2 `scripts/token-demo.mjs` — the orchestrator

Steps, all against throwaway state (temp dir database, generated master key):

1. Spawn the upstream; wait for `PORT=`.
2. `POST tools/list` to the upstream directly; **before** = Σ
   `estimateDefinitionTokens(tool)` over the 800 raw definitions.
3. Spawn the real CLI bin: `conduit add-mcp <url> --name demo --json` with a
   temp `CONDUIT_DB` + generated `CONDUIT_MASTER_KEY`. Parse the `--json`
   `{safe,review,destructive}` counts. Assert ingested total = 800.
4. Spawn `conduit serve` on the same env; connect a real MCP client
   (`@modelcontextprotocol/sdk` Client + StdioClientTransport, resolved via
   `createRequire` anchored at packages/mcp — the seed-demo.mjs pattern);
   `listTools()`; **after** = Σ `estimateDefinitionTokens` over the (two)
   definitions the client actually received.
5. Assertions (the QA-gate teeth — any failure exits 1):
   - after-side is exactly the two tools `execute` + `check_execution`;
   - after ≤ 1,300 (the two pinned caps summed);
   - ingested tool count = 800;
   - before/after ratio ≥ 20× (conservative floor; expected ~107×).
6. Print the before/after table to stderr; write `demo/token-demo.json`.
7. Render `demo/token-demo.html` from the JSON (template lives in the
   script; self-contained output).
8. Teardown both children; remove temp state. Non-zero exit from any step
   fails the run loudly.

### 3.3 `demo/token-demo.json` — the measured record

Machine-readable results: catalog size, per-risk-class counts from
`add-mcp --json`, before tokens, after tokens (per definition and summed),
per-tool average, ratio, the estimator's name, and the spec-scale
extrapolation point. No timestamps (D5).

### 3.4 `demo/token-demo.html` — the interactive page

Self-contained (inline CSS/JS, no CDN, works offline from `file://`):

- Headline before/after bar comparison with the measured numbers.
- The two "surfaces" side by side: 800 schemas vs. `execute` +
  `check_execution`.
- An N-tools slider: before grows linearly at the measured per-tool average;
  after stays flat at the measured constant. The spec's 1,600-tool point is
  marked and labeled "extrapolated (spec §4.2)".
- A provenance footer: how the numbers were measured, the estimator used,
  and the command to reproduce (`node scripts/token-demo.mjs`).
- Every number labeled "estimated tokens (~4 chars/token)".

## 4. Measurement honesty rules

- Both sides measured by the same operation (`tools/list`) and counted by the
  same function (D4). The orchestrator is the client in both measurements;
  each side is counted over exactly what that client received.
- The demo ingests through the REAL `add-mcp` bin and lists through the REAL
  `serve` bin — spawned processes, not in-process calls — so the caps,
  redirects, and env contract all apply exactly as they would for a user.
- Extrapolations are visually and textually segregated from measurements.

## 5. Error handling / failure modes

- Any subprocess exiting non-zero, any timeout (upstream start, add-mcp,
  serve handshake), or any failed assertion → exit 1 with a `[token-demo]`
  prefixed reason. No fixture fallback, no partial artifact write: the JSON
  and HTML are written only after all assertions pass (atomic
  write-at-the-end).
- Temp state lives under `mkdtemp`; teardown runs in `finally`. Children are
  killed on orchestrator exit (also on signal).

## 6. Out of scope

- Web console, FTS5, Trace viewer, Phases 2–5 (spec §17 exclusions).
- Executing tools / the approval flow — the demo lists, it never calls.
- Real third-party MCP servers (D2 rejection) and real tokenizers (D4).
- CI regeneration of the artifacts (staleness policy in D5 instead).

## 7. Testing & review routing

- The orchestrator's assertions ARE the test; no vitest suite for demo
  scaffolding. The one-line index.ts re-export is covered by the existing
  mcp suite compiling/passing (it changes no behavior).
- Routing: `scripts/` and `packages/` are on the protected floor → branch
  (`feat/token-demo`) → PR → CI green → review → human-named merge.
- Review tier: Tier 2 (`/pr-review-toolkit:review-pr`) + `/security-review`
  (the scripts spawn subprocesses and bind a localhost listener — worth the
  security look). Classified BELOW the codex-adversarial + explainer-quiz
  bar: demo tooling plus a pure re-export, no boundary or dependency
  changes. This classification is stated in the PR body for the human to
  confirm or override at merge time.
