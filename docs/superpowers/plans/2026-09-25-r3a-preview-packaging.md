# R3a Preview Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** REVIEWED (2026-09-25): `/plan-eng-review` plus three `codex exec` passes, then `/plan-devex-review` plus two more (`gpt-5.6-sol`, `high`); both loops converged by adjudication. D-R1, D-R2, D-R5–D-R13 are founder decisions; D-R3 and D-R4 are agent defaults open to redline. Not yet merged.

**Goal:** One versioned, packed artifact that an outside adopter can install without the repo. It ships with alpha install notes and shows one governance property in the first-run path: approve → the exact approved call runs once; deny → nothing ran.

**Architecture:** The artifact is ONE tarball of `@conduithq/cli`. tsup inlines `@conduithq/sdk` and `@conduithq/mcp` into the CLI build, and third-party packages stay ordinary registry dependencies. A new `conduit demo` command proves the governance property in-process. It uses an in-memory store and a freshly generated key, and it onboards a loopback demo upstream that it starts itself. It then drives the SAME manager composition the daemon uses (`createApprovalRuntime`) through one approve and one deny. It counts what the upstream actually received and exits non-zero when the evidence is wrong. CI installs the packed tarball into a clean prefix and runs `conduit demo` from it.

**Tech Stack:** Node `>=22.12.0 <23 || >=24 <25` (was >=20; D-R12), pnpm workspace, tsup, vitest, `@libsql/client`, `node:http`.

**Spec:** `conduitspec.md` §18 entry "R1 sequencing amended — Lane A, then preview packaging, then decide profiles (decided 2026-09-11)". Quoted verbatim: "a versioned, packed artifact with alpha install notes and ONE governance property demonstrable in the first-run path (approve → the exact approved call runs once; deny → nothing ran) — not a public npm release; full R3 (lifecycle, install/upgrade/recovery guidance, docs) is unchanged."

## Global Constraints

- Not a public npm release (§18, 2026-09-11). Distribution is a GitHub prerelease asset.
- Not in the minimum: trace viewer, GraphQL, cloud, desktop, SSO (§18, 2026-09-11).
- The agent never installs packages. Every `pnpm install` / `npm install` is handed to the founder (CLAUDE.md, Supply chain). CI may install; the agent's shell may not.
- `pnpm-lock.yaml` is authoritative. This plan adds NO new package to the dependency graph; it only moves existing packages between manifests (Task 4).
- Agents never run `scripts/pack-preview`: it contacts the npm registry with an install-form command (D-R7). CI runs it; the founder may run it by hand.
- Install-time build scripts are default-deny; `allowBuilds` stays `esbuild` only.
- Node engines: `>=22.12.0 <23 || >=24 <25` from Task 4 on (D-R12); it was `>=20`.
- CI stays unprivileged: `permissions: contents: read`, no `secrets.*`, `--ignore-scripts`, `persist-credentials: false`, no `pull_request_target`, actions pinned to SHAs (CLAUDE.md).
- The demo must never read or write `~/.conduit` or the `CONDUIT_*` env, and must never set `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS`. Private egress is granted in code, to the demo's own process, for the loopback server that process started.
- Public-safe writing: no absolute host paths, no personal URLs in committed files.
- Control characters in source are written as escapes (LEARNINGS #37).

## Decisions

- **D-R1 — artifact form (founder, 2026-09-25):** one CLI tarball, with `@conduithq/sdk` and `@conduithq/mcp` inlined by tsup `noExternal`. Rejected: three tarballs (sibling-tarball resolution under `npm i -g` is unverified, and a registry 404 on `@conduithq/sdk` is likely) and a vendored tree (platform-specific because of libsql's native binary; skips the adopter's own supply-chain scan).
- **D-R2 — first-run demo (founder, 2026-09-25):** a built-in `conduit demo` that runs in-process. Rejected: a docs-only GitHub walkthrough (needs a PAT and real side effects; "nothing ran" is only an absence) and a bundled loopback upstream in the real state dir (teaches the unsafe egress flag on first run).
- **D-R6 — CLI entry renamed to `dist/conduit.js`; mcp's bin ships as `dist/bin.js` (founder, 2026-09-25):** `daemonEntryPoint()` (`packages/mcp/src/daemon/spawn.ts:57`) resolves `./bin.js` beside the running code. After inlining, the running code is in the CLI's `dist/`, so `./bin.js` must be mcp's daemon entry, not the `conduit` dispatcher. The tarball exposes two bins: `conduit` → `dist/conduit.js` and `conduit-mcp` → `dist/bin.js`, so the `conduit-mcp --doctor` recovery lines stay true. No mcp or sdk source change. Rejected: delegating `--daemon` through the dispatcher (packaged and source paths would differ) and an injectable entry point (edits the §3.1 trusted-executable boundary).
- **D-R7 — the tarball ships `npm-shrinkwrap.json` (founder, eng review 2026-09-25):** without it, npm resolves every range fresh on the adopter's install day, outside `minimumReleaseAge` and the audit, and CI tests a different tree from the one the adopter gets. `pack-preview` resolves the production tree with `npm install --package-lock-only --before=<now − 4320 min>`, audits it at `high`, and packs the shrinkwrap in. CI verifies that npm installed exactly that tree. Rejected: exact direct versions only (transitive deps still float) and floating ranges.
- **D-R8 — the adopter command is `npm install -g --ignore-scripts` (founder, eng review 2026-09-25):** the documented command matches the CI command, and it extends the repo's default-deny rule for install scripts to adopters.
- **D-R9 — the tarball job runs on macOS too (founder, eng review 2026-09-25):** matrix `os: [ubuntu-latest, macos-latest]` × `node` (versions per D-R12). The notes promise macOS, and `state-dir.ts:106` and libsql's per-OS binary are real darwin code paths.
- **D-R10 — the shrinkwrap may name only versions pnpm resolved (founder, codex review 2026-09-25; relabelled after pass 2):** `pack-preview` pins direct dependencies to pnpm's versions, adds an npm `overrides` entry for every transitive package pnpm resolved to one version, and `check-shrinkwrap-in-pnpm` refuses any `(package, version)` absent from `pnpm-lock.yaml`. It is a **best-effort version-set guard, not graph equality**: npm and pnpm hoist differently by design, so dependency edges may differ (codex pass 2 #2; founder chose the relabel over a graph normalizer, per the adversarial-convergence rule). The structural guarantee for the adopter tree is the CI run of the real demo, daemon, and doctor on that exact npm tree. Rejected: a committed second lockfile; keeping D-R7 unconstrained; graph-edge comparison.
- **D-R11 — pack once, promote the tested bytes (founder, codex review 2026-09-25):** one `pack` job builds the tarball; every `preview` leg installs that file after matching its SHA-256; Task 7 publishes the merge commit's CI artifact and never repacks. Cost accepted: two new pinned actions (`upload-artifact`, `download-artifact`).
- **D-R12 — Node floor `>=22.12.0` (founder, codex review 2026-09-25):** Node 20 is end-of-life since 2026-04-30. The matrix tests the exact floor and the latest Node 24 on Linux and macOS, so the engines claim equals the evidence. If `22.12.0` fails, the floor rises to the lowest passing 22.x and is recorded.
- **Codex findings rejected with evidence (2026-09-25):** #1 "demo exit code lost" — `main()` in `packages/cli/src/bin.ts` sets `process.exitCode = await runCommand(...)`; #6 "`ProvisionInput` not exported" — `export interface ProvisionInput` at `packages/mcp/src/daemon/provision.ts:300`; #5 "root export adds a private-egress fetch primitive" — `@conduithq/mcp` already exports `fetchToolsList`, which pins `allowPrivate: true`. Pass 2 #10 "no promotable main run" — `ci.yml` already triggers on `push: branches: [main]`.
- **D-R3 — version (agent default, founder may redline):** `0.2.0-alpha.0` on all three packages, the CLI `VERSION` constant, and the daemon's `AGENT_VERSION`. They move together because the CLI/daemon skew check compares them.
- **D-R4 — demo evidence is a gate, not a printout (agent):** `conduit demo` exits 1 unless ALL of these hold: approved call count = 1 with the exact approved input, denied call count = 0, and a replayed approve of the same call id returns `conflict` without a second upstream call. The demo therefore doubles as the install smoke test, and Task 2 proves it can fail.
- **D-R5 — two PRs, Task 3B first (founder, 2026-09-25; replaces the agent's earlier one-PR default):** PR A is Task 3B plus the README shell-history correction from Task 6 Step 4, on `fix/approval-guidance`. PR B is Tasks 1, 2, 3, 4, 5, 6 on `feat/r3a-preview-packaging`, branched from `main` after PR A merges. Reason: Task 3B was added by the DX review after the one-PR default was set. Its product fixes (pause message, approve lines, token advice) can be approved or rejected independently of packaging, and PR B's install notes describe the pause message PR A introduces, so A lands first. Each PR takes the Tier 2 gauntlet and the `/explain-diff` quiz (both touch product code). Task 7 (the release) happens after PR B merges, only on the founder's word.
- **D-R13 — build order (founder, 2026-09-25):** plan PR → the doctor-fixture fix (pre-ship gate 1, moved first on CI evidence: 3 of the last 7 reruns in 60 `ci.yml` runs were this fixture) → PR A → PR B → Dependabot triage → Task 7. The other flake family (4 of 7, `packages/mcp/src/daemon/client.test.ts` auto-start timing) is recorded in HANDOFF DEFERRED and not scheduled into this path; until it is fixed, a red "Unit tests" run on one of those tests gets one rerun, and any other red is a real failure.
- **D-R10 is kept as decided.** An agent proposal to reverse it (2026-09-25) was withdrawn in the final audit: it traded the CLAUDE.md supply-chain non-negotiable for implementation convenience, and D-R10's failure mode is loud (the pack job refuses), never silent.

## Degrees of freedom

- **Implementer may improvise:** output wording of `conduit demo` (the three evidence lines must stay); helper names private to one file; test names beyond the `INVARIANT` prefix rule.
- **Stop and ask:** any new dependency; any change to `packages/sdk` or to `createApprovalRuntime`; any change to egress defaults; any CI permission change; any need to touch `~/.conduit` from a test; any tarball content beyond `dist/`, `README.md`, `LICENSE`, `package.json`.

## Pre-ship gates (separate PRs, from HANDOFF DEFERRED)

1. **FIRST, before PR A (D-R13).** The `--doctor --offline performs ZERO writes` fixture race in `packages/mcp/src/integration.test.ts`: fingerprint after the seeding write settles, or assert content rather than mtime. Prove the repaired test still fails by making `--doctor --offline` write once. Plan it separately; it is a test fix with its own review.
2. Dependabot triage: 15 alerts on main (14 moderate, 1 low) per HANDOFF. Threat-model each alert, fix or dismiss per advisory with a rationale (CLAUDE.md, Dependabot).
3. `pnpm audit` and an Aikido scan (`/aikido:scan`) on main after the R3a PR merges (CLAUDE.md audit cadence: "before anything ships").

## Task map

| Task | Deliverable | Files |
| --- | --- | --- |
| 1 | Loopback demo upstream with a call ledger | `packages/cli/src/demo/upstream.ts` + test |
| 2 | `runDemo()` — onboard, approve, deny, replay; evidence gate | `packages/cli/src/demo/run.ts` + test; `packages/mcp/src/index.ts` (one export) |
| 3 | `conduit demo` command wired into dispatch, help, and bin; `src/version.ts` | `dispatch.ts`, `bin.ts`, `version.ts`, `commands/demo.ts` + tests |
| 3B | The approve command named where users need it; correct token advice (**PR A, lands first**) | `mcp/src/payloads.ts`, `cli/src/commands/approvals.ts`, `mcp/src/daemon/provision.ts` + tests |
| 4 | One-tarball build: inline workspace packages, version bump | `packages/cli/tsup.config.ts`, three `package.json`, `dispatch.ts`, `packages/mcp/src/env.ts` |
| 5 | Pack script with shrinkwrap + audit; four check scripts; a `pack` job (once) and a `preview` job (Linux + macOS × Node 22.12.0 + 24) that installs those exact bytes and runs `conduit demo` | `scripts/pack-preview`, `scripts/check-*`, `.github/workflows/ci.yml` |
| 6 | Alpha install notes, LICENSE in the tarball, README pointers | `docs/alpha/INSTALL.md`, `packages/cli/LICENSE`, `README.md`, `packages/cli/README.md` |
| 7 | GitHub prerelease with tarball + SHA-256 (founder-confirmed, after merge) | none (release only) |

**Branch:** `feat/r3a-preview-packaging` from `origin/main`. Every subagent dispatch carries a git allowlist and "if you think you need a baseline, stop and report" (LEARNINGS #36).

**Session quirks that apply (HANDOFF 2026-09-20):** run `tsc --noEmit -p` on each of `packages/sdk`, `packages/mcp`, `packages/cli` by hand before claiming "tsc clean" — the pre-commit hook does not typecheck the way CI does. Run `packages/cli` integration tests from `packages/cli`, not the repo root. The shell's `grep` is aliased; use `/usr/bin/grep`. The commit-msg hook rejects an AI co-author trailer.

---

### Task 1: Loopback demo upstream with a call ledger

A minimal streamable-HTTP MCP server that exposes one tool, `create_note`, with no annotations. With no annotations, `add-mcp`'s risk classifier puts it in `review`, and the fail-closed default policy requires approval for `review`. The server records every `tools/call` it receives. That ledger is the demo's ground truth: the demo's claims rest on what the upstream saw, not on what the manager reported.

**Files:**
- Create: `packages/cli/src/demo/upstream.ts`
- Test: `packages/cli/src/demo/upstream.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `DEMO_NAMESPACE: "demo"`, `DEMO_TOOL: "create_note"`
  - `interface DemoUpstreamCall { name: string; arguments: unknown }`
  - `interface DemoUpstream { url: string; calls: readonly DemoUpstreamCall[]; close(): Promise<void> }`
  - `startDemoUpstream(opts?: { readOnly?: boolean }): Promise<DemoUpstream>` — listens on `127.0.0.1`, port 0; `url` is `http://127.0.0.1:<port>/mcp`. `readOnly: true` annotates the tool `readOnlyHint: true`, which the real classifier marks `safe` and the default policy auto-allows. Production never passes it; Task 2 uses it to prove the "did not pause" check can fail through the real policy path.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/demo/upstream.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TOOL, type DemoUpstream, startDemoUpstream } from "./upstream.js";

async function rpc(url: string, method: string, params?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) }),
    signal: AbortSignal.timeout(2000),
  });
}

