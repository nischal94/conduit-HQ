# §4.2 Token Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the §4.2 before/after token demo — a script that live-measures N raw upstream tool schemas vs. Conduit's two-tool surface through the real CLI front door, and renders the result as a checked-in interactive HTML page.

**Architecture:** A bundled deterministic `node:http` MCP upstream (800 realistic tool schemas) is ingested by the REAL `conduit add-mcp` bin into a throwaway store; the REAL `conduit serve` bin is then queried by a real MCP client, and both sides are token-counted with the same `estimateDefinitionTokens` heuristic that pins the INVARIANT §4.2 rows. The orchestrator asserts the claim holds (QA gate) and writes `demo/token-demo.json` + `demo/token-demo.html` (marketing seed).

**Tech Stack:** Node ≥20 stdlib only (`node:http`, `node:child_process`, `node:fs/promises`, `node:crypto`), built workspace dists (`packages/mcp/dist`, `packages/cli/dist`), `@modelcontextprotocol/sdk` resolved via `createRequire` anchored at `packages/mcp` (the `scripts/seed-demo.mjs` pattern).

**Design record:** `docs/superpowers/specs/2026-07-13-token-demo-design.md` (D1–D6). Branch: `feat/token-demo`.

## Global Constraints

- **Zero new third-party dependencies.** Anything non-stdlib is resolved from existing workspace packages via `createRequire` — never installed.
- **No timestamps or run-varying fields** in any generated output (design D5): a re-run on an unchanged surface must be byte-identical.
- **Catalog is exactly 800 tools** (design D6) — under the 1,024-tool and 5 MB ingestion caps.
- **The only product-package edit is one pure re-export line** in `packages/mcp/src/index.ts` (design D4). Nothing else under `packages/` changes.
- **Fail loud:** any subprocess failure, timeout, or assertion miss → exit 1 with a `[token-demo]`-prefixed reason; artifacts are written only after all assertions pass.
- **Commit with the Bash sandbox DISABLED, never `--no-verify`** — the pre-commit hook needs `mktemp` and runs the sdk suite + biome + spec-drift.
- **Style:** match `scripts/seed-demo.mjs` (JSDoc file header, double quotes, semicolons — biome checks `.mjs`).
- Keep an implementation-notes deviations log in the scratchpad (per project CLAUDE.md); summarize under a "Deviations" heading in the PR description.

---

### Task 1: Export `estimateDefinitionTokens` from `@conduithq/mcp`

**Files:**
- Modify: `packages/mcp/src/index.ts` (the `./payloads.js` export block, lines 2–7)

**Interfaces:**
- Consumes: `estimateDefinitionTokens(definition: unknown): number` — already defined at `packages/mcp/src/payloads.ts:44` (~4 chars/token heuristic).
- Produces: `estimateDefinitionTokens` importable from `packages/mcp/dist/index.js` — Tasks 3–4's orchestrator imports it from the built dist.

- [ ] **Step 1: Add the re-export**

Change the payloads export block in `packages/mcp/src/index.ts` from:

```ts
export {
  CHECK_EXECUTION_TOOL,
  executionToCheckPayload,
  extendExecuteDefinition,
  outcomeToPayload,
} from "./payloads.js";
```

to:

```ts
export {
  CHECK_EXECUTION_TOOL,
  estimateDefinitionTokens,
  executionToCheckPayload,
  extendExecuteDefinition,
  outcomeToPayload,
} from "./payloads.js";
```

- [ ] **Step 2: Rebuild the mcp dist and verify the export exists**

Run (from repo root):

```bash
cd packages/mcp && node_modules/.bin/tsup && cd ../..
node -e "import('./packages/mcp/dist/index.js').then(m => { if (typeof m.estimateDefinitionTokens !== 'function') { console.error('MISSING'); process.exit(1); } console.log('estimateDefinitionTokens: function'); })"
```

Expected: `estimateDefinitionTokens: function`

- [ ] **Step 3: Run the mcp suite (behavior unchanged)**

Run with the Bash sandbox DISABLED (loopback suites hang sandboxed):

```bash
cd packages/mcp && node_modules/.bin/vitest run
```

Expected: all 42 tests pass.

- [ ] **Step 4: Commit (sandbox disabled)**

```bash
git add packages/mcp/src/index.ts
git commit -m "feat: export estimateDefinitionTokens from @conduithq/mcp — the token demo counts both sides with the invariant yardstick"
```

Note: `packages/mcp/dist/` is gitignored build output — only `src/index.ts` is committed.

---

### Task 2: The bundled demo upstream — `scripts/token-demo-upstream.mjs`

**Files:**
- Create: `scripts/token-demo-upstream.mjs`

