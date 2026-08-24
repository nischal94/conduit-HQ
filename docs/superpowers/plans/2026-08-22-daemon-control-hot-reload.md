# Daemon Control Surface + Catalog Hot-Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One long-lived runtime inside `conduitd` with catalog hot-reload at the provisioning tail, a `control` capability (`daemon.status`, `daemon.stop`) with a `conduit daemon` CLI, version-skew warnings, a bounded daemon log, and a version-sync guard.

**Architecture:** The daemon builds one `ApprovalRuntime` at start; every connection shares it. The provisioning tail refreshes the shared catalog after commit, inside the per-namespace source lock. Control verbs ride the existing UDS RPC as a new capability row, answered outside the execution queue, with handlers in a transport-agnostic module taking an explicit `Principal` (step 4 mounts them over HTTP). The daemon's log moves from inherited stderr to a daemon-owned rotating sink.

**Tech Stack:** TypeScript (Node stdlib only), vitest, existing `@conduithq/sdk` + `@conduithq/mcp` + `@conduithq/cli` packages.

**Spec:** `docs/superpowers/specs/2026-08-22-daemon-control-hot-reload-design.md` (revision 2, three-pass-reviewed). Parent: `docs/superpowers/specs/2026-08-15-daemon-ownership-design.md`.

## Global Constraints

