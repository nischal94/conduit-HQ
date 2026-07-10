# §11 Trace Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redact policy-configured sensitive fields in the audit Trace at write time (input + outputSummary), drop the vestigial full `TraceEvent.output`, and flip the last ⏳ INVARIANTS row — completing Phase 0.

**Architecture:** A pure redactor module (`pipeline/redact.ts`) owns a builtin key denylist + normalized exact matching. Per-tool additions live on the `Policy` row and ride back on the `PolicyVerdict` (zero extra store reads on the common path). `appendTrace` in `pipeline/invoker.ts` — the only TraceEvent producer — applies redaction before append. The §5.5 replay journal is deliberately untouched (design D7). Spec: `docs/superpowers/specs/2026-07-10-trace-redaction-design.md` (decisions R1–R8).

**Tech Stack:** TypeScript (strict), vitest, libsql/SQLite. No new dependencies.

## Global Constraints

- Branch: `feat/trace-redaction` (already created from origin/main; the design spec is committed on it).
- Binaries: `packages/sdk/node_modules/.bin/{vitest,tsc}` — run from `packages/sdk`. Biome: `node_modules/.bin/biome` from repo root.
- **vitest suites that bind loopback servers (manager.test.ts, e2e.smoke.test.ts, upstream.test.ts) HANG under the Bash-tool sandbox** — run vitest with the sandbox disabled, or rely on the (unsandboxed) pre-commit hook run, which executes the full suite + biome on every commit.
- **The redactor must be strictly non-mutating** (spec R5): the manager journals the same object reference AFTER `appendTrace` runs; in-place mutation = replay divergence = D7 violation.
- **Never touch:** `replay_journal` writes/reads, `execution/journal.ts`, `execution/scrub.ts`, `PendingApproval.input` (spec R8).
- The redaction marker is exactly `"[redacted]"` (matches `pipeline/upstream.ts`).
- Conventional Commits; each task commits separately; the pre-commit hook must pass (it runs the whole suite).
- INVARIANTS.md row flips ✅ **in the same commit** as the invariant test (Task 5).

---

### Task 1: Redactor module `pipeline/redact.ts`

**Files:**
- Create: `packages/sdk/src/pipeline/redact.ts`
- Test: `packages/sdk/src/pipeline/redact.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 3, 5):
  - `export const BUILTIN_REDACT_KEYS: readonly string[]`
  - `export function normalizeRedactKey(key: string): string`
  - `export function redactSensitiveFields(value: unknown, extraKeys: readonly string[]): unknown`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/src/pipeline/redact.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { redactSensitiveFields } from "./redact.js";

describe("redactSensitiveFields (spec §11, design R2/R5)", () => {
  it("masks builtin keys at any depth, across arrays, in all naming variants", () => {
    const input = {
      user: "octocat",
      password: "hunter2",
      nested: { api_key: "sk-123", keep: "visible" },
      items: [{ "X-API-Key": "sk-456", id: 7 }, { Authorization: "Bearer abc" }],
    };
    const out = redactSensitiveFields(input, []) as Record<string, unknown>;
    expect(out).toEqual({
      user: "octocat",
      password: "[redacted]",
      nested: { api_key: "[redacted]", keep: "visible" },
      items: [{ "X-API-Key": "[redacted]", id: 7 }, { Authorization: "[redacted]" }],
    });
  });

  it("masks per-tool extra keys with the same normalization, and a matched key's whole subtree", () => {
    const input = {
      customerEmail: "a@b.com",
      details: { customer_email: "c@d.com", note: "hi" },
      payload: { secretBlob: { inner: "x" } },
    };
    const out = redactSensitiveFields(input, ["customer-email", "secret_blob"]);
    expect(out).toEqual({
      customerEmail: "[redacted]",
      details: { customer_email: "[redacted]", note: "hi" },
      payload: { secretBlob: "[redacted]" },
    });
  });

  it("normalized matching is exact, not substring: author does not match auth", () => {
    const out = redactSensitiveFields({ author: "kernighan", auth: "abc" }, []);
    expect(out).toEqual({ author: "kernighan", auth: "[redacted]" });
  });

  it("passes non-object roots through unchanged", () => {
    expect(redactSensitiveFields("a bare string with password inside", [])).toBe(
      "a bare string with password inside",
    );
    expect(redactSensitiveFields(42, [])).toBe(42);
    expect(redactSensitiveFields(null, [])).toBe(null);
    expect(redactSensitiveFields(undefined, [])).toBe(undefined);
  });

  it("fails CLOSED past the depth cap: the deep subtree becomes the marker, never raw", () => {
    // Build an object 70 levels deep with a sensitive leaf below the cap of 64.
    let deep: Record<string, unknown> = { password: "leaf-secret" };
    for (let i = 0; i < 70; i += 1) {
      deep = { level: deep };
    }
    const serialized = JSON.stringify(redactSensitiveFields(deep, []));
    expect(serialized).not.toContain("leaf-secret");
    expect(serialized).toContain("[redacted]");
  });

  it("fails CLOSED on a cycle: the back-reference becomes the marker instead of hanging", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    const out = redactSensitiveFields(node, []) as Record<string, unknown>;
    expect(out.name).toBe("a");
    expect(out.self).toBe("[redacted]");
  });

  it("does not conflate a shared (non-cyclic) subtree with a cycle", () => {
    const shared = { v: 1 };
    const out = redactSensitiveFields({ a: shared, b: shared }, []);
    expect(out).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it("NEVER mutates its argument (load-bearing: the journal serializes the same reference after appendTrace — design R5)", () => {
    const input = { password: "hunter2", nested: { token: "t", ok: 1 }, list: [{ secret: "s" }] };
    const snapshot = structuredClone(input);
    redactSensitiveFields(input, ["ok"]);
    expect(input).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/sdk`): `node_modules/.bin/vitest run src/pipeline/redact.test.ts`