**Interfaces:**
- Consumes: nothing (stdlib only).
- Produces: an HTTP server on `127.0.0.1:<os-assigned>` answering JSON-RPC POST `tools/list` with exactly 800 deterministic tool definitions `{name, description, inputSchema}`; prints `PORT=<n>\n` to stderr when listening; stdout stays empty. Task 3's orchestrator spawns it and scrapes `PORT=`.

- [ ] **Step 1: Write the upstream server**

Create `scripts/token-demo-upstream.mjs`:

```js
#!/usr/bin/env node

// Bundled demo upstream for the §4.2 token demo (design 2026-07-13, D2/D6).
// Serves a deterministic catalog of exactly 800 realistic tool schemas over
// the same bare JSON-RPC POST tools/list shape fetchToolsList
// (packages/cli/src/mcp-fetch.ts) and scripts/seed-demo.mjs speak. No MCP
// SDK, no sessions, no other methods — this is demo scaffolding, not a
// product surface.
//
// Usage: node scripts/token-demo-upstream.mjs
// stdout: NOTHING, ever.
// stderr: "PORT=<n>" once listening (scraped by scripts/token-demo.mjs).
//
// Determinism (design D5): the catalog is a pure function of the template
// tables below — no RNG, no time. Re-runs serve byte-identical definitions.

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const CATALOG_SIZE = 800;

const STR = (description) => ({ type: "string", description });
const INT = (description) => ({ type: "integer", description });
const BOOL = (description) => ({ type: "boolean", description });

const plural = (resource) => (resource.endsWith("s") ? resource : `${resource}s`);
const human = (resource) => resource.replace(/_/g, " ");

// 4 families x 20 resources x 10 verbs = 800 tools, sized to land near the
// ~174 tokens/tool density the spec's own 1,600 ≈ 278,800 figure implies.
const FAMILIES = [
  {
    service: "github",
    context: "the GitHub REST API",
    scope: "repository",
    resources: [
      "repo", "issue", "pull_request", "branch", "commit_status", "release",
      "workflow", "workflow_run", "deployment", "gist", "label", "milestone",
      "project_board", "team", "webhook", "check_run", "code_scanning_alert",
      "dependabot_alert", "environment", "tag_protection",
    ],
  },
  {
    service: "stripe",
    context: "the Stripe payments API",
    scope: "account",
    resources: [
      "customer", "charge", "payment_intent", "invoice", "subscription",
      "refund", "payout", "product", "price", "coupon", "dispute",
      "balance_transaction", "transfer", "setup_intent", "payment_method",
      "credit_note", "tax_rate", "webhook_endpoint", "checkout_session",
      "quote",
    ],
  },
  {
    service: "jira",
    context: "the Jira Cloud REST API",
    scope: "project",
    resources: [
      "issue", "epic", "sprint", "board", "backlog_item", "component",
      "version", "worklog", "comment", "attachment", "filter", "dashboard",
      "field_config", "workflow_scheme", "permission_scheme", "issue_type",
      "project_role", "screen", "status", "audit_record",
    ],
  },
  {
    service: "sentry",
    context: "the Sentry monitoring API",
    scope: "organization",
    resources: [
      "project", "issue_group", "event", "release", "alert_rule",
      "metric_alert", "dashboard", "team", "member", "monitor", "replay",
      "source_map", "dsym_file", "integration", "service_hook", "environment",
      "session", "span", "profile", "crons_checkin",
    ],
  },
];

const VERBS = [
  {
    verb: "list",
    description: (r, f) =>
      `List ${plural(human(r))} visible to the authenticated principal in ${f.context}, newest first. Supports cursor pagination and server-side filtering by lifecycle state.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} whose ${plural(human(r))} to list.`),
      cursor: STR("Opaque pagination cursor returned by a previous page."),
      per_page: INT("Page size between 1 and 100. Defaults to 30."),
      state: STR(`Lifecycle filter for ${plural(human(r))}: open, closed, or all.`),
    }),
    required: (r, f) => [`${f.scope}_id`],
  },
  {
    verb: "get",
    description: (r, f) =>
      `Fetch a single ${human(r)} by identifier from ${f.context}, including its full metadata and relationship references.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} the ${human(r)} belongs to.`),
      [`${r}_id`]: STR(`Unique identifier of the ${human(r)} to fetch.`),
      include_deleted: BOOL(`Whether a soft-deleted ${human(r)} may be returned.`),
    }),
    required: (r, f) => [`${f.scope}_id`, `${r}_id`],
  },
  {
    verb: "search",
    description: (r, f) =>
      `Search ${plural(human(r))} in ${f.context} with a free-text query plus structured filters. Results are relevance-ranked and cursor-paginated.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} to scope the search to.`),
      query: STR(`Free-text search query matched against ${human(r)} titles and bodies.`),
      created_after: STR("ISO 8601 lower bound on creation time."),
      cursor: STR("Opaque pagination cursor returned by a previous page."),
      per_page: INT("Page size between 1 and 100. Defaults to 30."),
    }),
    required: (r, f) => [`${f.scope}_id`, "query"],
  },
  {
    verb: "create",
    description: (r, f) =>
      `Create a new ${human(r)} in ${f.context}. Returns the created ${human(r)} with its server-assigned identifier.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} to create the ${human(r)} in.`),
      name: STR(`Human-readable name for the new ${human(r)}.`),
      description: STR(`Longer free-text description of the ${human(r)}.`),
      metadata: STR("JSON-encoded key/value metadata attached to the resource."),
    }),
    required: (r, f) => [`${f.scope}_id`, "name"],
  },
  {
    verb: "update",
    description: (r, f) =>
      `Update mutable fields of an existing ${human(r)} in ${f.context}. Only the provided fields change; omitted fields keep their values.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} the ${human(r)} belongs to.`),
      [`${r}_id`]: STR(`Unique identifier of the ${human(r)} to update.`),
      name: STR(`New human-readable name for the ${human(r)}.`),
      description: STR(`New free-text description of the ${human(r)}.`),
      expected_version: INT("Optimistic-concurrency version the update must match."),
    }),
    required: (r, f) => [`${f.scope}_id`, `${r}_id`],
  },
  {
    verb: "delete",
    description: (r, f) =>
      `Permanently delete a ${human(r)} from ${f.context}. This operation cannot be undone; dependent resources are detached.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} the ${human(r)} belongs to.`),
      [`${r}_id`]: STR(`Unique identifier of the ${human(r)} to delete.`),
      confirm: BOOL("Must be true to acknowledge the deletion is permanent."),
    }),
    required: (r, f) => [`${f.scope}_id`, `${r}_id`, "confirm"],
  },
  {
    verb: "archive",
    description: (r, f) =>
      `Archive a ${human(r)} in ${f.context}, hiding it from default listings while preserving its history for audit.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} the ${human(r)} belongs to.`),
      [`${r}_id`]: STR(`Unique identifier of the ${human(r)} to archive.`),
      reason: STR("Optional operator note recorded with the archive action."),
    }),
    required: (r, f) => [`${f.scope}_id`, `${r}_id`],
  },
  {
    verb: "restore",
    description: (r, f) =>
      `Restore a previously archived ${human(r)} in ${f.context} back to its active state, reattaching it to default listings.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} the ${human(r)} belongs to.`),
      [`${r}_id`]: STR(`Unique identifier of the archived ${human(r)} to restore.`),
    }),
    required: (r, f) => [`${f.scope}_id`, `${r}_id`],
  },
  {
    verb: "export",
    description: (r, f) =>
      `Start an asynchronous export of ${plural(human(r))} from ${f.context} to a downloadable file. Returns a job reference to poll.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} whose ${plural(human(r))} to export.`),
      format: STR("Output format: csv or json."),
      created_after: STR("ISO 8601 lower bound on creation time."),
      notify_email: STR("Email address notified when the export completes."),
    }),
    required: (r, f) => [`${f.scope}_id`, "format"],
  },
  {
    verb: "subscribe",
    description: (r, f) =>
      `Subscribe a callback URL to change events for ${plural(human(r))} in ${f.context}. Events are delivered as signed JSON webhooks.`,
    params: (r, f) => ({
      [`${f.scope}_id`]: STR(`Identifier of the ${f.scope} whose ${human(r)} events to subscribe to.`),
      callback_url: STR("HTTPS URL that will receive the signed event payloads."),
      events: STR(`Comma-separated ${human(r)} event types to deliver (created, updated, deleted).`),
      secret_hint: STR("Label of the signing secret to use for payload signatures."),
    }),
    required: (r, f) => [`${f.scope}_id`, "callback_url"],
  },
];

export function buildCatalog() {
  const tools = [];
  for (const family of FAMILIES) {
    for (const resource of family.resources) {
      for (const template of VERBS) {
        tools.push({
          name: `${family.service}_${template.verb}_${resource}`,
          description: template.description(resource, family),
          inputSchema: {
            type: "object",
            properties: template.params(resource, family),
            required: template.required(resource, family),
            additionalProperties: false,
          },
        });
      }
    }
  }
  if (tools.length !== CATALOG_SIZE) {
    throw new Error(
      `[token-demo-upstream] catalog builder produced ${tools.length} tools, expected ${CATALOG_SIZE}`,
    );
  }
  return tools;
}

// Serve only when run directly (buildCatalog stays importable for checks).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const catalog = buildCatalog();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let id = null;
      let method;
      try {
        const parsed = JSON.parse(body);
        id = parsed?.id ?? null;
        method = parsed?.method;
      } catch {
        method = undefined;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method !== "POST" || method !== "tools/list") {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "only POST tools/list is served here" },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: catalog } }));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    process.stderr.write(`PORT=${server.address().port}\n`);
  });
}
```

