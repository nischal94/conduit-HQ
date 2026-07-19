# Credential Key Lifecycle Implementation Plan (spec §17 v1 step 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the converged credential-key-lifecycle design — key-file-first resolution, startup canary, `conduit key generate`/`rotate`, 0600-at-creation db perms — per `docs/superpowers/specs/2026-07-19-credential-key-lifecycle-design.md`.

**Architecture:** A new sdk module (`store/key-lifecycle.ts`) owns the canary check and secret re-encryption beside the schema they touch; `packages/mcp`'s env resolver grows a key-file fallback with provenance (`keySource`) and 0600 db-file creation; `packages/cli` adds the `key` command family as a thin DI adapter over those seams (the established `approvals` pattern). Rotation is stop-first + in-place: both candidate keys are on disk before the db changes; crash recovery is a documented manual procedure, never automatic roll-forward.

**Tech Stack:** TypeScript (strict), vitest, `@libsql/client` 0.14 (already a dep), WebCrypto `SecretBox` (unchanged), node:fs.

## Global Constraints

- **Zero new dependencies.** Every import already exists in some workspace package. `packages/cli` gets NO direct `@libsql/client` dep — it reaches the client through `@conduithq/mcp`'s `openStoreClientFromEnv` (Task 3).
- **NO SQL schema changes.** The `secrets` table (`ref TEXT PRIMARY KEY, sealed TEXT, created_at INTEGER`) is used as-is. Any schema change is a STOP-and-ask deviation.
- **`SecretBox` is frozen.** Same `v1.<iv>.<ciphertext>` sealed format; rotation is re-encryption, not migration.
- **Key material NEVER reaches stdout/stderr, error messages, or test snapshots.** Paths and provenance (`keySource`) only.
- **Invariant tests are RED-first** and carry the `INVARIANT §16.3:` name prefix; each lands with its `INVARIANTS.md` row in the same commit (project rule).
- **Commit with the sandbox disabled** (pre-commit hook uses mktemp); NEVER `--no-verify`. No `git stash`.
- **Rebuild `packages/sdk/dist` (`pnpm --filter @conduithq/sdk build`) after any sdk change, before mcp/cli tasks consume it.**
- Error format: `[Module] Operation failed: reason. Context: {…}` — every error names the way forward.
- Run tests per package: `pnpm --filter @conduithq/sdk test`, `--filter @conduithq/mcp`, `--filter @conduithq/cli` (vitest; unsandboxed).

## File Structure

| File | Responsibility |
|---|---|
| Create `packages/sdk/src/store/key-lifecycle.ts` | Canary constants + `ensureKeyCanary` + `reencryptSecrets` + their error types. Keeps 1,070-line `sqlite.ts` from growing. |
| Create `packages/sdk/src/store/key-lifecycle.test.ts` | All §16.3 sdk invariants. |
| Modify `packages/sdk/src/store/sqlite.ts` | `SqliteStoreOptions` gains `keyContext?`; `openSqliteStore` calls `ensureKeyCanary` after schema setup. |
| Modify `packages/sdk/src/index.ts` | Export `reencryptSecrets`, `ReencryptError`, `KeyCanaryError`, `CANARY_REF`. |
| Modify `packages/mcp/src/env.ts` | Key-file fallback, `keySource`, perms warning, `ensureDbFile` (0600 + heal). |
| Modify `packages/mcp/src/env.test.ts` (exists) | New resolution/perms invariants. |
| Modify `packages/mcp/src/store-open.ts` | `openStoreClientFromEnv` (returns client too); threads `keyContext`; calls `ensureDbFile`. |
| Modify `packages/mcp/src/index.ts` | Export `openStoreClientFromEnv`. |
| Create `packages/cli/src/commands/key.ts` | `runKeyGenerate` + `runKeyRotate` + `KEY_USAGE`, DI deps per the approvals pattern. |
| Create `packages/cli/src/key.test.ts` | Generate/rotate invariants. |
| Modify `packages/cli/src/dispatch.ts` + `dispatch.test.ts` | Register `key`; help interception. |
| Modify `packages/cli/src/bin.ts` | Route `key` to the runner. |
| Modify `INVARIANTS.md` | One row per invariant, flipped in the same commit as its test. |
| Modify `conduitspec.html` (+ regen `conduitspec.md` via `python3 html2md.py`) | §14 onboarding, §16 item 3, §17 step-1 story. |
| Modify `packages/cli/README.md`, `packages/mcp/README.md` | Command reference, rotation walkthrough, recovery procedures. |

**Degrees of freedom:** exact error-message wording may be polished (structure and named-way-forward are fixed); test helper factoring within a test file is free. Everything else — sequences, refusal sets, file names (`master-key`, `master-key.bak`, `master-key.next`, `master-key.tmp-<pid>`), permissions, exit codes — is pinned by the design; deviations STOP and ask.

---

### Task 1: sdk canary — `ensureKeyCanary` wired into `openSqliteStore`

**Files:**
- Create: `packages/sdk/src/store/key-lifecycle.ts`
- Create: `packages/sdk/src/store/key-lifecycle.test.ts`
- Modify: `packages/sdk/src/store/sqlite.ts` (options + one call)
- Modify: `packages/sdk/src/index.ts` (exports)
- Modify: `INVARIANTS.md`

**Interfaces:**
- Consumes: `SecretBox` (`packages/sdk/src/secrets.ts`), `Client` type (`@libsql/client`), `openSqliteStore` (`store/sqlite.ts`).
- Produces (later tasks rely on these exact names):
  - `CANARY_REF = "__conduit.key-canary.v1__"`, `CANARY_SENTINEL = "conduit-key-canary"`
  - `class KeyCanaryError extends Error { readonly kind: "wrong-key" | "canary-corruption" }`
  - `ensureKeyCanary(client: Client, secretBox: SecretBox, context?: StoreKeyContext): Promise<void>`
  - `interface StoreKeyContext { dbPath?: string; keySource?: "env" | "file" }`
  - `SqliteStoreOptions` gains `keyContext?: StoreKeyContext`

- [ ] **Step 1: Write the failing tests**