- **Zero new dependencies.** Node stdlib only; hand-written decoders (no zod/ajv).
- **No SQL schema changes.**
- **Capability rows for `serve`, `approvals`, `add-mcp` are UNCHANGED** — no admin verb ever lands on `serve` (§3.1).
- **No HTTP listener, route, port, or CORS/CSRF machinery** (step 4).
- **No RPC response may carry a master key, plaintext credential, credential-bearing header, or repository row** (§3.3/§9.2).
- **Commits run with sandbox-disabled Bash, NEVER `--no-verify`** (pre-commit runs the sdk suite + spec drift).
- **All test commands run in the FOREGROUND** (subagent background runs die with the turn).
- **Atomicity tests use file-backed temp dbs, never `:memory:`** (libsql swaps `:memory:` to a fresh db per client use).
- **Invariant tests carry the `INVARIANT §17:` title prefix** and their `INVARIANTS.md` row flips in the same commit as the module.
- **`npx`/`pnpm exec` are blocked** — use `packages/<p>/node_modules/.bin/vitest` / `.bin/tsc` directly. The agent never installs anything.
- **Public-safe writing** in every committed file: no machine paths, no personal URLs.
- **Normative constants** get a doc comment naming them normative-local (follow `RESUME_ADMISSION_DEADLINE_MS`'s pattern).
- Branch: cut `feat/daemon-control` from `docs/daemon-control-design` (so spec + plan ride the PR, per the PR #41/#46 precedent).

---

### Task 1: RPC vocabulary — `control` capability, `daemon.status` / `daemon.stop` kinds, status payload type

**Files:**
- Modify: `packages/mcp/src/daemon/rpc.ts`
- Modify: `packages/mcp/src/payloads.ts`
- Test: `packages/mcp/src/daemon/rpc.test.ts` (extend)

**Interfaces:**
- Consumes: existing `RpcRequest`, `CAPABILITIES`, `RpcPayloadFor`.
- Produces: `RpcRequest` variants `{ kind: "daemon.status" }` and `{ kind: "daemon.stop" }` (both nullary); `CAPABILITIES.control = Set(["handshake","daemon.status","daemon.stop"])`; `interface DaemonStatusPayload` and `interface DaemonStopPayload { stopping: true }` in payloads.ts; `RpcPayloadFor` maps both kinds.

- [ ] **Step 1: Write the failing tests** (append to `rpc.test.ts`)

```typescript
describe("control vocabulary", () => {
  it("decodes daemon.status and daemon.stop as nullary requests", () => {
    expect(decodeRequest({ kind: "daemon.status" })).toEqual({ kind: "daemon.status" });
    expect(decodeRequest({ kind: "daemon.stop" })).toEqual({ kind: "daemon.stop" });
  });

  it("rejects any field on the nullary control kinds — a client steers nothing", () => {
    expect(() => decodeRequest({ kind: "daemon.status", verbose: true })).toThrow(
      InvalidRpcRequest,
    );
    expect(() => decodeRequest({ kind: "daemon.stop", force: true })).toThrow(InvalidRpcRequest);
  });

  it("accepts a control-capability handshake", () => {
    expect(decodeRequest({ kind: "handshake", protocol: 1, capability: "control" })).toEqual({
      kind: "handshake",
      protocol: 1,
      capability: "control",
    });
  });

  it("scopes the control row to exactly handshake + the two daemon verbs", () => {
    expect([...CAPABILITIES.control].sort()).toEqual([
      "daemon.status",
      "daemon.stop",
      "handshake",
    ]);
  });

  it("leaves the serve/approvals/add-mcp rows without any control verb", () => {
    for (const row of ["serve", "approvals", "add-mcp"] as const) {
      expect(CAPABILITIES[row].has("daemon.status")).toBe(false);
      expect(CAPABILITIES[row].has("daemon.stop")).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `packages/mcp/node_modules/.bin/vitest run src/daemon/rpc.test.ts` (from `packages/mcp`)
Expected: FAIL — `unknown request kind "daemon.status"`, missing `control` row.

- [ ] **Step 3: Implement**

In `rpc.ts`:
1. Add to the `RpcRequest` union (after `source.revalidate`, with a doc comment citing spec §3.1: nullary on purpose, answered outside the queue, capability-scoped to `control` only):

```typescript
  | { kind: "daemon.status" }
  | { kind: "daemon.stop" };
```

2. Add decode cases (mirror `catalog.listing`'s nullary pattern):

```typescript
    case "daemon.status": {
      assertNoExtraKeys(v, ["kind"]);
      return { kind: "daemon.status" };
    }
    case "daemon.stop": {
      assertNoExtraKeys(v, ["kind"]);
      return { kind: "daemon.stop" };
    }
```

3. Extend the `CAPABILITIES` record type to `Record<"serve" | "approvals" | "add-mcp" | "control", ...>` and add (with a doc comment: capability scopes honest clients; it is NOT a privilege boundary against a hostile same-UID process — parent design's accepted v1 limit, spec §3.1):

```typescript
  control: new Set(["handshake", "daemon.status", "daemon.stop"]),
```

In `payloads.ts`, add near `CatalogListing` (doc comment: projection computed daemon-side, defined metric semantics per spec §3.1; no credential-adjacent material; `logPath`/`logSizeBytes` null when the daemon logs to a TTY):

```typescript
export interface DaemonStatusPayload {
  pid: number;
  agentVersion: string;
  /** Epoch ms the daemon's serve loop started. */
  startedAt: number;
  dbPath: string;
  /** READY-granted open sockets, the asking connection included. */
  connections: number;
  /** Queue entries currently running. */
  executionsInFlight: number;
  /** Queue entries admitted and waiting. */
  queueDepth: number;
  logPath: string | null;
  logSizeBytes: number | null;
}

export interface DaemonStopPayload {
  stopping: true;
}
```

Extend `RpcPayloadFor` with two arms before the final `unknown`:

```typescript
            : K extends "daemon.status"
              ? DaemonStatusPayload
              : K extends "daemon.stop"
                ? DaemonStopPayload
                : unknown;
```

- [ ] **Step 4: Run tests + typecheck**

Run: `packages/mcp/node_modules/.bin/vitest run src/daemon/rpc.test.ts` then `packages/mcp/node_modules/.bin/tsc --noEmit -p .`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/daemon/rpc.ts packages/mcp/src/payloads.ts packages/mcp/src/daemon/rpc.test.ts
git commit -m "feat(mcp): add control capability vocabulary to the daemon RPC"
```

---

### Task 2: Long-lived runtime — one `ApprovalRuntime` per daemon, shared catalog serves search/describe

**Files:**
- Modify: `packages/mcp/src/runtime.ts`
- Modify: `packages/mcp/src/daemon/conduitd.ts` (the `serve` function)
- Modify: `packages/mcp/src/daemon/connection.ts`
- Test: `packages/mcp/src/daemon/conduitd.test.ts` (extend), `packages/mcp/src/runtime.test.ts` (extend)

**Interfaces:**
- Consumes: `createApprovalRuntime` (runtime.ts), `ConnectionDeps` (connection.ts), `serve` (conduitd.ts), `InMemoryCatalog` from `@conduithq/sdk`.
- Produces: `ApprovalRuntime` gains `catalog: InMemoryCatalog`; `ConnectionDeps` REPLACES `createRuntime: typeof createApprovalRuntime` with `runtime: ApprovalRuntime`; `serve()` builds the runtime once via `opts.createRuntime` (the injectable test seam on `RunDaemonOptions` is unchanged — it is now called exactly once per daemon). `snapshotCatalog` is DELETED from connection.ts.

- [ ] **Step 1: Write the failing tests**

In `runtime.test.ts` (or create the describe block if absent):

```typescript
it("exposes the catalog it hydrated so the daemon can serve and refresh it", async () => {
  const store = await openTestStore(); // use the file's existing store helper
  const runtime = await createApprovalRuntime({ store, allowPrivateEgress: false });
  expect(runtime.catalog).toBeInstanceOf(InMemoryCatalog);
  expect(runtime.catalog.size).toBe((await store.tools.list()).length);
});
```

In `conduitd.test.ts` (using the existing spawned-daemon test helpers in `helpers/` — follow the file's established fixture pattern for starting a daemon with an injected `createRuntime`):

```typescript
it("builds ONE runtime per daemon process and reuses it across requests", async () => {
  let builds = 0;
  // start a daemon via the existing fixture, passing:
  //   createRuntime: async (opts) => { builds += 1; return createApprovalRuntime(opts); }
  // then issue two execute requests and one search through clients.
  // Assert afterward:
  expect(builds).toBe(1);
});

it("INVARIANT §17: search reads the daemon's shared catalog, not a per-call store snapshot", async () => {
  // start a daemon with an injected createRuntime that KEEPS a reference
  // to the runtime it built:
  //   let shared: ApprovalRuntime | undefined;
  //   createRuntime: async (opts) => { shared = await createApprovalRuntime(opts); return shared; }
  // 1. serve-client search for "planted" -> expect zero hits.
  // 2. Mutate the shared catalog DIRECTLY — no store write:
  //      shared!.catalog.upsert([{ name: "planted.tool", namespace: "planted",
  //        description: "planted directly", riskClass: "safe" }]);
  // 3. serve-client search for "planted" again on a FRESH connection ->
  //    expect a hit for "planted.tool".
  // A per-call store snapshot cannot see this tool (it exists nowhere in
  // the store), so this test fails if the search path bypasses the
  // shared catalog.
});

it("runs two overlapping executions through the one shared runtime", async () => {
  // start a daemon (real createApprovalRuntime), then fire two `execute`
  // requests CONCURRENTLY (Promise.all over two serve clients), each with
  // code that returns a distinct literal. Assert both complete with their
  // own correct result payloads — the shared sandbox/manager must not
  // cross their answers.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `packages/mcp/node_modules/.bin/vitest run src/runtime.test.ts src/daemon/conduitd.test.ts`
Expected: FAIL — `runtime.catalog` undefined; `builds` is >1; planted tool not found.

- [ ] **Step 3: Implement**

`runtime.ts`:

```typescript
export interface ApprovalRuntime {
  manager: ExecutionManager;
  /**
   * The one cached piece of state in the composition (spec §2.1): policy
   * and credentials read the store live per decision, the manager is
   * store-backed, the sandbox module is process-shared with its own
   * poison/rebuild recovery. The daemon refreshes this catalog at the
   * provisioning tail; nothing else mutates it.
   */
  catalog: InMemoryCatalog;
}
```

Return `{ manager, catalog }`. REWRITE the docblock: delete the "Callers MUST invoke this fresh per unit of work (M6)" contract and replace with: "Built ONCE per daemon process (spec §2.1). The M6 per-call rehydration was the no-owner workaround; the daemon's catalog is authoritative because the daemon is the only writer."

`connection.ts`:
1. In `ConnectionDeps`: replace `createRuntime: typeof createApprovalRuntime;` with `runtime: ApprovalRuntime;` (import the type from `../runtime.js`). Delete the now-unused `createApprovalRuntime` type import and the `InMemoryCatalog` import.
2. Delete `snapshotCatalog` entirely.
3. `execute` handler: replace the two lines building a fresh runtime with `const { manager } = deps.runtime;` (keep the requestKey forwarding exactly as is).
4. `approvals.resume` handler: same replacement.
5. `search` handler: `sendResult(ctx, requestId, deps.runtime.catalog.search({ query: request.query }), log);`
6. `describe` handler: `sendResult(ctx, requestId, deps.runtime.catalog.describe(request.toolName) ?? null, log);`

`conduitd.ts` `serve()`: before building `connectionDeps`:

```typescript
  // ONE runtime for the daemon's whole life (spec §2.1). Built after the
  // store opened, before the socket binds: hydration failure is fail-closed
  // — the throw propagates out of serve(), the socket never binds, and the
  // locks release through startDaemon's finally. A credential boundary
  // does not limp.
  const runtime = await createRuntime({ store, allowPrivateEgress, log });
```

and in `connectionDeps`, replace `createRuntime,` with `runtime,`.

Update any conduitd/connection unit tests that construct `ConnectionDeps` directly: build a runtime once in the fixture and pass it.

- [ ] **Step 4: Run the full mcp suite + typecheck**

Run: `packages/mcp/node_modules/.bin/vitest run` then `tsc --noEmit -p .`
Expected: all green (existing e2e "a source added via one client is visible to another" stays green — per-call snapshots are gone but the shared catalog is refreshed nowhere yet, so IF that e2e fails here, STOP: it means the existing test covers refresh, and Task 3's hook must land in the same commit as this task. In that case squash Tasks 2+3.)

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/runtime.ts packages/mcp/src/daemon/conduitd.ts packages/mcp/src/daemon/connection.ts packages/mcp/src/runtime.test.ts packages/mcp/src/daemon/conduitd.test.ts
git commit -m "feat(mcp): one long-lived runtime per daemon; search reads the shared catalog"
```

---

### Task 3: Hot-reload — catalog refresh at the provisioning tail, with recovery

**Files:**
- Modify: `packages/mcp/src/daemon/connection.ts` (provision/revalidate handlers)
- Modify: `INVARIANTS.md` (row flip)
- Test: `packages/mcp/src/daemon/conduitd.test.ts` (extend)

**Interfaces:**
- Consumes: `deps.runtime.catalog` (Task 2), `deps.withSourceLock` (existing), `deps.store.tools.list()` (existing), `provisionSourceRequest`/`revalidateSourceRequest` (existing).
- Produces: `refreshNamespace(deps, namespace)` — internal to connection.ts, NEVER throws; called inside the held source lock after a successful commit, by BOTH handlers.

- [ ] **Step 1: Write the failing tests** (in `conduitd.test.ts`, spawned-daemon fixtures)

```typescript
it("INVARIANT §17: a source added via one client is visible to another with no restart", async () => {
  // If a test with this exact title already exists from Lane B, KEEP it —
  // verify it still passes against the long-lived runtime and move on.
  // Otherwise: start a daemon + a stub upstream MCP server (the file's
  // existing stub-upstream helper); connect a serve client and search for
  // the stub's tool name -> zero hits; provision the stub via an add-mcp
  // client (source.provision); search again via serve -> the stub's tools
  // appear. No daemon restart in between.
});

it("refreshes the shared catalog on source.revalidate too (the shared-tail hook)", async () => {
  // provision a stub upstream; then CHANGE the stub's advertised tools/list
  // (the stub helpers support re-arming the response); send
  // source.revalidate for the namespace; serve-client search must now find
  // the NEW tool name and no longer find the old one.
});

it("recovers by rehydrating when the catalog refresh throws after commit", async () => {
  // Inject a runtime whose catalog throws ONCE:
  //   const runtime = await createApprovalRuntime(opts);
  //   const realRemove = runtime.catalog.removeNamespace.bind(runtime.catalog);
  //   let poisoned = true;
  //   runtime.catalog.removeNamespace = (ns) => {
  //     if (poisoned) { poisoned = false; throw new Error("injected refresh failure"); }
  //     realRemove(ns);
  //   };
  // provision a stub source. The provision RESPONSE must still be a
  // success result (the commit landed; refresh failure never turns a
  // committed write into an error answer). A serve-client search must
  // still find the new tools (the rehydrate fallback ran).
});
```

- [ ] **Step 2: Run to verify failure**

Run: `packages/mcp/node_modules/.bin/vitest run src/daemon/conduitd.test.ts`
Expected: FAIL — provisioned tools invisible to the already-running daemon's search.

- [ ] **Step 3: Implement** (connection.ts)

Add below `runSourceRequest`:

```typescript
/**
 * Refreshes the shared catalog after a provisioning commit (spec §2.2).
 *
 * Runs INSIDE the held per-namespace source lock, so catalog publication
 * order matches commit order. The store read happens FIRST; the two
 * catalog mutations then run synchronously in one tick, so no request can
 * observe the removed-but-not-upserted state.
 *
 * NEVER throws: a refresh failure after a committed write must not turn
 * the operator's successful provisioning into an error answer. Recovery
 * ladder: full rehydrate from the store; failing that, keep serving the
 * previous catalog (stale-but-consistent — repaired by the next
 * provision or restart), with both failures logged.
 */
async function refreshNamespace(deps: ConnectionDeps, namespace: string): Promise<void> {
  const { log } = deps;
  try {
    const tools = await deps.store.tools.list();
    deps.runtime.catalog.removeNamespace(namespace);
    deps.runtime.catalog.upsert(tools);
  } catch (err) {
    log(
      `[conduitd] Catalog refresh failed after commit: attempting full rehydrate. Context: {namespace: ${namespace}, cause: ${
        err instanceof Error ? err.message : String(err)
      }}`,
    );
    try {
      deps.runtime.catalog.upsert(await deps.store.tools.list());
      log(`[conduitd] Catalog rehydrated after refresh failure. Context: {namespace: ${namespace}}`);
    } catch (err2) {
      log(
        `[conduitd] Catalog rehydrate failed: serving the previous catalog until the next provision or restart. Context: {namespace: ${namespace}, cause: ${
          err2 instanceof Error ? err2.message : String(err2)
        }}`,
      );
    }
  }
}
```

Rewrite the two handlers so the refresh runs inside the lock, after the commit:

```typescript
    case "source.provision": {
      await runSourceRequest(ctx, requestId, deps, () =>
        deps.withSourceLock(request.namespace, async () => {
          const payload = await provisionSourceRequest(
            {
              namespace: request.namespace,
              url: request.url,
              prefix: request.prefix,
              replace: request.replace,
              clearCredential: request.clearCredential,
              ...(request.secret !== undefined ? { secret: request.secret } : {}),
            },
            { store, log },
          );
          // Hot-reload hook (spec §2.2): after the commit, still inside the
          // source lock. Never throws.
          await refreshNamespace(deps, request.namespace);
          return payload;
        }),
      );
      return;
    }
    case "source.revalidate": {
      await runSourceRequest(ctx, requestId, deps, () =>
        deps.withSourceLock(request.namespace, async () => {
          const payload = await revalidateSourceRequest(request.namespace, { store, log });
          await refreshNamespace(deps, request.namespace);
          return payload;
        }),
      );
      return;
    }
```

In `INVARIANTS.md`: find the §17 row for "a source added via one client is visible to another with no restart"; set/keep it ✅ quoting the exact test title. If no such row exists, add one under the §17 section following the file's row format.

**Bounded-input verification (spec §2.2, required):** read `provision.ts`'s `tools/list` handling and the shared MCP client's response limits. Confirm a cap exists on (a) total response bytes, (b) tool count, and (c) per-tool name/description size BEFORE the commit. If any of the three is missing, add it in this task with a `ProvisionRefused` refusal naming the limit (normative-local constants, e.g. `MAX_TOOLS_PER_SOURCE = 512`, `MAX_TOOL_TEXT_BYTES = 16 * 1024`) plus one test per added cap (stub upstream returns an oversized `tools/list` → provision refused, nothing committed, catalog untouched). If all three exist, note where in the task's commit message body and add no code.

- [ ] **Step 4: Run the full mcp suite**

Run: `packages/mcp/node_modules/.bin/vitest run`
Expected: PASS incl. all three new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/daemon/connection.ts packages/mcp/src/daemon/conduitd.test.ts INVARIANTS.md
git commit -m "feat(mcp): hot-reload the shared catalog at the provisioning tail"
```

---

### Task 4: Control handlers — `control.ts` module, connection dispatch, flushed stop ack

**Files:**
- Create: `packages/mcp/src/daemon/control.ts`
- Modify: `packages/mcp/src/daemon/connection.ts`, `packages/mcp/src/daemon/conduitd.ts`
- Test: `packages/mcp/src/daemon/control.test.ts` (create), `packages/mcp/src/daemon/conduitd.test.ts` (extend)

**Interfaces:**
- Consumes: `DaemonStatusPayload`/`DaemonStopPayload` (Task 1), `ConnectionDeps` (Task 2 shape), `StopSignal` via a `requestStop` closure.
- Produces:
  - `control.ts`: `export type Principal = { kind: "anonymous-local" };`
    `export interface ControlDeps { pid: () => number; agentVersion: string; startedAt: number; dbPath: string; connectionCount: () => number; queueStats: () => { depth: number; activeCount: number }; logInfo: () => { path: string; sizeBytes: number } | null; }`
    `export function daemonStatus(principal: Principal, deps: ControlDeps): DaemonStatusPayload`
    `export function daemonStop(principal: Principal): DaemonStopPayload`
  - `ConnectionDeps` gains: `startedAt: number; requestStop: () => void; logInfo: () => { path: string; sizeBytes: number } | null;`
  - `RunDaemonOptions` gains: `logInfo?: () => { path: string; sizeBytes: number } | null;` (default `() => null`; Task 6 wires the real one).

- [ ] **Step 1: Write the failing tests**

`control.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { daemonStatus, daemonStop, type Principal } from "./control.js";

const anon: Principal = { kind: "anonymous-local" };

const deps = {
  pid: () => 4242,
  agentVersion: "0.1.0",
  startedAt: 1_000,
  dbPath: "/tmp/x/conduit.db",
  connectionCount: () => 3,
  queueStats: () => ({ depth: 2, activeCount: 1 }),
  logInfo: () => ({ path: "/tmp/x/conduitd.log", sizeBytes: 512 }),
};

describe("daemonStatus", () => {
  it("projects exactly the defined status fields", () => {
    expect(daemonStatus(anon, deps)).toEqual({
      pid: 4242,
      agentVersion: "0.1.0",
      startedAt: 1_000,
      dbPath: "/tmp/x/conduit.db",
      connections: 3,
      executionsInFlight: 1,
      queueDepth: 2,
      logPath: "/tmp/x/conduitd.log",
      logSizeBytes: 512,
    });
  });

  it("reports null log fields when the daemon logs to a TTY", () => {
    const status = daemonStatus(anon, { ...deps, logInfo: () => null });
    expect(status.logPath).toBeNull();
    expect(status.logSizeBytes).toBeNull();
  });
});

describe("daemonStop", () => {
  it("returns the stopping intent — the transport performs the flush-then-stop", () => {
    expect(daemonStop(anon)).toEqual({ stopping: true });
  });
});
```

`conduitd.test.ts` additions (spawned-daemon fixtures; issue requests via a raw `control`-capability client, the same low-level request helper the file already uses):

```typescript
it("answers daemon.status for a control client with live counts and no credential material", async () => {
  // start daemon; issue {kind:"daemon.status"} with capability "control".
  // Assert: result payload has pid > 0, agentVersion === AGENT_VERSION,
  // dbPath ending in "conduit.db", connections >= 1, finite queueDepth and
  // executionsInFlight. Assert the serialized payload contains NO key
  // named "credentialRef", "secret", or "masterKey".
});

it("rejects control verbs from serve, and serve/provision verbs from control", async () => {
  // serve-capability client sends daemon.stop -> error frame, code
  // "invalid", message naming the capability.
  // control-capability client sends {kind:"search",query:"x"} -> same
  // rejection. Also send {kind:"source.provision",...} from control ->
  // rejected. (Both directions: spec §9.)
});

it("daemon.stop drains live work: an active execution and a queued request both resolve", async () => {
  // 1. Fill the daemon: submit ONE long-running execute (guest code that
  //    loops until its wall clock budget; use a small deadlineMs) plus one
  //    quick queued execute behind it.
  // 2. From a control client, send daemon.stop -> expect result
  //    {stopping:true} BEFORE the executions finish.
  // 3. Await both execute promises: each must resolve with a real
  //    result/error frame, not a destroyed socket. (The drain finishes
  //    accepted work; §3.3.)
  // 4. Then the daemon process exits; assert its lifecycle lock probe
  //    reads "free" within the drain deadline.
});

it("stop is prompt when nothing is in flight", async () => {
  // daemon.stop on an idle daemon: measure from the stop ack to the
  // lifecycle lock reading "free"; assert < 5_000 ms (far below the 30s
  // drain deadline — pins the one-shot client disconnect assumption).
});

it("a second daemon.stop and a SIGTERM racing the first are idempotent", async () => {
  // send daemon.stop twice back-to-back from two control clients, and
  // process.kill(pid, "SIGTERM") immediately after. Daemon exits cleanly
  // exactly once; both stop requests got answers or clean disconnects;
  // no crash line in the daemon log.
});

it("a paused approval created before an RPC stop is resumable after the next start", async () => {
  // provision stub with a destructive tool; execute code that pauses on
  // approval; daemon.stop; start a NEW daemon (fixture); approvals.list
  // shows the paused row; approvals.resume approve drives it to a
  // terminal status. (Extends the existing signal-stop invariant to the
  // RPC path.)
});
```

- [ ] **Step 2: Run to verify failure**

Run: `packages/mcp/node_modules/.bin/vitest run src/daemon/control.test.ts src/daemon/conduitd.test.ts`
Expected: FAIL — module missing; daemon answers `capability "control"`-handshakes fine (Task 1) but `daemon.status` hits no dispatch arm.

- [ ] **Step 3: Implement**

`control.ts` (module docblock: transport-agnostic control handlers, spec §7 — the principal is constructed by the TRANSPORT server-side, never decoded from the request; step 4 mounts these over HTTP behind the §16 floor; `_principal` is unused today because `anonymous-local` is the only variant, and authorization stays with the capability row):

```typescript
import type { DaemonStatusPayload, DaemonStopPayload } from "../payloads.js";

export type Principal = { kind: "anonymous-local" };

export interface ControlDeps {
  pid: () => number;
  agentVersion: string;
  startedAt: number;
  dbPath: string;
  connectionCount: () => number;
  queueStats: () => { depth: number; activeCount: number };
  logInfo: () => { path: string; sizeBytes: number } | null;
}

export function daemonStatus(_principal: Principal, deps: ControlDeps): DaemonStatusPayload {
  const queue = deps.queueStats();
  const log = deps.logInfo();
  return {
    pid: deps.pid(),
    agentVersion: deps.agentVersion,
    startedAt: deps.startedAt,
    dbPath: deps.dbPath,
    connections: deps.connectionCount(),
    executionsInFlight: queue.activeCount,
    queueDepth: queue.depth,
    logPath: log === null ? null : log.path,
    logSizeBytes: log === null ? null : log.sizeBytes,
  };
}

/**
 * Returns the stopping intent only. The TRANSPORT flushes the response
 * frame and THEN triggers the stop (spec §3.1): signaling shutdown before
 * the ack is on the wire could close the connection under the reply.
 */
export function daemonStop(_principal: Principal): DaemonStopPayload {
  return { stopping: true };
}
```

`connection.ts`:
1. Extend `ConnectionDeps` with `startedAt: number; requestStop: () => void; logInfo: () => { path: string; sizeBytes: number } | null;`. (`queueStats` already exists and already carries `activeCount`/`depth`.)
2. Import `daemonStatus, daemonStop` and `encodeFrame` (already imported).
3. Add dispatch arms in `handleRequest` alongside the other non-queued reads (doc comment: answered OUTSIDE the ExecutionQueue like `approvals.list` — a busy daemon must not answer its own stop with `busy`, spec §3.1):

```typescript
    case "daemon.status": {
      sendResult(
        ctx,
        requestId,
        daemonStatus(
          { kind: "anonymous-local" },
          {
            pid: () => process.pid,
            agentVersion: deps.agentVersion,
            startedAt: deps.startedAt,
            dbPath: deps.dbPath,
            connectionCount: () =>
              [...deps.connections].filter((c) => c.readyGranted && !c.socket.destroyed).length,
            queueStats: () => {
              const stats = deps.queueStats();
              return { depth: stats.depth, activeCount: stats.activeCount };
            },
            logInfo: deps.logInfo,
          },
        ),
        log,
      );
      return;
    }
    case "daemon.stop": {
      // Flush-then-stop (spec §3.1): the write callback fires once the
      // frame is handed to the kernel, and only then does the drain begin.
      // A destroyed peer skips the write; stop still proceeds — the
      // operator asked for it.
      const payload = daemonStop({ kind: "anonymous-local" });
      if (ctx.socket.destroyed) {
        deps.requestStop();
        return;
      }
      ctx.socket.write(
        encodeFrame({ kind: "result", requestId, payload }),
        () => deps.requestStop(),
      );
      return;
    }
```

`conduitd.ts` `serve()`: add `const startedAt = Date.now();` next to the runtime build; extend `connectionDeps` with:

```typescript
    startedAt,
    requestStop: () => stopSignal.request(),
    logInfo: opts.logInfo ?? (() => null),
```

Thread `logInfo` through `ServeOptions` and `RunDaemonOptions` (optional, default `() => null`).

- [ ] **Step 4: Run the full mcp suite + typecheck**

Run: `packages/mcp/node_modules/.bin/vitest run` then `tsc --noEmit -p .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/daemon/control.ts packages/mcp/src/daemon/control.test.ts packages/mcp/src/daemon/connection.ts packages/mcp/src/daemon/conduitd.ts packages/mcp/src/daemon/conduitd.test.ts
git commit -m "feat(mcp): daemon.status and daemon.stop control handlers"
```

---

### Task 5: Rotating log sink — daemon-owned fd, byte-accurate cap, `--debug` volume gate

**Files:**
- Create: `packages/mcp/src/daemon/log-sink.ts`
- Modify: `packages/mcp/src/daemon/spawn.ts`, `packages/mcp/src/bin.ts`, `packages/mcp/src/daemon/conduitd.ts`, `packages/mcp/src/daemon/connection.ts`
- Test: `packages/mcp/src/daemon/log-sink.test.ts` (create), `packages/mcp/src/daemon/conduitd.test.ts` (extend)

**Interfaces:**
- Consumes: `DAEMON_LOG` (spawn.ts), state dir path.
- Produces:
  - `log-sink.ts`: `export const LOG_MAX_BYTES = 5 * 1024 * 1024;` `export const LOG_LINE_MAX_BYTES = 8 * 1024;` `export interface RotatingLog { log: (line: string) => void; info: () => { path: string; sizeBytes: number }; close: () => void; }` `export function createRotatingLog(stateDir: string): RotatingLog`
  - `ConnectionDeps` gains `logDebug: (line: string) => void` (per-admission lines move to it).
  - `RunDaemonOptions` gains `debug?: boolean`.
  - `spawnDaemon` threads `--debug` when the SPAWNING environment sets `CONDUIT_DAEMON_DEBUG=1` (read client-side; the constructed child env stays exactly `{ PATH }`).

- [ ] **Step 1: Write the failing tests**

`log-sink.test.ts` (use `mkdtempSync(join(tmpdir(), "sink-"))` per test):

```typescript
describe("createRotatingLog", () => {
  it("appends lines to conduitd.log in the state dir, 0600", () => {
    // write two lines; readFileSync shows both, each newline-terminated;
    // statSync(...).mode & 0o777 === 0o600.
  });

  it("counts existing bytes: a reopened sink continues the running total", () => {
    // pre-write a file of N bytes; createRotatingLog; info().sizeBytes === N.
  });

  it("rotates at the cap: current -> .1 (replacing any previous .1), fresh active file", () => {
    // set up: write until just under LOG_MAX_BYTES (write large lines),
    // then one more line -> conduitd.log.1 exists holding the old bytes,
    // conduitd.log holds only the new line, info().sizeBytes is small.
    // A pre-existing conduitd.log.1 gets REPLACED, not appended.
  });

  it("truncates a single oversized line to LOG_LINE_MAX_BYTES", () => {
    // log("x".repeat(LOG_LINE_MAX_BYTES * 2)); active file size <=
    // LOG_LINE_MAX_BYTES + a small suffix allowance; content ends with
    // "…[truncated]\n".
  });

  it("keeps logging through a rotation failure", () => {
    // make rename fail: chmod the state dir read-only (skip on root/CI
    // where chmod is a no-op: guard with a canary chmod+probe, and
    // it.skipIf when the probe shows writes still succeed).
    // log past the cap -> no throw; lines still land in the (over-cap)
    // active file.
  });
});
```

`conduitd.test.ts` addition:

```typescript
it("bounds the ON-DISK active log under real daemon logging (fd ownership, not just the sink object)", async () => {
  // start a daemon via the SPAWN path against a temp state dir with
  // CONDUIT_DAEMON_DEBUG unset. Drive enough requests to produce log
  // traffic. Assert statSync(join(stateDir, "conduitd.log")).size stays
  // below LOG_MAX_BYTES + LOG_LINE_MAX_BYTES at every sample point.
  // (Full rotation under real traffic needs 5MB of lines — this test pins
  // the BOUND property; the rotation mechanics are pinned unit-side.)
});
```

- [ ] **Step 2: Run to verify failure**

Run: `packages/mcp/node_modules/.bin/vitest run src/daemon/log-sink.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`log-sink.ts` (docblock: spec §5 — the daemon OWNS its log fd; the inherited-stderr path cannot be bounded because append fds follow the inode and Node has no dup2. Residual fd-2 traffic — Node warnings, stack traces — still follows the inherited fd and is accepted as bounded-in-practice best effort. Rotation stays inside the lstat-verified 0700 state dir. Concurrent appenders — the spawning client's failure line, a losing auto-start child — follow the renamed inode into `.1`, which is correct; the single-writer claim is deliberately NOT made):

```typescript
import { closeSync, fstatSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_LOG } from "./spawn.js";

/** Normative-local (spec §5): active-file cap; worst case on disk ~2x. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Normative-local (spec §5): single-line cap so one write cannot blow the budget. */
export const LOG_LINE_MAX_BYTES = 8 * 1024;
/** Retry a failed rotation only after this much MORE has been written. */
const ROTATE_RETRY_BYTES = 64 * 1024;

export interface RotatingLog {
  log: (line: string) => void;
  info: () => { path: string; sizeBytes: number };
  close: () => void;
}

export function createRotatingLog(stateDir: string): RotatingLog {
  const path = join(stateDir, DAEMON_LOG);
  let fd = openSync(path, "a", 0o600);
  let bytes = fstatSync(fd).size;
  let nextRotateAttempt = LOG_MAX_BYTES;

  const rotate = (): void => {
    try {
      renameSync(path, `${path}.1`);
      const fresh = openSync(path, "a", 0o600);
      closeSync(fd);
      fd = fresh;
      bytes = 0;
      nextRotateAttempt = LOG_MAX_BYTES;
    } catch (err) {
      // Keep the old fd; logging degrades, the daemon never dies for its
      // log (spec §5/§8). Retry only after ROTATE_RETRY_BYTES more.
      nextRotateAttempt = bytes + ROTATE_RETRY_BYTES;
      try {
        const note = `[conduitd] Log rotation failed: keeping the current file. Context: {cause: ${
          err instanceof Error ? err.message : String(err)
        }}\n`;
        writeSync(fd, note);
        bytes += Buffer.byteLength(note);
      } catch {
        /* nothing left to report through */
      }
    }
  };

  return {
    log(line: string): void {
      let text = line;
      if (Buffer.byteLength(text) > LOG_LINE_MAX_BYTES) {
        text = `${Buffer.from(text).subarray(0, LOG_LINE_MAX_BYTES).toString()}…[truncated]`;
      }
      const buf = Buffer.from(`${text}\n`);
      if (bytes + buf.length > nextRotateAttempt) rotate();
      try {
        writeSync(fd, buf);
        bytes += buf.length;
      } catch {
        /* ENOSPC-class: degrade best-effort (spec §5) */
      }
    },
    info: () => ({ path, sizeBytes: bytes }),
    close: () => {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    },
  };
}
```

`connection.ts`: add `logDebug: (line: string) => void;` to `ConnectionDeps`. In `submitSandboxWork`, switch the two `queue depth=` lines from `log(...)` to `deps.logDebug(...)` (doc comment: per-admission volume behind the debug gate, spec §5; lifecycle and error lines stay on `log`).

`conduitd.ts`: `RunDaemonOptions` gains `debug?: boolean`. In `serve()`'s `connectionDeps`: `logDebug: opts.debug === true ? log : () => {},` (thread `debug` through `ServeOptions` like `logInfo`).

`bin.ts` `--daemon` branch: parse a `--debug` flag off the daemon argv. Build the sink (read the branch's current shape first and keep its structure):

```typescript
      // Spec §5: owned rotating sink when backgrounded; a hand-started
      // daemon on a terminal keeps stderr and performs no rotation.
      const sink = process.stderr.isTTY ? null : createRotatingLog(stateDir);
      try {
        await runDaemon({
          stateDir,
          sweep: sweepCrashedExecutions,        // keep whatever the branch passes today
          ...(sink !== null ? { log: sink.log, logInfo: sink.info } : {}),
          ...(debug ? { debug: true } : {}),
        });
      } finally {
        sink?.close();
      }
```

(`stateDir` here is the daemon's own resolved state dir — reuse the exact variable the `--daemon` branch already computes for `runDaemon`; if it currently passes no `stateDir`, derive the sink dir from `DEFAULT_CONDUIT_DIR` exactly as `runDaemon`'s default does.)

`spawn.ts`: in `spawnDaemon`, build the argv:

```typescript
    const argv = [daemonEntryPoint(), "--daemon"];
    // Volume gate (spec §5): the SPAWNER's environment opts into debug
    // logging via argv — the child's constructed env stays exactly {PATH}.
    if (process.env.CONDUIT_DAEMON_DEBUG === "1") argv.push("--debug");
    const child = spawn(process.execPath, argv, { ...unchanged options... });
```

- [ ] **Step 4: Run the full mcp suite**

Run: `packages/mcp/node_modules/.bin/vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/daemon/log-sink.ts packages/mcp/src/daemon/log-sink.test.ts packages/mcp/src/daemon/spawn.ts packages/mcp/src/bin.ts packages/mcp/src/daemon/conduitd.ts packages/mcp/src/daemon/connection.ts packages/mcp/src/daemon/conduitd.test.ts
git commit -m "feat(mcp): daemon-owned rotating log sink with byte-accurate cap"
```

---

### Task 6: Skew warning — shared helper, sanitization, wired into every daemon-handshaking CLI client

**Files:**
- Create: `packages/mcp/src/version-skew.ts`
- Modify: `packages/mcp/src/index.ts` (export), `packages/mcp/src/runtime-stdio.ts`, `packages/cli/src/commands/approvals.ts`, `packages/cli/src/commands/add-mcp.ts`
- Test: `packages/mcp/src/version-skew.test.ts` (create)

**Interfaces:**
- Consumes: `AGENT_VERSION` (env.ts), the `onHandshake` seam on `DaemonRequestOptions` (client.ts — already exists).
- Produces: `export function skewWarningLine(daemonVersion: string | undefined): string | null` — null when versions match; a single sanitized stderr line otherwise. `export function sanitizeVersionForDisplay(v: string): string` (printable ASCII only, 64-char cap).

- [ ] **Step 1: Write the failing tests** (`version-skew.test.ts`)

```typescript
import { describe, expect, it } from "vitest";
import { AGENT_VERSION } from "./env.js";
import { sanitizeVersionForDisplay, skewWarningLine } from "./version-skew.js";

describe("skewWarningLine", () => {
  it("is silent when the daemon matches this build", () => {
    expect(skewWarningLine(AGENT_VERSION)).toBeNull();
  });

  it("warns on a mismatched version, naming both and the stop command", () => {
    const line = skewWarningLine("9.9.9");
    expect(line).toContain("9.9.9");
    expect(line).toContain(AGENT_VERSION);
    expect(line).toContain("conduit daemon stop");
  });

  it("treats an ABSENT version as skew from an older build, with the signal remediation", () => {
    const line = skewWarningLine(undefined);
    expect(line).toContain("older build");
    // Pre-control daemons cannot be RPC-stopped (spec §4): the absent-
    // version arm points at the signal path, not at `daemon stop`.
    expect(line).toContain("--daemon");
  });

  it("strips control characters and caps length before printing", () => {
    const hostile = `1.0.0[2J${"x".repeat(500)}`;
    const line = skewWarningLine(hostile);
    expect(line).not.toContain("");
    expect(line).not.toContain("");
    expect(sanitizeVersionForDisplay(hostile).length).toBeLessThanOrEqual(64);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `packages/mcp/node_modules/.bin/vitest run src/version-skew.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`version-skew.ts` (docblock: spec §4 — skew is diagnosed loudly and never acted on automatically; `protocol` stays the wire-compat gate; the daemon-supplied string is untrusted display input):

```typescript
import { AGENT_VERSION } from "./env.js";

/** Printable-ASCII only, capped: a stale daemon must not get terminal-escape injection. */
export function sanitizeVersionForDisplay(v: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return v.replace(/[^\x20-\x7e]/g, "").slice(0, 64);
}

/**
 * One stderr line when the daemon's build differs from this client's, null
 * when they match. The ABSENT arm names the signal path: a daemon old
 * enough to omit agentVersion also predates the control capability, so
 * `conduit daemon stop` cannot reach it (spec §4).
 */
export function skewWarningLine(daemonVersion: string | undefined): string | null {
  if (daemonVersion === AGENT_VERSION) return null;
  if (daemonVersion === undefined) {
    return (
      `conduit: the running daemon is an older build (it reports no version) and predates ` +
      `the control API. Stop it by signal — find the process running with --daemon and send ` +
      `it SIGTERM (safe: paused approvals are durable) — and the next command starts a ` +
      `matching daemon.`
    );
  }
  return (
    `conduit: daemon is ${sanitizeVersionForDisplay(daemonVersion)}, this CLI is ` +
    `${AGENT_VERSION} — run \`conduit daemon stop\`; the next command auto-starts a ` +
    `matching daemon.`
  );
}
```

Export both from `packages/mcp/src/index.ts`.

Wire into `packages/cli/src/commands/approvals.ts` `prodDeps` — once per process:

```typescript
function prodDeps(stateDir: string): ApprovalsDeps {
  let skewWarned = false;
  return {
    daemon: (request) =>
      daemonRequest({
        stateDir,
        role: "approvals",
        request,
        deadlineMs: deadlineForRequest(request),
        onHandshake: (info) => {
          if (skewWarned) return;
          const line = skewWarningLine(info.agentVersion);
          if (line !== null) {
            skewWarned = true;
            process.stderr.write(`${line}\n`);
          }
        },
      }),
    ...unchanged (now/stdout/stderr)...
  };
}
```

Apply the same `onHandshake` block to `add-mcp.ts`'s production `daemonRequest` call site (read the file; it mirrors approvals' prodDeps pattern).

`runtime-stdio.ts` (the `serve` client): it already records `staleDaemon` in its `onHandshake` (line ~120). Extend that callback: when `skewWarningLine(info.agentVersion)` is non-null, emit it ONCE per process through the module's existing stderr logging path (read the surrounding code and use the same log function it uses for its other diagnostics; keep the existing `staleDaemon` bookkeeping untouched; never write into an MCP response).

- [ ] **Step 4: Run both suites**

Run: `packages/mcp/node_modules/.bin/vitest run` and `packages/cli/node_modules/.bin/vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/version-skew.ts packages/mcp/src/version-skew.test.ts packages/mcp/src/index.ts packages/mcp/src/runtime-stdio.ts packages/cli/src/commands/approvals.ts packages/cli/src/commands/add-mcp.ts
git commit -m "feat: version-skew warning on every daemon-handshaking client"
```

---

### Task 7: `conduit daemon status|stop` CLI

**Files:**
- Create: `packages/cli/src/commands/daemon.ts`
- Modify: `packages/cli/src/dispatch.ts`, `packages/cli/src/bin.ts`, `packages/mcp/src/index.ts` (exports)
- Test: `packages/cli/src/daemon-cmd.test.ts` (create), `packages/cli/src/dispatch.test.ts` (extend)

**Interfaces:**
- Consumes: `daemonRequest` with `role: "control"` + `autoStart: false`; `DaemonUnavailable` (code `"unavailable" | "rotation-in-progress"`); `daemonPaths(stateDir)` → `{ lifecycleLockDb, socket, ... }`; `probeShared(lockDb)` → `Promise<"busy" | "free">`; `resolveEffectiveStateDir`; `skewWarningLine` (Task 6); `DaemonStatusPayload`.
- Produces: `export async function daemonCommand(argv: string[], opts: { stateDir?: string } = {}): Promise<number>` wired into dispatch as command `daemon`. Exit codes: `status` → 0 running / 3 not running (normative, spec §3.2); `stop` → 0 stopped or not-running / 1 still-draining or refused.
- Exports to add in `packages/mcp/src/index.ts` if not already exported: `daemonPaths`, `probeShared`, `DaemonUnavailable`, `resolveEffectiveStateDir`, `type DaemonStatusPayload` (check first — some already are).

- [ ] **Step 1: Write the failing tests**

`daemon-cmd.test.ts` — test through an injectable deps seam (mirror `approvals.ts`'s DI pattern: the command takes a `deps` object with `daemon`, `probeLifecycle`, `now`, `sleep`, `stdout`, `stderr`):

```typescript
describe("conduit daemon status", () => {
  it("prints the running daemon's projection and exits 0", async () => {
    // deps.daemon resolves {kind:"result", requestId:"r1", payload: <full
    // DaemonStatusPayload literal>}. Assert stdout contains the pid, both
    // versions, dbPath, counts; exit 0.
  });

  it("exits 3 with 'not running' when no daemon is up — and never spawns", async () => {
    // deps.daemon rejects with new DaemonUnavailable("unavailable", "...").
    // Assert stdout/stderr says "not running", exit 3, and the deps.daemon
    // fake records that autoStart:false was requested (assert on the
    // options your prod wiring passes — see step 3's prodDeps shape).
  });

  it("prints rotation guidance and exits 1 during a rotation", async () => {
    // DaemonUnavailable("rotation-in-progress", ...) -> stderr names
    // rotation, exit 1.
  });

  it("explains the manual signal path against a pre-control daemon", async () => {
    // deps.daemon resolves {kind:"error", requestId:"r1", code:"invalid",
    //   message:'handshake.capability must be one of serve | approvals | add-mcp'}
    // -> stderr contains "predates the control API" and "SIGTERM"; exit 1.
  });
});

describe("conduit daemon stop", () => {
  it("acks, waits for the lifecycle lock to release, prints 'stopped', exits 0", async () => {
    // deps.daemon resolves {stopping:true}; deps.probeLifecycle returns
    // "busy" twice then "free". Assert stdout "stopped", exit 0, and
    // probeLifecycle was called until "free".
  });

  it("is idempotent: no daemon running prints 'not running' and exits 0", async () => {
    // DaemonUnavailable("unavailable") -> exit 0.
  });

  it("reports 'still draining' and exits 1 when the wait window elapses", async () => {
    // probeLifecycle always "busy"; injected now/sleep advance a fake
    // clock past STOP_WAIT_MS. stderr mentions draining + `conduit daemon
    // status`; exit 1.
  });

  it("explains the manual signal path against a pre-control daemon", async () => {
    // same capability-rejection frame as status -> same remediation, exit 1.
  });
});
```

`dispatch.test.ts`: extend the routing expectations — `dispatch(["daemon","status"])` routes `{ command: "daemon", args: ["status"] }`; help text lists `daemon`.

- [ ] **Step 2: Run to verify failure**

Run: `packages/cli/node_modules/.bin/vitest run src/daemon-cmd.test.ts src/dispatch.test.ts`
Expected: FAIL — module missing, `daemon` not a command.

- [ ] **Step 3: Implement**

`packages/cli/src/commands/daemon.ts` (docblock: spec §3.2 — never spawns (`autoStart: false`); "not running" keyed on the `DaemonUnavailable` CODE, never message text; status exit 3 when absent is the systemctl convention; stop waits for verified termination because `daemon stop` → `key rotate` must work back-to-back):

```typescript
import {
  AGENT_VERSION,
  DEFAULT_CONDUIT_DIR,
  type DaemonStatusPayload,
  DaemonUnavailable,
  daemonPaths,
  daemonRequest,
  deadlineForRequest,
  probeShared,
  resolveEffectiveStateDir,
  type RpcRequest,
  type RpcResponse,
  skewWarningLine,
} from "@conduithq/mcp";

/**
 * Normative-local: how long `stop` waits for verified termination. Covers
 * the daemon's 30s drain deadline plus margin for lock release.
 */
export const STOP_WAIT_MS = 35_000;
const STOP_POLL_MS = 100;

export interface DaemonCmdDeps {
  daemon: (request: RpcRequest) => Promise<RpcResponse>;
  probeLifecycle: () => Promise<"busy" | "free">;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function prodDeps(stateDir: string): DaemonCmdDeps {
  const paths = daemonPaths(resolveEffectiveStateDir(stateDir));
  let skewWarned = false;
  return {
    daemon: (request) =>
      daemonRequest({
        stateDir,
        role: "control",
        request,
        deadlineMs: deadlineForRequest(request),
        // NEVER spawns (spec §3.2): status must not create the thing it is
        // asking about, and stop's absent case is already the goal state.
        autoStart: false,
        onHandshake: (info) => {
          if (skewWarned) return;
          const line = skewWarningLine(info.agentVersion);
          if (line !== null) {
            skewWarned = true;
            process.stderr.write(`${line}\n`);
          }
        },
      }),
    probeLifecycle: () => probeShared(paths.lifecycleLockDb),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  };
}

/** A pre-control daemon rejects the control handshake as an invalid capability. */
function isPreControlRejection(response: RpcResponse): boolean {
  return (
    response.kind === "error" &&
    response.code === "invalid" &&
    response.message.includes("handshake.capability must be one of")
  );
}

const PRE_CONTROL_REMEDIATION =
  "[conduit daemon] the running daemon predates the control API and cannot be reached over " +
  "RPC. Stop it by signal: find the conduit process running with --daemon and send it " +
  "SIGTERM (safe: paused approvals are durable and survive). The next command auto-starts " +
  "a current daemon.";

export async function runStatus(deps: DaemonCmdDeps): Promise<number> {
  let response: RpcResponse;
  try {
    response = await deps.daemon({ kind: "daemon.status" });
  } catch (err) {
    if (err instanceof DaemonUnavailable) {
      if (err.code === "rotation-in-progress") {
        deps.stderr(`[conduit daemon] ${err.message}\n`);
        return 1;
      }
      // Exit 3 (normative, spec §3.2): scripts must never read "not
      // running" as healthy.
      deps.stdout("not running\n");
      return 3;
    }
    throw err;
  }
  if (isPreControlRejection(response)) {
    deps.stderr(`${PRE_CONTROL_REMEDIATION}\n`);
    return 1;
  }
  if (response.kind !== "result") {
    deps.stderr(`[conduit daemon] status failed: unexpected ${response.kind} answer.\n`);
    return 1;
  }
  const s = response.payload as DaemonStatusPayload;
  deps.stdout(
    `running\n` +
      `  pid:         ${s.pid}\n` +
      `  version:     ${s.agentVersion} (this CLI: ${AGENT_VERSION})\n` +
      `  started:     ${new Date(s.startedAt).toISOString()}\n` +
      `  db:          ${s.dbPath}\n` +
      `  connections: ${s.connections}\n` +
      `  in flight:   ${s.executionsInFlight} running, ${s.queueDepth} queued\n` +
      `  log:         ${s.logPath ?? "stderr (hand-started)"}${
        s.logSizeBytes !== null ? ` (${s.logSizeBytes} bytes)` : ""
      }\n`,
  );
  return 0;
}

export async function runStop(deps: DaemonCmdDeps): Promise<number> {
  let response: RpcResponse;
  try {
    response = await deps.daemon({ kind: "daemon.stop" });
  } catch (err) {
    if (err instanceof DaemonUnavailable) {
      if (err.code === "rotation-in-progress") {
        deps.stderr(`[conduit daemon] ${err.message}\n`);
        return 1;
      }
      // Idempotent (spec §3.2): the operator wanted it stopped; it is.
      deps.stdout("not running\n");
      return 0;
    }
    throw err;
  }
  if (isPreControlRejection(response)) {
    deps.stderr(`${PRE_CONTROL_REMEDIATION}\n`);
    return 1;
  }
  if (response.kind !== "result") {
    deps.stderr(`[conduit daemon] stop failed: unexpected ${response.kind} answer.\n`);
    return 1;
  }
  // Ack received; wait for VERIFIED termination (spec §3.2): the drain can
  // run to the daemon's deadline, and `key rotate` needs the lock actually
  // free, not merely a stop acked.
  const waitUntil = deps.now() + STOP_WAIT_MS;
  while (deps.now() < waitUntil) {
    if ((await deps.probeLifecycle()) === "free") {
      deps.stdout("stopped\n");
      return 0;
    }
    await deps.sleep(STOP_POLL_MS);
  }
  deps.stderr(
    "[conduit daemon] stop requested; the daemon is still draining in-flight work " +
      "(bounded by its drain deadline). Re-run `conduit daemon status` to confirm it exited.\n",
  );
  return 1;
}

export async function daemonCommand(
  argv: string[],
  opts: { stateDir?: string } = {},
): Promise<number> {
  const deps = prodDeps(opts.stateDir ?? DEFAULT_CONDUIT_DIR);
  const [sub] = argv;
  switch (sub) {
    case "status":
      return runStatus(deps);
    case "stop":
      return runStop(deps);
    default:
      deps.stderr(
        `[conduit daemon] Unknown subcommand: ${sub ?? "(none)"}. Usage: conduit daemon status|stop\n`,
      );
      return 1;
  }
}
```

(Adjust `runStatus`/`runStop` signatures to take `deps` so the tests inject; `daemonCommand` builds prod deps. If `probeShared` returns a richer type in `locks.ts`, adapt the `"busy" | "free"` narrowing to the real signature — read `locks.ts` first.)

`dispatch.ts`: add `"daemon"` to `COMMANDS`, a HELP line (`daemon     Inspect or stop the background daemon (status | stop)`), and `bin.ts`: a `case "daemon"` arm threading `takeStateDir` exactly like `approvals`.

`packages/mcp/src/index.ts`: ensure `daemonPaths`, `probeShared`, `DaemonUnavailable`, `resolveEffectiveStateDir`, `deadlineForRequest`, `type DaemonStatusPayload`, `skewWarningLine`, `AGENT_VERSION` are all exported (several already are — add only what is missing).

- [ ] **Step 4: Run cli suite + typecheck; then one real-daemon smoke via the mcp e2e fixture**

Run: `packages/cli/node_modules/.bin/vitest run` and `packages/cli/node_modules/.bin/tsc --noEmit -p .`
Also add to `packages/mcp/src/daemon/conduitd.test.ts` (belongs with the spawned-daemon fixtures):

```typescript
it("status/stop with no daemon: no spawn occurs", async () => {
  // fresh temp state dir, NO daemon. Issue a control daemonRequest with
  // autoStart:false (the CLI's exact options) -> DaemonUnavailable, and
  // assert no lifecycle lock ever appears (probeShared stays "free") and
  // no conduitd.log is created.
});
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/daemon.ts packages/cli/src/daemon-cmd.test.ts packages/cli/src/dispatch.ts packages/cli/src/dispatch.test.ts packages/cli/src/bin.ts packages/mcp/src/index.ts packages/mcp/src/daemon/conduitd.test.ts
git commit -m "feat(cli): conduit daemon status|stop over the control capability"
```

---

### Task 8: Version-sync guards + `key rotate` guidance

**Files:**
- Modify: `packages/mcp/src/env.test.ts`, `packages/cli/src/dispatch.test.ts`, `packages/cli/src/commands/key.ts` (guidance text only)
- Test: same files.

**Interfaces:** none new.

- [ ] **Step 1: Write the failing-or-passing pins**

`env.test.ts`:

```typescript
import { createRequire } from "node:module";

it("AGENT_VERSION matches package.json — the skew warning must never report a stale string", () => {
  const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
  expect(AGENT_VERSION).toBe(pkg.version);
});
```

`dispatch.test.ts` (same guard for the CLI's own `VERSION` constant):

```typescript
it("CLI VERSION matches package.json", () => {
  const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
  expect(VERSION).toBe(pkg.version);
});
```

- [ ] **Step 2: Run** — both should PASS today (0.1.0 == 0.1.0); they are regression pins. If either fails, the constants are already stale: fix the constant, not the test.

- [ ] **Step 3: `key rotate` guidance.** In `packages/cli/src/commands/key.ts`, find the stop-first refusal/guidance text (grep for "stop running conduit" / the daemon-holder refusal). Update the wording to name the concrete command, e.g. "stop running conduit processes first — run `conduit daemon stop`, then re-run rotate." Update the corresponding assertion in `key.test.ts` if it pins the old wording.

- [ ] **Step 4: Run both suites** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/env.test.ts packages/cli/src/dispatch.test.ts packages/cli/src/commands/key.ts packages/cli/src/key.test.ts
git commit -m "test: pin version constants to package.json; rotate names daemon stop"
```

---

### Task 9: Docs + ledger closeout

**Files:**
- Modify: `conduitspec.html` (§17 build-sequence + step-3 bullet), regenerate `conduitspec.md` via `python3 html2md.py` in the SAME commit
- Modify: `packages/cli/README.md` (command table + daemon section), `INVARIANTS.md` (final row audit)

**Interfaces:** none.

- [ ] **Step 1: Spec.** In `conduitspec.html`, edit the §17 "Typed control-plane API + hot-reload" bullet: mark the daemon-side half BUILT (2026-08-22 design: long-lived runtime, catalog hot-reload at the provisioning tail, `control` capability with `daemon.status`/`daemon.stop`, skew diagnosis, bounded daemon log) and state explicitly that the local HTTP API half ships WITH step 4 behind the §16 floor — the step-3 line stays PARTIAL (ledger honesty, spec §1). Update the build-sequence line: `(3) typed control API + hot-reload` gets a `✅ daemon-side (HTTP with step 4)` marker and "**Next: step 4.**". NEVER hand-edit `conduitspec.md`.

- [ ] **Step 2: Regenerate.** Run `python3 html2md.py`; verify `git diff conduitspec.md` shows exactly the §17 text change.

- [ ] **Step 3: README.** Add `daemon` to the CLI command table (`status` — inspect the running daemon; `stop` — graceful stop; exit 3 from `status` = not running). One paragraph on the skew warning and on `conduitd.log` rotation (5 MB active file + one `.1`).

- [ ] **Step 4: INVARIANTS.md audit.** Every §17 row this plan touched quotes its test title verbatim and is ✅; no ⏳ row describes anything this branch shipped.

- [ ] **Step 5: Full verification, then commit**

Run, each in the foreground:
- `packages/sdk/node_modules/.bin/vitest run` (expect 444+)
- `packages/mcp/node_modules/.bin/vitest run`
- `packages/cli/node_modules/.bin/vitest run`
- `packages/mcp/node_modules/.bin/tsc --noEmit -p packages/sdk -p packages/mcp -p packages/cli` (or per-package `tsc` as the repo does it)
- `node_modules/.bin/biome check .` (repo root)

```bash
git add conduitspec.html conduitspec.md packages/cli/README.md INVARIANTS.md
git commit -m "docs: record §17 step-3 daemon-side completion (HTTP rides step 4)"
```

---

## Post-plan route (project rules, not tasks)

Whole-branch review → push → PR with a **Deviations** section (deviations log kept in the scratchpad during the build) → full load-bearing gauntlet (Tier-2 five-specialist wave, /security-review, code-review mechanic, codex arc per `codex-one-path.md` to convergence) → `/explain-diff` explainer + quiz → **HUMAN-NAMED merge** → post-merge sweep + `pnpm -r build` (user terminal) + real-db canary.