- [ ] **Step 2: Verify catalog size, determinism, and the served shape**

```bash
node -e "
import('./scripts/token-demo-upstream.mjs').then((m) => {
  const a = JSON.stringify(m.buildCatalog());
  const b = JSON.stringify(m.buildCatalog());
  console.log('size:', m.buildCatalog().length);
  console.log('deterministic:', a === b);
});
"
```

Expected: `size: 800` and `deterministic: true`.

Then spawn it and hit it the way `add-mcp` will:

```bash
node scripts/token-demo-upstream.mjs 2>/tmp/claude/port.txt & sleep 1
PORT=$(sed -n 's/^PORT=//p' /tmp/claude/port.txt)
curl -s -X POST "http://127.0.0.1:$PORT" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node -e "
let s=''; process.stdin.on('data',(c)=>s+=c).on('end',()=>{
  const r = JSON.parse(s);
  console.log('tools:', r.result.tools.length);
  console.log('first:', r.result.tools[0].name);
});"
kill %1
```

Expected: `tools: 800`, `first: github_list_repo`.

- [ ] **Step 3: Commit (sandbox disabled)**

```bash
git add scripts/token-demo-upstream.mjs
git commit -m "feat: bundled 800-tool demo upstream for the §4.2 token demo"
```

---

### Task 3: The orchestrator — `scripts/token-demo.mjs` (measure + assert + JSON)