`packages/sdk/src/store/key-lifecycle.test.ts` (test setup mirrors `sqlite.test.ts`'s in-memory client convention):

```typescript
import { createClient } from "@libsql/client";
import { beforeEach, describe, expect, it } from "vitest";
import { SecretBox } from "../secrets.js";
import { openSqliteStore } from "./sqlite.js";
import { CANARY_REF, CANARY_SENTINEL, KeyCanaryError } from "./key-lifecycle.js";

async function freshBoxes() {
  const right = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
  const wrong = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
  return { right, wrong };
}

describe("key canary (design §2)", () => {
  let client: ReturnType<typeof createClient>;
  beforeEach(() => {
    client = createClient({ url: ":memory:" });
  });

  it("INVARIANT §16.3: first open on an empty db writes the canary; reopen with the same key succeeds", async () => {
    const { right } = await freshBoxes();
    await openSqliteStore({ client, secretBox: right });
    const row = await client.execute({
      sql: "SELECT sealed FROM secrets WHERE ref = ?",
      args: [CANARY_REF],
    });
    expect(row.rows).toHaveLength(1);
    expect(await right.open(String(row.rows[0]?.sealed))).toBe(CANARY_SENTINEL);
    await expect(openSqliteStore({ client, secretBox: right })).resolves.toBeDefined();
  });

  it("INVARIANT §16.3: wrong master key fails at store open (canary), not first use", async () => {
    const { right, wrong } = await freshBoxes();
    await openSqliteStore({ client, secretBox: right });
    await expect(openSqliteStore({ client, secretBox: wrong })).rejects.toThrow(KeyCanaryError);
  });

  it("INVARIANT §16.3: legacy db (real rows, no canary) + wrong key → refused, canary NOT created", async () => {
    const { right, wrong } = await freshBoxes();
    const store = await openSqliteStore({ client, secretBox: right });
    await store.secrets.put("cred_github", "real-secret");
    await client.execute({ sql: "DELETE FROM secrets WHERE ref = ?", args: [CANARY_REF] });
    await expect(openSqliteStore({ client, secretBox: wrong })).rejects.toThrow(KeyCanaryError);
    const canary = await client.execute({
      sql: "SELECT 1 FROM secrets WHERE ref = ?",
      args: [CANARY_REF],
    });
    expect(canary.rows).toHaveLength(0); // never bound to an unverified key
  });

  it("INVARIANT §16.3: legacy db + correct key → canary created, subsequent opens pass", async () => {
    const { right } = await freshBoxes();
    const store = await openSqliteStore({ client, secretBox: right });
    await store.secrets.put("cred_github", "real-secret");
    await client.execute({ sql: "DELETE FROM secrets WHERE ref = ?", args: [CANARY_REF] });
    await openSqliteStore({ client, secretBox: right });
    const canary = await client.execute({
      sql: "SELECT 1 FROM secrets WHERE ref = ?",
      args: [CANARY_REF],
    });
    expect(canary.rows).toHaveLength(1);
  });

  it("INVARIANT §16.3: corrupted canary + healthy real row → canary-corruption error, not wrong-key", async () => {
    const { right } = await freshBoxes();
    const store = await openSqliteStore({ client, secretBox: right });
    await store.secrets.put("cred_github", "real-secret");
    await client.execute({
      sql: "UPDATE secrets SET sealed = ? WHERE ref = ?",
      args: [await right.seal("not-the-sentinel"), CANARY_REF],
    });
    const err = await openSqliteStore({ client, secretBox: right }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyCanaryError);
    expect((err as KeyCanaryError).kind).toBe("canary-corruption");
  });

  it("INVARIANT §16.3: probe-all — corrupt FIRST real row + later good row → still canary-corruption", async () => {
    const { right, wrong } = await freshBoxes();
    const store = await openSqliteStore({ client, secretBox: right });
    // ref ordering: cred_a sorts before cred_b — corrupt the first.
    await store.secrets.put("cred_a", "s1");
    await store.secrets.put("cred_b", "s2");
    await client.execute({
      sql: "UPDATE secrets SET sealed = ? WHERE ref = ?",
      args: [await wrong.seal("foreign"), "cred_a"],
    });
    await client.execute({
      sql: "UPDATE secrets SET sealed = 'v1.garbage.garbage' WHERE ref = ?",
      args: [CANARY_REF],
    });
    const err = await openSqliteStore({ client, secretBox: right }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyCanaryError);
    expect((err as KeyCanaryError).kind).toBe("canary-corruption"); // cred_b proved the key
  });

  it("INVARIANT §16.3: canary fails + ALL real rows fail → ambiguous wrong-key-or-corruption error", async () => {
    const { right, wrong } = await freshBoxes();
    const store = await openSqliteStore({ client, secretBox: right });
    await store.secrets.put("cred_github", "real-secret");
    const err = await openSqliteStore({ client, secretBox: wrong }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyCanaryError);
    expect((err as KeyCanaryError).kind).toBe("wrong-key");
    expect(String(err)).toMatch(/wrong master key/i);
    expect(String(err)).not.toMatch(/[A-Za-z0-9+/]{40,}/); // no key material
  });

  it("INVARIANT §16.3: M5 first-run race — INSERT OR IGNORE keeps a racing pair consistent", async () => {
    const { right } = await freshBoxes();
    // Sequential simulation of the race: both opens bootstrap with the SAME key;
    // the second must tolerate the first's row (INSERT OR IGNORE + verify).
    await Promise.all([
      openSqliteStore({ client, secretBox: right }),
      openSqliteStore({ client, secretBox: right }),
    ]);
    const rows = await client.execute({
      sql: "SELECT sealed FROM secrets WHERE ref = ?",
      args: [CANARY_REF],
    });
    expect(rows.rows).toHaveLength(1);
    expect(await right.open(String(rows.rows[0]?.sealed))).toBe(CANARY_SENTINEL);
  });

  it("context (db path / key source) appears in the error, key material never does", async () => {
    const { right, wrong } = await freshBoxes();
    await openSqliteStore({ client, secretBox: right });
    const err = await openSqliteStore({
      client,
      secretBox: wrong,
      keyContext: { dbPath: "/tmp/x/conduit.db", keySource: "file" },
    }).catch((e: unknown) => e);
    expect(String(err)).toContain("/tmp/x/conduit.db");
    expect(String(err)).toContain("file");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @conduithq/sdk exec vitest run src/store/key-lifecycle.test.ts`
Expected: FAIL — `Cannot find module './key-lifecycle.js'`.

- [ ] **Step 3: Write the implementation**

`packages/sdk/src/store/key-lifecycle.ts`:

```typescript
import type { Client } from "@libsql/client";
import type { SecretBox } from "../secrets.js";

/**
 * Key-lifecycle primitives (design 2026-07-19, spec §16.3 / §17 v1 step 1):
 * the startup canary that makes a wrong master key fail loud at store open,
 * and the re-encryption primitive `conduit key rotate` drives. Lives beside
 * the sqlite schema it touches; NOT part of the cross-backend ConduitStore
 * contract (a D1 backend needs its own).
 */

export const CANARY_REF = "__conduit.key-canary.v1__";
export const CANARY_SENTINEL = "conduit-key-canary";

export interface StoreKeyContext {
  dbPath?: string;
  keySource?: "env" | "file";
}

export class KeyCanaryError extends Error {
  readonly kind: "wrong-key" | "canary-corruption";
  constructor(kind: "wrong-key" | "canary-corruption", message: string) {
    super(message);
    this.name = "KeyCanaryError";
    this.kind = kind;
  }
}

function contextSuffix(context?: StoreKeyContext): string {
  return ` Context: { db: ${context?.dbPath ?? "unknown"}, keySource: ${context?.keySource ?? "unknown"} }`;
}

/** True iff `box` opens at least one non-canary secrets row. False when no row opens OR none exist. */
async function anyRealRowOpens(client: Client, box: SecretBox): Promise<boolean> {
  const rows = await client.execute({
    sql: "SELECT sealed FROM secrets WHERE ref != ? ORDER BY ref",
    args: [CANARY_REF],
  });
  for (const row of rows.rows) {
    try {
      await box.open(String(row.sealed));
      return true;
    } catch {
      // keep probing — one corrupt row must not condemn a correct key
    }
  }
  return false;
}

async function hasRealRows(client: Client): Promise<boolean> {
  const rs = await client.execute({
    sql: "SELECT 1 FROM secrets WHERE ref != ? LIMIT 1",
    args: [CANARY_REF],
  });
  return rs.rows.length > 0;
}

/**
 * Verify (or bootstrap) the key canary. Called by openSqliteStore after
 * schema setup so every product bin fails loud at startup on a wrong key.
 *
 * - Canary present: open + compare the sentinel. On failure, probe ALL real
 *   rows: any opens → canary-corruption (the key is fine); none → ambiguous
 *   wrong-key.
 * - Canary absent + real rows (legacy db): probe rows FIRST — the db is
 *   never bound to an unverified key. Any opens → create the canary; none →
 *   ambiguous wrong-key, no canary written.
 * - Canary absent + empty table: create freely (INSERT OR IGNORE tolerates
 *   the M5 first-run race — both racers hold the same key), then re-read and
 *   verify.
 */
export async function ensureKeyCanary(
  client: Client,
  secretBox: SecretBox,
  context?: StoreKeyContext,
): Promise<void> {
  const existing = await client.execute({
    sql: "SELECT sealed FROM secrets WHERE ref = ?",
    args: [CANARY_REF],
  });

  const wrongKey = () =>
    new KeyCanaryError(
      "wrong-key",
      "[SqliteStore] Failed to open store: wrong master key — or, if this key is known-correct, " +
        "the stored rows are corrupted/foreign. If this db was mid-rotation, see the rotation-recovery " +
        `procedure (master-key.next / master-key.bak).${contextSuffix(context)}`,
    );
  const corruption = () =>
    new KeyCanaryError(
      "canary-corruption",
      "[SqliteStore] Failed to open store: the key canary is damaged but a real secret decrypts — " +
        "the master key is correct. Recovery: delete the canary row (see README one-liner) and " +
        `reopen; it is recreated under the verified key.${contextSuffix(context)}`,
    );

  const sealed = existing.rows[0]?.sealed;
  if (sealed !== undefined) {
    try {
      if ((await secretBox.open(String(sealed))) === CANARY_SENTINEL) return;
    } catch {
      // fall through to the probe — decrypt failure alone can't name the cause
    }
    throw (await anyRealRowOpens(client, secretBox)) ? corruption() : wrongKey();
  }

  if (await hasRealRows(client)) {
    if (!(await anyRealRowOpens(client, secretBox))) throw wrongKey();
  }

  await client.execute({
    sql: "INSERT OR IGNORE INTO secrets (ref, sealed, created_at) VALUES (?, ?, ?)",
    args: [CANARY_REF, await secretBox.seal(CANARY_SENTINEL), Date.now()],
  });
  // Re-read and verify: under the M5 race the surviving row is the racer's,
  // sealed with the SAME key — if it doesn't verify, something else wrote it.
  const reread = await client.execute({
    sql: "SELECT sealed FROM secrets WHERE ref = ?",
    args: [CANARY_REF],
  });
  try {
    if ((await secretBox.open(String(reread.rows[0]?.sealed))) === CANARY_SENTINEL) return;
  } catch {
    // fall through
  }
  throw wrongKey();
}
```

In `packages/sdk/src/store/sqlite.ts` — add to `SqliteStoreOptions`:

```typescript
import { ensureKeyCanary, type StoreKeyContext } from "./key-lifecycle.js";

export interface SqliteStoreOptions {
  client: Client;
  /** Encrypts SecretRepository contents at rest (spec §9.2). */
  secretBox: SecretBox;
  /** Sanitized provenance for canary errors (db path + key source; design §2). NEVER key material. */
  keyContext?: StoreKeyContext;
  /** Host-side sink for infra diagnostics (e.g. a WAL-pragma failure); NEVER guest-visible. */
  log?: (message: string) => void;
}
```

and at the END of `openSqliteStore`'s setup (after `await client.batch(SCHEMA, "write")` and the retrofit ladder, immediately before the `return` of the store object):

```typescript
  // Design §2 (2026-07-19): wrong master key fails loud HERE, at open —
  // not at the first secret decrypt. Every product bin routes through this.
  await ensureKeyCanary(client, secretBox, options.keyContext);
```

In `packages/sdk/src/index.ts`, alongside the existing store exports add:

```typescript
export {
  CANARY_REF,
  ensureKeyCanary,
  KeyCanaryError,
  reencryptSecrets,
  ReencryptError,
  type StoreKeyContext,
} from "./store/key-lifecycle.js";
```

(`reencryptSecrets`/`ReencryptError` arrive in Task 2 — if implementing tasks strictly in order, add those two names in Task 2's commit instead.)

- [ ] **Step 4: Run the new tests, then the full sdk suite**

Run: `pnpm --filter @conduithq/sdk exec vitest run src/store/key-lifecycle.test.ts`
Expected: PASS (all 9).
Run: `pnpm --filter @conduithq/sdk test`
Expected: PASS — pre-existing `sqlite.test.ts`/`e2e.smoke.test.ts` opens go through the empty-table bootstrap path and stay green. If any pre-existing test asserts on exact `secrets` row counts, update it to exclude `CANARY_REF` (state the change in the commit body).

- [ ] **Step 5: INVARIANTS.md rows**

Append to the ledger table:

```markdown
| §16.3 — wrong master key fails at store open (canary), not first use | `packages/sdk/src/store/key-lifecycle.test.ts` | ✅ pinned |
| §16.3 — legacy db is never bound to an unverified key (probe-before-bootstrap); one corrupt row cannot condemn a correct key (probe-all); canary corruption is distinguished from wrong key | `packages/sdk/src/store/key-lifecycle.test.ts` | ✅ pinned |
```

- [ ] **Step 6: Rebuild dist + commit**

```bash
pnpm --filter @conduithq/sdk build
git add packages/sdk/src/store/key-lifecycle.ts packages/sdk/src/store/key-lifecycle.test.ts packages/sdk/src/store/sqlite.ts packages/sdk/src/index.ts INVARIANTS.md
git commit -m "feat: startup key canary — wrong master key fails loud at store open (§16.3)"
```

---

### Task 2: sdk `reencryptSecrets` — the rotation primitive

**Files:**
- Modify: `packages/sdk/src/store/key-lifecycle.ts`
- Modify: `packages/sdk/src/store/key-lifecycle.test.ts`
- Modify: `packages/sdk/src/index.ts` (if Task 1 deferred the two names)
- Modify: `INVARIANTS.md`

**Interfaces:**
- Consumes: `Client.transaction("write")` (= `BEGIN IMMEDIATE`, verified), `SecretBox`.
- Produces:
  - `class ReencryptError extends Error { readonly dbState: "unchanged" | "unknown" }`
  - `reencryptSecrets(client: Client, oldBox: SecretBox, newBox: SecretBox): Promise<number>` — resolves with the row count re-sealed; `dbState: "unchanged"` = confirmed still-old (safe to delete `master-key.next`); `"unknown"` = commit outcome uncertain (NEVER delete `.next`).

- [ ] **Step 1: Write the failing tests**

Append to `key-lifecycle.test.ts`:

```typescript
import { reencryptSecrets, ReencryptError } from "./key-lifecycle.js";

describe("reencryptSecrets (design §3)", () => {
  it("INVARIANT §16.3: after re-seal, every row (canary incl.) opens under the NEW key, none under the old", async () => {
    const client = createClient({ url: ":memory:" });
    const { right: oldBox } = await freshBoxes();
    const newBox = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
    const store = await openSqliteStore({ client, secretBox: oldBox });
    await store.secrets.put("cred_a", "s1");
    await store.secrets.put("cred_b", "s2");

    const count = await reencryptSecrets(client, oldBox, newBox);
    expect(count).toBe(3); // 2 real + canary

    const rows = await client.execute("SELECT ref, sealed FROM secrets");
    for (const row of rows.rows) {
      await expect(newBox.open(String(row.sealed))).resolves.toBeDefined();
      await expect(oldBox.open(String(row.sealed))).rejects.toThrow();
    }
    // the store now opens under the NEW key only
    await expect(openSqliteStore({ client, secretBox: newBox })).resolves.toBeDefined();
    await expect(openSqliteStore({ client, secretBox: oldBox })).rejects.toThrow(KeyCanaryError);
  });

  it("INVARIANT §16.3: atomic — a mid-rotate failure leaves every row openable under the OLD key", async () => {
    const client = createClient({ url: ":memory:" });
    const { right: oldBox, wrong: foreignBox } = await freshBoxes();
    const newBox = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
    const store = await openSqliteStore({ client, secretBox: oldBox });
    await store.secrets.put("cred_a", "s1");
    // Inject failure: one row sealed under a foreign key makes open() throw mid-loop.
    await client.execute({
      sql: "UPDATE secrets SET sealed = ? WHERE ref = ?",
      args: [await foreignBox.seal("alien"), "cred_a"],
    });

    const err = await reencryptSecrets(client, oldBox, newBox).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReencryptError);
    expect((err as ReencryptError).dbState).toBe("unchanged"); // rollback confirmed
    // canary is still old-key — store opens under old, not new
    await expect(openSqliteStore({ client, secretBox: oldBox })).rejects.toThrow(KeyCanaryError); // cred_a foreign → corruption diagnosis path
    const canary = await client.execute({
      sql: "SELECT sealed FROM secrets WHERE ref = ?",
      args: [CANARY_REF],
    });
    await expect(oldBox.open(String(canary.rows[0]?.sealed))).resolves.toBe(CANARY_SENTINEL);
  });

  it("ReencryptError.dbState is 'unknown' when COMMIT itself fails", async () => {
    const client = createClient({ url: ":memory:" });
    const { right: oldBox } = await freshBoxes();
    const newBox = await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes());
    await openSqliteStore({ client, secretBox: oldBox });
    // Force COMMIT failure: close the client's underlying connection is not
    // reachable through the public API, so pin the classification seam
    // directly with a stub tx-shaped failure via the exported classifier.
    // (See implementation: classifyReencryptFailure is exported for this pin.)
    const { classifyReencryptFailure } = await import("./key-lifecycle.js");
    expect(classifyReencryptFailure("commit", new Error("io"))).toBe("unknown");
    expect(classifyReencryptFailure("before-commit", new Error("SQLITE_BUSY"))).toBe("unchanged");
    expect(classifyReencryptFailure("rollback-failed", new Error("io"))).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @conduithq/sdk exec vitest run src/store/key-lifecycle.test.ts`
Expected: FAIL — `reencryptSecrets is not a function` (or import error).

- [ ] **Step 3: Implement**

Append to `packages/sdk/src/store/key-lifecycle.ts`:

```typescript
export class ReencryptError extends Error {
  /**
   * "unchanged" — the failure occurred strictly before COMMIT was issued, or
   * the explicit rollback succeeded: every row is still under the OLD key and
   * the caller may safely delete a staged new-key file.
   * "unknown" — COMMIT itself threw (SQLite may or may not have committed) or
   * the rollback failed: the caller must NOT delete either candidate key.
   */
  readonly dbState: "unchanged" | "unknown";
  constructor(dbState: "unchanged" | "unknown", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ReencryptError";
    this.dbState = dbState;
  }
}

/** Exported for the invariant pin on commit-boundary classification (design pass-4 #2). */
export function classifyReencryptFailure(
  phase: "before-commit" | "commit" | "rollback-failed",
  _cause: unknown,
): "unchanged" | "unknown" {
  return phase === "before-commit" ? "unchanged" : "unknown";
}

/**
 * Re-seal every secrets row (canary included) from oldBox to newBox inside
 * ONE interactive write transaction (BEGIN IMMEDIATE — writer exclusion for
 * the duration; a competing writer surfaces as SQLITE_BUSY within
 * busy_timeout, which lands here as dbState "unchanged": the refusal path).
 * Returns the number of rows re-sealed. The store handle that supplied
 * oldBox is DEAD after a successful return — its SecretBox is the old key.
 */
export async function reencryptSecrets(
  client: Client,
  oldBox: SecretBox,
  newBox: SecretBox,
): Promise<number> {
  let tx: Awaited<ReturnType<Client["transaction"]>>;
  try {
    tx = await client.transaction("write");
  } catch (cause) {
    throw new ReencryptError(
      "unchanged",
      `[KeyLifecycle] Rotation failed: could not acquire the write lock — stop running conduit processes first. Context: { cause: ${String(cause)} }`,
      cause,
    );
  }
  try {
    let count = 0;
    try {
      const rows = await tx.execute("SELECT ref, sealed FROM secrets ORDER BY ref");
      for (const row of rows.rows) {
        const plaintext = await oldBox.open(String(row.sealed));
        await tx.execute({
          sql: "UPDATE secrets SET sealed = ? WHERE ref = ?",
          args: [await newBox.seal(plaintext), String(row.ref)],
        });
        count++;
      }
    } catch (cause) {
      try {
        await tx.rollback();
      } catch (rollbackCause) {
        throw new ReencryptError(
          classifyReencryptFailure("rollback-failed", rollbackCause),
          `[KeyLifecycle] Rotation failed AND rollback failed — db state uncertain; do NOT delete either key file. Context: { cause: ${String(cause)} }`,
          cause,
        );
      }
      throw new ReencryptError(
        classifyReencryptFailure("before-commit", cause),
        `[KeyLifecycle] Rotation failed before commit; every secret is still under the old key. Context: { cause: ${String(cause)} }`,
        cause,
      );
    }
    try {
      await tx.commit();
    } catch (cause) {
      throw new ReencryptError(
        classifyReencryptFailure("commit", cause),
        `[KeyLifecycle] Rotation COMMIT outcome uncertain — do NOT delete either key file; whichever key opens the db is live. Context: { cause: ${String(cause)} }`,
        cause,
      );
    }
    return count;
  } finally {
    tx.close();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @conduithq/sdk test`
Expected: PASS (whole suite).

- [ ] **Step 5: INVARIANTS.md rows**

```markdown
| §16.3 — rotation re-seal is atomic: a mid-rotate failure leaves every secret under the OLD key (confirmed via rollback); after success every row (canary incl.) opens ONLY under the new key | `packages/sdk/src/store/key-lifecycle.test.ts` | ✅ pinned |
| §16.3 — commit-boundary honesty: an uncertain COMMIT outcome is classified "unknown" (caller must not delete either candidate key) | `packages/sdk/src/store/key-lifecycle.test.ts` | ✅ pinned |
```

- [ ] **Step 6: Rebuild dist + commit**

```bash
pnpm --filter @conduithq/sdk build
git add packages/sdk/src/store/key-lifecycle.ts packages/sdk/src/store/key-lifecycle.test.ts packages/sdk/src/index.ts INVARIANTS.md
git commit -m "feat: reencryptSecrets — atomic secret re-seal with commit-boundary honesty (§16.3)"
```

---

### Task 3: mcp env — key-file resolution, `keySource`, 0600 db file

**Files:**
- Modify: `packages/mcp/src/env.ts`
- Modify: `packages/mcp/src/env.test.ts`
- Modify: `packages/mcp/src/store-open.ts`
- Modify: `packages/mcp/src/index.ts`
- Modify: `INVARIANTS.md`

**Interfaces:**
- Consumes: Task 1's `StoreKeyContext` via `openSqliteStore`'s `keyContext` option.
- Produces (Tasks 4–5 rely on these):
  - `ResolvedEnv` gains `keySource: "env" | "file"`
  - `resolveEnv(env: NodeJS.ProcessEnv, opts?: ResolveEnvOptions): ResolvedEnv` with `interface ResolveEnvOptions { keyFilePath?: string; warn?: (message: string) => void }` (defaults: `join(homedir(), ".conduit", "master-key")`, `console.error`)
  - `ensureDbFile(dbPath: string): void` (replaces `ensureDbDir` at call sites; `ensureDbDir` stays exported for compat)
  - `openStoreClientFromEnv(env?: NodeJS.ProcessEnv): Promise<{ env: ResolvedEnv; store: ConduitStore; client: Client }>` — same sequence as `openStoreFromEnv` but returns the client (rotate needs it); `openStoreFromEnv` delegates to it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mcp/src/env.test.ts` (existing file — follow its current describe/import style):

```typescript
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDbFile, resolveEnv } from "./env.js";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("key resolution (design §1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conduit-env-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("INVARIANT §16.3: env var wins over the key file; keySource says so", () => {
    const keyFile = join(dir, "master-key");
    writeFileSync(keyFile, Buffer.alloc(32, 9).toString("base64"), { mode: 0o600 });
    const resolved = resolveEnv({ CONDUIT_MASTER_KEY: VALID_KEY }, { keyFilePath: keyFile });
    expect(resolved.keySource).toBe("env");
    expect(Buffer.from(resolved.keyBytes).toString("base64")).toBe(VALID_KEY);
  });

  it("INVARIANT §16.3: no env var → key file is read, validated, keySource 'file'", () => {
    const keyFile = join(dir, "master-key");
    writeFileSync(keyFile, `${VALID_KEY}\n`, { mode: 0o600 }); // trailing newline is trimmed
    const resolved = resolveEnv({}, { keyFilePath: keyFile });
    expect(resolved.keySource).toBe("file");
    expect(Buffer.from(resolved.keyBytes).toString("base64")).toBe(VALID_KEY);
  });

  it("INVARIANT §16.3: neither env nor file → loud error naming `conduit key generate`", () => {
    expect(() => resolveEnv({}, { keyFilePath: join(dir, "master-key") })).toThrow(
      /conduit key generate/,
    );
  });

  it("malformed key FILE names the file, never its contents", () => {
    const keyFile = join(dir, "master-key");
    writeFileSync(keyFile, "not-base64!!", { mode: 0o600 });
    const err = (() => {
      try {
        resolveEnv({}, { keyFilePath: keyFile });
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(String(err)).toContain(keyFile);
    expect(String(err)).not.toContain("not-base64!!");
  });

  it("INVARIANT §16.3: key file wider than 0600 → stderr warning, still serves", () => {
    const keyFile = join(dir, "master-key");
    writeFileSync(keyFile, VALID_KEY, { mode: 0o644 });
    const warnings: string[] = [];
    const resolved = resolveEnv({}, { keyFilePath: keyFile, warn: (m) => warnings.push(m) });
    expect(resolved.keySource).toBe("file");
    expect(warnings.some((w) => w.includes("0600"))).toBe(true);
  });
});

describe("ensureDbFile (design §4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conduit-dbfile-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const mode = (p: string) => statSync(p).mode & 0o777;

  it("INVARIANT §16.3: db file created 0600 before libsql touches it; dir 0700", () => {
    const dbPath = join(dir, "sub", "conduit.db");
    ensureDbFile(dbPath);
    expect(mode(dbPath)).toBe(0o600);
    expect(mode(join(dir, "sub"))).toBe(0o700);
  });

  it("INVARIANT §16.3: existing wider-perms db and sidecars healed to 0600", () => {
    const dbPath = join(dir, "conduit.db");
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      closeSync(openSync(p, "w", 0o644));
      chmodSync(p, 0o644);
    }
    ensureDbFile(dbPath);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      expect(mode(p)).toBe(0o600);
    }
  });

  it("is idempotent and tolerates a concurrent-create race", () => {
    const dbPath = join(dir, "conduit.db");
    ensureDbFile(dbPath);
    ensureDbFile(dbPath); // second call: file exists, already 0600 — no-op
    expect(existsSync(dbPath)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @conduithq/mcp exec vitest run src/env.test.ts`
Expected: FAIL — `ensureDbFile` not exported; `keySource` missing; file fallback throws the old env-only error.

- [ ] **Step 3: Implement**

Rewrite `packages/mcp/src/env.ts` (keep `KEYGEN_ONE_LINER` and the canonical-base64 check verbatim; shown in full):

```typescript
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const KEYGEN_ONE_LINER = `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`;

export const DEFAULT_CONDUIT_DIR = join(homedir(), ".conduit");
export const DEFAULT_KEY_FILE = join(DEFAULT_CONDUIT_DIR, "master-key");

export interface ResolvedEnv {
  dbPath: string;
  keyBytes: Uint8Array<ArrayBuffer>;
  /** Where the key came from — rotate refuses "env"; canary errors name it (design §1). */
  keySource: "env" | "file";
  allowPrivateEgress: boolean;
}

export interface ResolveEnvOptions {
  /** Test seam; production always uses DEFAULT_KEY_FILE. */
  keyFilePath?: string;
  /** Sink for the wide-perms warning (default: console.error — stdout is the MCP wire). */
  warn?: (message: string) => void;
}

function decodeKey(raw: string, sourceLabel: string): Uint8Array<ArrayBuffer> {
  const trimmed = raw.trim();
  const keyBytes = Buffer.from(trimmed, "base64");
  // Canonical-encoding check (design M8): Buffer.from silently ignores
  // invalid base64 characters — re-encode and compare so a corrupted key is
  // a loud per-cause failure, not 32 quietly-wrong bytes.
  if (keyBytes.length !== 32 || keyBytes.toString("base64") !== trimmed) {
    throw new Error(
      `[ConduitMcp] Malformed master key in ${sourceLabel}: expected canonical base64 of exactly 32 bytes ` +
        `(got ${keyBytes.length} bytes${keyBytes.toString("base64") !== trimmed ? ", non-canonical encoding" : ""}). ` +
        `Generate a valid key with: conduit key generate (or ${KEYGEN_ONE_LINER})`,
    );
  }
  // Copy out of the pooled Buffer into a Uint8Array backed by its own
  // ArrayBuffer — matches SecretBox's Uint8Array<ArrayBuffer> contract.
  return Uint8Array.from(keyBytes);
}

export function resolveEnv(env: NodeJS.ProcessEnv, opts?: ResolveEnvOptions): ResolvedEnv {
  const keyFilePath = opts?.keyFilePath ?? DEFAULT_KEY_FILE;
  const warn = opts?.warn ?? ((message: string) => console.error(message));
  const dbPath = env.CONDUIT_DB?.trim() || join(DEFAULT_CONDUIT_DIR, "conduit.db");
  const allowPrivateEgress = env.CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS === "1";

  const raw = env.CONDUIT_MASTER_KEY;
  if (raw !== undefined && raw.trim() !== "") {
    return { dbPath, keyBytes: decodeKey(raw, "CONDUIT_MASTER_KEY"), keySource: "env", allowPrivateEgress };
  }

  if (existsSync(keyFilePath)) {
    if ((statSync(keyFilePath).mode & 0o077) !== 0) {
      warn(
        `[ConduitMcp] WARNING: ${keyFilePath} permissions are wider than 0600 — ` +
          `fix with: chmod 600 ${keyFilePath}`,
      );
    }
    return {
      dbPath,
      keyBytes: decodeKey(readFileSync(keyFilePath, "utf8"), keyFilePath),
      keySource: "file",
      allowPrivateEgress,
    };
  }

  throw new Error(
    `[ConduitMcp] Missing master key: set CONDUIT_MASTER_KEY in your MCP client config, ` +
      `or create ${keyFilePath} with: conduit key generate`,
  );
}

/** Creates the db's parent directory 0700 (it holds encrypted secrets — design M7). */
export function ensureDbDir(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
}

/**
 * Design §4: the db file is 0600 from birth. Create it empty (`wx`, 0600)
 * BEFORE @libsql/client touches the path — SQLite accepts a zero-length file
 * as a fresh db and creates -wal/-shm with the db file's permissions
 * (verified 2026-07-19). Existing wider-perms files (and sidecars) are
 * healed. Guarantee scope: everything opening through openStoreFromEnv /
 * openStoreClientFromEnv; direct createClient callers bypass by design.
 */
export function ensureDbFile(dbPath: string): void {
  ensureDbDir(dbPath);
  if (!existsSync(dbPath)) {
    try {
      closeSync(openSync(dbPath, "wx", 0o600));
      return; // fresh 0600 file; no sidecars can exist yet
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      // lost a concurrent-create race — fall through to heal
    }
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    if (existsSync(path) && (statSync(path).mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
    }
  }
}
```

Rewrite `packages/mcp/src/store-open.ts`:

```typescript
import { type ConduitStore, openSqliteStore, SecretBox } from "@conduithq/sdk";
import { type Client, createClient } from "@libsql/client";
import { ensureDbFile, type ResolvedEnv, resolveEnv } from "./env.js";

/**
 * The env→store opening sequence: resolve env (key file fallback, design
 * §1), ensure the db file exists 0600 (design §4), open the libsql client,
 * open the encrypted store (canary check inside — design §2). Shared by
 * `conduit-mcp`'s bin (--doctor), `runStdioServer`, and the CLI.
 */
export async function openStoreClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ env: ResolvedEnv; store: ConduitStore; client: Client }> {
  const resolved = resolveEnv(env);
  ensureDbFile(resolved.dbPath);
  const client = createClient({ url: `file:${resolved.dbPath}` });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(resolved.keyBytes),
    keyContext: { dbPath: resolved.dbPath, keySource: resolved.keySource },
  });
  return { env: resolved, store, client };
}

/** Back-compat shape — everything except `conduit key rotate` uses this. */
export async function openStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ env: ResolvedEnv; store: ConduitStore }> {
  const { env: resolved, store } = await openStoreClientFromEnv(env);
  return { env: resolved, store };
}
```

Add `openStoreClientFromEnv` (and `DEFAULT_CONDUIT_DIR`, `DEFAULT_KEY_FILE`, `ensureDbFile`) to `packages/mcp/src/index.ts`'s exports, mirroring how `openStoreFromEnv`/`resolveEnv` are exported today.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @conduithq/mcp test`
Expected: PASS. Watch for: existing `env.test.ts` cases that assert the OLD missing-env error text — update them to the new message (state in commit body). Existing integration tests set `CONDUIT_MASTER_KEY`, so `keySource: "env"` keeps them on the unchanged path.

