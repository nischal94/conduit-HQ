#!/usr/bin/env node

// Interim demo approver (task 9). Opens the store from the same env contract
// as the bin, composes a manager EXACTLY as packages/mcp/src/server.ts does
// (per-call: fresh catalog snapshot, fresh invoker factory wired to the
// decisions seam), and resumes one paused execution with an approve
// decision. Task 10's ring-2 suite execs this file as its cross-process
// approver — the argv/exit/stdio contract below is load-bearing, not
// incidental.
//
// Usage: node scripts/approve-demo.mjs <executionId> <callId>
// stdout: NOTHING, ever.
// stderr: the outcome status line (or the failure reason).
// exit 0: resume settled (completed / paused / expired).
// exit 1: resume could not settle as approved (conflict / failed) or threw.

import { createRequire } from "node:module";
import { ensureDbDir, resolveEnv } from "../packages/mcp/dist/index.js";
import {
  createCatalogToolHost,
  createExecutionManager,
  createMcpUpstreamCaller,
  createStoreCredentialResolver,
  createStorePolicyEngine,
  createToolInvoker,
  InMemoryCatalog,
  openSqliteStore,
  QuickJSSandbox,
  SecretBox,
} from "../packages/sdk/dist/index.js";

// scripts/ sits outside the pnpm workspace's own node_modules, so a bare
// `@libsql/client` specifier does not resolve from here. Anchor resolution
// at the sdk package, which declares the same dependency directly — zero
// new deps, no brittle literal pnpm-store path.
const { createClient } = createRequire(new URL("../packages/sdk/dist/index.js", import.meta.url))(
  "@libsql/client",
);

async function hydrateCatalog(store) {
  const catalog = new InMemoryCatalog();
  catalog.upsert(await store.tools.list());
  return catalog;
}

async function main() {
  const executionId = process.argv[2];
  const callId = process.argv[3];
  if (executionId === undefined || executionId === "" || callId === undefined || callId === "") {
    console.error("[ApproveDemo] Usage: node scripts/approve-demo.mjs <executionId> <callId>");
    process.exit(1);
  }

  const env = resolveEnv(process.env);
  ensureDbDir(env.dbPath);
  const client = createClient({ url: `file:${env.dbPath}` });
  const store = await openSqliteStore({
    client,
    secretBox: await SecretBox.fromKeyBytes(env.keyBytes),
  });

  const sandbox = new QuickJSSandbox();
  const policy = createStorePolicyEngine(store.policies);
  const credentials = createStoreCredentialResolver(store.secrets);
  const upstream = createMcpUpstreamCaller(
    env.allowPrivateEgress === true ? { egress: { allowPrivate: true } } : {},
  );

  // Same per-call composition as server.ts's `execute` handler: a fresh
  // catalog snapshot and a fresh manager, the invoker factory receiving the
  // manager's staged `decisions` seam on resume.
  const catalog = await hydrateCatalog(store);
  const manager = createExecutionManager({
    store,
    sandbox,
    makeInvoker: ({ executionId: execId, decisions }) =>
      createToolInvoker(
        {
          store,
          policy,
          credentials,
          upstream,
          ...(decisions !== undefined ? { decisions } : {}),
        },
        { executionId: execId, log: (line) => console.error(line) },
      ),
    makeToolHost: (invoke) => createCatalogToolHost(catalog, invoke),
  });

  // An approval is for ONE pending call (spec §5.5): the caller names the
  // call it reviewed and this script passes it UNCHANGED — never looked up
  // here, which would bind a queued duplicate to whatever is pending now.
  // A stale id is refused by the daemon's claim as `conflict`.
  const outcome = await manager.resume(executionId, { kind: "approve" }, callId);
  console.error(`[ApproveDemo] outcome: ${outcome.status}`);

  if (outcome.status === "conflict" || outcome.status === "failed") {
    if (outcome.status === "failed") {
      console.error(`[ApproveDemo] error: ${outcome.error.name}: ${outcome.error.message}`);
    } else {
      console.error(
        `[ApproveDemo] conflict: execution ${executionId} was not paused (race or not found).`,
      );
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  // Bad-env failures (resolveEnv) are already formatted with a `[ConduitMcp]`
  // prefix; anything else gets an `[ApproveDemo]` prefix here so every
  // failure path is still traceable to its source.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith("[") ? message : `[ApproveDemo] ${message}`);
  process.exit(1);
});