**Files:**
- Create: `scripts/token-demo.mjs`
- Create (generated, committed in Task 4): `demo/token-demo.json`

**Interfaces:**
- Consumes: `estimateDefinitionTokens` from `packages/mcp/dist/index.js` (Task 1); the upstream's `PORT=` stderr contract and 800-tool catalog (Task 2); the real bins `packages/cli/dist/bin.js` (`add-mcp`, `serve`); `@modelcontextprotocol/sdk` client via `createRequire` anchored at `packages/mcp`.
- Produces: `runTokenDemo(): Promise<results>` and a `demo/token-demo.json` results file with shape `{catalog, before, after, ratio, ingested, estimator, reproduce, extrapolation}` — Task 4's HTML renderer consumes exactly this object.

- [ ] **Step 1: Write the orchestrator**

Create `scripts/token-demo.mjs`:

```js
#!/usr/bin/env node

// §4.2 before/after token demo orchestrator (design 2026-07-13, D1/D3/D4).
// Live-measures, through the REAL front door, the token cost of 800 raw
// upstream tool schemas vs. the two-tool surface `conduit serve` advertises,
// then writes demo/token-demo.json + demo/token-demo.html. Fails loud
// (exit 1) if the §4.2 claim does not hold — this run IS the QA artifact.
//
// Usage: node scripts/token-demo.mjs
// stdout: NOTHING (results go to the demo/ files).
// stderr: progress + the before/after table.
//
// Honesty rules (design §4): both sides are measured by the same operation
// (tools/list) over exactly what the client received, counted by the same
// estimateDefinitionTokens heuristic that pins the INVARIANT §4.2 rows.
// Determinism (D5): no timestamps or run-varying fields in any output.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { estimateDefinitionTokens } from "../packages/mcp/dist/index.js";
import { CATALOG_SIZE } from "./token-demo-upstream.mjs";
import { renderTokenDemoHtml } from "./token-demo-html.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BIN = join(ROOT, "packages", "cli", "dist", "bin.js");
const UPSTREAM_SCRIPT = join(ROOT, "scripts", "token-demo-upstream.mjs");
const DEMO_DIR = join(ROOT, "demo");
const SPEC_TOOL_COUNT = 1600; // spec §4.2's headline catalog size (extrapolation only)
const MAX_AFTER_TOKENS = 1044 + 256; // the two INVARIANT §4.2 pins, summed
const MIN_RATIO = 20; // conservative floor; expected ~100x

const log = (line) => process.stderr.write(`[token-demo] ${line}\n`);

function fail(reason) {
  throw new Error(`[token-demo] ${reason}`);
}

/** Spawns the upstream and resolves its OS-assigned port from stderr. */
function startUpstream() {
  const child = spawn(process.execPath, [UPSTREAM_SCRIPT], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const port = new Promise((resolvePort, rejectPort) => {
    const timer = setTimeout(
      () => rejectPort(new Error("[token-demo] upstream did not print PORT= within 5s")),
      5000,
    );
    let buffer = "";
    child.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/^PORT=(\d+)$/m);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectPort(new Error(`[token-demo] upstream exited early with code ${code}`));
    });
  });
  return { child, port };
}

/** Runs a child to completion, collecting stdout/stderr. */
function run(command, args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

/** Fetches the raw tools/list from the upstream — the "before" surface. */
async function fetchRawTools(port) {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    fail(`upstream tools/list responded ${response.status}`);
  }
  const body = await response.json();
  const tools = body?.result?.tools;
  if (!Array.isArray(tools)) {
    fail("upstream tools/list response missing result.tools");
  }
  return tools;
}

/** Connects a real MCP client to `conduit serve` — the "after" surface. */
async function fetchServedTools(env) {
  const requireFromMcp = createRequire(join(ROOT, "packages", "mcp", "dist", "index.js"));
  const { Client } = await import(
    pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js"))
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js"))
  );
  const client = new Client({ name: "token-demo", version: "0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_BIN, "serve"],
    env: { ...process.env, ...env },
    stderr: "ignore",
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
  }
}

const sumTokens = (tools) =>
  tools.reduce((total, tool) => total + estimateDefinitionTokens(tool), 0);

export async function runTokenDemo() {
  const stateDir = await mkdtemp(join(tmpdir(), "conduit-token-demo-"));
  const { child: upstream, port: portPromise } = startUpstream();
  try {
    const port = await portPromise;
    log(`upstream listening on 127.0.0.1:${port}`);

    // BEFORE: what an agent faces with every raw schema injected directly.
    const rawTools = await fetchRawTools(port);
    if (rawTools.length !== CATALOG_SIZE) {
      fail(`upstream served ${rawTools.length} tools, expected ${CATALOG_SIZE}`);
    }
    const beforeTokens = sumTokens(rawTools);

    // Ingest through the REAL front door: conduit add-mcp.
    const env = {
      CONDUIT_DB: join(stateDir, "demo.db"),
      CONDUIT_MASTER_KEY: randomBytes(32).toString("base64"),
    };
    const addMcp = await run(
      process.execPath,
      [
        CLI_BIN,
        "add-mcp",
        "--url",
        `http://127.0.0.1:${port}`,
        "--namespace",
        "demo",
        "--prefix",
        "demo",
        "--json",
      ],
      { ...process.env, ...env },
    );
    if (addMcp.code !== 0) {
      fail(`conduit add-mcp exited ${addMcp.code}: ${addMcp.stderr.trim()}`);
    }
    const ingested = JSON.parse(addMcp.stdout);
    const ingestedTotal = ingested.safe + ingested.review + ingested.destructive;
    if (ingestedTotal !== CATALOG_SIZE) {
      fail(`add-mcp ingested ${ingestedTotal} tools, expected ${CATALOG_SIZE}`);
    }
    log(
      `ingested ${ingestedTotal} tools (${ingested.safe} safe / ${ingested.review} review / ${ingested.destructive} destructive)`,
    );

    // AFTER: what a real MCP client actually receives from conduit serve.
    const servedTools = await fetchServedTools(env);
    const servedNames = servedTools.map((tool) => tool.name).sort();
    if (servedNames.join(",") !== "check_execution,execute") {
      fail(`conduit serve advertises [${servedNames.join(", ")}], expected exactly execute + check_execution`);
    }
    const afterTokens = sumTokens(servedTools);

    // The QA-gate teeth (design §3.2 step 5).
    if (afterTokens > MAX_AFTER_TOKENS) {
      fail(`after-side is ${afterTokens} tokens, above the ${MAX_AFTER_TOKENS} pinned cap`);
    }
    const ratio = beforeTokens / afterTokens;
    if (ratio < MIN_RATIO) {
      fail(`before/after ratio ${ratio.toFixed(1)}x is below the ${MIN_RATIO}x sanity floor`);
    }

    const perToolAvg = beforeTokens / CATALOG_SIZE;
    const results = {
      catalog: {
        tools: CATALOG_SIZE,
        families: ["github", "stripe", "jira", "sentry"],
        source: "scripts/token-demo-upstream.mjs (bundled deterministic demo upstream)",
      },
      before: {
        tokens: beforeTokens,
        perToolAvg: Math.round(perToolAvg * 10) / 10,
        surface: `${CATALOG_SIZE} raw tool schemas injected directly`,
      },
      after: {
        tokens: afterTokens,
        definitions: servedTools
          .map((tool) => ({ name: tool.name, tokens: estimateDefinitionTokens(tool) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        surface: "conduit serve — execute + check_execution",
      },
      ratio: Math.round(ratio * 10) / 10,
      ingested,
      estimator: "estimateDefinitionTokens (~4 chars/token heuristic, packages/mcp/src/payloads.ts)",
      reproduce: "node scripts/token-demo.mjs",
      extrapolation: {
        label: "extrapolated (spec §4.2) — NOT measured",
        specTools: SPEC_TOOL_COUNT,
        beforeTokens: Math.round(perToolAvg * SPEC_TOOL_COUNT),
        afterTokens,
      },
    };

    log("── §4.2 before/after (estimated tokens) ──");
    log(`before  ${String(beforeTokens).padStart(8)}  (${CATALOG_SIZE} raw schemas, ~${results.before.perToolAvg}/tool)`);
    log(`after   ${String(afterTokens).padStart(8)}  (execute + check_execution)`);
    log(`ratio   ${String(`${results.ratio}x`).padStart(8)}`);

    // Artifacts are written ONLY after every assertion above has passed.
    await mkdir(DEMO_DIR, { recursive: true });
    await writeFile(join(DEMO_DIR, "token-demo.json"), `${JSON.stringify(results, null, 2)}\n`);
    await writeFile(join(DEMO_DIR, "token-demo.html"), renderTokenDemoHtml(results));
    log("wrote demo/token-demo.json + demo/token-demo.html");
    return results;
  } finally {
    upstream.kill();
    await rm(stateDir, { recursive: true, force: true });
  }
}

runTokenDemo().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
```

Note: `renderTokenDemoHtml` comes from Task 4's `scripts/token-demo-html.mjs`. To keep this task independently runnable, Task 3 creates that file as a stub in Step 2 and Task 4 replaces it with the real page.

- [ ] **Step 2: Create the renderer stub**

Create `scripts/token-demo-html.mjs`:

```js
// HTML renderer for the §4.2 token demo. Task 4 replaces this stub with the
// full interactive page; the results-object shape is demo/token-demo.json's.
export function renderTokenDemoHtml(results) {
  return `<!doctype html><title>token demo</title><pre>${JSON.stringify(results, null, 2)}</pre>\n`;
}
```

- [ ] **Step 3: Ensure both dists are current, then run end-to-end**

Run with the Bash sandbox DISABLED (spawns bins + loopback HTTP):

```bash
cd packages/mcp && node_modules/.bin/tsup && cd ../..
cd packages/cli && node_modules/.bin/tsup && cd ../..
node scripts/token-demo.mjs; echo "exit=$?"
```

Expected: stderr shows the upstream port, the ingest counts (summing to 800), the before/after table with a ratio well above 20x, `wrote demo/token-demo.json + demo/token-demo.html`, and `exit=0`.

Then verify determinism (D5) — a second run changes nothing:

```bash
node scripts/token-demo.mjs && git status --porcelain demo/
```

Expected: `git status` prints only untracked `?? demo/` entries (no modifications on re-run once tracked; at this point the two files are new-but-identical across runs — confirm with `shasum` across two runs if in doubt).

- [ ] **Step 4: Commit the orchestrator + stub (sandbox disabled; artifacts commit in Task 4)**

```bash
git add scripts/token-demo.mjs scripts/token-demo-html.mjs
git commit -m "feat: §4.2 token-demo orchestrator — live before/after measurement through the real add-mcp + serve bins"
```

---

### Task 4: The interactive page — `scripts/token-demo-html.mjs` + checked-in artifacts

**Files:**
- Modify: `scripts/token-demo-html.mjs` (replace the Task 3 stub wholesale)
- Create (generated): `demo/token-demo.json`, `demo/token-demo.html`

**Interfaces:**
- Consumes: the Task 3 results object (`{catalog, before, after, ratio, ingested, estimator, reproduce, extrapolation}`).
- Produces: `renderTokenDemoHtml(results): string` — a self-contained HTML document (inline CSS/JS, no external requests, works from `file://`).

- [ ] **Step 1: Write the real renderer**

Replace `scripts/token-demo-html.mjs` with:

```js
// HTML renderer for the §4.2 token demo (design 2026-07-13, §3.4). Produces
// a fully self-contained page: inline CSS/JS, zero external requests, works
// offline from file://. Every number on the page is live-measured by
// scripts/token-demo.mjs EXCEPT the spec-scale point, which is visually and
// textually labeled as an extrapolation (design §4).

export function renderTokenDemoHtml(results) {
  const data = JSON.stringify(results);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conduit — §4.2 before/after token demo</title>
<style>
  :root {
    --bg: #ffffff; --fg: #111418; --muted: #5b6470; --line: #e3e7ec;
    --before: #c74440; --after: #2c7a4b; --accent: #2f5fd0; --card: #f6f8fa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1116; --fg: #e8ebef; --muted: #98a1ad; --line: #2a3038;
      --before: #e0716d; --after: #57b380; --accent: #7da2f0; --card: #171b21;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
    max-width: 880px; margin: 0 auto; padding: 48px 24px 64px;
  }
  h1 { font-size: 1.6rem; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 6px 0 36px; }
  .numbers { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
  .stat {
    flex: 1 1 240px; background: var(--card); border: 1px solid var(--line);
    border-radius: 10px; padding: 18px 20px;
  }
  .stat .label { color: var(--muted); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em; }
  .stat .value { font-size: 2rem; font-variant-numeric: tabular-nums; font-weight: 650; }
  .stat .detail { color: var(--muted); font-size: 0.85rem; }
  .stat.before .value { color: var(--before); }
  .stat.after .value { color: var(--after); }
  .stat.ratio .value { color: var(--accent); }
  .bars { margin: 28px 0 40px; }
  .bar-row { display: grid; grid-template-columns: 64px 1fr 110px; gap: 12px; align-items: center; margin: 10px 0; }
  .bar-row .name { color: var(--muted); font-size: 0.85rem; text-align: right; }
  .bar-track { background: var(--card); border: 1px solid var(--line); border-radius: 6px; height: 26px; overflow: hidden; }
  .bar { height: 100%; min-width: 2px; }
  .bar.before { background: var(--before); }
  .bar.after { background: var(--after); }
  .bar-row .val { font-variant-numeric: tabular-nums; font-size: 0.9rem; }
  h2 { font-size: 1.05rem; margin: 36px 0 10px; }
  .slider-box { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 20px; }
  .slider-box input[type="range"] { width: 100%; accent-color: var(--accent); }
  .slider-readout { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 10px; font-variant-numeric: tabular-nums; }
  .slider-readout .b { color: var(--before); }
  .slider-readout .a { color: var(--after); }
  .extrapolated { color: var(--muted); font-size: 0.85rem; margin-top: 8px; }
  .badge {
    display: inline-block; border: 1px dashed var(--muted); color: var(--muted);
    border-radius: 5px; padding: 0 6px; font-size: 0.75rem; vertical-align: middle;
  }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
  td, th { border-bottom: 1px solid var(--line); padding: 8px 10px; text-align: left; font-variant-numeric: tabular-nums; }
  th { color: var(--muted); font-weight: 500; font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.05em; }
  footer { margin-top: 44px; color: var(--muted); font-size: 0.85rem; border-top: 1px solid var(--line); padding-top: 16px; }
  code { font: 0.88em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; }
</style>
</head>
<body>
<h1>Thousands of tools, no bloat</h1>
<p class="sub">Conduit §4.2 progressive disclosure — every number below was <strong>live-measured</strong> by
<code>node scripts/token-demo.mjs</code>: the same <code>tools/list</code> question asked of a raw
upstream and of <code>conduit serve</code> standing in front of it, counted with the same estimator.</p>

<div class="numbers">
  <div class="stat before">
    <div class="label">Before — raw schemas</div>
    <div class="value" id="stat-before"></div>
    <div class="detail" id="detail-before"></div>
  </div>
  <div class="stat after">
    <div class="label">After — Conduit</div>
    <div class="value" id="stat-after"></div>
    <div class="detail" id="detail-after"></div>
  </div>
  <div class="stat ratio">
    <div class="label">Reduction</div>
    <div class="value" id="stat-ratio"></div>
    <div class="detail">measured, estimated tokens</div>
  </div>
</div>

<div class="bars">
  <div class="bar-row">
    <span class="name">before</span>
    <div class="bar-track"><div class="bar before" id="bar-before"></div></div>
    <span class="val" id="bar-before-val"></span>
  </div>
  <div class="bar-row">
    <span class="name">after</span>
    <div class="bar-track"><div class="bar after" id="bar-after"></div></div>
    <span class="val" id="bar-after-val"></span>
  </div>
</div>

<h2>What the model actually sees</h2>
<table>
  <thead><tr><th>Surface</th><th>Tool definitions</th><th>Estimated tokens</th></tr></thead>
  <tbody id="surface-rows"></tbody>
</table>

<h2>Scale it: how the two surfaces grow</h2>
<div class="slider-box">
  <input type="range" id="n-slider" min="10" max="2000" step="10">
  <div class="slider-readout">
    <span><strong id="n-tools"></strong> tools connected</span>
    <span class="b">before: <strong id="proj-before"></strong> tokens</span>
    <span class="a">after: <strong id="proj-after"></strong> tokens (flat)</span>
  </div>
  <p class="extrapolated" id="extrapolation-note"></p>
</div>

<footer>
  <p><strong>Provenance.</strong> Before = sum over the raw <code>tools/list</code> definitions served by the
  bundled demo upstream and ingested via <code>conduit add-mcp</code>. After = the definitions a real MCP
  client received from <code>conduit serve</code>. Counter: <span id="estimator"></span> — all figures are
  estimates, not tokenizer output. Points beyond the measured catalog are linear extrapolations at the
  measured per-tool average and carry the <span class="badge">extrapolated</span> badge.
  Reproduce: <code id="reproduce"></code></p>
</footer>

<script>
  const DATA = ${data};
  const fmt = (n) => n.toLocaleString("en-US");
  const byId = (id) => document.getElementById(id);

  byId("stat-before").textContent = fmt(DATA.before.tokens);
  byId("detail-before").textContent =
    DATA.catalog.tools + " tool schemas, ~" + DATA.before.perToolAvg + " tokens/tool";
  byId("stat-after").textContent = fmt(DATA.after.tokens);
  byId("detail-after").textContent = DATA.after.definitions.map((d) => d.name).join(" + ");
  byId("stat-ratio").textContent = DATA.ratio + "×";

  byId("bar-before").style.width = "100%";
  byId("bar-before-val").textContent = fmt(DATA.before.tokens);
  byId("bar-after").style.width = (100 * DATA.after.tokens / DATA.before.tokens).toFixed(2) + "%";
  byId("bar-after-val").textContent = fmt(DATA.after.tokens);

  const rows = [
    ["Raw (" + DATA.catalog.families.join(", ") + ")", fmt(DATA.catalog.tools) + " definitions", fmt(DATA.before.tokens)],
    ...DATA.after.definitions.map((d) => ["Conduit", d.name, fmt(d.tokens)]),
  ];
  byId("surface-rows").innerHTML = rows
    .map((r) => "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td><td>" + r[2] + "</td></tr>")
    .join("");

  byId("estimator").textContent = DATA.estimator;
  byId("reproduce").textContent = DATA.reproduce;

  const slider = byId("n-slider");
  slider.value = DATA.catalog.tools;
  function project() {
    const n = Number(slider.value);
    const measured = n === DATA.catalog.tools;
    byId("n-tools").textContent = fmt(n);
    byId("proj-before").textContent = fmt(Math.round(n * DATA.before.perToolAvg));
    byId("proj-after").textContent = fmt(DATA.after.tokens);
    byId("extrapolation-note").innerHTML = measured
      ? "This point is the <strong>measured</strong> catalog (" + fmt(DATA.catalog.tools) + " tools)."
      : 'Linear extrapolation at the measured average <span class="badge">extrapolated</span> — at the spec\\u2019s ' +
        fmt(DATA.extrapolation.specTools) + "-tool catalog this projects to " +
        fmt(DATA.extrapolation.beforeTokens) + " tokens before vs " +
        fmt(DATA.extrapolation.afterTokens) + " after.";
  }
  slider.addEventListener("input", project);
  project();
</script>
</body>
</html>
`;
}
```

- [ ] **Step 2: Regenerate, inspect, and check determinism**

Run with the Bash sandbox DISABLED:

```bash
node scripts/token-demo.mjs && shasum demo/token-demo.json demo/token-demo.html
node scripts/token-demo.mjs && shasum demo/token-demo.json demo/token-demo.html
```

Expected: exit 0 both times, identical hashes across the two runs (D5). Open `demo/token-demo.html` in a browser (or the Browser pane) and confirm: the three stat cards, the two bars, the surface table, the working slider with the "extrapolated" badge away from 800, and the provenance footer.

- [ ] **Step 3: Commit renderer + artifacts (sandbox disabled)**

```bash
git add scripts/token-demo-html.mjs demo/token-demo.json demo/token-demo.html
git commit -m "feat: §4.2 token-demo interactive page — checked-in measured artifacts"
```

---

### Task 5: Whole-branch verification + PR

**Files:** none new — verification and shipping.

- [ ] **Step 1: Full local verification (sandbox disabled)**

```bash
cd packages/sdk && node_modules/.bin/vitest run && cd ../..
cd packages/mcp && node_modules/.bin/vitest run && cd ../..
cd packages/cli && node_modules/.bin/vitest run && cd ../..
node_modules/.bin/biome check .
cd packages/mcp && node_modules/.bin/tsc --noEmit && cd ../..
node scripts/token-demo.mjs; echo "exit=$?"
```

Expected: sdk 321 + mcp 42 + cli 50 all green, biome clean, tsc clean, demo exit=0 with no diff under `demo/` (`git status --porcelain demo/` empty).

- [ ] **Step 2: Push branch and open the PR (sandbox disabled for network)**

PR body must include: the design-doc pointer, the measured numbers, a "Deviations" heading (from the scratchpad log; "none" if none), and the review-tier classification from design §7 (Tier 2 + /security-review; below the codex-adversarial/quiz bar — for the human to confirm at merge time).

```bash
git push -u origin feat/token-demo
gh pr create --title "feat: §4.2 before/after token demo — live-measured through add-mcp + serve" --body-file <the drafted body>
```

- [ ] **Step 3: Run the review gauntlet per design §7**

Tier 2 (`/pr-review-toolkit:review-pr all parallel`) + `/security-review`; then CI green; then hand to the human — **merge is human-named, never the agent's call.**