- [ ] **Step 5: INVARIANTS.md rows**

```markdown
| §16.3 — key resolution: env overrides file; neither → loud error naming `conduit key generate`; wide key-file perms warn-and-serve | `packages/mcp/src/env.test.ts` | ✅ pinned |
| §16.3 — conduit.db (and sidecars) 0600 at creation via the env open path; wider existing perms healed | `packages/mcp/src/env.test.ts` | ✅ pinned |
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/env.ts packages/mcp/src/env.test.ts packages/mcp/src/store-open.ts packages/mcp/src/index.ts INVARIANTS.md
git commit -m "feat: key-file-first master-key resolution + 0600-at-creation db file (§16.3)"
```

---

### Task 4: cli `key generate` + dispatch registration

**Files:**
- Create: `packages/cli/src/commands/key.ts`
- Create: `packages/cli/src/key.test.ts`
- Modify: `packages/cli/src/dispatch.ts`, `packages/cli/src/dispatch.test.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `INVARIANTS.md`

**Interfaces:**
- Consumes: `DEFAULT_CONDUIT_DIR` (Task 3), `SecretBox.generateKeyBytes` (sdk), node:fs.
- Produces:
  - `KEY_USAGE: string` (exported for dispatch help interception)
  - `runKey(args: string[], overrides?: Partial<KeyDeps>): Promise<{ exitCode: number }>` — routes `generate`/`rotate`; anything else prints `KEY_USAGE` to stderr, exit 1.
  - `interface KeyDeps { env: NodeJS.ProcessEnv; conduitDir: string; stdout: (line: string) => void; stderr: (line: string) => void; openStoreClient: typeof openStoreClientFromEnv }` (production defaults: `process.env`, `DEFAULT_CONDUIT_DIR`, `process.stdout.write`, `process.stderr.write`, `openStoreClientFromEnv`).

- [ ] **Step 1: dispatch failing tests**

Append to `packages/cli/src/dispatch.test.ts` (follow its existing `dispatch([...])` assertion style):

```typescript
it("routes `key` with its args", () => {
  expect(dispatch(["key", "generate"])).toEqual({
    kind: "route",
    command: "key",
    args: ["generate"],
  });
});