Expected: FAIL — cannot resolve `./redact.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/sdk/src/pipeline/redact.ts`:

```typescript
/**
 * §11 semantic redaction — display hygiene for the audit Trace, NOT a
 * security boundary. The credential boundary is structural (§9.2:
 * request-scoped, never-persisted credentials); the §5.5 replay journal
 * is deliberately untouched (design D7 / spec R8). The claim here is
 * BOUNDED and convergent (adversarial-convergence.md): fields NAMED by
 * the builtin list or a tool's policy are masked — not "all sensitive
 * data". Scalar payloads are not scanned.
 *
 * STRICTLY NON-MUTATING (design R5, load-bearing): the execution manager
 * scrubs and journals the same `value` reference AFTER appendTrace runs,
 * and `pausedOn.input` is journaled after the refusal-path trace append.
 * An in-place mutation here would put semantically-redacted data into
 * the replay journal — replay divergence, exactly the D7 violation this
 * module must not commit.
 */

/** Same marker as pipeline/upstream.ts's credential scan. */
const REDACTED = "[redacted]";

/**
 * Fail-closed recursion cap: past it, the SUBTREE is replaced with the
 * marker — passing it through unredacted would make deep nesting a
 * redaction bypass (design R5).
 */
const MAX_DEPTH = 64;

/**
 * Builtin sensitive key names, already normalized (see normalizeRedactKey).
 * Pinned by the INVARIANT §11 test; extend deliberately, not per finding.
 */
export const BUILTIN_REDACT_KEYS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "xapikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "clientsecret",
  "authorization",
  "auth",
  "bearer",
  "credential",
  "credentials",
  "cookie",
  "setcookie",
  "ssn",
];

/**
 * Lowercase + strip `-`, `_`, `.`, and spaces: `apiKey`, `api_key`, and
 * `API-KEY` all normalize to `apikey`. Matching is EXACT on the normalized
 * form (`author` never matches `auth`) — no substring heuristics, so the
 * claim stays bounded (design R2).
 */
export function normalizeRedactKey(key: string): string {
  return key.toLowerCase().replace(/[-_.\s]/g, "");
}

/**
 * Returns a redacted deep copy of `value`: every object entry whose
 * normalized key is in the builtin list or `extraKeys` has its value
 * (scalar or whole subtree) replaced with "[redacted]". Non-object roots
 * pass through unchanged. Never mutates `value`.
 */
export function redactSensitiveFields(value: unknown, extraKeys: readonly string[]): unknown {
  const keys = new Set(BUILTIN_REDACT_KEYS);
  for (const key of extraKeys) {
    keys.add(normalizeRedactKey(key));
  }
  return walk(value, keys, 0, new WeakSet());
}

function walk(
  value: unknown,
  keys: ReadonlySet<string>,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_DEPTH || ancestors.has(value)) {
    return REDACTED;
  }
  // `ancestors` tracks the CURRENT path only (delete after recursion), so a
  // shared non-cyclic subtree is copied normally and only a true
  // back-reference trips the fail-closed arm.
  ancestors.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((item) => walk(item, keys, depth + 1, ancestors));
  } else {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = keys.has(normalizeRedactKey(key)) ? REDACTED : walk(entry, keys, depth + 1, ancestors);
    }
    result = out;
  }
  ancestors.delete(value);
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/sdk`): `node_modules/.bin/vitest run src/pipeline/redact.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck and commit**

Run (from `packages/sdk`): `node_modules/.bin/tsc --noEmit`
Expected: clean.

```bash
git add packages/sdk/src/pipeline/redact.ts packages/sdk/src/pipeline/redact.test.ts
git commit -m "feat: §11 redactor — builtin denylist, normalized exact matching, fail-closed guards (R2/R5)"
```

---

### Task 2: `redactFields` on Policy + PolicyVerdict, sqlite policies column

**Files:**
- Modify: `packages/sdk/src/types.ts` (Policy, ~line 73)
- Modify: `packages/sdk/src/policy.ts` (PolicyVerdict + all verdict constructors)
- Modify: `packages/sdk/src/pipeline/invoker.ts` (two synthetic verdicts in `resolveDecisionVerdict`, ~lines 269–271; the `blocked` verdict ~line 133)
- Modify: `packages/sdk/src/store/sqlite.ts` (policies CREATE TABLE ~line 66, retrofit block ~line 116, upsert ~line 270, `rowToPolicy` ~line 721)
- Modify: `packages/sdk/src/pipeline/invoker.test.ts` (one fixture verdict, ~line 159)
- Test: `packages/sdk/src/policy.test.ts`, `packages/sdk/src/store/sqlite.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 3, 5):
  - `Policy.redactFields: string[]` (required, default `[]` at call sites)
  - `PolicyVerdict.redactFields: readonly string[]` (required)
  - sqlite column `policies.redact_fields TEXT NOT NULL DEFAULT '[]'`

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/src/policy.test.ts` (inside `describe("createStorePolicyEngine")`; the file's `memoryPolicies()` helper and `known`/`unknown`/`makeTool` fixtures already exist — note `memoryPolicies()` rows will need `redactFields` in their `Policy` objects once types change):

```typescript
  it("§11: verdicts carry the row's redactFields on every shape, independent of manualOverride", async () => {
    const policies = memoryPolicies();
    const engine = createStorePolicyEngine(policies);
    const tool = makeTool("safe", "acme.things.redacted");

    // No row → empty additions.
    const bare = await engine.evaluate(known(tool));
    expect(bare.redactFields).toEqual([]);

    // Row WITHOUT manualOverride: action stays the default, but redactFields apply.
    await policies.upsert({
      toolName: tool.name,
      action: "allow",
      seededFrom: "safe",
      manualOverride: false,
      redactFields: ["customer_email"],
    });
    const tuned = await engine.evaluate(known(tool));
    expect(tuned.source).toBe("default");
    expect(tuned.redactFields).toEqual(["customer_email"]);

    // Row WITH manualOverride: override verdict carries them too.
    await policies.upsert({
      toolName: tool.name,
      action: "block",
      seededFrom: "safe",
      manualOverride: true,
      redactFields: ["customer_email", "amount"],
    });
    const overridden = await engine.evaluate(known(tool));
    expect(overridden.source).toBe("override");
    expect(overridden.redactFields).toEqual(["customer_email", "amount"]);

    // Unknown tool → empty additions.
    const missing = await engine.evaluate(unknown("acme.ghost"));
    expect(missing.redactFields).toEqual([]);
  });