describe("demo upstream", () => {
  let upstream: DemoUpstream | undefined;
  afterEach(async () => {
    await upstream?.close();
    upstream = undefined;
  });

  it("answers initialize and tools/list, and records nothing for them", async () => {
    upstream = await startDemoUpstream();
    expect(upstream.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const init = await rpc(upstream.url, "initialize", {});
    expect(init.status).toBe(200);
    const list = (await (await rpc(upstream.url, "tools/list")).json()) as {
      result: { tools: { name: string; annotations?: unknown }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual([DEMO_TOOL]);
    expect(list.result.tools[0]?.annotations).toBeUndefined();
    expect(upstream.calls).toEqual([]);
  });

  it("readOnly: true annotates the tool readOnlyHint", async () => {
    upstream = await startDemoUpstream({ readOnly: true });
    const list = (await (await rpc(upstream.url, "tools/list")).json()) as {
      result: { tools: { annotations?: unknown }[] };
    };
    expect(list.result.tools[0]?.annotations).toEqual({ readOnlyHint: true });
  });

  it("records each tools/call with its exact arguments", async () => {
    upstream = await startDemoUpstream();
    await rpc(upstream.url, "tools/call", { name: DEMO_TOOL, arguments: { title: "a" } });
    await rpc(upstream.url, "tools/call", { name: DEMO_TOOL, arguments: { title: "b" } });
    expect(upstream.calls).toEqual([
      { name: DEMO_TOOL, arguments: { title: "a" } },
      { name: DEMO_TOOL, arguments: { title: "b" } },
    ]);
  });

  it("refuses GET (no SSE stream) and a body that is not JSON", async () => {
    upstream = await startDemoUpstream();
    const get = await fetch(upstream.url, { signal: AbortSignal.timeout(2000) });
    expect(get.status).toBe(405);
    const bad = await fetch(upstream.url, {
      method: "POST",
      body: "not json",
      signal: AbortSignal.timeout(2000),
    });
    expect(bad.status).toBe(400);
    expect(upstream.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `packages/cli`): `pnpm vitest run src/demo/upstream.test.ts`
Expected: FAIL — `Cannot find module './upstream.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/cli/src/demo/upstream.ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const DEMO_NAMESPACE = "demo";
export const DEMO_TOOL = "create_note";

export interface DemoUpstreamCall {
  name: string;
  arguments: unknown;
}

export interface DemoUpstream {
  url: string;
  calls: readonly DemoUpstreamCall[];
  close(): Promise<void>;
}

/**
 * No annotations by default: an unannotated tool classifies as `review`,
 * and `review` requires approval under the default policy. The demo's
 * pause depends on that default, and `runDemo` fails loudly if it changes.
 * `readOnly` exists only so a test can make the real policy auto-allow.
 */
function toolsFor(readOnly: boolean): unknown[] {
  return [
    {
      name: DEMO_TOOL,
      description: "Create a note. Demo upstream: it records every call it receives.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
    },
  ];
}

const MAX_BODY_BYTES = 64 * 1024;

interface RpcPayload {
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: unknown };
}

export function startDemoUpstream(opts: { readOnly?: boolean } = {}): Promise<DemoUpstream> {
  const calls: DemoUpstreamCall[] = [];
  const tools = toolsFor(opts.readOnly === true);
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200);
      res.end();
      return;
    }
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      let payload: RpcPayload;
      try {
        payload = JSON.parse(body) as RpcPayload;
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const reply = (result: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
      };
      switch (payload.method) {
        case "initialize":
          reply(
            {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "conduit-demo-upstream", version: "0" },
            },
            { "mcp-session-id": "conduit-demo" },
          );
          return;
        case "notifications/initialized":
          res.writeHead(202);
          res.end();
          return;
        case "tools/list":
          reply({ tools });
          return;
        case "tools/call":
          calls.push({ name: payload.params?.name ?? "", arguments: payload.params?.arguments });
          reply({ content: [{ type: "text", text: "note created" }] });
          return;
        default:
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              error: { code: -32601, message: "Method not found" },
            }),
          );
      }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `packages/cli`): `pnpm vitest run src/demo/upstream.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/demo/upstream.ts packages/cli/src/demo/upstream.test.ts
git commit -m "feat(cli): add loopback demo upstream with call ledger"
```

---

### Task 2: `runDemo()` — onboard, approve, deny, replay; the evidence gate

`runDemo` composes the production pieces against an in-memory store. It never reads `~/.conduit` or the environment. It runs three acts and then judges the evidence from the upstream's ledger:

1. **Approve:** start a program that calls `tools.demo.create_note({ title: "approved by you" })`. The execution pauses with ZERO upstream calls. Resume with approve. The upstream now holds exactly one call, and its arguments equal the approved input.
2. **Deny:** start the same program with `{ title: "denied by you" }`. It pauses, and the demo resumes with deny. The upstream holds no call with the denied input, and the total count is still 1.
3. **Replay:** resume the approved execution again with the same call id. The manager answers `conflict`, and the total count is still 1.

`ok` is true only if every check holds. Otherwise `failures` names each broken check.

**Files:**
- Modify: `packages/mcp/src/index.ts` (export `provisionSourceRequest` and `type ProvisionInput` from `./daemon/provision.js`)
- Create: `packages/cli/src/demo/run.ts`
- Test: `packages/cli/src/demo/run.test.ts`

**Interfaces:**
- Consumes: `startDemoUpstream`, `DemoUpstream`, `DEMO_NAMESPACE`, `DEMO_TOOL` (Task 1). From `@conduithq/sdk`: `openSqliteStore`, `SecretBox`. From `@conduithq/mcp`: `createApprovalRuntime`, `provisionSourceRequest`.
- Produces:
  ```ts
  export interface DemoEvidence {
    approve: { pausedBeforeRun: boolean; status: string; decisionApplied: boolean; approvedCalls: number; exactInput: boolean };
    deny: { pausedBeforeRun: boolean; status: string; decisionApplied: boolean; deniedCalls: number };
    replay: { status: string; totalCallsAfter: number };
  }
  export interface DemoResult { ok: boolean; evidence: DemoEvidence; failures: string[]; log: string[] }
  export interface DemoDeps { startUpstream?: () => Promise<DemoUpstream> }
  export function runDemo(deps?: DemoDeps): Promise<DemoResult>;   // never throws
  export function judgeEvidence(e: DemoEvidence): string[];         // pure; [] = PASS
  export function times(n: number): string;                         // "1 time" / "N times"
  export const APPROVED_INPUT: { title: string };
  export const DENIED_INPUT: { title: string };
  ```

- [ ] **Step 1: Add the export to `@conduithq/mcp`**

In `packages/mcp/src/index.ts`, next to the `createApprovalRuntime` export line:

```ts
export { type ProvisionInput, provisionSourceRequest } from "./daemon/provision.js";
```

Run (from `packages/mcp`): `pnpm build && npx tsc --noEmit -p .`
Expected: exit 0.

- [ ] **Step 2: Write the failing tests — including two that prove the gate can fail**

```ts
// packages/cli/src/demo/run.test.ts
import { describe, expect, it } from "vitest";
import { APPROVED_INPUT, type DemoEvidence, judgeEvidence, runDemo } from "./run.js";
import { type DemoUpstream, startDemoUpstream } from "./upstream.js";

const GOOD: DemoEvidence = {
  approve: { pausedBeforeRun: true, status: "completed", decisionApplied: true, approvedCalls: 1, exactInput: true },
  deny: { pausedBeforeRun: true, status: "failed", decisionApplied: true, deniedCalls: 0 },
  replay: { status: "conflict", totalCallsAfter: 1 },
};

describe("judgeEvidence — every predicate fails on its own", () => {
  it("good evidence passes", () => {
    expect(judgeEvidence(GOOD)).toEqual([]);
  });

  const cases: [string, DemoEvidence, RegExp][] = [
    ["approve did not pause", { ...GOOD, approve: { ...GOOD.approve, pausedBeforeRun: false } }, /approve execution did not pause/],
    ["approve status not completed", { ...GOOD, approve: { ...GOOD.approve, status: "failed" } }, /approval was not applied \(status failed\)/],
    ["approval not consumed", { ...GOOD, approve: { ...GOOD.approve, decisionApplied: false } }, /approval was not applied/],
    ["approved call ran twice", { ...GOOD, approve: { ...GOOD.approve, approvedCalls: 2 } }, /approved call ran 2 times/],
    ["approved call never ran", { ...GOOD, approve: { ...GOOD.approve, approvedCalls: 0 } }, /approved call ran 0 times/],
    ["wrong input reached upstream", { ...GOOD, approve: { ...GOOD.approve, exactInput: false } }, /exact approved input/],
    ["deny did not pause", { ...GOOD, deny: { ...GOOD.deny, pausedBeforeRun: false } }, /deny execution did not pause/],
    ["denial not consumed", { ...GOOD, deny: { ...GOOD.deny, decisionApplied: false } }, /denial was not applied/],
    ["denied call ran", { ...GOOD, deny: { ...GOOD.deny, deniedCalls: 1 } }, /denied call ran 1 time/],
    ["replay accepted", { ...GOOD, replay: { ...GOOD.replay, status: "completed" } }, /replayed approval returned completed/],
    ["upstream total wrong", { ...GOOD, replay: { ...GOOD.replay, totalCallsAfter: 2 } }, /received 2 times in total/],
  ];
  it.each(cases)("%s → exactly one failure", (_name, evidence, message) => {
    const failures = judgeEvidence(evidence);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(message);
  });
});

/**
 * Wraps the real upstream but lies in its ledger. The demo's verdict must
 * come from the ledger, so a lying ledger must turn the verdict red.
 */
function lyingUpstream(mutate: (calls: DemoUpstream["calls"]) => DemoUpstream["calls"]) {
  return async (): Promise<DemoUpstream> => {
    const real = await startDemoUpstream();
    return {
      url: real.url,
      get calls() {
        return mutate(real.calls);
      },
      close: () => real.close(),
    };
  };
}

describe("runDemo", () => {
  it("approve runs the exact call once; deny runs nothing; replay conflicts", async () => {
    const result = await runDemo();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.evidence.approve).toEqual({
      pausedBeforeRun: true,
      status: "completed",
      decisionApplied: true,
      approvedCalls: 1,
      exactInput: true,
    });
    expect(result.evidence.deny.pausedBeforeRun).toBe(true);
    expect(result.evidence.deny.decisionApplied).toBe(true);
    expect(result.evidence.deny.deniedCalls).toBe(0);
    expect(result.evidence.replay).toEqual({ status: "conflict", totalCallsAfter: 1 });
  }, 60_000);

  it("fails when the upstream saw the approved call twice", async () => {
    const result = await runDemo({
      startUpstream: lyingUpstream((calls) => [...calls, ...calls.filter((c) => (c.arguments as { title?: string })?.title === APPROVED_INPUT.title)]),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/approved call ran 2 times/);
  }, 60_000);

  it("fails when the upstream saw a denied call", async () => {
    const result = await runDemo({
      startUpstream: lyingUpstream((calls) => [
        ...calls,
        { name: "create_note", arguments: { title: "denied by you" } },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/denied call ran 1 time/);
  }, 60_000);

  it("fails when the real policy auto-allows the tool (no pause)", async () => {
    const result = await runDemo({ startUpstream: () => startDemoUpstream({ readOnly: true }) });
    expect(result.ok).toBe(false);
    expect(result.evidence.approve.pausedBeforeRun).toBe(false);
    expect(result.failures.join("\n")).toMatch(/did not pause/);
  }, 60_000);

  it("reports a run that cannot start as a failure and keeps the log", async () => {
    const result = await runDemo({
      startUpstream: async () => {
        const real = await startDemoUpstream();
        await real.close();
        // The url now points at a closed port: onboarding cannot reach it.
        return { url: real.url, calls: [], close: async () => {} };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/^the demo could not run: /);
  }, 60_000);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `packages/cli`): `pnpm vitest run src/demo/run.test.ts`
Expected: FAIL — `Cannot find module './run.js'`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/cli/src/demo/run.ts
import { createApprovalRuntime, provisionSourceRequest } from "@conduithq/mcp";
import { openSqliteStore, SecretBox } from "@conduithq/sdk";
import { createClient } from "@libsql/client";
import { DEMO_NAMESPACE, DEMO_TOOL, type DemoUpstream, startDemoUpstream } from "./upstream.js";

export const APPROVED_INPUT = { title: "approved by you" };
export const DENIED_INPUT = { title: "denied by you" };

export interface DemoEvidence {
  approve: {
    pausedBeforeRun: boolean;
    status: string;
    decisionApplied: boolean;
    approvedCalls: number;
    exactInput: boolean;
  };
  deny: { pausedBeforeRun: boolean; status: string; decisionApplied: boolean; deniedCalls: number };
  replay: { status: string; totalCallsAfter: number };
}

export interface DemoResult {
  ok: boolean;
  evidence: DemoEvidence;
  failures: string[];
  /** Runtime log lines, kept out of stdout; the command prints them only on failure. */
  log: string[];
}

export interface DemoDeps {
  startUpstream?: () => Promise<DemoUpstream>;
}

function program(input: { title: string }): string {
  return `return await tools.${DEMO_NAMESPACE}.${DEMO_TOOL}(${JSON.stringify(input)});`;
}

function countWithTitle(calls: DemoUpstream["calls"], title: string): number {
  return calls.filter(
    (c) => c.name === DEMO_TOOL && (c.arguments as { title?: unknown } | undefined)?.title === title,
  ).length;
}

export function times(n: number): string {
  return n === 1 ? "1 time" : `${n} times`;
}

/**
 * The demo's verdict, as a pure function of the evidence, so each of the
 * nine predicates can be proven to fail on its own (run.test.ts). Returns
 * one message per broken predicate; an empty list is a PASS.
 */
export function judgeEvidence(e: DemoEvidence): string[] {
  const failures: string[] = [];
  if (!e.approve.pausedBeforeRun) {
    failures.push("the approve execution did not pause before the upstream call");
  }
  if (e.approve.status !== "completed" || !e.approve.decisionApplied) {
    failures.push(`the approval was not applied (status ${e.approve.status})`);
  }
  if (e.approve.approvedCalls !== 1) {
    failures.push(`the approved call ran ${times(e.approve.approvedCalls)}, expected 1 time`);
  }
  if (!e.approve.exactInput) {
    failures.push("the upstream did not receive the exact approved input");
  }
  if (!e.deny.pausedBeforeRun) {
    failures.push("the deny execution did not pause before the upstream call");
  }
  if (!e.deny.decisionApplied) {
    failures.push(`the denial was not applied (status ${e.deny.status})`);
  }
  if (e.deny.deniedCalls !== 0) {
    failures.push(`the denied call ran ${times(e.deny.deniedCalls)}, expected 0 times`);
  }
  if (e.replay.status !== "conflict") {
    failures.push(`a replayed approval returned ${e.replay.status}, expected conflict`);
  }
  if (e.replay.totalCallsAfter !== 1) {
    failures.push(`the upstream received ${times(e.replay.totalCallsAfter)} in total, expected 1 time`);
  }
  return failures;
}

const NOT_RUN: DemoEvidence = {
  approve: { pausedBeforeRun: false, status: "not-run", decisionApplied: false, approvedCalls: 0, exactInput: false },
  deny: { pausedBeforeRun: false, status: "not-run", decisionApplied: false, deniedCalls: 0 },
  replay: { status: "not-run", totalCallsAfter: 0 },
};

/**
 * Never throws: a run that cannot start (the loopback bind fails, onboarding
 * is refused, the store cannot open) is a FAIL with the reason and the
 * captured log, so the operator sees what the runtime said.
 */
export async function runDemo(deps: DemoDeps = {}): Promise<DemoResult> {
  const log: string[] = [];
  try {
    return await drive(deps, log);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, evidence: NOT_RUN, failures: [`the demo could not run: ${reason}`], log };
  }
}

async function drive(deps: DemoDeps, log: string[]): Promise<DemoResult> {
  const sink = (line: string): void => {
    log.push(line);
  };
  const upstream = await (deps.startUpstream ?? startDemoUpstream)();
  // Cleanup is armed before anything else can throw, so a failure can never
  // leave the loopback server open and hang the process.
  let client: ReturnType<typeof createClient> | undefined;
  try {
    client = createClient({ url: ":memory:" });
    const store = await openSqliteStore({
      client,
      secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
      log: sink,
    });
    await provisionSourceRequest(
      {
        namespace: DEMO_NAMESPACE,
        url: upstream.url,
        prefix: "demo.local",
        replace: false,
        clearCredential: false,
      },
      { store, log: sink },
    );
    // Private egress is granted HERE, in code, to this process only, for the
    // loopback server this process just started. The adopter's daemon and
    // the CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS env var are never touched.
    const { manager } = await createApprovalRuntime({ store, allowPrivateEgress: true, log: sink });

    // Act 1: approve.
    const a = await manager.start(program(APPROVED_INPUT));
    const aPausedBeforeRun = a.status === "paused" && upstream.calls.length === 0;
    const aResumed =
      a.status === "paused"
        ? await manager.resume(a.executionId, { kind: "approve" }, a.pending.callId)
        : undefined;
    const approvedCalls = countWithTitle(upstream.calls, APPROVED_INPUT.title);
    const exactInput =
      upstream.calls.length > 0 &&
      JSON.stringify(upstream.calls[0]?.arguments) === JSON.stringify(APPROVED_INPUT);

    // Act 2: deny.
    const callsBeforeDeny = upstream.calls.length;
    const d = await manager.start(program(DENIED_INPUT));
    const dPausedBeforeRun = d.status === "paused" && upstream.calls.length === callsBeforeDeny;
    const dResumed =
      d.status === "paused"
        ? await manager.resume(d.executionId, { kind: "deny" }, d.pending.callId)
        : undefined;
    const deniedCalls = countWithTitle(upstream.calls, DENIED_INPUT.title);

    // Act 3: replay the approval of the call that already ran.
    const replay =
      a.status === "paused"
        ? await manager.resume(a.executionId, { kind: "approve" }, a.pending.callId)
        : undefined;
    const totalCallsAfter = upstream.calls.length;

    const evidence: DemoEvidence = {
      approve: {
        pausedBeforeRun: aPausedBeforeRun,
        status: aResumed?.status ?? a.status,
        decisionApplied: aResumed?.decisionApplied ?? false,
        approvedCalls,
        exactInput,
      },
      deny: {
        pausedBeforeRun: dPausedBeforeRun,
        status: dResumed?.status ?? d.status,
        decisionApplied: dResumed?.decisionApplied ?? false,
        deniedCalls,
      },
      replay: { status: replay?.status ?? "not-run", totalCallsAfter },
    };

    const failures = judgeEvidence(evidence);
    return { ok: failures.length === 0, evidence, failures, log };
  } finally {
    client?.close();
    await upstream.close();
  }
}
```

Note for the implementer: the failure messages in the tests match on "approved call ran 2 times" and "denied call ran 1 time". Keep those phrases. `openSqliteStore` already accepts `log` (`packages/sdk/src/store/sqlite.ts:230`).

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `packages/cli`): `pnpm vitest run src/demo/run.test.ts`
Expected: PASS, 17 tests (12 `judgeEvidence` + 5 `runDemo`). If the first `runDemo` test fails with `approve.pausedBeforeRun: false` and `approvedCalls: 1`, the default policy auto-allowed `review`. Stop and report; do NOT add a policy override to the demo, because the demo must show the default.

- [ ] **Step 6: Typecheck both packages**

Run: `npx tsc --noEmit -p packages/mcp && npx tsc --noEmit -p packages/cli`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/index.ts packages/cli/src/demo/run.ts packages/cli/src/demo/run.test.ts
git commit -m "feat(cli): run the approve/deny demo against the real runtime"
```

---

### Task 3: `conduit demo` command

Wire `runDemo` into the CLI. `conduit demo` takes no arguments except `--help`/`-h`. It prints three evidence lines and a verdict, and exits 0 on a pass and 1 on a fail. On a fail it also prints the failures and the captured runtime log to stderr.

**Why no "HOME stays empty" test here:** the product's state dir is `join(userInfo().homedir, ".conduit")` (`packages/mcp/src/env.ts:46`), the passwd home, not `$HOME`. A test that sets `HOME` to a temp dir would stay green even if the demo wrote to the developer's real `~/.conduit`. The "demo never creates `~/.conduit`" check runs in Task 5, on a disposable CI runner.

**Files:**
- Create: `packages/cli/src/commands/demo.ts`
- Test: `packages/cli/src/commands/demo.test.ts`
- Modify: `packages/cli/src/dispatch.ts` (COMMANDS, HELP, `demo --help` interception)
- Modify: `packages/cli/src/dispatch.test.ts:92-93` (COMMANDS now has six entries)
- Modify: `packages/cli/src/bin.ts` (`case "demo"`)
- Modify: `packages/cli/src/integration.test.ts` (one spawned-bin test)

**Interfaces:**
- Consumes: `runDemo`, `DemoResult` (Task 2).
- Produces:
  - `DEMO_USAGE: string`
  - `renderDemo(result: DemoResult): { stdout: string; stderr: string; exitCode: 0 | 1 }`
  - `demo(argv: string[], opts?: { run?: () => Promise<DemoResult> }): Promise<number>`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/commands/demo.test.ts
import { describe, expect, it, vi } from "vitest";
import type { DemoResult } from "../demo/run.js";
import { demo, NEXT_STEP, renderDemo } from "./demo.js";

const PASS: DemoResult = {
  ok: true,
  failures: [],
  log: ["[runtime] noise"],
  evidence: {
    approve: { pausedBeforeRun: true, status: "completed", decisionApplied: true, approvedCalls: 1, exactInput: true },
    deny: { pausedBeforeRun: true, status: "failed", decisionApplied: true, deniedCalls: 0 },
    replay: { status: "conflict", totalCallsAfter: 1 },
  },
};

const FAIL: DemoResult = {
  ...PASS,
  ok: false,
  failures: ["the approved call ran 2 times, expected 1 time"],
  evidence: { ...PASS.evidence, approve: { ...PASS.evidence.approve, approvedCalls: 2 } },
};

describe("conduit demo rendering", () => {
  it("a pass prints the three evidence lines, keeps the log off stdout, exits 0", () => {
    const out = renderDemo(PASS);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("approve: paused before it ran; after approval the upstream received it 1 time, with the exact input");
    expect(out.stdout).toContain("deny:    paused before it ran; after denial the upstream received it 0 times");
    expect(out.stdout).toContain("replay:  approving the same call again was refused (conflict); upstream total is still 1");
    expect(out.stdout).toContain(`PASS\n${NEXT_STEP}\n`);
    expect(out.stdout).not.toContain("[runtime] noise");
    expect(out.stderr).toBe("");
  });

  it("a fail never prints the next step", () => {
    expect(renderDemo(FAIL).stdout).not.toContain(NEXT_STEP);
  });

  it("the header is written BEFORE the run resolves (no silent wait)", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    let release!: (r: DemoResult) => void;
    const pending = demo([], { run: () => new Promise<DemoResult>((r) => { release = r; }) });
    await Promise.resolve();
    expect(writes.join("")).toContain("conduit demo — the approval gate");
    expect(writes.join("")).not.toContain("PASS");
    release(PASS);
    await pending;
    spy.mockRestore();
    expect(writes.join("")).toContain("PASS");
  });

  it("a fail prints the failures and the runtime log to stderr, exits 1", () => {
    const out = renderDemo(FAIL);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("FAIL");
    expect(out.stderr).toContain("the approved call ran 2 times, expected 1 time");
    expect(out.stderr).toContain("[runtime] noise");
  });

  it("a run that never paused says so on the evidence line", () => {
    const out = renderDemo({
      ...FAIL,
      evidence: { ...PASS.evidence, approve: { ...PASS.evidence.approve, pausedBeforeRun: false } },
    });
    expect(out.stdout).toContain("approve: DID NOT PAUSE;");
    expect(out.exitCode).toBe(1);
  });

  it("refuses unexpected arguments with exit 1 and never runs the demo", async () => {
    let ran = false;
    const code = await demo(["--state-dir", "/x"], {
      run: async () => {
        ran = true;
        return PASS;
      },
    });
    expect(code).toBe(1);
    expect(ran).toBe(false);
  });
});
```

In `packages/cli/src/dispatch.test.ts`, change the COMMANDS test to:

```ts
  it("COMMANDS contains exactly the six routed commands", () => {
    expect(COMMANDS).toEqual(["serve", "add-mcp", "approvals", "key", "daemon", "demo"]);
  });

  it("demo --help prints the demo usage and does not route", () => {
    const result = dispatch(["demo", "--help"]);
    expect(result.kind).toBe("help");
  });

  it("top-level help leads with the demo for a new user", () => {
    const result = dispatch(["--help"]);
    expect(result.kind).toBe("help");
    const lines = (result as { stdout: string }).stdout.split("\n");
    const usage = lines.findIndex((l) => l.startsWith("Usage: conduit <command>"));
    expect(usage).toBeGreaterThan(-1);
    expect(lines.slice(usage + 1, usage + 3).join("\n")).toContain('New here? Run "conduit demo"');
  });
```

In `packages/cli/src/integration.test.ts`, add at the end of the file (it uses the file's existing `cliBinPath` and `execFileAsync`):

```ts
describe("ring-2: conduit demo (spawned CLI bin)", () => {
  it("passes with a minimal environment and prints the verdict", async () => {
    const { stdout } = await execFileAsync(process.execPath, [cliBinPath, "demo"], {
      env: { PATH: process.env.PATH ?? "" },
      timeout: 60_000,
    });
    expect(stdout.startsWith("conduit demo — the approval gate")).toBe(true);
    expect(stdout).toContain("approve: paused before it ran");
    expect(stdout).toMatch(/\nPASS\nNext: /);
  }, 90_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `packages/cli`): `pnpm vitest run src/commands/demo.test.ts src/dispatch.test.ts`
Expected: FAIL — `Cannot find module './demo.js'`, and the COMMANDS assertion fails.

- [ ] **Step 3: Write the version home, then the command**

```ts
// packages/cli/src/version.ts — NO imports: the Task 4 Node guard loads it
// before anything else. The one home of the CLI version.
export const VERSION = "0.1.1";

/** The install notes at THIS build's tag: an adopter has the tarball, not the repo. */
export const INSTALL_NOTES_URL = `https://github.com/nischal94/conduit-HQ/blob/v${VERSION}/docs/alpha/INSTALL.md`;
```

In `packages/cli/src/dispatch.ts`, replace `export const VERSION = "0.1.1";` with:

```ts
import { VERSION } from "./version.js";
export { VERSION };
```

```ts
// packages/cli/src/commands/demo.ts
import { type DemoResult, runDemo, times } from "../demo/run.js";
import { INSTALL_NOTES_URL } from "../version.js";

export const DEMO_USAGE = `Usage: conduit demo

Shows Conduit's approval gate end to end, in memory, with no external
network (loopback only) and no setup. A local demo upstream exposes one tool that needs approval. The demo
approves one call and denies another, then reports what the upstream
actually received. It never opens or creates anything in ~/.conduit.

Exit code: 0 when every check passes, 1 otherwise.`;

/** Printed BEFORE the run, so the few seconds of QuickJS boot are visibly working. */
export const DEMO_HEADER = "conduit demo — the approval gate, end to end (in memory). Running…";

/** Printed after PASS: the adopter's next command, at the moment they need it. */
export const NEXT_STEP = `Next: follow step 4 of ${INSTALL_NOTES_URL} to govern your own agent's calls.`;

export function renderDemo(result: DemoResult): {
  stdout: string;
  stderr: string;
  exitCode: 0 | 1;
} {
  const { approve, deny, replay } = result.evidence;
  const lines = [
    `approve: ${approve.pausedBeforeRun ? "paused before it ran" : "DID NOT PAUSE"}; after approval the upstream received it ${times(approve.approvedCalls)}${approve.exactInput ? ", with the exact input" : ", NOT with the exact input"}`,
    `deny:    ${deny.pausedBeforeRun ? "paused before it ran" : "DID NOT PAUSE"}; after denial the upstream received it ${times(deny.deniedCalls)}`,
    `replay:  approving the same call again was ${replay.status === "conflict" ? "refused (conflict)" : `answered ${replay.status}`}; upstream total is still ${replay.totalCallsAfter}`,
    "",
    result.ok ? "PASS" : "FAIL",
    ...(result.ok ? [NEXT_STEP] : []),
  ];
  const stderr = result.ok
    ? ""
    : [
        "[conduit demo] Checks failed:",
        ...result.failures.map((f) => `  - ${f}`),
        "Runtime log:",
        ...result.log.map((l) => `  ${l}`),
        "",
      ].join("\n");
  return { stdout: `${lines.join("\n")}\n`, stderr, exitCode: result.ok ? 0 : 1 };
}

export async function demo(
  argv: string[],
  opts: { run?: () => Promise<DemoResult> } = {},
): Promise<number> {
  if (argv.length > 0) {
    process.stderr.write(`[conduit demo] Unexpected arguments: ${argv.join(" ")}\n\n${DEMO_USAGE}\n`);
    return 1;
  }
  process.stdout.write(`${DEMO_HEADER}\n\n`);
  const out = renderDemo(await (opts.run ?? runDemo)());
  process.stdout.write(out.stdout);
  if (out.stderr !== "") {
    process.stderr.write(out.stderr);
  }
  return out.exitCode;
}
```

- [ ] **Step 4: Wire dispatch and bin**

In `packages/cli/src/dispatch.ts`:

```ts
import { DEMO_USAGE } from "./commands/demo.js";
// ...
export const COMMANDS = ["serve", "add-mcp", "approvals", "key", "daemon", "demo"] as const;
```

In `HELP`, after the `daemon` line:

```
  demo       Show the approval gate end to end, in memory (no setup needed)
```

and directly under the `Usage:` line, so a new user sees it first (DX review, Pass 2):

```
New here? Run "conduit demo" to see approvals work in a few seconds.
```

In `dispatch()`, beside the `key` help interception (demo has no value-taking flags either):

```ts
    if (first === "demo" && rest.some((token) => token === "--help" || token === "-h")) {
      return { kind: "help", stdout: `${DEMO_USAGE}\n` };
    }
```

In `packages/cli/src/bin.ts`, import `demo` from `./commands/demo.js` and add before `default:`:

```ts
    case "demo":
      // No --state-dir on purpose: the demo never selects a daemon or a database.
      return demo(args);
```

- [ ] **Step 5: Run the unit tests, then build and run the spawned-bin test**

Run (from `packages/cli`): `pnpm vitest run src/commands/demo.test.ts src/dispatch.test.ts`
Expected: PASS.

Run (from the repo root): `pnpm -r build`, then (from `packages/cli`): `pnpm vitest run src/integration.test.ts -t "conduit demo"`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit -p packages/cli`
Expected: exit 0.

```bash
git add packages/cli/src/version.ts packages/cli/src/commands/demo.ts packages/cli/src/commands/demo.test.ts packages/cli/src/dispatch.ts packages/cli/src/dispatch.test.ts packages/cli/src/bin.ts packages/cli/src/integration.test.ts
git commit -m "feat(cli): add conduit demo command"
```

---

### Task 3B: The pause names the approve command; `approvals list` prints ready-to-run lines (DX review D3, D7)

The DX review's roleplay found two stalls on the adopter's first governed call. When the agent pauses, it says "a human must approve" but never names the command. And `approve` needs two ids copied from a wide table, so the adopter pastes the wrong column and gets `conflict`.

**Files:**
- Modify: `packages/mcp/src/payloads.ts:306-309` (`PAUSE_MESSAGE`)
- Modify: `packages/mcp/src/payloads.test.ts:53-75` (one assertion)
- Modify: `packages/cli/src/commands/approvals.ts` (`runList` args + `renderTable`), and the `approvals()` call site that invokes `runList`
- Modify: `packages/cli/src/approvals.test.ts` (one new test)
- Modify: `packages/mcp/src/daemon/provision.ts:385-396, 765` (`mapFetchError` learns whether a credential was supplied — DX review D8)
- Modify: `packages/mcp/src/daemon/provision.test.ts` (two new error-mapping cases)

**Interfaces:**
- Consumes: nothing from Tasks 1–3.
- Produces: `runList(args: { json: boolean; stateDir?: string }, deps)`. The table output gains a trailing "decide" block; the `--json` output is unchanged.

- [ ] **Step 1: Write the failing tests**

In `packages/mcp/src/payloads.test.ts`, inside the test at line 53 ("paused message tells the agent to report to the human and STOP"), add:

```ts
    expect(p.message).toContain("conduit approvals list");
```

In `packages/cli/src/approvals.test.ts`, beside the list test at line 262 (reusing its `seedPaused` and `makeDeps`):

```ts
  it("list ends with deny-then-approve lines per decidable row, fully quoted, with an absolute --state-dir", async () => {
    const store = await seedPaused();
    const deps = makeDeps({ store, now: () => 10_000 });

    await runList({ json: false }, deps);
    const plain = deps.stdoutLines.join("");
    expect(plain).toContain("  To deny:    conduit approvals deny 'exec_new' 'c2'");
    expect(plain).toContain("  To approve: conduit approvals approve 'exec_new' 'c2'");
    expect(plain.indexOf("To deny:    conduit approvals deny 'exec_new'")).toBeLessThan(
      plain.indexOf("To approve: conduit approvals approve 'exec_new'"),
    );
    expect(plain).toContain("Call 'c2' (github.create_issue):");

    const withDir = makeDeps({ store, now: () => 10_000 });
    await runList({ json: false, stateDir: "rel dir/it's" }, withDir);
    expect(withDir.stdoutLines.join("")).toContain(
      `conduit approvals approve 'exec_new' 'c2' --state-dir '${resolve("rel dir/it's").replace(/'/g, `'\\''`)}'`,
    );
  });

  it("shellQuote survives spaces, quotes, newlines, and ESC; an unsafe tool name never reaches a line", () => {
    for (const hostile of ["a b", "it's", "x\ny; rm -rf ~", "\u001b[2Jclear"]) {
      const quoted = shellQuote(hostile);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      expect(quoted.slice(1, -1).replace(/'\\''/g, "")).not.toContain("'");
    }
  });

  it("an upstream tool name carrying a newline or ESC never appears in the decide block", async () => {
    const store = await seedPaused();
    await store.executions.put({
      ...(await store.executions.get("exec_new"))!,
      id: "exec_evil",
      pausedOn: {
        callId: "c9",
        toolName: "gh.x\n$(touch /tmp/pwned)\u001b[2J",
        input: {},
        reason: "requires approval",
        expiresAt: 999_999_999_999,
      },
    });
    const deps = makeDeps({ store, now: () => 10_000 });
    await runList({ json: false }, deps);
    const out = deps.stdoutLines.join("");
    const decideBlock = out.slice(out.indexOf("\nCall "));
    expect(decideBlock).toContain("Call 'c9':");
    expect(decideBlock).not.toContain("touch /tmp/pwned");
    expect(decideBlock).not.toContain("\u001b");
  });

  it("a call id or execution id outside the safe set gets no copyable line", async () => {
    const store = await seedPaused();
    await store.executions.put({
      ...(await store.executions.get("exec_new"))!,
      id: "exec_ok",
      pausedOn: {
        callId: "c\n\u001b]52;c;cm0gLXJmIH4=\u0007",
        toolName: "gh.x",
        input: {},
        reason: "requires approval",
        expiresAt: 999_999_999_999,
      },
    });
    const deps = makeDeps({ store, now: () => 10_000 });
    await runList({ json: false }, deps);
    const out = deps.stdoutLines.join("");
    expect(out).toContain("not printing copyable lines for it");
    expect(out).not.toContain("approve 'exec_ok'");
    expect(out.slice(out.indexOf("A paused call has ids"))).not.toContain("\u001b");
  });

  it("list --json is unchanged by the decide block", async () => {
    const store = await seedPaused();
    const deps = makeDeps({ store, now: () => 10_000 });
    await runList({ json: true }, deps);
    expect(deps.stdoutLines.join("")).not.toContain("To decide");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/mcp`): `pnpm vitest run src/payloads.test.ts -t "paused message"` — Expected: FAIL on `conduit approvals list`.
Run (from `packages/cli`): `pnpm vitest run src/approvals.test.ts -t "deny-then-approve|shellQuote|newline or ESC"` — Expected: FAIL (the block and `shellQuote` do not exist yet). The test file imports `resolve` from `node:path` and `shellQuote` from `./commands/approvals.js`.

Note: the existing TABLE row still prints `row.tool` raw, as it does today. Sanitizing terminal control bytes in the table is pre-existing behavior outside this task; it is recorded in HANDOFF DEFERRED, and only the new decide block is hardened here.

- [ ] **Step 3: Implement**

`packages/mcp/src/payloads.ts`:

```ts
const PAUSE_MESSAGE =
  "A human must approve this call out-of-band. Report the pending approval and this " +
  "executionId to the user, and tell them to run `conduit approvals list` in a terminal " +
  "to approve or deny it. Then STOP — do not poll in a loop; approval may take hours. " +
  "When the user says it is decided, call check_execution with this executionId (or your requestKey).";
```

`packages/cli/src/commands/approvals.ts`: add `stateDir?: string` to `runList`'s `args`, pass it into `renderTable(rows, now, args.stateDir)`, and pass the command's `stateDir` option through from the `approvals()` call site that invokes `runList`. In `renderTable`, after the table:

```ts
import { resolve } from "node:path";

/** POSIX single-quote: safe for ANY string, including newlines and control bytes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Upstream-controlled; shown only when it cannot carry shell or terminal syntax. */
const SAFE_LABEL = /^[A-Za-z0-9._-]{1,128}$/;
/** Conduit-generated ids; a copyable line is printed only when both match. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// …inside renderTable, replacing the final return:
  // Absolute, so a copied line targets the same database from any directory.
  const dirFlag = stateDir !== undefined ? ` --state-dir ${shellQuote(resolve(stateDir))}` : "";
  // A row from an older daemon carries no call id ("-") and cannot be decided by id.
  const decidable = rows.filter((row) => row.callId !== "-");
  const decide = decidable.flatMap((row) => {
    // Quoting stops the shell, not the terminal: an id with a newline or ESC
    // would still corrupt the screen or a copy. Ids are Conduit-generated,
    // so anything outside the safe set means something is wrong: say so.
    if (!SAFE_ID.test(row.executionId) || !SAFE_ID.test(row.callId)) {
      return ["", "A paused call has ids with unexpected characters; not printing copyable lines for it. Use `conduit approvals list --json`."];
    }
    const ids = `${shellQuote(row.executionId)} ${shellQuote(row.callId)}${dirFlag}`;
    const label = SAFE_LABEL.test(row.tool) ? ` (${row.tool})` : "";
    // Deny first, neutral wording: approving must be a choice, not the default.
    return [
      "",
      `Call ${shellQuote(row.callId)}${label}:`,
      `  To deny:    conduit approvals deny ${ids}`,
      `  To approve: conduit approvals approve ${ids}`,
    ];
  });
  return `${[header, ...lines, ...decide].join("\n")}\n`;
```

Every argument is quoted unconditionally, so the check does not depend on how ids are generated. The tool name is upstream-controlled: it is never placed on a command line, and it appears in the label only when it matches `SAFE_LABEL`.

- [ ] **Step 4: Run the tests, then the two full suites**

Run (from `packages/mcp`): `pnpm vitest run src/payloads.test.ts` — Expected: PASS.
Run (from `packages/cli`): `pnpm vitest run src/approvals.test.ts` — Expected: PASS, including the existing `INVARIANT /cli approvals` list test (its header regex is unaffected).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit -p packages/mcp && npx tsc --noEmit -p packages/cli` — Expected: exit 0.

```bash
git add packages/mcp/src/payloads.ts packages/mcp/src/payloads.test.ts packages/cli/src/commands/approvals.ts packages/cli/src/approvals.test.ts
git commit -m "feat(cli): name the approve command where users need it"
```

- [ ] **Step 6: add-mcp's 401/403 advice matches whether a credential was sent (DX review D8)**

Today `mapFetchError` (`provision.ts:393-395`) answers every 401/403 with "set CONDUIT_ADD_SECRET", including when the adopter DID set it (a wrong, expired, or under-scoped token). Add to the `errorCases` table in `provision.test.ts` (around line 712), with the existing `run` helper's `env` option:

```ts
  const suppliedCases: { status: 401 | 403 }[] = [{ status: 401 }, { status: 403 }];
  for (const { status } of suppliedCases) {
    it(`error mapping: http_status ${status} WITH a credential supplied → check-the-token guidance, 0 writes`, async () => {
      const store = await openTestStore();
      const result = await run(
        {},
        {
          store,
          env: { CONDUIT_ADD_SECRET: "Bearer wrong-scope" },
          fetchTools: vi.fn(async () => {
            throw new McpClientError("http_status", `MCP endpoint returned HTTP ${status}`, { status });
          }),
        },
      );
      expect(result.exitCode).toBe(1);
      const stderr = result.stderrLines.join("");
      expect(stderr).toContain(
        `[conduit add-mcp] the upstream rejected the credential you supplied (HTTP ${status}): check the token's permissions for this upstream and that it has not expired; nothing was written.`,
      );
      expect(stderr).not.toContain("wrong-scope");
      expect(stderr).not.toContain("set CONDUIT_ADD_SECRET");
    });
  }
```

Run (from `packages/mcp`): `pnpm vitest run src/daemon/provision.test.ts -t "WITH a credential"` — Expected: FAIL (old message).

Implement: give `mapFetchError` a third parameter `secretSupplied: boolean`; in the 401/403 arm return the new line when it is true and the existing line when false. At the call site (`provision.ts:765`) pass `(input.secret ?? "").trim() !== ""`, so a blank or whitespace-only value counts as "not supplied". Before writing that line, read how `provisionSourceRequest` builds the `authorization` it hands to `fetchTools`, and branch on that SAME normalized value if it differs. The two existing 401/403 cases (no credential) stay as they are and must still pass: they pin the other branch. Add one more case, `env: { CONDUIT_ADD_SECRET: "   " }` with a 403, expecting the existing "set CONDUIT_ADD_SECRET" line.

Run: `pnpm vitest run src/daemon/provision.test.ts` — Expected: PASS, all error-mapping cases. Then `npx tsc --noEmit -p packages/mcp`.

```bash
git add packages/mcp/src/daemon/provision.ts packages/mcp/src/daemon/provision.test.ts
git commit -m "fix(mcp): give token advice when a supplied token is refused"
```

---

### Task 4: One-tarball build, entry rename, version bump

Make `packages/cli` build into a self-contained package: `@conduithq/sdk` and `@conduithq/mcp` are inlined, and third-party packages are declared as the CLI's own dependencies. Emit the CLI as `dist/conduit.js` and mcp's daemon entry as `dist/bin.js` (D-R6). Bump every version to `0.2.0-alpha.0` (D-R3).

**Files:**
- Modify: `packages/cli/tsup.config.ts`
- Modify: `package.json` (root; engines only), `packages/cli/package.json`, `packages/mcp/package.json`, `packages/sdk/package.json`
- Modify: `packages/cli/src/dispatch.ts` (`VERSION`), `packages/mcp/src/env.ts:27` (`AGENT_VERSION`), and every test that asserts `0.1.1` (find them with `/usr/bin/grep -rn '0\.1\.1' packages/*/src`)
- Modify: `packages/cli/src/integration.test.ts:159` (`cliBinPath`)
- Modify: `README.md:60,88,98`, `packages/cli/README.md:26,90`, `packages/mcp/README.md:44,92,93` (`packages/cli/dist/bin.js` → `packages/cli/dist/conduit.js`)
- Create: `packages/cli/src/package-layout.test.ts`
- Create: `packages/cli/src/entry.ts`, `packages/cli/src/node-support.ts`, `packages/cli/src/node-support.test.ts` (Node-version guard, DX review D5)
- Rename: `packages/cli/src/bin.ts` → `packages/cli/src/cli.ts`, hashbang line removed (PR #63 review: `bin` must name one file only)
- Founder-run: `pnpm install` (updates `pnpm-lock.yaml` importers; the agent does not run it)

**Interfaces:**
- Consumes: the built `packages/mcp/dist/bin.js` (mcp builds before cli; `pnpm -r build` orders by the workspace graph, and cli keeps mcp as a devDependency so the order holds).
- Produces: `packages/cli/dist/conduit.js` (bin `conduit`), `packages/cli/dist/bin.js` (bin `conduit-mcp`, the daemon entry), `dist/index.js` + `dist/index.d.ts` with no `@conduithq/` import left.

- [ ] **Step 1: Write the failing layout test**

```ts
// packages/cli/src/package-layout.test.ts
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "./dispatch.js";

/**
 * Pins the D-R6 layout the daemon auto-start depends on: `daemonEntryPoint()`
 * resolves "./bin.js" beside the running code, so in this package's dist
 * `bin.js` MUST be mcp's daemon entry and the dispatcher MUST live elsewhere.
 * Requires a fresh `pnpm -r build`.
 */
const dist = join(process.cwd(), "dist");

describe("packed CLI layout", () => {
  it("dist/bin.js is the daemon entry, not the dispatcher", () => {
    const bin = readFileSync(join(dist, "bin.js"), "utf8");
    expect(bin.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(bin).toContain('"--daemon"');
    expect(bin).not.toContain("Usage: conduit <command>");
  });

  it("dist/conduit.js is the Node-version guard in front of the dispatcher", () => {
    const conduit = readFileSync(join(dist, "conduit.js"), "utf8");
    expect(conduit.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(conduit).toContain("is not supported");
    // It must never reach the daemon entry at runtime.
    expect(conduit).not.toMatch(/import\(\s*["']\.\/bin\.js["']\s*\)/);
  });

  it("running dist/conduit.js reaches the DISPATCHER, not mcp's entry", () => {
    // --help, not --version: mcp's entry also answers --version with the
    // same string, so a version check passes when the wrong module loads.
    const out = execFileSync(process.execPath, [join(dist, "conduit.js"), "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(out).toContain("Usage: conduit <command>");
  });

  it("no emitted file imports a workspace package", () => {
    const offenders = (readdirSync(dist, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))
      // Every specifier form: `from "..."` (import and re-export), bare
      // side-effect `import "..."`, dynamic `import("...")`, and `require("...")`.
      .filter((f) =>
        /(?:\bfrom|\bimport|\bimport\(|\brequire\()\s*["']@conduithq\//.test(readFileSync(join(dist, f), "utf8")),
      );
    expect(offenders).toEqual([]);
  });

  it("manifest bins, version, and dependencies match the packed layout", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.version).toBe(VERSION);
    expect(pkg.bin).toEqual({ conduit: "./dist/conduit.js", "conduit-mcp": "./dist/bin.js" });
    expect(Object.keys(pkg.dependencies).filter((d) => d.startsWith("@conduithq/"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Build and run it to verify it fails**

Run (repo root): `pnpm -r build`, then (from `packages/cli`): `pnpm vitest run src/package-layout.test.ts`
Expected: FAIL — `dist/conduit.js` does not exist, `dist/bin.js` is the dispatcher, and `dist/*.js` imports `@conduithq/mcp`.

- [ ] **Step 3: Change the CLI build**

```ts
// packages/cli/tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // The Node-version guard (DX review D5). It statically imports only the
    // dependency-free src/node-support.ts, checks the version, and only then
    // dynamic-imports ./bin.js, so an unsupported Node gets one clear line
    // instead of a failure inside some dependency.
    conduit: "src/entry.ts",
    // mcp's daemon entry, emitted as dist/bin.js: daemonEntryPoint()
    // resolves "./bin.js" beside the running code, so an auto-started
    // daemon runs this file. Built from mcp's dist so both entries share
    // one copy of mcp's chunks.
    bin: "../mcp/dist/bin.js",
  },
  format: "esm",
  // The CLI's index exports only dispatch symbols, so its types reference
  // no workspace package and need no cross-package type bundling.
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  noExternal: [/^@conduithq\//],
});
```

- [ ] **Step 3b: Write the Node-version guard (TDD)**

```ts
// packages/cli/src/node-support.test.ts
import { describe, expect, it } from "vitest";
import { isSupportedNode, UNSUPPORTED_NODE_LINE } from "./node-support.js";
import { INSTALL_NOTES_URL } from "./version.js";

describe("isSupportedNode — mirrors engines `>=22.12.0 <23 || >=24 <25`", () => {
  it.each([
    ["22.12.0", true], ["22.20.0", true], ["24.0.0", true], ["24.9.1", true],
    ["22.11.9", false], ["20.19.0", false], ["23.5.0", false], ["25.0.0", false], ["not-a-version", false],
  ])("%s → %s", (version, expected) => {
    expect(isSupportedNode(version)).toBe(expected);
  });

  it("the refusal names the running version, the fix, and the versioned notes", () => {
    expect(UNSUPPORTED_NODE_LINE("20.11.0")).toBe(
      `[conduit] Node 20.11.0 is not supported: this preview runs on Node 22 (22.12.0 or later) or Node 24. Switch to a supported Node, then install the tarball again (a version manager keeps global packages per Node version). Notes: ${INSTALL_NOTES_URL}\n`,
    );
  });
});
```

Run (from `packages/cli`): `pnpm vitest run src/node-support.test.ts` — Expected: FAIL, module missing.

(`packages/cli/src/version.ts` already exists from Task 3 Step 3.)

```ts
// packages/cli/src/node-support.ts — imports only the dependency-free version.ts,
// so the guard loads on any Node.
import { INSTALL_NOTES_URL } from "./version.js";

export function isSupportedNode(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return (major === 22 && minor >= 12) || major === 24;
}

export function UNSUPPORTED_NODE_LINE(version: string): string {
  return `[conduit] Node ${version} is not supported: this preview runs on Node 22 (22.12.0 or later) or Node 24. Switch to a supported Node, then install the tarball again (a version manager keeps global packages per Node version). Notes: ${INSTALL_NOTES_URL}\n`;
}
```

```ts
#!/usr/bin/env node
// packages/cli/src/entry.ts
import { isSupportedNode, UNSUPPORTED_NODE_LINE } from "./node-support.js";

if (!isSupportedNode(process.versions.node)) {
  process.stderr.write(UNSUPPORTED_NODE_LINE(process.versions.node));
  process.exit(1);
}
await import("./cli.js");
```

**Rename the dispatcher source first** (PR #63 review, Greptile P1): `git mv packages/cli/src/bin.ts packages/cli/src/cli.ts`, and delete its `#!/usr/bin/env node` line (it is no longer an entry; `entry.ts` carries the hashbang). After this, `bin` names exactly ONE file in the package: the emitted `dist/bin.js`, which is mcp's daemon entry (D-R6). tsup bundles `import("./cli.js")` from the source file `src/cli.ts` into a split chunk. It is never a runtime import of `dist/bin.js`, and no reader can mistake the two. Update the one other reference: `packages/cli/tsup.config.ts` has no `src/bin.ts` entry after Step 3.

Run: `pnpm vitest run src/node-support.test.ts` — Expected: PASS. After the Step 7 build, the layout test's dispatcher check (Step 1) proves that `dist/conduit.js` reaches the dispatcher. Do NOT use `--version` for this: mcp's entry (`packages/mcp/src/bin.ts:311`) also answers `--version` with the same version string, so that check passes even when the wrong module loads. Only the dispatcher prints `Usage: conduit <command>`. The engines range and `isSupportedNode` must change together; the `it.each` table is the pin.

- [ ] **Step 4: Change the manifests and version constants**

`packages/cli/package.json` — set exactly these keys (versions copied from the sdk and mcp manifests; no new package enters the graph):

```json
  "version": "0.2.0-alpha.0",
  "bin": {
    "conduit": "./dist/conduit.js",
    "conduit-mcp": "./dist/bin.js"
  },
  "dependencies": {
    "@libsql/client": "^0.14.0",
    "@modelcontextprotocol/sdk": "1.29.0",
    "ajv": "^8.17.1",
    "quickjs-emscripten": "^0.31.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@conduithq/mcp": "workspace:*",
    "@conduithq/sdk": "workspace:*",
    "@types/node": "26.0.1",
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^3.2.6"
  }
```

`packages/sdk/package.json` and `packages/mcp/package.json`: `"version": "0.2.0-alpha.0"`.
All three package manifests AND the root `package.json`: `"engines": { "node": ">=22.12.0 <23 || >=24 <25" }` (D-R12: Node 20 is end-of-life since 2026-04-30; the range is exactly the lines the Task 5 matrix tests, and it widens only when CI adds a major).
`packages/cli/src/version.ts`: `export const VERSION = "0.2.0-alpha.0";` (the file and the dispatch re-export exist since Task 3 Step 3).
`packages/mcp/src/env.ts:27`: `export const AGENT_VERSION = "0.2.0-alpha.0";`
Update every test found by `/usr/bin/grep -rn '0\.1\.1' packages/*/src` to the new value.

- [ ] **Step 5: Hand the founder the lockfile update, then review its diff**

The agent stops here and hands over, verbatim:

```bash
pnpm install
```

After the founder runs it: `git diff --stat pnpm-lock.yaml` and `git diff pnpm-lock.yaml`. Expected: changes only under `importers:` → `packages/cli` (dependencies moved between sections, plus version fields). If any entry appears under `packages:` or `snapshots:` that was not there before, a new package entered the graph: stop and report.

- [ ] **Step 6: Rename the CLI entry everywhere it is referenced**

`packages/cli/src/integration.test.ts:159`:

```ts
const cliBinPath = join(process.cwd(), "dist", "conduit.js");
```

In `README.md`, `packages/cli/README.md`, `packages/mcp/README.md`: replace `packages/cli/dist/bin.js` with `packages/cli/dist/conduit.js` at the lines listed under **Files**. Then confirm nothing is left:

Run: `/usr/bin/grep -rn 'cli/dist/bin' README.md packages/*/README.md packages/*/src`
Expected: no output.

- [ ] **Step 7: Build, run the layout test and the full CLI suite**

Run (repo root): `pnpm -r build`
Run (from `packages/cli`): `pnpm vitest run src/package-layout.test.ts` — Expected: PASS, 5 tests.
Run (from `packages/cli`): `pnpm vitest run` — Expected: PASS.
Run (repo root): `pnpm -r test` — Expected: PASS (the known flakes named in HANDOFF are the only acceptable reruns; name each rerun in the task report).

- [ ] **Step 8: Prove the layout test can fail**

Temporarily change the tsup entry key `bin` to `mcpbin`, rebuild the CLI (`pnpm --filter @conduithq/cli build`), and rerun `src/package-layout.test.ts`.
Expected: FAIL on `dist/bin.js` (missing). Revert, rebuild, rerun: PASS. Record both runs in the task report.

- [ ] **Step 9: Typecheck all three packages, then commit**

Run: `npx tsc --noEmit -p packages/sdk && npx tsc --noEmit -p packages/mcp && npx tsc --noEmit -p packages/cli`
Expected: exit 0.

```bash
git add packages/cli/src/entry.ts packages/cli/src/cli.ts packages/cli/src/node-support.ts packages/cli/src/node-support.test.ts   # the bin.ts → cli.ts rename is already staged by git mv
git add package.json packages/cli/tsup.config.ts packages/cli/package.json packages/mcp/package.json packages/sdk/package.json packages/cli/src/dispatch.ts packages/mcp/src/env.ts packages/cli/src/integration.test.ts packages/cli/src/package-layout.test.ts README.md packages/cli/README.md packages/mcp/README.md pnpm-lock.yaml
git add $(git diff --name-only -- 'packages/*/src/*.test.ts')
git commit -m "feat(cli): pack sdk and mcp into one CLI tarball"
```

---

### Task 5: Pack script + CI job that installs the tarball and runs it

The layout test in Task 4 checks files in the workspace. This task checks the ARTIFACT (false-green rule 2). One job packs the tarball once (D-R11). Fresh runners then install that exact file with npm, outside the repo, on Linux and macOS, each on Node 22.12.0 (the engines floor) and the latest Node 24 (D-R9, D-R12). It then confirms that npm installed exactly the shrinkwrapped tree (D-R7), runs `conduit demo`, confirms that the demo created no state dir, and auto-starts a real daemon through the real `spawnDaemon`. That last step closes the residual risk named in `packages/cli/src/integration.test.ts:850-870`: nothing currently exercises `spawnDaemon` → `bin.js --daemon` end to end. A CI runner is a disposable default state dir, so it can.

**Who can run what.** `scripts/pack-preview` resolves the shrinkwrap with `npm install --package-lock-only`, which contacts the registry and matches the install-command form the sfw guard hook blocks. Agents (the orchestrator and every implementer subagent) therefore never run `pack-preview`; CI runs it, and the founder may run it by hand. The three check scripts need no network, and agents run and failure-prove them locally.

```
pnpm -r build ─▶ pnpm pack ─▶ stage/package ─▶ strip devDependencies + scripts
                                   │
                                   ▼
          npm install --package-lock-only --ignore-scripts --before=<now−3d>
                                   │  (mirrors minimumReleaseAge = 4320 min)
                                   ▼
          npm-shrinkwrap.json ─▶ npm audit --audit-level=high ─▶ npm pack ─▶ out/*.tgz
                                                                   │
                                  check-tarball-paths (allowlist) ◀┘ ─▶ *.tgz.sha256
```

**Files:**
- Create: `scripts/pack-preview` (POSIX sh, executable)
- Create: `scripts/check-absent`, `scripts/check-tarball-paths`, `scripts/check-shrinkwrap-installed` (POSIX sh, executable)
- Modify: `.github/workflows/ci.yml` (new job `preview`), `.gitignore` (add `.preview/`)

**Interfaces:**
- Consumes: the Task 4 build (`pnpm -r build`) and `packages/cli/package.json` `version`.
- Produces:
  - `scripts/pack-preview [OUT_DIR]` writes `conduithq-cli-<version>.tgz` (containing `npm-shrinkwrap.json`) and `conduithq-cli-<version>.tgz.sha256` to `OUT_DIR` (default `<repo>/.preview`), and prints the tarball path on its last stdout line. Exit 1 on an audit finding at `high` or above, or on any path outside the allowlist.
  - `scripts/check-tarball-paths <TGZ>` — exit 1 and name the paths if any entry is outside the allowlist, or if `package/npm-shrinkwrap.json` is missing.
  - `scripts/check-shrinkwrap-installed <INSTALLED_PKG_DIR>` — exit 1 and name each package whose installed version differs from the shrinkwrap, or that is missing and not `optional`.

- [ ] **Step 1: Write `scripts/check-absent` and prove it can fail**

```sh
#!/bin/sh
# Fails if the given path exists. Used by CI to prove `conduit demo`
# created no state directory.
set -eu
if [ "$#" -ne 1 ]; then
  echo "[check-absent] Usage: check-absent <path>" >&2
  exit 2
fi
if [ -e "$1" ]; then
  echo "[check-absent] Path exists but must not: $1" >&2
  exit 1
fi
```

Run: `chmod +x scripts/check-absent && scripts/check-absent "$TMPDIR/does-not-exist-$$"; echo "exit $?"`
Expected: `exit 0`.
Run: `scripts/check-absent "$TMPDIR"; echo "exit $?"`
Expected: `[check-absent] Path exists but must not: …` and `exit 1`.

- [ ] **Step 2: Write `scripts/check-tarball-paths` and prove it can fail**

```sh
#!/bin/sh
# Refuses a preview tarball unless every entry is on the allowlist and the
# shrinkwrap is present. Allowlist, not denylist: anything else is a refusal.
set -eu
if [ "$#" -ne 1 ]; then
  echo "[check-tarball-paths] Usage: check-tarball-paths <tarball.tgz>" >&2
  exit 2
fi
entries="$(tar -tzf "$1")"
# Shape first: no absolute path, no backslash, no empty / . / .. component.
malformed="$(printf '%s\n' "$entries" | grep -E '^/|\\|//|(^|/)\.\.?(/|$)' || true)"
if [ -n "$malformed" ]; then
  echo "[check-tarball-paths] Refused: malformed entry names. Context: { tarball: $1, entries: $malformed }" >&2
  exit 1
fi
# Then the allowlist: directory entries under package/ and package/dist/,
# and files of the listed kinds.
unexpected="$(printf '%s\n' "$entries" | grep -Ev '^package/((dist/)([^/]+/)*)?$|^package/(dist/.+\.(js|js\.map|d\.ts)|package\.json|npm-shrinkwrap\.json|README\.md|LICENSE)$' || true)"
if [ -n "$unexpected" ]; then
  echo "[check-tarball-paths] Refused: tarball holds paths outside the allowlist. Context: { tarball: $1, paths: $unexpected }" >&2
  exit 1
fi
if ! printf '%s\n' "$entries" | grep -qx 'package/npm-shrinkwrap.json'; then
  echo "[check-tarball-paths] Refused: npm-shrinkwrap.json is missing. Context: { tarball: $1 }" >&2
  exit 1
fi
# Names alone are not enough: an allowed name can be a symlink or hard link.
# The verbose listing's first character is the entry type on GNU tar and
# bsdtar alike; only regular files (-) and directories (d) pass.
links="$(tar -tvzf "$1" | grep -Ev '^[-d]' || true)"
linked="$(tar -tvzf "$1" | grep -E ' -> | link to ' || true)"
if [ -n "$links" ] || [ -n "$linked" ]; then
  echo "[check-tarball-paths] Refused: tarball holds a non-regular entry. Context: { tarball: $1, entries: $links $linked }" >&2
  exit 1
fi
```

Prove it both ways with throwaway tarballs in `$TMPDIR` (no network):

```bash
chmod +x scripts/check-tarball-paths
d="$TMPDIR/ctp-$$" && mkdir -p "$d/package/dist" && cd "$d"
echo '{}' > package/package.json && echo '{}' > package/npm-shrinkwrap.json && echo 'x' > package/dist/a.js
tar -czf ok.tgz package && "$OLDPWD/scripts/check-tarball-paths" ok.tgz; echo "exit $?"
echo x > package/dist/probe.txt && tar -czf bad.tgz package && "$OLDPWD/scripts/check-tarball-paths" bad.tgz; echo "exit $?"
rm package/dist/probe.txt package/npm-shrinkwrap.json && tar -czf nosw.tgz package && "$OLDPWD/scripts/check-tarball-paths" nosw.tgz; echo "exit $?"
echo '{}' > package/npm-shrinkwrap.json && ln -s /etc/passwd package/dist/b.js && tar -czf link.tgz package && "$OLDPWD/scripts/check-tarball-paths" link.tgz; echo "exit $?"
rm package/dist/b.js && mkdir -p evil && echo x > evil/e.js && tar -czf trav.tgz package package/dist/../../evil/e.js && "$OLDPWD/scripts/check-tarball-paths" trav.tgz; echo "exit $?"
cd "$OLDPWD" && rm -rf "$d"
```

Expected: `exit 0` (the `package/` and `package/dist/` directory entries that `tar -czf … package` writes are allowed); then `Refused: … package/dist/probe.txt` and `exit 1`; then `npm-shrinkwrap.json is missing` and `exit 1`; then `non-regular entry … package/dist/b.js` and `exit 1`; then `malformed entry names … ..` and `exit 1`. If the local `tar` normalizes the `..` path away when creating `trav.tgz` (print `tar -tzf trav.tgz` to see), record that and build the case with `tar --transform` (GNU) or `-s` (bsdtar) instead.

- [ ] **Step 3: Write `scripts/check-shrinkwrap-installed` and prove it can fail**

```sh
#!/bin/sh
# Verifies npm installed exactly the shrinkwrapped tree: every non-optional
# package the shrinkwrap names is present at the pinned version.
set -eu
if [ "$#" -ne 1 ]; then
  echo "[check-shrinkwrap-installed] Usage: check-shrinkwrap-installed <installed package dir>" >&2
  exit 2
fi
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const lock = JSON.parse(fs.readFileSync(path.join(root, "npm-shrinkwrap.json"), "utf8"));
  const entries = Object.entries(lock.packages ?? {}).filter(([rel]) => rel !== "");
  const libc = process.platform !== "linux" ? undefined
    : process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
  // An optional package is excused only when its os/cpu/libc fields rule out
  // THIS platform. A platform binary that applies here must be installed.
  // npm selector semantics: "!x" excludes x; if any positive entry exists,
  // the current value must be one of them.
  const matches = (list, current) => {
    if (!list || current === undefined) return true;
    if (list.includes(`!${current}`)) return false;
    const positives = list.filter((v) => !v.startsWith("!"));
    return positives.length === 0 || positives.includes(current);
  };
  const appliesHere = (meta) =>
    matches(meta.os, process.platform) && matches(meta.cpu, process.arch) && matches(meta.libc, libc);
  const bad = [];
  let checked = 0;
  for (const [rel, meta] of entries) {
    const manifest = path.join(root, rel, "package.json");
    if (!fs.existsSync(manifest)) {
      if (meta.optional !== true || appliesHere(meta)) bad.push(`${rel}: missing`);
      continue;
    }
    checked++;
    const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version;
    if (version !== meta.version) bad.push(`${rel}: installed ${version}, shrinkwrap ${meta.version}`);
  }
  // The other direction: nothing installed that the shrinkwrap does not name.
  const known = new Set(entries.map(([rel]) => rel));
  const walk = (dir, relBase) => {
    const nm = path.join(dir, "node_modules");
    if (!fs.existsSync(nm)) return;
    for (const name of fs.readdirSync(nm)) {
      if (name.startsWith(".")) continue;
      const scoped = name.startsWith("@") ? fs.readdirSync(path.join(nm, name)).map((s) => `${name}/${s}`) : [name];
      for (const pkg of scoped) {
        const rel = `${relBase}node_modules/${pkg}`;
        if (!fs.existsSync(path.join(nm, pkg, "package.json"))) continue;
        if (!known.has(rel)) bad.push(`${rel}: installed but not in the shrinkwrap`);
        walk(path.join(nm, pkg), `${rel}/`);
      }
    }
  };
  walk(root, "");
  if (checked === 0) bad.push("no shrinkwrapped package was found installed");
  if (bad.length > 0) {
    console.error(`[check-shrinkwrap-installed] Installed tree differs from the shrinkwrap. Context: { root: ${root} }\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
' "$1"
```

The `checked === 0` line is there so an empty or wrong directory can never pass as "no differences" (false-green: empty input read as a pass). Integrity is not re-checked here: npm verifies each package's `integrity` against the shrinkwrap during install and fails the install on a mismatch.

Prove it with a fake tree in `$TMPDIR` (no network):

```bash
chmod +x scripts/check-shrinkwrap-installed
d="$TMPDIR/csi-$$" && mkdir -p "$d/node_modules/zod"
printf '%s' '{"packages":{"":{},"node_modules/zod":{"version":"3.24.1"},"node_modules/@libsql/aix-ppc64":{"version":"0.4.0","optional":true,"os":["aix"],"cpu":["ppc64"]}}}' > "$d/npm-shrinkwrap.json"
echo '{"version":"3.24.1"}' > "$d/node_modules/zod/package.json"
scripts/check-shrinkwrap-installed "$d"; echo "exit $?"
echo '{"version":"3.25.0"}' > "$d/node_modules/zod/package.json"
scripts/check-shrinkwrap-installed "$d"; echo "exit $?"
echo '{"version":"3.24.1"}' > "$d/node_modules/zod/package.json"
mkdir -p "$d/node_modules/evil" && echo '{"version":"1.0.0"}' > "$d/node_modules/evil/package.json"
scripts/check-shrinkwrap-installed "$d"; echo "exit $?"
rm -rf "$d/node_modules/evil"
printf '%s' '{"packages":{"":{},"node_modules/zod":{"version":"3.24.1"},"node_modules/@libsql/here":{"version":"0.4.0","optional":true}}}' > "$d/npm-shrinkwrap.json"
scripts/check-shrinkwrap-installed "$d"; echo "exit $?"
printf '%s' '{"packages":{"":{},"node_modules/zod":{"version":"3.24.1"},"node_modules/@libsql/not-aix":{"version":"0.4.0","optional":true,"os":["!aix"]}}}' > "$d/npm-shrinkwrap.json"
scripts/check-shrinkwrap-installed "$d"; echo "exit $?"
rm -rf "$d/node_modules"
scripts/check-shrinkwrap-installed "$d"; echo "exit $?"
rm -rf "$d"
```

Expected, in order: `exit 0` (the aix-only optional package is excused); `node_modules/zod: installed 3.25.0, shrinkwrap 3.24.1`, `exit 1`; `node_modules/evil: installed but not in the shrinkwrap`, `exit 1`; `node_modules/@libsql/here: missing`, `exit 1` (an optional package with no platform fields applies everywhere, so it must be installed); `node_modules/@libsql/not-aix: missing`, `exit 1` (`os: ["!aix"]` applies on every non-aix host); `node_modules/zod: missing`, `exit 1`.

- [ ] **Step 4: Write `scripts/check-shrinkwrap-in-pnpm` and prove it can fail (D-R10)**

Refuses a shrinkwrap that names any `(package, version)` pair absent from `pnpm-lock.yaml`. The lockfile's `packages:` section lists every platform's optional binaries, unlike `pnpm list`, which sees only the host's install (codex pass 2 #1). **What it proves, and what it does not (D-R10, relabelled):** every version an adopter installs is one pnpm resolved for this workspace. It does NOT prove the dependency edges match pnpm's; npm and pnpm hoist differently by design. The structural guarantee for the adopter tree is the CI run of the real demo and daemon on that exact npm tree (Task 5 Step 8).

```sh
#!/bin/sh
# Version-set guard (best-effort, not graph equality): refuses an npm
# shrinkwrap naming any (package, version) that pnpm-lock.yaml's
# `packages:` section does not contain.
set -eu
if [ "$#" -ne 2 ]; then
  echo "[check-shrinkwrap-in-pnpm] Usage: check-shrinkwrap-in-pnpm <npm-shrinkwrap.json> <pnpm-lock.yaml>" >&2
  exit 2
fi
node -e '
  const fs = require("node:fs");
  const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const seen = new Map();
  let inPackages = false;
  // lockfileVersion 9.0: under `packages:`, each key sits at indent 2 as
  // `  name@version:` or `  '"'"'@scope/name@version'"'"':`.
  for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
    if (/^\S/.test(line)) { inPackages = line === "packages:"; continue; }
    const m = inPackages && /^  (\S.*):$/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/^'"'"'|'"'"'$/g, "");
    const at = key.lastIndexOf("@");
    if (at <= 0) continue;
    const name = key.slice(0, at);
    if (!seen.has(name)) seen.set(name, new Set());
    seen.get(name).add(key.slice(at + 1));
  }
  if (seen.size === 0) {
    console.error("[check-shrinkwrap-in-pnpm] Refused: no packages were read from the pnpm lockfile, so nothing can be compared.");
    process.exit(1);
  }
  const bad = [];
  for (const [rel, meta] of Object.entries(lock.packages ?? {})) {
    if (rel === "") continue;
    const name = rel.slice(rel.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!seen.get(name)?.has(meta.version)) bad.push(`${name}@${meta.version} (pnpm has: ${[...(seen.get(name) ?? [])].join(", ") || "none"})`);
  }
  if (bad.length > 0) {
    console.error(`[check-shrinkwrap-in-pnpm] Refused: the shrinkwrap names versions pnpm never resolved:\n  ${bad.join("\n  ")}`);
    process.exit(1);
  }
' "$1" "$2"
```

Prove it with fixtures in `$TMPDIR` (no network):

```bash
chmod +x scripts/check-shrinkwrap-in-pnpm
d="$TMPDIR/csp-$$" && mkdir -p "$d"
printf "lockfileVersion: '9.0'\n\npackages:\n\n  zod@3.24.1:\n    resolution: {integrity: x}\n\n  '@libsql/darwin-arm64@0.4.7':\n    resolution: {integrity: y}\n\nsnapshots:\n\n  zod@3.99.0: {}\n" > "$d/pnpm-lock.yaml"
printf '%s' '{"packages":{"":{},"node_modules/zod":{"version":"3.24.1"},"node_modules/@libsql/darwin-arm64":{"version":"0.4.7","optional":true}}}' > "$d/ok.json"
printf '%s' '{"packages":{"":{},"node_modules/zod":{"version":"3.99.0"}}}' > "$d/bad.json"
printf 'lockfileVersion: 9.0\n' > "$d/empty.yaml"
scripts/check-shrinkwrap-in-pnpm "$d/ok.json" "$d/pnpm-lock.yaml"; echo "exit $?"
scripts/check-shrinkwrap-in-pnpm "$d/bad.json" "$d/pnpm-lock.yaml"; echo "exit $?"
scripts/check-shrinkwrap-in-pnpm "$d/ok.json" "$d/empty.yaml"; echo "exit $?"
printf '%s' '{"packages":{"":{},"node_modules/zod":{"version":"3.25.76"},"node_modules/@libsql/darwin-arm64":{"version":"0.4.7","optional":true},"node_modules/@libsql/linux-x64-gnu":{"version":"0.4.7","optional":true}}}' > "$d/real.json"
scripts/check-shrinkwrap-in-pnpm "$d/real.json" pnpm-lock.yaml; echo "exit $?"
scripts/check-shrinkwrap-in-pnpm "$d/ok.json" pnpm-lock.yaml; echo "exit $?"
rm -rf "$d"
```

Expected: `exit 0` (a darwin-only binary passes on any host, because the lockfile lists it); then `zod@3.99.0 (pnpm has: 3.24.1)` and `exit 1` (a version found only under `snapshots:` does not count); then `no packages were read` and `exit 1`; then, against the REAL repo lockfile, `exit 0`; then `zod@3.24.1 (pnpm has: 3.25.76)` and `exit 1`. (The parser was run against the real lockfile during review on 2026-09-25: 263 package names; `zod 3.25.76`, `@libsql/darwin-arm64 0.4.7`, `@libsql/linux-x64-gnu 0.4.7`. If the lockfile has moved since, adjust the two real-lockfile versions to what it holds.)

- [ ] **Step 5: Write `scripts/pack-preview` (CI and founder only — agents do not run it)**

```sh
#!/bin/sh
# Builds the workspace, packs @conduithq/cli, pins its production tree in
# npm-shrinkwrap.json (resolved no newer than minimumReleaseAge allows),
# audits that tree, repacks, and refuses the tarball unless its paths pass
# the allowlist. Contacts the npm registry: not for agent shells.
set -eu

root="$(git rev-parse --show-toplevel)"
out="${1:-$root/.preview}"
mkdir -p "$out"
# Absolute from here on: the script cds into the stage before packing.
out="$(cd "$out" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cd "$root"
pnpm -r build
pnpm --filter @conduithq/cli list --prod --depth Infinity --json > "$stage/pnpm-tree.json"

cd "$root/packages/cli"
version="$(node -p 'require("./package.json").version')"
tarball="$out/conduithq-cli-$version.tgz"
rm -f "$tarball" "$tarball.sha256"
# pnpm pack, not npm pack: it rewrites workspace:* specifiers.
pnpm pack --pack-destination "$stage" >/dev/null
tar -xzf "$stage/conduithq-cli-$version.tgz" -C "$stage"

cd "$stage/package"
# devDependencies name workspace packages that are not on any registry, and
# scripts must not run during resolution: drop both from the staged manifest.
# Then steer npm to pnpm's tested versions (D-R10): direct dependencies are
# pinned exactly (an override on a direct dependency is an npm error), and
# every transitive package pnpm resolved to ONE version gets an override.
node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const tree = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const seen = new Map();
  const collect = (deps) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      if (!seen.has(name)) seen.set(name, new Set());
      seen.get(name).add(node.version);
      collect(node.dependencies);
    }
  };
  for (const project of Array.isArray(tree) ? tree : [tree]) collect(project.dependencies);
  delete pkg.devDependencies;
  delete pkg.scripts;
  pkg.overrides = {};
  for (const name of Object.keys(pkg.dependencies)) {
    const versions = [...(seen.get(name) ?? [])];
    if (versions.length !== 1) throw new Error(`[pack-preview] Direct dependency ${name} has ${versions.length} pnpm versions`);
    pkg.dependencies[name] = versions[0];
  }
  for (const [name, versions] of seen) {
    if (!(name in pkg.dependencies) && versions.size === 1) pkg.overrides[name] = [...versions][0];
  }
  fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
' "$stage/pnpm-tree.json"
# pnpm-workspace.yaml minimumReleaseAge is 4320 minutes; --before mirrors it
# for any package pnpm resolved to more than one version.
before="$(node -p 'new Date(Date.now() - 4320 * 60 * 1000).toISOString()')"
npm install --package-lock-only --ignore-scripts --omit=dev --before="$before" >/dev/null
mv package-lock.json npm-shrinkwrap.json
"$root/scripts/check-shrinkwrap-in-pnpm" npm-shrinkwrap.json "$root/pnpm-lock.yaml"
npm audit --omit=dev --audit-level=high
npm pack --pack-destination "$out" >/dev/null

if [ ! -f "$tarball" ]; then
  echo "[pack-preview] Pack failed: expected tarball is missing. Context: { tarball: $tarball }" >&2
  exit 1
fi
"$root/scripts/check-tarball-paths" "$tarball"

node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync, writeFileSync } = require("node:fs");
  const { basename } = require("node:path");
  const file = process.argv[1];
  const sum = createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(`${file}.sha256`, `${sum}  ${basename(file)}\n`);
' "$tarball"

echo "$tarball"
```

Add `.preview/` to `.gitignore` under the "Generated outputs" comment.

`--audit-level=high` matches the repo's existing audit gate (the `pnpm-workspace.yaml` overrides exist to clear HIGH advisories; moderates are parked per the Dependabot triage). If `npm audit` fails on the first CI run, that is a real finding on the adopter tree: stop and report it, do not lower the level.

- [ ] **Step 6: Run shellcheck on all five scripts**

Run: `shellcheck scripts/pack-preview scripts/check-absent scripts/check-tarball-paths scripts/check-shrinkwrap-installed scripts/check-shrinkwrap-in-pnpm`
Expected: no output. (If `shellcheck` is not installed locally, CI's `meta` job runs it; say so in the task report instead of claiming it passed.)

- [ ] **Step 7: Pin the two artifact actions (new supply-chain surface — stop and report if anything differs)**

The pack-once layout (D-R11) needs `actions/upload-artifact` and `actions/download-artifact`, which the workflow does not use today. Pin each to a full commit SHA, per CLAUDE.md ("Actions get pinned to commit SHAs before enabling"):

```bash
gh api repos/actions/upload-artifact/releases/latest --jq .tag_name
gh api repos/actions/download-artifact/releases/latest --jq .tag_name
gh api repos/actions/upload-artifact/commits/<TAG> --jq .sha
gh api repos/actions/download-artifact/commits/<TAG> --jq .sha
```

Use `commits/<TAG>` (it dereferences annotated tags to the commit). Write each as `uses: actions/<name>@<40-hex sha> # <TAG>`, the same comment style as the existing pins. Name both tags and SHAs in the task report; the PR's review checks them.

- [ ] **Step 8: Add the CI jobs**

Append to `.github/workflows/ci.yml` under `jobs:`. Reuse the exact pinned SHAs already in the file for checkout, pnpm, and setup-node.

```yaml
  pack:
    name: Pack preview tarball (once)
    runs-on: ubuntu-latest
    outputs:
      sha256: ${{ steps.pack.outputs.sha256 }}
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - name: Pack, then record the tarball and its SHA-256
        id: pack
        run: |
          # No pipe: a failed pack must fail THIS step (set -e sees the script's exit).
          scripts/pack-preview "$RUNNER_TEMP/preview" > "$RUNNER_TEMP/pack.log"
          tarball="$(tail -n 1 "$RUNNER_TEMP/pack.log")"
          test -f "$tarball"
          test -f "$tarball.sha256"
          echo "sha256=$(cut -d ' ' -f 1 "$tarball.sha256")" >> "$GITHUB_OUTPUT"
      - uses: actions/upload-artifact@<SHA from Step 7> # <TAG>
        with:
          name: preview-tarball
          path: ${{ runner.temp }}/preview/conduithq-cli-*
          if-no-files-found: error

  preview:
    name: Preview tarball (${{ matrix.os }}, Node ${{ matrix.node }})
    needs: pack
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        # The engines floor, exactly, and the current LTS line (D-R12).
        node: ["22.12.0", "24"]
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: ${{ matrix.node }}
      - name: This leg is the target the notes claim (Linux x64 glibc / macOS arm64)
        env:
          OS: ${{ matrix.os }}
        run: |
          node -e '
            const want = process.env.OS.startsWith("ubuntu")
              ? { platform: "linux", arch: "x64", glibc: true }
              : { platform: "darwin", arch: "arm64", glibc: false };
            const glibc = Boolean(process.report.getReport().header.glibcVersionRuntime);
            const got = { platform: process.platform, arch: process.arch, glibc };
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              console.error(`[preview] Runner target mismatch. Context: { want: ${JSON.stringify(want)}, got: ${JSON.stringify(got)} }`);
              process.exit(1);
            }
          '
      - uses: actions/download-artifact@<SHA from Step 7> # <TAG>
        with:
          name: preview-tarball
          path: ${{ runner.temp }}/preview
      - name: The downloaded tarball is the exact bytes the pack job built
        env:
          EXPECTED: ${{ needs.pack.outputs.sha256 }}
        run: |
          tarball="$(ls "$RUNNER_TEMP"/preview/conduithq-cli-*.tgz)"
          actual="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$tarball")"
          test -n "$EXPECTED"
          test "$actual" = "$EXPECTED"
          scripts/check-tarball-paths "$tarball"
          echo "TARBALL=$tarball" >> "$GITHUB_ENV"
      - name: Install the tarball into a clean prefix (the adopter command, plus --prefix)
        run: npm install -g --prefix "$RUNNER_TEMP/prefix" --ignore-scripts "$TARBALL"
      - name: npm installed exactly the shrinkwrapped tree
        run: scripts/check-shrinkwrap-installed "$RUNNER_TEMP/prefix/lib/node_modules/@conduithq/cli"
      - name: conduit demo neither opens nor creates the state path, and ignores CONDUIT_*
        working-directory: ${{ runner.temp }}
        run: |
          export PATH="$RUNNER_TEMP/prefix/bin:$PATH"
          state="$(node -p 'require("node:path").join(require("node:os").userInfo().homedir, ".conduit")')"
          "$GITHUB_WORKSPACE/scripts/check-absent" "$state"
          test "$(conduit --version)" = "$(node -p "require('$GITHUB_WORKSPACE/packages/cli/package.json').version")"
          # A FILE where the state dir would be, unreadable: any open fails
          # (EACCES) and any mkdir fails (EEXIST), so a demo that opens or
          # creates state cannot PASS. It does NOT catch a bare stat/exists.
          # Egress is forced OFF in the env: the demo's loopback grant is in
          # code, so a demo that wrongly takes egress from the env fails here.
          printf 'sentinel' > "$state"
          chmod 000 "$state"
          CONDUIT_DB=/nonexistent/conduit.db CONDUIT_MASTER_KEY=not-a-key CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=0 conduit demo
          chmod 600 "$state"
          test "$(cat "$state")" = "sentinel"
          rm "$state"
      - name: A real daemon auto-starts from the installed tarball
        working-directory: ${{ runner.temp }}
        run: |
          export PATH="$RUNNER_TEMP/prefix/bin:$PATH"
          conduit key generate
          test "$(conduit approvals list)" = "No paused executions awaiting approval."
          conduit daemon status
          conduit daemon stop
      - name: The installed conduit-mcp doctor runs (the notes advertise it)
        working-directory: ${{ runner.temp }}
        run: |
          export PATH="$RUNNER_TEMP/prefix/bin:$PATH"
          conduit-mcp --doctor --offline

  preview-unsupported-node:
    name: Preview tarball refuses an unsupported Node (20)
    needs: pack
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: "20"
      - uses: actions/download-artifact@<SHA from Step 7> # <TAG>
        with:
          name: preview-tarball
          path: ${{ runner.temp }}/preview
      - name: Install (npm only warns on engines) and expect the guard's one-line refusal
        working-directory: ${{ runner.temp }}
        run: |
          npm install -g --prefix "$RUNNER_TEMP/prefix" --ignore-scripts "$RUNNER_TEMP"/preview/conduithq-cli-*.tgz
          export PATH="$RUNNER_TEMP/prefix/bin:$PATH"
          set +e
          conduit --version > out.txt 2> err.txt
          code=$?
          set -e
          test "$code" = "1"
          test ! -s out.txt
          test "$(wc -l < err.txt)" -eq 1
          grep -qE '^\[conduit\] Node 20\.[0-9]+\.[0-9]+ is not supported: .* Notes: https://github\.com/.+/INSTALL\.md$' err.txt
```

`working-directory: runner.temp` keeps Node's module resolution out of the workspace, so nothing can resolve from the repo's `node_modules`. The `preview` job checks out the repo only for its `scripts/`; it never installs the workspace. The `pack` job also runs on every push to `main`, so the merge commit's run holds the artifact Task 7 promotes (default retention: 90 days).

- [ ] **Step 9: Lint the workflow**

Run: `actionlint .github/workflows/ci.yml`
Expected: no output. (If `actionlint` is not installed locally, CI's `meta` job runs it; say so instead of claiming a pass.)

- [ ] **Step 10: Commit**

```bash
git add scripts/pack-preview scripts/check-absent scripts/check-tarball-paths scripts/check-shrinkwrap-installed scripts/check-shrinkwrap-in-pnpm .github/workflows/ci.yml .gitignore
git commit -m "ci: pack the preview tarball once and test it"
```

- [ ] **Step 11: After the PR opens — verify the artifact, and prove the job can fail**

`pack-preview` has never run before this point (agents do not run it). On the PR's first CI run, open the logs and confirm: the `pack` job passed `check-shrinkwrap-in-pnpm` and `npm audit` and uploaded one tarball; each of the FOUR `preview` legs matched the SHA-256, passed `check-shrinkwrap-installed` having checked a non-zero count, ran `conduit demo` to `PASS`, restored the sentinel unchanged, and ran `conduit daemon status` to exit 0. A green job with a skipped step is not a pass. If `pnpm pack --pack-destination`, the `pnpm list` shape, or the override resolution fails on the first run, fix the script on the branch and record the fix under "Deviations". If the `22.12.0` leg fails for a runtime reason, raise the engines floor (Task 4) to the lowest 22.x patch that passes, pin the matrix to it, and record it.

Prove the job can fail: push one throwaway commit that adds `mkdirSync(join(userInfo().homedir, ".conduit"), { recursive: true })` at the top of `drive` in `runDemo`'s file (imports from `node:fs`, `node:path`, `node:os`). Expected: all four `preview` legs fail at `conduit demo` (the sentinel file makes the mkdir throw, and `runDemo` reports it as a FAIL). Then push a commit that reverts it. Expected: green. Record both run URLs in the PR description under "Gate proofs" (run URLs on github.com are public-safe; they are not personal URLs).

---

### Task 6: Alpha install notes, license in the tarball, README pointers

**Files:**
- Create: `docs/alpha/INSTALL.md`
- Create: `packages/cli/LICENSE` (byte copy of the root `LICENSE`)
- Modify: `packages/cli/src/package-layout.test.ts` (one test)
- Modify: `README.md` (Quick start, first paragraph), `packages/cli/README.md` (the "Nothing is published to npm yet" paragraph)

**Interfaces:**
- Consumes: the version `0.2.0-alpha.0`, the tarball name from Task 5, `conduit demo` output from Task 3.
- Produces: the page an adopter reads; nothing in code depends on it.

- [ ] **Step 1: Write the failing license test**

Append to `packages/cli/src/package-layout.test.ts`:

```ts
describe("license travels with the tarball", () => {
  it("packages/cli/LICENSE is byte-identical to the root LICENSE", () => {
    const here = readFileSync(join(process.cwd(), "LICENSE"));
    const root = readFileSync(join(process.cwd(), "..", "..", "LICENSE"));
    expect(here.equals(root)).toBe(true);
  });
});
```

Run (from `packages/cli`): `pnpm vitest run src/package-layout.test.ts -t "license"`
Expected: FAIL — `ENOENT … packages/cli/LICENSE`.

- [ ] **Step 2: Copy the license and rerun**

Run: `cp LICENSE packages/cli/LICENSE`
Run (from `packages/cli`): `pnpm vitest run src/package-layout.test.ts -t "license"`
Expected: PASS.

- [ ] **Step 3: Write `docs/alpha/INSTALL.md`**

````markdown
# Conduit preview 0.2.0-alpha.0 — install notes

This is an **alpha preview**, not a release. It is not on npm. The on-disk
state format can change before the first public release, and this preview
has no state migration: a later build may refuse your existing state, and
then you move `~/.conduit` aside (never delete it: it holds your master key
and sealed credentials; see "Moving to a later preview"). Report problems
as GitHub issues on this repository.

## Requirements

- Node.js 22 (22.12.0 or later) or Node.js 24. CI installs and runs this
  exact tarball on Node 22.12.0 and the latest Node 24.
- Tested targets: Linux x64 with glibc, and macOS on Apple silicon
  (arm64). Other combinations (Linux arm64, musl/Alpine, Intel macOS) are
  untested; they may work, but nothing has checked them. Windows is not
  supported (the daemon uses Unix sockets).
- Network access to the npm registry during install: the tarball contains
  Conduit's own code, and npm fetches its dependencies at the exact
  versions pinned in the tarball's `npm-shrinkwrap.json`. Those versions
  were at least three days old when the tarball was packed, and they
  passed `npm audit` at level `high`.

## 1. Download and verify

From the repository's Releases page, download both files for the tag
`v0.2.0-alpha.0`:

- `conduithq-cli-0.2.0-alpha.0.tgz`
- `conduithq-cli-0.2.0-alpha.0.tgz.sha256`

Verify the tarball before you install it. On macOS:

```bash
shasum -a 256 -c conduithq-cli-0.2.0-alpha.0.tgz.sha256
```

On Linux:

```bash
sha256sum -c conduithq-cli-0.2.0-alpha.0.tgz.sha256
```

Both print `conduithq-cli-0.2.0-alpha.0.tgz: OK`. If they do not, do not
install the file. The checksum proves the download is intact. It does not
prove who built the file: it is published in the same release as the
tarball. This preview has no signature or build attestation.

## 2. Install

```bash
npm install -g --ignore-scripts ./conduithq-cli-0.2.0-alpha.0.tgz
```

`--ignore-scripts` stops npm from running install-time scripts from any
package in the tree. Conduit needs none; CI installs this same tarball with
these same flags into an isolated prefix.

This installs two commands: `conduit` and `conduit-mcp`. Check the version:

```bash
conduit --version
```

If `npm install -g` fails with `EACCES`, your Node is a system install
that npm cannot write to. Do not use `sudo`. Either install Node with a
version manager (nvm, fnm, or volta) or give npm a user-owned prefix:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"   # add this line to your shell profile
```

If `conduit` prints `Node … is not supported`, switch to Node 22.12+ or 24
(for example `nvm install 24 && nvm use 24`), then run the install command
again: a version manager keeps global packages per Node version.

## 3. See the approval gate work (no setup)

```bash
conduit demo
```

The demo runs in memory. It needs no key, no external network (it talks
only to a loopback server it starts itself), and no account, and it does
not open or create anything in `~/.conduit`. A local demo upstream exposes one
tool that needs approval. The demo approves one call to it and denies
another, then reports what the upstream actually received. It takes a few
seconds:

```
conduit demo — the approval gate, end to end (in memory). Running…

approve: paused before it ran; after approval the upstream received it 1 time, with the exact input
deny:    paused before it ran; after denial the upstream received it 0 times
replay:  approving the same call again was refused (conflict); upstream total is still 1

PASS
Next: follow step 4 of https://github.com/nischal94/conduit-HQ/blob/v0.2.0-alpha.0/docs/alpha/INSTALL.md to govern your own agent's calls.
```

The counts come from the upstream's own record of the calls it received,
not from Conduit's report. The demo exits 1 if any count is wrong.

## 4. Govern your own agent's calls

This walkthrough uses GitHub, with a token that can touch ONE scratch
repository, so your first governed call has a small, known blast radius.

1. **Make a scratch repository** on GitHub (for example
   `YOUR_USER/conduit-scratch`), then create a **fine-grained personal
   access token** limited to that one repository, with **Issues: Read and
   write**.

2. **Mint the master key.** It seals every stored credential:

   ```bash
   conduit key generate
   ```

3. **Onboard GitHub's MCP server** — yourself, in your own terminal, not
   through your agent. Type the token at a hidden prompt so it never lands
   in your shell history. It travels to Conduit in an environment
   variable and is encrypted at rest; Conduit never passes it to your agent
   or the model. (An agent that has shell access and runs as your user can
   read anything you can, including `~/.conduit`. Conduit's boundary covers
   what flows through Conduit, not your agent's own shell.)

   ```bash
   read -rs TOKEN   # paste the token, press Enter; nothing is shown
   CONDUIT_ADD_SECRET="$TOKEN" conduit add-mcp \
     --url https://api.githubcopilot.com/mcp/ \
     --namespace github --prefix github.scratch
   unset TOKEN
   ```

   It prints how many tools it found in each risk class, and the policy
   for each class: `safe` runs without asking; `review` and `destructive`
   pause for your approval. Conduit classifies each tool from the hints its
   upstream publishes, so check the tool you intend to use: the
   create-issue tool must be in `review` or `destructive`. If it is not,
   stop here and report it (see "Tell us how it went").

4. **Point Claude Code at Conduit.** Pin both Node and Conduit by absolute
   path: a client started outside this shell (for example the desktop app)
   may not have your Node on its PATH:

   ```bash
   claude mcp add --scope user conduit -- "$(command -v node)" "$(realpath "$(command -v conduit)")" serve
   ```

   If you later switch Node versions, run this command again.

   Restart Claude Code (or open a new session) so it loads the server.

5. **Ask your agent for a write.** For example: *"Create an issue in
   YOUR_USER/conduit-scratch titled 'hello from conduit'."* The agent
   reports that the call is waiting for approval and tells you to run
   `conduit approvals list`.

6. **Decide it** in a second terminal:

   ```bash
   conduit approvals list
   ```

   Under the table, each paused call has two ready-to-run lines, one to
   deny and one to approve. Read the call first, then copy the line for
   your decision.

7. **Go back to your agent and say it was approved.** The agent then
   checks the execution and reports the result. The issue appears in your
   scratch repository. Nothing ran before you approved; a denied call never
   reaches GitHub.

## Tell us how it went (3 minutes)

This preview exists to learn two things: how long the first run takes you,
and whether you need different tool access for different agents. Please
fill in the short form, whether it went well or not:
[Alpha feedback](https://github.com/nischal94/conduit-HQ/issues/new?template=alpha-feedback.yml).

## When something goes wrong

- `conduit daemon status` shows whether the background daemon is running
  and which version it is.
- `conduit-mcp --doctor` asks the running daemon for its health.
  `conduit-mcp --doctor --offline` diagnoses an install whose daemon will
  not start.
- The daemon writes its log to `~/.conduit/conduitd.log`.
- To report a problem, open an issue on this repository with: the output of
  `conduit --version` and `node --version`, your OS, the command you ran,
  and its full output. **Never paste a token, the contents of `~/.conduit`,
  or your master key.**

## Moving to a later preview

```bash
conduit daemon stop
npm install -g --ignore-scripts ./conduithq-cli-<NEW_VERSION>.tgz
conduit demo
```

If the new daemon refuses your existing state, move it aside instead of
deleting it (it holds your master key and sealed credentials):

```bash
mv ~/.conduit ~/.conduit.previous
```

## Known limits of this preview

- One authority profile: every connected client shares the same tool access.
- No trace viewer. Executions are traced in the local database only.
- No service install: the daemon starts on first use and runs until
  `conduit daemon stop`.
- No state migration between previews: moving `~/.conduit` aside is the
  upgrade path when a new build refuses old state.

## Uninstall

```bash
conduit daemon stop
npm uninstall -g @conduithq/cli
```

Your state stays in `~/.conduit`. It holds the master key and your sealed
credentials. Delete it only if you intend to lose them:

```bash
rm -rf ~/.conduit
```
````

- [ ] **Step 4: Point the READMEs at it**

In `README.md`, replace the Quick start's first line `Not yet on npm — run from source (Node version in [`.nvmrc`](.nvmrc), pnpm):` with:

```markdown
**Preview build:** an alpha tarball with install notes is in
[`docs/alpha/INSTALL.md`](docs/alpha/INSTALL.md) — install it and run
`conduit demo` to see the approval gate work in one command.

Or run from source (Node version in [`.nvmrc`](.nvmrc), pnpm):
```

**This README correction ships in PR A with Task 3B (D-R5), not in PR B; PR B's implementer skips it if `main` already has it.** In `README.md`, correct the false claim in Quick start step 2 (DX review, codex P0 #1). `VAR=value cmd` keeps the token out of argv but NOT out of shell history. Replace the sentence "The optional credential travels via env var — never a flag, so it stays out of argv and shell history — and is SecretBox-encrypted at rest:" and the command under it with:

````markdown
The optional credential travels via env var — never a flag, so it stays out
of argv — and is SecretBox-encrypted at rest. Type it at a hidden prompt so
it stays out of your shell history too:

```bash
read -rs TOKEN
CONDUIT_ADD_SECRET="$TOKEN" conduit add-mcp \
  --url https://api.githubcopilot.com/mcp/ \
  --namespace github --prefix github.personal
unset TOKEN
```
````

Then sweep for the same pattern elsewhere: `/usr/bin/grep -rn 'CONDUIT_ADD_SECRET=[A-Za-z]' README.md packages/*/README.md docs/alpha`. Every hit gets the same `read -rs` form. Expected after the sweep: no output.

In `packages/cli/README.md`, replace the paragraph that starts `Nothing is published to npm yet` with:

```markdown
Nothing is published to npm yet. Install the alpha tarball per
[`docs/alpha/INSTALL.md`](../../docs/alpha/INSTALL.md), or run the built file
directly: `node <abs path>/packages/cli/dist/conduit.js <command>` (build with
`npm run build` in this package). `--help` and `--version` are available at
the top level. `conduit demo` shows the approval gate end to end with no setup.
```

- [ ] **Step 5: Confirm npm will pack LICENSE and README (no network)**

Run (from `packages/cli`, after `pnpm --filter @conduithq/cli build`): `npm pack --dry-run --json --ignore-scripts | node -e 'const f=JSON.parse(require("fs").readFileSync(0,"utf8"))[0].files.map(x=>x.path);for(const p of ["LICENSE","README.md"])if(!f.includes(p)){console.error("missing "+p);process.exit(1)}console.log("ok")'`
Expected: `ok`. (`npm pack --dry-run` reads only local files. If the sfw guard blocks it anyway, say so in the task report; the Task 5 CI job's `check-tarball-paths` run is then the confirmation.)

- [ ] **Step 5a: Add the alpha feedback form (DX review D9 — the §18 signal)**

Create `.github/ISSUE_TEMPLATE/alpha-feedback.yml`:

```yaml
name: Alpha feedback
description: Tell us how the R3a preview went (about 3 minutes).
title: "[alpha] feedback"
labels: ["alpha-feedback"]
body:
  - type: markdown
    attributes:
      value: >-
        Thanks for trying the preview. This form creates a PUBLIC GitHub
        issue: anyone can read it. Never paste a token, the contents of
        ~/.conduit, your master key, or private repository names.
  - type: input
    id: version
    attributes:
      label: Output of `conduit --version`
    validations:
      required: true
  - type: input
    id: minutes-to-pass
    attributes:
      label: Minutes from download to `conduit demo` printing PASS
  - type: input
    id: minutes-to-governed-call
    attributes:
      label: Minutes to the first governed call from your own agent (leave blank if you did not get there)
  - type: dropdown
    id: clients
    attributes:
      label: How many agents or MCP clients do you connect, or want to connect, to Conduit?
      options: ["1", "2-3", "4 or more"]
    validations:
      required: true
  - type: dropdown
    id: per-client-access
    attributes:
      label: Should any of them get different tool access than the others?
      options:
        - "No: one policy for all of them is fine"
        - "Yes: I need different access per agent or client"
        - "Not sure yet"
    validations:
      required: true
  - type: textarea
    id: stuck
    attributes:
      label: Where did you get stuck, if anywhere?
```

The `per-client-access` answer is the §18 profiles signal; the two minute fields measure the TTHW targets this plan set. The `alpha-feedback` label must exist for the form to apply it. Creating a repository label is an outward-facing change, so the agent asks the founder, then runs `gh label create alpha-feedback --description "R3a alpha feedback form"` on a yes. No local check parses GitHub's issue-form schema, so the verification is on GitHub: after pushing the PR branch, open `https://github.com/nischal94/conduit-HQ/issues/new?template=alpha-feedback.yml` with the branch's template (or view the file on the branch: GitHub shows a form-syntax error banner on invalid issue forms) and confirm the form renders all six fields. Record it in the task report.

- [ ] **Step 5b: Founder dogfoods section 4 before the notes may recommend it (DX review D7 [2])**

Nobody has verified that GitHub's remote MCP server (`https://api.githubcopilot.com/mcp/`) accepts a fine-grained PAT scoped to one repository with Issues read/write, or that its issue-creation tool classifies as `review` and pauses.

**Setup, so the trial can neither pass on stale state nor touch real credentials:** run it under a **disposable macOS user account** (never the founder's own account: its `~/.conduit` holds real sealed credentials, and an auto-started daemon always uses the default state dir). Install the PR's CI-packed tarball (downloaded from the PR's `pack` job with `gh run download <run-id> --name preview-tarball`) into a temporary prefix with the notes' exact install flags. Put that prefix's `bin` first on PATH, then record `command -v conduit`, `realpath "$(command -v conduit)"`, `conduit --version`, and `node --version`.

**Run:** the agent hands the founder sections 2–4 of the notes verbatim, including the `read -rs` token prompt and the pinned-Node `claude mcp add` line. Start Claude Code from the Dock (GUI launch, not the shell) at least once, to prove the pinned-path config works without shell PATH. The founder reports: the `add-mcp` counts line and the create-issue tool's class; whether the call paused; whether the deny line created no issue; and whether the approve line created exactly one.

**If it fails:** there is **no fallback to a broader token.** A classic PAT with `public_repo` widens the credential's authority and defeats the small blast radius the notes promise. Instead the guided path is BLOCKED, and the agent escalates to the founder with the failure and 2–3 options (for example another upstream that supports a scoped credential). Record the result, date, and resolved paths in the task report. Task 6 is not done until this report exists. Delete the disposable account afterwards.

- [ ] **Step 6: Commit**

```bash
git add .github/ISSUE_TEMPLATE/alpha-feedback.yml docs/alpha/INSTALL.md packages/cli/LICENSE packages/cli/src/package-layout.test.ts README.md packages/cli/README.md
git commit -m "docs: add alpha install notes for the preview tarball"
```

---

### The two PRs (D-R5)

**PR A — `fix/approval-guidance` → `main`, titled `fix: name the approve command where users need it`.** Contents: Task 3B (all steps) plus the README shell-history correction from Task 6 Step 4 (the `read -rs` form and the sweep). It lands BEFORE any of Tasks 1–6 are built. It touches product code and credential-handling messages, so it takes the Tier 2 gauntlet and the `/explain-diff` quiz.

**PR B — `feat/r3a-preview-packaging` → `main`, branched from `main` after PR A merges, titled `feat: R3a preview packaging — one tarball and conduit demo`.** Contents: Tasks 1, 2, 3, 4, 5, 6 (Task 6 without the README correction, which PR A shipped). It is load-bearing (product code, supply-chain manifests, CI), so it takes the Tier 2 gauntlet and the `/explain-diff` quiz before any merge talk (CLAUDE.md, Commit routing). The PR description carries "Deviations" (from the deviations log) and "Gate proofs" (Task 4 Step 8, Task 5 Steps 1–4 and 11). Record the D-R decisions in `conduitspec.html` §18 in this PR, then run `python3 html2md.py`.

---

### Task 7: GitHub prerelease (after merge and pre-ship gates; founder-confirmed)

Publishing is outward-facing: every step that creates a tag or a release waits for the founder's explicit yes in chat.

- [ ] **Step 1: Download the exact bytes CI tested on the merge commit (D-R11 — never repack)**

**Candidate commit.** After the R3a PR and every pre-ship gate PR have merged, the agent records ONE candidate SHA in HANDOFF (`R3a release candidate: <40-hex sha>`) and asks the founder to confirm it. Everything below uses that recorded SHA, never "current main": a later merge must not change what is released.

```bash
git fetch origin && git status --short
merge_sha="<the recorded candidate SHA, pasted verbatim>"
git merge-base --is-ancestor "$merge_sha" origin/main
run_id="$(gh run list --workflow ci.yml --branch main --commit "$merge_sha" --json databaseId,conclusion,headSha --jq ".[] | select(.conclusion == \"success\" and .headSha == \"$merge_sha\") | .databaseId" | head -n 1)"
test -n "$run_id"
gh run download "$run_id" --name preview-tarball --dir .preview
scripts/check-tarball-paths .preview/conduithq-cli-0.2.0-alpha.0.tgz
cd .preview && shasum -a 256 -c conduithq-cli-0.2.0-alpha.0.tgz.sha256 && cd ..
test "$(tar -xOzf .preview/conduithq-cli-0.2.0-alpha.0.tgz package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')" = "0.2.0-alpha.0"
```

Expected: `git status --short` prints nothing; the candidate is on `main`; `run_id` is non-empty (a green CI run whose `headSha` IS the candidate exists; if not, stop); the paths check passes; `OK`; the packed version equals the tag's version. Record `merge_sha`, `run_id`, and the SHA-256, and confirm the SHA-256 equals the `pack` job's `sha256` output in that run's log. These bytes are what all four `preview` legs installed.

- [ ] **Step 2: Founder smoke-installs the exact file**

The agent hands over, verbatim (the agent does not install):

```bash
npm install -g --ignore-scripts --prefix "$TMPDIR/conduit-preview" ./.preview/conduithq-cli-0.2.0-alpha.0.tgz && "$TMPDIR/conduit-preview/bin/conduit" demo
```

Expected (founder reports back): `PASS`.

- [ ] **Step 3: Write the release notes (the adopter's first screen — DX review D6)**

Write `.preview/RELEASE_NOTES.md` (untracked; `.preview/` is gitignored) with the Write tool:

````markdown
**Alpha preview — not on npm.** Linux x64 (glibc) and macOS arm64, Node 22.12+ or 24.

Verify the download. On macOS:

```bash
shasum -a 256 -c conduithq-cli-0.2.0-alpha.0.tgz.sha256
```

On Linux:

```bash
sha256sum -c conduithq-cli-0.2.0-alpha.0.tgz.sha256
```

Then install, run the demo, and follow the notes:

```bash
npm install -g --ignore-scripts ./conduithq-cli-0.2.0-alpha.0.tgz
conduit demo                                                    # approve runs once; deny runs nothing
conduit key generate                                            # then step 4 of the install notes
```

Full install notes, troubleshooting, and known limits:
[docs/alpha/INSTALL.md at v0.2.0-alpha.0](https://github.com/nischal94/conduit-HQ/blob/v0.2.0-alpha.0/docs/alpha/INSTALL.md)

The checksum proves the download is intact, not who built it: this preview has no signature or build attestation.

**Tried it?** Three minutes of feedback decides what gets built next: [Alpha feedback form](https://github.com/nischal94/conduit-HQ/issues/new?template=alpha-feedback.yml).
````

- [ ] **Step 4: Ask, then publish**

Ask in chat, naming the tag, the commit SHA, the two files, the SHA-256, and the release-notes text. On an explicit yes:

```bash
gh release create v0.2.0-alpha.0 \
  --prerelease \
  --target "$merge_sha" \
  --title "Conduit preview 0.2.0-alpha.0" \
  --notes-file .preview/RELEASE_NOTES.md \
  .preview/conduithq-cli-0.2.0-alpha.0.tgz \
  .preview/conduithq-cli-0.2.0-alpha.0.tgz.sha256
```

- [ ] **Step 5: Verify the published artifact, not the command's exit**

Run: `gh release download v0.2.0-alpha.0 --dir "$TMPDIR/verify-release" && cd "$TMPDIR/verify-release" && shasum -a 256 -c conduithq-cli-0.2.0-alpha.0.tgz.sha256`
Expected: `conduithq-cli-0.2.0-alpha.0.tgz: OK`, and the SHA-256 matches the one recorded in Step 1.

- [ ] **Step 6: Record the alpha-window start as pending**

The §18 three-week window starts on the day the artifact first reaches someone outside the repo, not on the release day. Write in HANDOFF: "Alpha window: not started — record the date of first outside distribution in spec §18 when it happens; the window closes three weeks later with the §18 default outcome."

---

## Self-review (run by the plan author, 2026-09-25)

- **Spec coverage.** "versioned, packed artifact" → Tasks 4, 5, 7. "alpha install notes" → Task 6. "ONE governance property demonstrable in the first-run path (approve → the exact approved call runs once; deny → nothing ran)" → Tasks 1–3, surfaced in Task 6 step 3 of the notes and gated in CI by Task 5. "not a public npm release" → Task 7 is a GitHub prerelease; no `npm publish` anywhere. "full R3 … unchanged" → no lifecycle, service-install, or upgrade work in any task.
- **Placeholder scan.** No TBD/TODO. Every code step shows the code.
- **Type consistency.** `DemoResult`/`DemoEvidence` fields match across Tasks 2 and 3 (`approvedCalls`, `deniedCalls`, `totalCallsAfter`, `pausedBeforeRun`, `decisionApplied`, `exactInput`). `DEMO_NAMESPACE`/`DEMO_TOOL` come from Task 1 only. The bin names `conduit` → `dist/conduit.js` and `conduit-mcp` → `dist/bin.js` match in Tasks 4, 5, and 6.
- **False-green review.** Each new gate has a failure proof: `runDemo` (Task 2: two lying upstreams, a real-policy auto-allow, a run that cannot start), the layout test (Task 4 Step 8), `check-absent` / `check-tarball-paths` / `check-shrinkwrap-installed` / `check-shrinkwrap-in-pnpm` (Task 5 Steps 1–4, fixtures, no network), the CI job (Task 5 Step 11). One gate was rejected in drafting: a "HOME stays empty" test cannot fail for the real state dir, because the product resolves it from `userInfo().homedir`.
- **Unverified in this plan (the first CI run confirms; stop-and-report on mismatch):** that `pnpm pack` on pnpm 11 accepts `--pack-destination`; the JSON shape of `pnpm list --json` on pnpm 11 (the empty-tree refusal fires instead of a silent pass if it differs); that tsup accepts a `.js` file from another package as an entry and preserves its hashbang (the source hashbang is verified: `packages/mcp/dist/bin.js` line 1 is `#!/usr/bin/env node`); that npm accepts `overrides` for every single-version transitive package without an `EOVERRIDE` conflict; that Node 22.12.0 runs the tarball (D-R12 names the fallback).

## NOT in scope (considered and deferred)

- **Public npm release and full R3** (lifecycle, service install, upgrade and recovery guidance): §18 2026-09-11 keeps R3a to a packed preview.
- **Signed build provenance** for the tarball: deferred to public R3 and recorded in HANDOFF DEFERRED (eng review D9). R3a discloses "integrity only" in the notes.
- **Windows support:** the daemon uses Unix sockets; the notes state that Windows is unsupported.
- **Lane B/C (profiles, per-client authority):** §18 default outcome; the notes list "one authority profile" as a known limit.
- **The `--doctor --offline` fixture race and the Dependabot triage:** separate pre-ship PRs before Task 7 (HANDOFF DEFERRED).
- **Upgrade path from a from-source 0.1.1 install:** alpha adopters start fresh; the notes say to expect deleting `~/.conduit` on later builds.

## What already exists (reused, not rebuilt)

- `createApprovalRuntime` (`packages/mcp/src/runtime.ts`): the daemon's own manager composition; the demo reuses it instead of building a parallel one.
- `provisionSourceRequest` (`packages/mcp/src/daemon/provision.ts`): the daemon's onboarding path, including the real `tools/list` fetch and risk classification; the demo calls it instead of seeding tools by hand.
- The loopback MCP fixture pattern in `packages/sdk/src/e2e.smoke.test.ts`: the model for the demo upstream (Task 1).
- `manager.resume`'s atomic claim (`manager.ts:1880`): produces the replay `conflict` the demo reports; nothing new is built for it.
- The pinned checkout / pnpm / setup-node actions in `ci.yml`: reused; only `upload-artifact` and `download-artifact` are new (Task 5 Step 7).

## Failure modes (new codepaths)

| Codepath | Realistic production failure | Test? | Handled? | User sees |
| --- | --- | --- | --- | --- |
| `startDemoUpstream` | loopback bind refused (sandboxed host, port policy) | yes (Task 2 "cannot start") | `runDemo` catch → FAIL | `FAIL` + "the demo could not run: …" |
| `provisionSourceRequest` in demo | onboarding fetch fails | yes (closed-port case) | same catch | same, with the runtime log on stderr |
| `manager.start` | default policy changes so `review` auto-allows | yes (readOnly case) | evidence check | `approve: DID NOT PAUSE`, exit 1 |
| `manager.resume` approve | approved call runs twice | yes (lying ledger) | evidence check | `approved call ran 2 times`, exit 1 |
| daemon auto-start from tarball | `dist/bin.js` is not the daemon entry | yes (layout test + CI auto-start step) | CI red | CI red before release |
| adopter install | npm resolves a tree other than the shrinkwrap | yes (`check-shrinkwrap-installed` in CI) | CI red | CI red before release |
| adopter install | old Node | yes (floor leg in CI) | npm engines warning | a warning at install; runtime behaviour on older Node is untested |
| release | published bytes differ from tested bytes | yes (Task 7 SHA-256 match to the `pack` output) | stop before publish | nothing is published |

No failure mode is untested, unhandled, AND silent together: **0 critical gaps.**

## Worktree parallelization

| Step | Modules touched | Depends on |
| --- | --- | --- |
| Tasks 1–3 (demo) | `packages/cli/src/demo`, `packages/cli/src/commands`, `packages/mcp/src/index.ts` | — |
| Task 4 (build + rename + version) | `packages/*/package.json`, `packages/cli/tsup.config.ts`, READMEs | — (touches `dispatch.ts` VERSION, which Task 3 also edits) |
| Task 5 (scripts + CI) | `scripts/`, `.github/` | Task 4 (the layout it packs) |
| Task 6 (docs + LICENSE) | `docs/alpha/`, READMEs, `packages/cli` | Tasks 3 and 4 (the demo output and bin names it documents) |

Lane A: Tasks 1 → 2 → 3. Lane B: Task 4, then Task 5. Both edit `packages/cli/src/dispatch.ts` (COMMANDS vs VERSION) and `packages/cli/src/integration.test.ts`: a conflict risk, so run them **sequentially** (1 → 2 → 3 → 4 → 5 → 6), as subagent-driven development does by default. Parallelism would save little on a six-task plan.

---

## Implementation tasks from the review

Every review finding was folded into Tasks 1–7 above; none became a separate task. The map, for the implementer:

- Task 1: `readOnly` upstream option (test gap: the "did not pause" branch).
- Task 2: `judgeEvidence()` pure judge + 11 predicate cases (codex 3 #5); `runDemo` never throws, cleanup armed first (codex 1 #11); real-policy and cannot-start failure tests.
- Task 3: "DID NOT PAUSE" render test; shared `times()`.
- Task 4: engines `>=22.12.0 <23 || >=24 <25` (D-R12, codex 2 #3); side-effect import scan (codex 3 #4); no `dts.resolve`.
- Task 5: shrinkwrap (D-R7), pnpm-version guard from `pnpm-lock.yaml` (D-R10, codex 2 #1), pack once + SHA-256 promote (D-R11), four check scripts with fixture failure proofs, Linux + macOS legs with target asserts (D-R9, codex 3 #1), hostile env + sentinel (codex 1 #8, codex 2 #5/#6), installed doctor (codex 2 #9).
- Task 6: `--ignore-scripts` (D-R8); exact tested targets (codex 2 #4); integrity-only disclosure.
- Task 7: promote the recorded candidate SHA's CI bytes; headSha and version checks (codex 3 #6); release notes with inline commands and the feedback link (DX D6, D9).
- DX review additions: Task 3 (header before run, Next line, help leads with demo, `src/version.ts`); **Task 3B, new** (pause message names `conduit approvals list`; deny-then-approve copy lines, fully quoted, safe-id gated; 401/403 advice branches on a supplied token); Task 4 Step 3b (Node guard + refusal CI job); Task 6 (guided scoped-token first call with `read -rs`, pinned-Node client config, troubleshooting, upgrade, feedback form, founder dogfood under a disposable account, README history claim corrected).

## Developer experience (plan-devex-review, 2026-09-25, DX POLISH)

### Persona

```
TARGET DEVELOPER PERSONA
========================
Who:       Builds with Claude Code or its own agent over MCP; holds GitHub and similar tokens
Context:   Got the alpha tarball from the founder; wants approvals before risky agent calls
Tolerance: ~15 min to first real value; runs commands verbatim, reads notes only when stuck
Expects:   npm-style install, one command to see it work, a clear next step, errors that say what to do
```

### Developer perspective (before this review; founder-confirmed)

The adopter verifies and installs the tarball and runs `conduit demo`. It passes, and the output ends at PASS with no next step. They find section 4 of the notes and pick a token for GitHub's MCP endpoint by guesswork. Their agent pauses on a write and says "a human must approve", but not how. They search the notes for `conduit approvals list`, copy two ids from a wide table, approve, and then must know to tell the agent it was approved. It works, but three things nobody told them at the moment they needed them. The fixes below target exactly those moments.

### Competitive benchmark (summary-grade: search snippets, pages not opened)

| Tool | TTHW | Notable DX choice |
| --- | --- | --- |
| executor.sh | not published | a pasted prompt makes the adopter's agent install and connect it |
| Preloop | not published | approvals pushed to phone, Slack, email, or webhook |
| Docker MCP Toolkit | not published | server catalog inside Docker Desktop |
| Conduit R3a (after review) | ~3 min to demo PASS; ~7-10 min to first governed call (estimates) | in-process proof of approve-once / deny-nothing; guided scoped-token first call |

Agent-driven setup (executor.sh's approach) was rejected for Conduit: it would route the adopter's token through their agent, contradicting the §9.2 boundary in the product's own first run. Push approvals are R5 scope.

### Magical moment

`conduit demo` (D-R2): "after approval the upstream received it 1 time, with the exact input; after denial … 0 times", counted by the upstream itself. Then the first governed call on the adopter's own scratch repo is the second moment (notes §4).

### Journey map (after fixes)

| Stage | Developer does | Friction found | Status |
| --- | --- | --- | --- |
| Discover | opens the release page | only a path to the notes | fixed: inline commands + links (Task 7 Step 3) |
| Install | verify, `npm install -g --ignore-scripts` | EACCES on system Node; unsupported Node installs with only a warning | fixed: notes (EACCES) + Node guard with CI proof (Task 4 3b, Task 5) |
| Hello world | `conduit demo` | silent wait; no next step after PASS | fixed: header before run, Next line (Task 3) |
| Real usage | key, add-mcp, client, approve | which token; client PATH; approve command unnamed; two-id copy; "now what" after approve | fixed: guided scoped PAT + founder dogfood (Task 6), absolute path, pause names the command, ready-to-run lines, notes step 7 (Task 3B) |
| Debug | something fails | wrong advice on a refused token; no troubleshooting page | fixed: 401/403 branches on supplied credential (Task 3B Step 6); "When something goes wrong" |
| Upgrade | next preview | nothing documented | fixed: "Moving to a later preview" (move state aside, never delete) |

### First-time confusion report (roleplay), with dispositions

1. Silent wait during the demo: fixed (header first).
2. Unverified guided token path: fixed by founder dogfood before the notes may recommend it (Task 6 Step 5b).
3. Two-id approve copy error: fixed (ready-to-run lines, `--state-dir` carried).

### DX scorecard

| Dimension | Before | After |
| --- | --- | --- |
| Getting started | 5 | 8 |
| CLI design | 6 | 8 |
| Error messages | 5 | 8 |
| Documentation | 4 | 8 |
| Upgrade path | 2 | 6 |
| Dev environment | 6 | 8 |
| Community | 5 | 6 |
| DX measurement | 1 | 7 |
| **Overall** | **4** | **7.5** |
| TTHW | ~15 min to first governed call | ~7-10 min (estimate; the feedback form measures it) |

Competitive rank: Competitive tier. Magical moment: designed, via the copy-paste demo command.

### DX NOT in scope

- Push approvals (phone, Slack, email): R5 "focused approval + evidence UX".
- Agent-driven setup: conflicts with the §9.2 credential boundary.
- Automatic telemetry of the first run: the feedback form asks instead, so no data leaves the adopter's machine unasked.
- Error codes with per-error doc pages: public R3.
- State migration between previews: R3a documents "move aside".
- Showing a paused call's arguments before approval (codex DX pass 2 #2): `approvals list` withholds them by design (the §3.3 projection keeps agent-supplied arguments off the socket, `packages/mcp/src/payloads.ts:168-181`), and approval evidence UX is R5 in the roadmap. The guided first call uses a scratch repository, so the adopter's blast radius stays small meanwhile.
- A native hidden-prompt / `--secret-stdin` for `add-mcp`: HANDOFF DEFERRED; the notes use `read -rs` + `unset` meanwhile.

### What already exists (DX)

- `KEYGEN_ONE_LINER` and the missing-key error already name `conduit key generate` (`packages/mcp/src/env.ts:114`).
- `mapFetchError`'s fixed-category messages (no upstream text) are kept; only the 401/403 advice branches.
- The existing `approvals list` table and its `INVARIANT /cli approvals` test are unchanged; the decide block is appended below them.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 5 | CONVERGED (adjudicated, both loops) | eng loop — pass 1: 0 P0 / 7 P1 / 5 P2; pass 2: 0 / 5 / 5; pass 3: 0 / 1 / 5. DX loop — pass 1: 2 / 7 / 6; pass 2: 0 / 4 / 3. All folded, relabelled, deferred, or rejected with evidence |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 11 issues (3 architecture, 3 code quality, 4 test gaps, 1 notes wording), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — (no UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | ISSUES OPEN (score < 8 by rule; 0 unresolved decisions) | score: 4/10 → 7.5/10; TTHW: ~15 min → ~7-10 min to first governed call (estimate; the feedback form measures it); mode DX POLISH; persona: agent builder with real credentials |

- **CODEX:** raw `codex exec`, `gpt-5.6-sol`, effort `high` throughout. Eng loop trigger: the plan changes dependency manifests and CI. DX loop trigger: the plan changes credential-handling messages in `provision.ts`. Prompts were inlined, with file reads forbidden. The eng loop found the design gaps (untested released bytes, npm-vs-pnpm tree, Node floor), then only seams. The DX loop found two P0s in the adopter-facing text and CLI: a token written into shell history, and injectable copy-paste lines. Both are fixed. Its confirming pass found one seam (terminal controls in ids), two overclaims, and one R5-scope item. Rejected with code evidence: eng pass 1 #1, #5, #6; eng pass 2 #10; DX pass 1 #9 (a public repo URL is not a personal URL). Relabelled per the adversarial-convergence rule: eng pass 2 #2 (graph equality → best-effort version-set guard). Both loops stopped by the written stop line, founder-confirmed.
- **CROSS-MODEL:** the reviews agree on the architecture (one tarball, in-process demo, entry rename). The eng review found the supply-chain posture gaps; Codex extended them and caught defects in every fold, including two security slips in the DX review's own notes (token in shell history, approve-by-default nudge). The one tension (graph equality) was resolved in favour of the relabel.
- **DX:** fixes landed in Tasks 3, 3B (new), 4, 5, 6, 7. Remaining gaps are deliberate and recorded: approval evidence UX (R5), native secret input and table-row sanitizing (HANDOFF DEFERRED), push approvals (R5). The DX score stays under 8 because upgrade (6) and community (6) are preview-scoped by §18.
- **VERDICT:** ENG CLEARED (plan). Codex converged on both loops. DX reviewed with every decision resolved; its sub-8 dimensions are scoped out by §18. Ready for the plan PR, then `superpowers:subagent-driven-development`.

NO UNRESOLVED DECISIONS