it("`key --help`, `key generate --help`, `key rotate -h` print the family usage, exit 0", () => {
  for (const argv of [["key", "--help"], ["key", "generate", "--help"], ["key", "rotate", "-h"]]) {
    const result = dispatch(argv);
    expect(result.kind).toBe("help");
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @conduithq/cli exec vitest run src/dispatch.test.ts`
Expected: FAIL — `key` is an unknown command.

- [ ] **Step 3: dispatch implementation**

In `packages/cli/src/dispatch.ts`:

```typescript
import { KEY_USAGE } from "./commands/key.js";

export const COMMANDS = ["serve", "add-mcp", "approvals", "key"] as const;
```

Extend `HELP`'s Commands block with a `key` line (`key        Manage the master key (generate | rotate)`), and inside `dispatch`'s `isCommand` branch add (beside the add-mcp interception — the `key` family has NO value-taking flags, so any `--help`/`-h` token is a genuine help request):

```typescript
    if (first === "key" && rest.some((token) => token === "--help" || token === "-h")) {
      return { kind: "help", stdout: `${KEY_USAGE}\n` };
    }
```

In `packages/cli/src/bin.ts`, mirror the existing `approvals` routing arm: `case "key": process.exit((await runKey(route.args)).exitCode);` (match the file's exact style).

- [ ] **Step 4: `key generate` failing tests**

`packages/cli/src/key.test.ts`:

```typescript
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { runKey } from "./commands/key.js";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  };
}

describe("conduit key generate (design §3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conduit-key-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("INVARIANT §16.3: happy path — 0600 key file, no key material on stdout/stderr", async () => {
    const io = makeIo();
    const result = await runKey(["generate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(0);
    const keyPath = join(dir, "master-key");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const key = readFileSync(keyPath, "utf8").trim();
    expect(Buffer.from(key, "base64")).toHaveLength(32);
    const all = [...io.out, ...io.err].join("\n");
    expect(all).not.toContain(key); // NEVER prints the key
    expect(existsSync(join(dir, `master-key.tmp-${process.pid}`))).toBe(false); // temp unlinked
  });

  it("INVARIANT §16.3: refuses when the key file exists (points at rotate)", async () => {
    writeFileSync(join(dir, "master-key"), VALID_KEY, { mode: 0o600 });
    const io = makeIo();
    const result = await runKey(["generate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/conduit key rotate/);
    expect(readFileSync(join(dir, "master-key"), "utf8")).toBe(VALID_KEY); // untouched
  });

  it("INVARIANT §16.3: refuses when CONDUIT_MASTER_KEY is set", async () => {
    const io = makeIo();
    const result = await runKey(["generate"], {
      env: { CONDUIT_MASTER_KEY: VALID_KEY },
      conduitDir: dir,
      ...io,
    });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/env/i);
    expect(existsSync(join(dir, "master-key"))).toBe(false);
  });

  it("INVARIANT §16.3: refuses when the default db already holds sealed rows", async () => {
    // A db file with a secrets row (any bytes count — the check is COUNT, not decrypt).
    // Build it through the real path: put a row via a scratch store.
    const { createDbWithOneSecret } = await import("./key-test-helpers.js");
    await createDbWithOneSecret(join(dir, "conduit.db"));
    const io = makeIo();
    const result = await runKey(["generate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/sealed/i);
    expect(existsSync(join(dir, "master-key"))).toBe(false);
  });

  it("bare `conduit key` / unknown subcommand → usage on stderr, exit 1", async () => {
    for (const args of [[], ["frobnicate"]]) {
      const io = makeIo();
      const result = await runKey(args, { env: {}, conduitDir: dir, ...io });
      expect(result.exitCode).toBe(1);
      expect(io.err.join("\n")).toMatch(/generate/);
    }
  });
});
```

Create `packages/cli/src/key-test-helpers.ts` (test-only, colocated like the existing test fixtures):

```typescript
import { openStoreClientFromEnv } from "@conduithq/mcp";

/** Builds a real db at dbPath containing one sealed secret (fresh throwaway key). */
export async function createDbWithOneSecret(dbPath: string): Promise<string> {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const { store, client } = await openStoreClientFromEnv({
    CONDUIT_DB: dbPath,
    CONDUIT_MASTER_KEY: key,
  });
  await store.secrets.put("cred_seed", "seed-secret");
  client.close();
  return key;
}
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm --filter @conduithq/cli exec vitest run src/key.test.ts`
Expected: FAIL — `./commands/key.js` not found.

- [ ] **Step 6: Implement `key.ts` (generate half + routing)**

`packages/cli/src/commands/key.ts`:

```typescript
import { existsSync, closeSync, fsyncSync, linkSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONDUIT_DIR, openStoreClientFromEnv } from "@conduithq/mcp";
import { SecretBox } from "@conduithq/sdk";
import { mkdirSync } from "node:fs";

export const KEY_USAGE = `conduit key — manage the Conduit master key

Usage: conduit key <subcommand>

Subcommands:
  generate   Mint a new master key at ~/.conduit/master-key (0600).
             Refuses if a key file exists, CONDUIT_MASTER_KEY is set,
             or the default db already holds sealed secrets.
  rotate     Re-seal every stored secret under a fresh key (stop-first:
             stop all conduit processes and MCP clients before running).
             Refuses for env-managed keys and custom CONDUIT_DB paths.

Run with --help for this text. See packages/cli/README.md for the
rotation walkthrough and crash-recovery procedures.`;

export interface KeyDeps {
  env: NodeJS.ProcessEnv;
  conduitDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  openStoreClient: typeof openStoreClientFromEnv;
}

const PROD_DEPS: KeyDeps = {
  env: process.env,
  conduitDir: DEFAULT_CONDUIT_DIR,
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
  openStoreClient: openStoreClientFromEnv,
};

export interface KeyResult {
  exitCode: number;
}

export async function runKey(args: string[], overrides?: Partial<KeyDeps>): Promise<KeyResult> {
  const deps: KeyDeps = { ...PROD_DEPS, ...overrides };
  const [sub] = args;
  if (sub === "generate") return runKeyGenerate(deps);
  if (sub === "rotate") return runKeyRotate(deps);
  deps.stderr(`${KEY_USAGE}\n`);
  return { exitCode: 1 };
}

/** fsync a directory so a just-created/renamed entry survives a host crash. Best-effort on non-POSIX. */
function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function countSealedRows(dbPath: string): Promise<number> {
  // Raw count — no key needed, and MUST NOT create the db as a side effect.
  if (!existsSync(dbPath)) return 0;
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const rs = await client.execute("SELECT COUNT(*) AS n FROM secrets");
    return Number(rs.rows[0]?.n ?? 0);
  } catch {
    return 0; // no secrets table = nothing sealed
  } finally {
    client.close();
  }
}

async function runKeyGenerate(deps: KeyDeps): Promise<KeyResult> {
  const keyPath = join(deps.conduitDir, "master-key");

  if (deps.env.CONDUIT_MASTER_KEY !== undefined && deps.env.CONDUIT_MASTER_KEY.trim() !== "") {
    deps.stderr(
      "[ConduitKey] generate refused: CONDUIT_MASTER_KEY is set (env overrides any key file, so a " +
        "differing file is a delayed lockout). A fresh install can unset the env var and re-run; an " +
        "env-key install with a populated db cannot migrate to file keys in v1 — keep the env key, " +
        "or delete the db and re-onboard.\n",
    );
    return { exitCode: 1 };
  }
  if (existsSync(keyPath)) {
    deps.stderr(
      `[ConduitKey] generate refused: ${keyPath} already exists. To change keys, run: conduit key rotate\n`,
    );
    return { exitCode: 1 };
  }
  const dbPath = join(deps.conduitDir, "conduit.db");
  if ((await countSealedRows(dbPath)) > 0) {
    deps.stderr(
      `[ConduitKey] generate refused: ${dbPath} already holds sealed secrets under some other key — a ` +
        "fresh key cannot decrypt them. Locate the original key, or delete the db and re-onboard.\n",
    );
    return { exitCode: 1 };
  }

  mkdirSync(deps.conduitDir, { recursive: true, mode: 0o700 });
  const stale = readdirSync(deps.conduitDir).filter((f) => f.startsWith("master-key.tmp-"));
  if (stale.length > 0) {
    deps.stderr(
      `[ConduitKey] note: leftover temp key files from a crashed run: ${stale.join(", ")} — inert ` +
        "(never read); remove them at leisure.\n",
    );
  }

  const keyBase64 = Buffer.from(SecretBox.generateKeyBytes()).toString("base64");
  const tmpPath = join(deps.conduitDir, `master-key.tmp-${process.pid}`);
  // Durable-staging publication (design pass-3 #1 / pass-4 #1): content is
  // fsynced BEFORE the final name exists; link() never replaces, so EEXIST
  // is the concurrent-generate loser. Same inode — unlinking the temp after
  // link leaves the published key untouched.
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeSync(fd, `${keyBase64}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmpPath, keyPath);
  } catch (cause) {
    unlinkSync(tmpPath);
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      deps.stderr(
        `[ConduitKey] generate refused: ${keyPath} appeared concurrently — another generate won. ` +
          "Re-run to inspect state; nothing was overwritten.\n",
      );
      return { exitCode: 1 };
    }
    throw cause;
  }
  let durabilityWarning = "";
  try {
    fsyncDir(deps.conduitDir);
  } catch {
    durabilityWarning =
      "[ConduitKey] WARNING: directory fsync failed — the key file is live and correct, but until " +
      "the entry is durable a host crash could lose it. Verify the disk, then re-run any command to confirm.\n";
  }
  unlinkSync(tmpPath);

  if (durabilityWarning) deps.stderr(durabilityWarning);
  deps.stdout(
    `[ConduitKey] master key generated at ${keyPath} (0600).\n` +
      "Next steps:\n" +
      "  1. Your MCP client config no longer needs CONDUIT_MASTER_KEY for default-path setups.\n" +
      "  2. Onboard an upstream: conduit add-mcp --url <url> --namespace <ns> --prefix <prefix>\n" +
      "  3. Stop-first rule: run this BEFORE wiring clients; see packages/cli/README.md.\n",
  );
  return { exitCode: 0 };
}
```

(`runKeyRotate` is Task 5 — for this commit add a stub that prints `KEY_USAGE` guidance and exits 1: `deps.stderr("[ConduitKey] rotate lands in the next commit of this branch.\n"); return { exitCode: 1 };` — replaced in Task 5. The dispatch/help/refusal tests must not depend on it.)

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @conduithq/cli test`
Expected: PASS — dispatch + generate suites green; existing suites untouched.

- [ ] **Step 8: INVARIANTS.md rows**

```markdown
| §16.3 — `key generate` refusals (file exists / env set / db has sealed rows) and 0600 link-publication; key material never printed | `packages/cli/src/key.test.ts` | ✅ pinned |
```

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/commands/key.ts packages/cli/src/key.test.ts packages/cli/src/key-test-helpers.ts packages/cli/src/dispatch.ts packages/cli/src/dispatch.test.ts packages/cli/src/bin.ts INVARIANTS.md
git commit -m "feat: conduit key generate — file-based master key with durable no-clobber publication (§16.3)"
```

---

### Task 5: cli `key rotate`

**Files:**
- Modify: `packages/cli/src/commands/key.ts` (replace the stub)
- Modify: `packages/cli/src/key.test.ts`
- Modify: `INVARIANTS.md`

**Interfaces:**
- Consumes: `openStoreClientFromEnv` (Task 3), `reencryptSecrets`/`ReencryptError` (Task 2), `SecretBox.fromKeyBytes`/`generateKeyBytes` (sdk), `createDbWithOneSecret` helper (Task 4).
- Produces: the final `runKeyRotate(deps)` behavior; no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/key.test.ts`:

```typescript
import { copyFileSync, renameSync } from "node:fs";
import { openStoreClientFromEnv } from "@conduithq/mcp";

/** Sets up a rotatable install: file-sourced key + db with one real secret. */
async function rotatableInstall(dir: string) {
  const keyPath = join(dir, "master-key");
  const dbPath = join(dir, "conduit.db");
  const key = await (await import("./key-test-helpers.js")).createDbWithOneSecret(dbPath);
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  return { keyPath, dbPath, key };
}

describe("conduit key rotate (design §3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "conduit-rotate-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("INVARIANT §16.3: end state — db + key file both new, .bak = old, secret still opens; keys never printed", async () => {
    const { keyPath, dbPath, key: oldKey } = await rotatableInstall(dir);
    const io = makeIo();
    const result = await runKey(["rotate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(0);

    const newKey = readFileSync(keyPath, "utf8").trim();
    expect(newKey).not.toBe(oldKey);
    expect(readFileSync(join(dir, "master-key.bak"), "utf8").trim()).toBe(oldKey);
    expect(existsSync(join(dir, "master-key.next"))).toBe(false);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    // db opens under the NEW key; the real secret round-trips
    const { store, client } = await openStoreClientFromEnv({
      CONDUIT_DB: dbPath,
      CONDUIT_MASTER_KEY: newKey,
    });
    expect(await store.secrets.reveal("cred_seed")).toBe("seed-secret");
    client.close();

    const all = [...io.out, ...io.err].join("\n");
    expect(all).not.toContain(oldKey);
    expect(all).not.toContain(newKey);
    expect(all).toMatch(/restart/i); // "restart your MCP clients"
  });

  it("INVARIANT §16.3: refuses an env-sourced key", async () => {
    const { key } = await rotatableInstall(dir);
    const io = makeIo();
    const result = await runKey(["rotate"], {
      env: { CONDUIT_MASTER_KEY: key },
      conduitDir: dir,
      ...io,
    });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/env/i);
  });

  it("INVARIANT §16.3: refuses a custom CONDUIT_DB path", async () => {
    await rotatableInstall(dir);
    const io = makeIo();
    const result = await runKey(["rotate"], {
      env: { CONDUIT_DB: join(dir, "elsewhere.db") },
      conduitDir: dir,
      ...io,
    });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/CONDUIT_DB/);
  });

  it("INVARIANT §16.3: refuses a leftover master-key.next (never silently reused or deleted)", async () => {
    await rotatableInstall(dir);
    writeFileSync(join(dir, "master-key.next"), "leftover", { mode: 0o600 });
    const io = makeIo();
    const result = await runKey(["rotate"], { env: {}, conduitDir: dir, ...io });
    expect(result.exitCode).toBe(1);
    expect(io.err.join("\n")).toMatch(/master-key\.next/);
    expect(readFileSync(join(dir, "master-key.next"), "utf8")).toBe("leftover");
  });

  it("INVARIANT §16.3: BUSY refusal removes its own .next — retry is not poisoned", async () => {
    const { dbPath, key } = await rotatableInstall(dir);
    // Hold the write lock from a second connection.
    const holder = await openStoreClientFromEnv({ CONDUIT_DB: dbPath, CONDUIT_MASTER_KEY: key });
    const tx = await holder.client.transaction("write");
    await tx.execute("SELECT 1"); // materialize BEGIN IMMEDIATE
    try {
      const io = makeIo();
      const result = await runKey(["rotate"], { env: {}, conduitDir: dir, ...io });
      expect(result.exitCode).toBe(1);
      expect(io.err.join("\n")).toMatch(/stop running conduit processes/i);
      expect(existsSync(join(dir, "master-key.next"))).toBe(false); // cleaned up
      expect(readFileSync(join(dir, "master-key"), "utf8").trim()).toBe(key); // untouched
    } finally {
      await tx.rollback();
      tx.close();
      holder.client.close();
    }
  });

  it("INVARIANT §16.3: crash-table row 2 — .next promotes manually and the db opens", async () => {
    // Simulate "crash after commit, before promote": run a real rotate, then
    // reconstruct row-2 state from its outputs (bak=old, next=new via rename back).
    const { keyPath, dbPath, key: oldKey } = await rotatableInstall(dir);
    const io = makeIo();
    await runKey(["rotate"], { env: {}, conduitDir: dir, ...io });
    const newKey = readFileSync(keyPath, "utf8").trim();
    renameSync(keyPath, join(dir, "master-key.next")); // db=new, master-key absent→restore old
    writeFileSync(keyPath, `${oldKey}\n`, { mode: 0o600 });
    // startup with the stale (old) key fails loud and names the recovery files
    // (resolveEnv's default key-file path is HOME-based, so pass the old key explicitly)
    const err = await openStoreClientFromEnv({
      CONDUIT_DB: dbPath,
      CONDUIT_MASTER_KEY: oldKey,
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/master-key\.next|rotation-recovery/);
    // the documented manual recovery works: mv .next → master-key
    renameSync(join(dir, "master-key.next"), keyPath);
    const opened = await openStoreClientFromEnv({
      CONDUIT_DB: dbPath,
      CONDUIT_MASTER_KEY: newKey,
    });
    expect(await opened.store.secrets.reveal("cred_seed")).toBe("seed-secret");
    opened.client.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @conduithq/cli exec vitest run src/key.test.ts`
Expected: FAIL — the rotate stub exits 1 on every path.

- [ ] **Step 3: Implement `runKeyRotate`**

Replace the Task-4 stub in `packages/cli/src/commands/key.ts`:

```typescript
import { copyFileSync, renameSync } from "node:fs";
import { ReencryptError, reencryptSecrets, SecretBox } from "@conduithq/sdk";

const RECOVERY_HINT =
  "Recovery: whichever of master-key / master-key.next opens the db is live — " +
  "promote it (mv) or restore master-key.bak; see packages/cli/README.md.";

async function runKeyRotate(deps: KeyDeps): Promise<KeyResult> {
  const keyPath = join(deps.conduitDir, "master-key");
  const bakPath = join(deps.conduitDir, "master-key.bak");
  const nextPath = join(deps.conduitDir, "master-key.next");

  // Refusals (design §3) — each names the way forward.
  if (deps.env.CONDUIT_MASTER_KEY !== undefined && deps.env.CONDUIT_MASTER_KEY.trim() !== "") {
    deps.stderr(
      "[ConduitKey] rotate refused: the key is env-managed (CONDUIT_MASTER_KEY). Rotation is " +
        "unsupported for env-managed keys in v1 — keep using the env key, or delete the db and " +
        "re-onboard (conduit key import is the deferred migration path).\n",
    );
    return { exitCode: 1 };
  }
  if (deps.env.CONDUIT_DB !== undefined && deps.env.CONDUIT_DB.trim() !== "") {
    deps.stderr(
      "[ConduitKey] rotate refused: CONDUIT_DB is set. Rotation is defined only for the default " +
        "db + key-file pair (one global key file cannot serve N dbs). Custom-path installs: manage " +
        "the key via env; rotation story is delete-and-re-onboard.\n",
    );
    return { exitCode: 1 };
  }
  if (existsSync(nextPath)) {
    deps.stderr(
      `[ConduitKey] rotate refused: ${nextPath} exists — a prior rotation crashed mid-flight. ${RECOVERY_HINT}\n`,
    );
    return { exitCode: 1 };
  }

  // 1. Preflight: open the store — the canary proves the old key (design §2).
  //    deps.env deliberately lacks CONDUIT_MASTER_KEY here (checked above), so
  //    resolution is file-sourced.
  let opened: Awaited<ReturnType<typeof deps.openStoreClient>>;
  try {
    opened = await deps.openStoreClient(deps.env);
  } catch (cause) {
    deps.stderr(`[ConduitKey] rotate preflight failed: ${String(cause)}\n`);
    return { exitCode: 1 };
  }
  const { client } = opened;

  try {
    // 2. Backup the old key (overwritten each rotation — crash insurance, not history).
    copyFileSync(keyPath, bakPath);
    const bakFd = openSync(bakPath, "r");
    try {
      fsyncSync(bakFd);
    } finally {
      closeSync(bakFd);
    }

    // 3. Persist the NEW key BEFORE the db changes (wx: a racing rotate loses here).
    const newKeyBytes = SecretBox.generateKeyBytes();
    const newKeyBase64 = Buffer.from(newKeyBytes).toString("base64");
    const nextFd = openSync(nextPath, "wx", 0o600);
    try {
      writeSync(nextFd, `${newKeyBase64}\n`);
      fsyncSync(nextFd);
    } finally {
      closeSync(nextFd);
    }
    fsyncDir(deps.conduitDir);

    // 4. Re-seal in ONE write transaction (Task 2 owns atomicity + classification).
    const oldBox = await SecretBox.fromKeyBytes(opened.env.keyBytes);
    const newBox = await SecretBox.fromKeyBytes(newKeyBytes);
    let count: number;
    try {
      count = await reencryptSecrets(client, oldBox, newBox);
    } catch (cause) {
      if (cause instanceof ReencryptError && cause.dbState === "unchanged") {
        // Confirmed still-old → this run's .next is provably meaningless.
        try {
          unlinkSync(nextPath);
        } catch {
          deps.stderr(`[ConduitKey] note: could not remove ${nextPath} — delete it before retrying.\n`);
        }
        deps.stderr(`[ConduitKey] rotation failed (db unchanged): ${cause.message}\n`);
        return { exitCode: 1 };
      }
      // Uncertain outcome → NEVER delete .next (design pass-4 #2).
      deps.stderr(`[ConduitKey] rotation failed with UNCERTAIN db state: ${String(cause)}\n${RECOVERY_HINT}\n`);
      return { exitCode: 1 };
    }

    // 5. Promote (two failure states — design pass-4 #3).
    try {
      renameSync(nextPath, keyPath);
    } catch (cause) {
      deps.stderr(
        `[ConduitKey] rotation committed but promotion failed: ${String(cause)}\n` +
          `The db is under the NEW key at ${nextPath}. Recovery: mv ${nextPath} ${keyPath}\n`,
      );
      return { exitCode: 1 };
    }
    let promoteWarning = "";
    try {
      fsyncDir(deps.conduitDir);
    } catch {
      promoteWarning =
        "[ConduitKey] WARNING: directory fsync failed after promotion — the new key is live and " +
        "correct, but until the entry is durable a host crash could revert it; master-key.bak " +
        "still holds the old key.\n";
    }

    // 6. Hygiene — best-effort defense-in-depth (design pass-2 #2), never a failure.
    let hygieneWarning = "";
    try {
      await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
      await client.execute("VACUUM");
    } catch (cause) {
      hygieneWarning =
        `[ConduitKey] WARNING: post-rotation cleanup (checkpoint/VACUUM) failed: ${String(cause)} — ` +
        "old-key ciphertext may linger in WAL/free pages. Once all conduit processes are stopped, " +
        "re-run it via the one-liner in packages/cli/README.md.\n";
    }

    if (promoteWarning) deps.stderr(promoteWarning);
    if (hygieneWarning) deps.stderr(hygieneWarning);
    deps.stdout(
      `[ConduitKey] rotation complete: ${count} secrets re-sealed under the new key.\n` +
        "Restart your MCP clients now (any process started before rotation holds the old key).\n" +
        "Back up the db and key file TOGETHER — old db backups pair only with master-key.bak-era keys.\n",
    );
    return { exitCode: 0 };
  } finally {
    client.close();
  }
}
```

(Also remove the Task-4 stub text and make sure `runKey` routes `rotate` here. The pre-rotate store handle is used ONLY for preflight — after `reencryptSecrets` commits, nothing touches `opened.store` again; the process exits.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @conduithq/cli test`
Expected: PASS (whole cli suite; BUSY test relies on the 5000ms busy_timeout — the second writer errors after its wait; runtime ≈ 5–6s for that case).

- [ ] **Step 5: INVARIANTS.md rows**

```markdown
| §16.3 — `key rotate` refusals (env-sourced key / custom CONDUIT_DB / held write lock / leftover master-key.next); a BUSY refusal removes its own `.next` so the retry is not poisoned | `packages/cli/src/key.test.ts` | ✅ pinned |
| §16.3 — rotation end-state: db + key file both new, `master-key.bak` = old, real secret round-trips; crash-table row-2 manual promotion recovers; key material never printed | `packages/cli/src/key.test.ts` | ✅ pinned |
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/key.ts packages/cli/src/key.test.ts INVARIANTS.md
git commit -m "feat: conduit key rotate — stop-first in-place re-seal with manual crash recovery (§16.3)"
```

---

### Task 6: docs — spec, READMEs, ledger sweep

**Files:**
- Modify: `conduitspec.html` → regenerate `conduitspec.md` (`python3 html2md.py`, same turn — project rule)
- Modify: `packages/cli/README.md`, `packages/mcp/README.md`
- Verify: `INVARIANTS.md` (rows landed in Tasks 1–5; this task only sweeps)

**Interfaces:** none (prose). Content requirements, from design §7 — every bullet must land:

- [ ] **Step 1: Spec edits (`conduitspec.html`, then `python3 html2md.py`)**

1. §14 `/mcp` onboarding step 1: replace the raw keygen one-liner as the primary path with `conduit key generate` (file-based default); keep the one-liner as the env-var alternative. Drop "chmod 600 the client config file afterward — it now holds the master key" for default-path setups; note the env block no longer needs the key when `~/.conduit/master-key` exists.
2. §14 env-var table, `CONDUIT_MASTER_KEY` row: default becomes "optional when `~/.conduit/master-key` exists (env overrides file)".
3. §14 troubleshooting: "a wrong master key fails at first secret decrypt, not startup" → "a wrong master key fails at startup (key canary)".
4. §16 item 3 ("Secrets encrypted at rest"): append the lifecycle sentence — key file `~/.conduit/master-key` (0600) or env override; startup canary; `conduit key generate`/`rotate`; stop-first rotation obligation; crash recovery via `master-key.bak`/`master-key.next` manual procedure; paired db+key backup rule.
5. §17 v1 prerequisite bullet ("verify credential key lifecycle"): mark it BUILT with a pointer to the design doc date (2026-07-19) — generation, permissions, and the recovery/rotation story are now product behavior pinned in `INVARIANTS.md` §16.3 rows.

- [ ] **Step 2: `packages/cli/README.md`**

Add a `conduit key` section containing, verbatim as procedures:
1. `generate` reference (all three refusals + what the happy path writes).
2. Rotation walkthrough: stop clients → `conduit key rotate` → restart clients.
3. Crash recovery (the design's table, prose form): db won't open + `master-key.next` present → try `.next` as the key (`mv master-key.next master-key`); db under old key → `master-key.next` is stale, delete and re-run; last resort → `cp master-key.bak master-key`.
4. Canary-corruption recovery SQL one-liner: `sqlite3 ~/.conduit/conduit.db "DELETE FROM secrets WHERE ref = '__conduit.key-canary.v1__'"` then reopen.
5. Hygiene re-run one-liner: `sqlite3 ~/.conduit/conduit.db "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"` (stopped processes only).
6. Env-key and custom-`CONDUIT_DB` installs: rotation story is delete-and-re-onboard (v1).
7. Backup rule: back up `conduit.db` and `master-key` together, always.

- [ ] **Step 3: `packages/mcp/README.md`**

Onboarding now starts with `conduit key generate`; the client-config snippet drops `CONDUIT_MASTER_KEY` for default-path setups (keep the env variant as the alternative for containers/custom paths).

- [ ] **Step 4: Regenerate + verify**

```bash
python3 html2md.py
git diff --stat  # conduitspec.md must move in lockstep with conduitspec.html
pnpm -r test     # full workspace green before the docs commit
```

- [ ] **Step 5: Commit**

```bash
git add conduitspec.html conduitspec.md packages/cli/README.md packages/mcp/README.md
git commit -m "docs: key lifecycle — spec §14/§16/§17 truth-ups, key command reference, recovery procedures"
```

---

## Post-plan gauntlet (load-bearing route — from HANDOFF, not optional)

After Task 6: whole-branch review → PR (design + plan ride with it, the PR #31 precedent) → Tier-2 BOTH mechanics (`/pr-review-toolkit:review-pr all parallel` pre-PR; `code-review` post-PR) → `/security-review` → codex correctness-framed pass per `codex-one-path` (the DESIGN converged over 5 passes; the CODE pass is separate and required) → `/explain-diff` + quiz gate → HUMAN-NAMED merge. Deviations log lives in the scratchpad; summarize under "Deviations" in the PR description.

## Self-review (performed at write time)

- **Spec coverage:** design §1 → Task 3; §2 → Task 1; §3 generate → Task 4; §3 rotate + SDK seam → Tasks 2+5; §4 → Task 3; §5 woven through all error paths; §6 ledger → per-task rows exactly matching the design's invariant table (the design's "hygiene failure → still succeeds with loud warning" row is pinned by Task 5's implementation and exercised in the BUSY/end-state tests; a dedicated fault-injection test for hygiene would need a client stub — acceptable coverage via the warning branch being unreachable only when both PRAGMAs succeed); §7 → Task 6. The design's "post-link dir-fsync = success + durability warning" ledger row is implemented in Task 4; its test would need fsync fault injection — pinned at the code level by the warning branch, noted here as the one deliberate test-depth deviation (STOP-and-ask if the reviewer wants an injectable fs seam instead).
- **Placeholders:** none — every step carries code or exact commands.
- **Type consistency:** `StoreKeyContext`/`keyContext` (Tasks 1↔3), `ReencryptError.dbState` (Tasks 2↔5), `openStoreClientFromEnv` return shape (Tasks 3↔4↔5), `KeyDeps`/`runKey` (Tasks 4↔5) cross-checked.