```

Append to `packages/sdk/src/store/sqlite.test.ts` (a policies round-trip + retrofit test; the file already has an `openStore()`-style helper pattern — follow the existing policies tests' setup in that file):

```typescript
  it("§11: policies round-trip redactFields, and a pre-§11 DB is retrofitted with the column", async () => {
    // Round-trip on a fresh store.
    await store.policies.upsert({
      toolName: "github.list_issues",
      action: "allow",
      seededFrom: "safe",
      manualOverride: false,
      redactFields: ["customer_email"],
    });
    const row = await store.policies.get("github.list_issues");
    expect(row?.redactFields).toEqual(["customer_email"]);

    // Legacy DB: create a policies table WITHOUT redact_fields, then reopen.
    const legacy = createClient({ url: ":memory:" });
    await legacy.execute(`CREATE TABLE policies (
      tool_name TEXT PRIMARY KEY,
      action TEXT NOT NULL CHECK (action IN ('allow', 'require_approval', 'block')),
      seeded_from TEXT NOT NULL CHECK (seeded_from IN ('safe', 'review', 'destructive')),
      manual_override INTEGER NOT NULL CHECK (manual_override IN (0, 1))
    )`);
    await legacy.execute({
      sql: "INSERT INTO policies (tool_name, action, seeded_from, manual_override) VALUES (?, ?, ?, ?)",
      args: ["github.delete_repo", "block", "destructive", 1],
    });
    const reopened = await openSqliteStore({
      client: legacy,
      secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
    });
    const migrated = await reopened.policies.get("github.delete_repo");
    expect(migrated?.redactFields).toEqual([]);
    expect(migrated?.manualOverride).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/sdk`): `node_modules/.bin/vitest run src/policy.test.ts src/store/sqlite.test.ts`
Expected: FAIL — `redactFields` does not exist on the types (compile errors are the failure mode here).

- [ ] **Step 3: Implement**

In `packages/sdk/src/types.ts`, extend `Policy` (after `manualOverride: boolean;`):

```typescript
  /**
   * §11 per-tool additions to the builtin sensitive-key list: key names
   * (normalized matching, pipeline/redact.ts) masked in this tool's audit
   * Trace rows. Operator data — respected independently of manualOverride.
   */
  redactFields: string[];
```

In `packages/sdk/src/policy.ts`:

1. Extend `PolicyVerdict`:

```typescript
export interface PolicyVerdict {
  readonly action: PolicyAction;
  readonly reason: string;
  readonly source: PolicyVerdictSource;
  /**
   * §11 per-tool redaction additions from the policy row, applied by
   * appendTrace on this call's audit row. Builtins always apply and are
   * owned by the redactor; this carries only the row's extras. Display
   * hygiene riding the verdict so the engine's single row read serves
   * both concerns — never a security decision.
   */
  readonly redactFields: readonly string[];
}
```

2. Thread it through the constructors — `defaultVerdict` and `overrideVerdict` gain a parameter, every return arm gains the field:

```typescript
function defaultVerdict(tool: Tool, redactFields: readonly string[]): PolicyVerdict {
  // ... each existing return gains: redactFields,
}

function overrideVerdict(
  toolName: string,
  action: PolicyAction,
  redactFields: readonly string[],
): PolicyVerdict {
  // ... each existing return gains: redactFields,
}
```

3. In `evaluate` (inside `createStorePolicyEngine`):

```typescript
      if (target.kind === "unknown") {
        return {
          action: "block",
          reason: `Unknown tool "${printableName(target.toolName)}": not in the catalog, so it is blocked. Check the tool name or re-sync the source.`,
          source: "unknown_tool",
          redactFields: [],
        };
      }
      const tool = target.tool;
      const row = await policies.get(tool.name);
      // §11: redaction tuning is operator data on the row, respected even
      // when the row is otherwise inert (no manualOverride).
      const redactFields = row?.redactFields ?? [];
      if (row?.manualOverride) {
        return overrideVerdict(tool.name, row.action, redactFields);
      }
      return defaultVerdict(tool, redactFields);
```

In `packages/sdk/src/pipeline/invoker.ts` (compile fixes only in this task):

1. The two synthetic verdicts in `resolveDecisionVerdict` (~lines 269–271) gain `redactFields: []` (Task 3 enriches the approve path with the row's values):

```typescript
  if (decision.kind === "approve") {
    return {
      action: "allow",
      reason: "operator approved this call on resume",
      source: "override",
      redactFields: [],
    };
  }
  return {
    action: "block",
    reason: "operator denied this call on resume",
    source: "override",
    redactFields: [],
  };
```

2. The `blocked` verdict for unknown tools (~line 133) gains `redactFields: verdict.redactFields,`.

In `packages/sdk/src/pipeline/invoker.test.ts`, the `permissivePolicy` fixture (~line 159) gains `redactFields: [] as const,` (or `redactFields: []`).

In `packages/sdk/src/store/sqlite.ts`:

1. CREATE TABLE (~line 66) gains the column:

```sql
  `CREATE TABLE IF NOT EXISTS policies (
    tool_name TEXT PRIMARY KEY,
    action TEXT NOT NULL CHECK (action IN ('allow', 'require_approval', 'block')),
    seeded_from TEXT NOT NULL CHECK (seeded_from IN ('safe', 'review', 'destructive')),
    manual_override INTEGER NOT NULL CHECK (manual_override IN (0, 1)),
    redact_fields TEXT NOT NULL DEFAULT '[]'
  )`,
```

2. Retrofit block (next to the existing ones, ~line 116):

```typescript
  // policies.redact_fields arrived with §11 redaction; same retrofit
  // pattern as trace_events.output before it.
  const policyColumns = await client.execute("PRAGMA table_info(policies)");
  if (!policyColumns.rows.some((row) => row.name === "redact_fields")) {
    await client.execute("ALTER TABLE policies ADD COLUMN redact_fields TEXT NOT NULL DEFAULT '[]'");
  }
```

3. `policies.upsert` gains the column:

```typescript
          sql: `INSERT INTO policies (tool_name, action, seeded_from, manual_override, redact_fields)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(tool_name) DO UPDATE SET
                  action = excluded.action, seeded_from = excluded.seeded_from,
                  manual_override = excluded.manual_override,
                  redact_fields = excluded.redact_fields`,
          args: [
            policy.toolName,
            policy.action,
            policy.seededFrom,
            policy.manualOverride ? 1 : 0,
            JSON.stringify(policy.redactFields),
          ],
```

4. `rowToPolicy` (~line 721) parses and validates, fail-closed like its siblings:

```typescript
  const redactFieldsText = text(row, "redact_fields");
  let redactFieldsParsed: unknown;
  try {
    redactFieldsParsed = JSON.parse(redactFieldsText);
  } catch (cause) {
    throw new Error(
      `[SqliteStore] Failed to read policy: redact_fields is not valid JSON. Context: { toolName: ${JSON.stringify(toolName)} }`,
      { cause },
    );
  }
  if (
    !Array.isArray(redactFieldsParsed) ||
    !redactFieldsParsed.every((field): field is string => typeof field === "string")
  ) {
    throw new Error(
      `[SqliteStore] Failed to read policy: redact_fields must be a JSON array of strings. Context: { toolName: ${JSON.stringify(toolName)} }`,
    );
  }
  return {
    toolName,
    action,
    seededFrom,
    manualOverride: manualOverride === 1,
    redactFields: redactFieldsParsed,
  };
```

Fix any remaining compile errors `tsc` reports at `Policy` object literals in tests (add `redactFields: []`) — the compiler enumerates them; do not change test intent.

- [ ] **Step 4: Typecheck, run tests**

Run (from `packages/sdk`): `node_modules/.bin/tsc --noEmit` then `node_modules/.bin/vitest run src/policy.test.ts src/store/sqlite.test.ts src/pipeline/invoker.test.ts`
Expected: clean + PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/sdk/src
git commit -m "feat: §11 redactFields on Policy rows and verdicts — engine's single row read serves both concerns (R1/R4)"
```

---

### Task 3: Redact at the appendTrace choke point + resume-path enrichment

**Files:**
- Modify: `packages/sdk/src/pipeline/invoker.ts` (`appendTrace` ~line 311; verdict resolution ~lines 112–126)
- Test: `packages/sdk/src/pipeline/invoker.test.ts`

**Interfaces:**
- Consumes: `redactSensitiveFields` (Task 1), `PolicyVerdict.redactFields` (Task 2).
- Produces: TraceEvents whose `input`/`outputSummary` are redacted at append time (Tasks 5's invariant asserts on this). `event.output` still written in this task (removed in Task 4).

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/src/pipeline/invoker.test.ts` (uses the file's existing `recordingUpstream`, `deps`, and beforeEach store; policies upserts now need `redactFields`):

```typescript
  it("§11: appendTrace masks builtin + per-tool keys in input and outputSummary, on allowed and refused calls", async () => {
    await store.policies.upsert({
      toolName: "github.list_issues",
      action: "allow",
      seededFrom: "safe",
      manualOverride: false,
      redactFields: ["repo_label"],
    });
    const { caller } = recordingUpstream({
      content: [{ password: "echoed-pw", repoLabel: "internal", ok: true }],
    });
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_redact", log: vi.fn() });

    await invoke("github.list_issues", { token: "sk-live", repo_label: "internal", repo: "hq" });

    const [event] = await store.trace.listByExecution("exec_redact");
    expect(event?.input).toEqual({ token: "[redacted]", repo_label: "[redacted]", repo: "hq" });
    const summary = String(event?.outputSummary);
    expect(summary).not.toContain("echoed-pw");
    expect(summary).not.toContain("internal");
    expect(summary).toContain("[redacted]");

    // Refusal path: the destructive tool's refusal row is redacted too.
    // (require_approval surfaces as ConduitPolicyDenied — errors.ts policyError.)
    const attempt = invoke("github.delete_repo", { password: "pw", repo: "hq" });
    await expect(attempt).rejects.toMatchObject({ name: GUEST_ERROR_NAMES.policyDenied });
    const refused = (await store.trace.listByExecution("exec_redact"))[1];
    expect(refused?.input).toEqual({ password: "[redacted]", repo: "hq" });
  });

  it("§11: the upstream call itself still receives the UNREDACTED input (redaction is trace-only)", async () => {
    const { caller, requests } = recordingUpstream();
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_live", log: vi.fn() });
    await invoke("github.list_issues", { token: "sk-live", repo: "hq" });
    expect(requests[0]?.input).toEqual({ token: "sk-live", repo: "hq" });
  });

  it("§11: a sensitive value's head never leaks through the 160-char summary slice (redact-then-slice, R7)", async () => {
    const { caller } = recordingUpstream({ secret: `sk-${"x".repeat(400)}`, note: "fine" });
    const invoke = createToolInvoker(deps(caller), { executionId: "exec_slice", log: vi.fn() });
    await invoke("github.list_issues", {});
    const [event] = await store.trace.listByExecution("exec_slice");
    expect(String(event?.outputSummary)).not.toContain("sk-x");
  });
```

(Verified: `policyError("require_approval", …)` produces `GUEST_ERROR_NAMES.policyDenied` — `pipeline/errors.ts:71-78`.)

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/sdk`): `node_modules/.bin/vitest run src/pipeline/invoker.test.ts`
Expected: the three new tests FAIL (input stored raw today).

- [ ] **Step 3: Implement in `invoker.ts`**

1. Import: `import { redactSensitiveFields } from "./redact.js";`

2. In `appendTrace` (~line 323), redact input and build the summary from the redacted output (keep `event.output` for now — Task 4 removes it):

```typescript
  const event: TraceEvent = {
    callId: crypto.randomUUID(),
    executionId: options.executionId,
    toolName: details.path,
    // Refusals are traced before any connection is engaged: empty prefix
    // records exactly that.
    connectionPrefix: details.connection?.prefix ?? "",
    // §11: the audit row is redacted at append time (builtins + the
    // verdict's per-tool additions). Non-mutating by contract (redact.ts)
    // — the caller's `input` reference is journaled for replay later.
    input: redactSensitiveFields(details.input, details.verdict.redactFields),
    policyVerdict: details.verdict.action,
    at: Date.now(),
  };
  if (details.outcome !== undefined) {
    const output = details.outcome.result ?? null;
    event.output = output;
    // §11 R7: redact BEFORE slicing, so a sensitive value's head cannot
    // leak through the 160-char display cap.
    event.outputSummary = JSON.stringify(
      redactSensitiveFields(output, details.verdict.redactFields),
    ).slice(0, 160);
    event.upstreamStatus = details.outcome.status;
    event.latencyMs = details.outcome.latencyMs;
  }
```

3. Resume-path enrichment (spec R4 amendment): replace the `const verdict = decisionVerdict ?? (await ...)` block (~lines 117–126) so a synthetic decision verdict picks up the row's `redactFields`:

```typescript
  let verdict =
    decisionVerdict ??
    (await deps.policy
      .evaluate({
        target: tool !== undefined ? { kind: "known", tool } : { kind: "unknown", toolName: path },
        input,
      })
      .catch((cause) => {
        throw infraError(cause, log);
      }));
  if (decisionVerdict !== undefined) {
    // §11 (design R4): the D6 decision branch skips the policy engine, so
    // the synthetic verdict carries no per-tool redactFields. Fetch them
    // here — one extra row read on the rare resume path only — so the
    // approved call's audit row is redacted identically to the policy path.
    const row = await deps.store.policies.get(path).catch((cause) => {
      throw infraError(cause, log);
    });
    verdict = { ...decisionVerdict, redactFields: row?.redactFields ?? [] };
  }
```

- [ ] **Step 4: Typecheck, run the invoker suite**

Run (from `packages/sdk`): `node_modules/.bin/tsc --noEmit` then `node_modules/.bin/vitest run src/pipeline/invoker.test.ts`
Expected: clean + PASS (existing tests may need their trace assertions updated ONLY where they asserted raw sensitive fixture values in `input`/`outputSummary`; keep intent, adjust fixtures to non-sensitive key names where the test is not about redaction).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/pipeline/invoker.ts packages/sdk/src/pipeline/invoker.test.ts
git commit -m "feat: §11 redact input + outputSummary at the appendTrace choke point; enrich resume-path verdicts (R4/R7)"
```

---

### Task 4: Drop `TraceEvent.output` (interface, I/O paths, purge migration)

**Files:**
- Modify: `packages/sdk/src/types.ts` (TraceEvent ~lines 108–133)
- Modify: `packages/sdk/src/pipeline/invoker.ts` (`appendTrace` outcome branch)
- Modify: `packages/sdk/src/store/sqlite.ts` (CREATE TABLE ~line 82, retrofit ~line 116, trace INSERT ~line 388, `rowToTraceEvent` ~line 776)
- Test: `packages/sdk/src/store/sqlite.test.ts`

**Interfaces:**
- Consumes: Task 3's appendTrace shape.
- Produces: `TraceEvent` WITHOUT `output` (final §11 shape); `trace_events.output` never written, purged where present.

- [ ] **Step 1: Write the failing test**

Append to `packages/sdk/src/store/sqlite.test.ts`:

```typescript
  it("§11: a legacy trace_events.output column is purged on open, and new writes never populate it", async () => {
    // Legacy DB with a populated output column (pre-§11 schema).
    const legacy = createClient({ url: ":memory:" });
    await legacy.execute(`CREATE TABLE trace_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL UNIQUE,
      execution_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      connection_prefix TEXT NOT NULL,
      input TEXT NOT NULL,
      output_summary TEXT,
      output TEXT,
      upstream_status INTEGER,
      latency_ms INTEGER,
      policy_verdict TEXT NOT NULL CHECK (policy_verdict IN ('allow', 'require_approval', 'block')),
      at INTEGER NOT NULL
    )`);
    await legacy.execute({
      sql: `INSERT INTO trace_events
              (call_id, execution_id, tool_name, connection_prefix, input,
               output_summary, output, policy_verdict, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ["c1", "e1", "github.list_issues", "p", '{"a":1}', '"s"', '{"password":"leak"}', "allow", 1],
    });
    const reopened = await openSqliteStore({
      client: legacy,
      secretBox: await SecretBox.fromKeyBytes(SecretBox.generateKeyBytes()),
    });
    const purged = await legacy.execute("SELECT output FROM trace_events WHERE call_id = 'c1'");
    expect(purged.rows[0]?.output).toBeNull();

    // New writes carry no output; reads return events without the field.
    await reopened.trace.append({
      callId: "c2",
      executionId: "e1",
      toolName: "github.list_issues",
      connectionPrefix: "p",
      input: { a: 1 },
      policyVerdict: "allow",
      at: 2,
    });
    const events = await reopened.trace.listByExecution("e1");
    expect(events).toHaveLength(2);
    expect(events.every((event) => !("output" in event))).toBe(true);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run (from `packages/sdk`): `node_modules/.bin/vitest run src/store/sqlite.test.ts`
Expected: FAIL — legacy `output` value survives reopen today.

- [ ] **Step 3: Implement**

1. `types.ts` — delete the `output?: unknown;` member and its stale comment block entirely; update the two remaining comments to their final form:

```typescript
/** One tool call as recorded for audit (spec §11). NOT the replay source —
 * that is the separate replay journal (§5.5 design D4). */
export interface TraceEvent {
  callId: string;
  executionId: string;
  /** `namespace.tool` */
  toolName: string;
  connectionPrefix: string;
  /** Redacted at append time (§11): builtin sensitive keys + the tool
   * policy's redactFields are masked before the row is written. */
  input: unknown;
  /** Display projection: redact-then-slice of the upstream result (§11).
   * The full result lives only in the replay journal (D4/D7). */
  outputSummary?: unknown;
  upstreamStatus?: number;
  latencyMs?: number;
  policyVerdict: PolicyAction;
  at: number;
}
```

2. `invoker.ts` `appendTrace` — delete the `event.output = output;` line (keep the `const output = details.outcome.result ?? null;` binding feeding the summary).

3. `sqlite.ts`:
   - CREATE TABLE `trace_events` (~line 82): remove the `output TEXT,` line.
   - Replace the old add-column retrofit (~lines 116–121) with the purge:

```typescript
  // Pre-§11 schemas carried a full trace_events.output payload for replay;
  // after the D4 split replay reads only replay_journal, and §11 drops the
  // field (design R3). Purge any data a legacy DB still holds — the audit
  // store must not keep full unredacted results. The dead column stays
  // (SQLite-cheap, never written again).
  const traceColumns = await client.execute("PRAGMA table_info(trace_events)");
  if (traceColumns.rows.some((row) => row.name === "output")) {
    await client.execute("UPDATE trace_events SET output = NULL WHERE output IS NOT NULL");
  }
```

   - Trace INSERT (~line 388): remove the `output` column and its arg:

```typescript
          sql: `INSERT INTO trace_events
                  (call_id, execution_id, tool_name, connection_prefix, input,
                   output_summary, upstream_status, latency_ms, policy_verdict, at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            event.callId,
            event.executionId,
            event.toolName,
            event.connectionPrefix,
            JSON.stringify(event.input ?? null),
            event.outputSummary === undefined ? null : JSON.stringify(event.outputSummary),
            event.upstreamStatus ?? null,
            event.latencyMs ?? null,
            event.policyVerdict,
            event.at,
          ],
```

   - `rowToTraceEvent` (~lines 776–779): delete the `output` read block.

4. Fix compile errors tsc reports (tests asserting `event.output` — delete those assertions; their raw-payload expectations are obsolete by design).

- [ ] **Step 4: Typecheck + full suite**

Run (from `packages/sdk`): `node_modules/.bin/tsc --noEmit` then the full suite via the pre-commit hook at commit time (loopback tests hang in the Bash sandbox — the hook run is authoritative).

- [ ] **Step 5: Commit**

```bash
git add -A packages/sdk/src
git commit -m "feat: §11 drop TraceEvent.output — redact-by-not-storing; purge legacy rows (R3/R6)"
```

---

### Task 5: INVARIANT §11 tests + ledger flip

**Files:**
- Modify: `packages/sdk/src/pipeline/invoker.test.ts` (rename/extend Task 3's redaction test into the invariant)
- Modify: `packages/sdk/src/execution/manager.test.ts` (journal-unredacted assertion)
- Modify: `INVARIANTS.md` (row ~line 26)

**Interfaces:**
- Consumes: everything above.
- Produces: the pinned §11 invariant; Phase 0 complete.

- [ ] **Step 1: Promote the trace-side test to the invariant name**

In `invoker.test.ts`, rename Task 3's first redaction test to carry the pin prefix and add the no-output assertion:

```typescript
  it("INVARIANT §11: Trace inputs and output summaries are redacted per policy (builtins + redactFields) on every verdict path, and the Trace stores no full output", async () => {
```

…and inside it, after the existing assertions, add:

```typescript
    const all = await store.trace.listByExecution("exec_redact");
    expect(all.every((event) => !("output" in event))).toBe(true);
```

- [ ] **Step 2: Add the replay-fidelity guard to `manager.test.ts`**

Inside the existing `describe` block, following the file's exact harness pattern (`const h = await makeHarness(); active = h;` — the suite's `afterEach` cleans up via `active`; guest code calls `tools.github.<tool>(...)`; `manager.start(code)` returns an `ExecutionOutcome` whose `completed` arm carries `executionId` — all verified against the current file, see the INVARIANT §5.5 test ~line 236 for the reference shape):

```typescript
  it("§11 (D7 guard): the replay journal keeps the semantically-unredacted request while the Trace row is redacted", async () => {
    const h = await makeHarness();
    active = h;
    const manager = createExecutionManager(h.deps);

    // list_issues is riskClass safe → auto-allowed. The input carries a
    // builtin-sensitive key: the journal must keep it, the Trace must mask it.
    const code = `return await tools.github.list_issues({ owner: "acme", token: "sk-fixture" });`;
    const outcome = await manager.start(code);
    expect(outcome.status).toBe("completed");

    const journal = await h.store.replayJournal.listByExecution(outcome.executionId);
    const callRow = journal.find((row) => row.op === "call");
    // Replay fidelity: the journaled REQUEST carries the raw input.
    expect(callRow?.request).toContain("sk-fixture");

    const [trace] = await h.store.trace.listByExecution(outcome.executionId);
    expect(JSON.stringify(trace?.input)).not.toContain("sk-fixture");
    expect(JSON.stringify(trace?.input)).toContain("[redacted]");
  });
```

- [ ] **Step 3: Flip the INVARIANTS.md row**

Replace line 26 with:

```markdown
| §11 — Trace stores no raw credentials; inputs redacted per policy (write-time; full `output` dropped from Trace — replay journal deliberately unredacted per §5.5 D7) | `packages/sdk/src/pipeline/invoker.test.ts` (+ D7 guard in `execution/manager.test.ts`) | ✅ pinned |
```

- [ ] **Step 4: Run the suites (unsandboxed — loopback)**

The manager suite hangs in the Bash sandbox; rely on the pre-commit hook run at commit, or run vitest with the sandbox disabled.
Expected: full suite PASS.

- [ ] **Step 5: Commit (test + ledger flip together — the CLAUDE.md invariant rule)**

```bash
git add packages/sdk/src/pipeline/invoker.test.ts packages/sdk/src/execution/manager.test.ts INVARIANTS.md
git commit -m "test: INVARIANT §11 pinned — trace redacted per policy, replay journal unredacted (D7 guard); ledger row flipped"
```

---

### Task 6: Spec §18 decision entry + regenerate conduitspec.md

**Files:**
- Modify: `conduitspec.html` (§18 decision log)
- Regenerate: `conduitspec.md` (via `python3 html2md.py` — NEVER hand-edit)

- [ ] **Step 1: Add the §18 entry**

In `conduitspec.html`, find the §18 decision log (search for the Phase-1 egress-pinning entry added by PR #23/#26 era edits and match its markup style exactly — read the surrounding entries first). Add an entry (adapt tags to the neighbors'):

> **§11 Trace redaction mechanism (2026-07-10).** Write-time redaction at the Trace append choke point: a builtin sensitive-key list (normalized exact matching) plus per-tool `redactFields` on the Policy row, riding the PolicyVerdict. The full `TraceEvent.output` is dropped from the Trace (redact-by-not-storing; legacy rows purged) — the full result lives only in the §5.5 replay journal, which stays semantically unredacted (D7). Not retroactive: policy changes mask future rows only. `PendingApproval.input` stays unredacted — the approver decides on real values. Display hygiene, not a boundary: the credential boundary remains §9.2's request-scoped, never-persisted credentials.

- [ ] **Step 2: Regenerate the derived markdown (same turn, per CLAUDE.md)**

Run (from repo root): `python3 html2md.py`
Expected: `conduitspec.md` updated; `git diff --stat` shows both spec files.

- [ ] **Step 3: Commit**

```bash
git add conduitspec.html conduitspec.md
git commit -m "docs(spec): §18 — §11 trace-redaction mechanism decided (write-time, builtin+per-tool keys, output dropped)"
```

---

### Task 7: Full verification + PR

- [ ] **Step 1: Full clean-room check**

From `packages/sdk`: `node_modules/.bin/tsc --noEmit`. From repo root: `node_modules/.bin/biome check packages/sdk/src`. Full vitest via an unsandboxed run (or trust the last pre-commit hook run).
Expected: all clean, 284 pre-existing + new tests green.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/trace-redaction
gh pr create --title "feat: §11 Trace redaction — write-time, policy-configured; drops TraceEvent.output (flips the last ⏳ invariant)" --body "<summary per PR conventions, including a Deviations section from the implementation notes log>"
```

Then the session protocol takes over (NOT plan steps): Tier 2 review, `/security-review`, real `codex exec` cross-model pass, `/explain-diff` + quiz, human-named merge.
