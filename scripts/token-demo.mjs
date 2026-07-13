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
import { renderTokenDemoHtml } from "./token-demo-html.mjs";
import { CATALOG_SIZE } from "./token-demo-upstream.mjs";

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
      fail(
        `conduit serve advertises [${servedNames.join(", ")}], expected exactly execute + check_execution`,
      );
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
      estimator:
        "estimateDefinitionTokens (~4 chars/token heuristic, packages/mcp/src/payloads.ts)",
      reproduce: "node scripts/token-demo.mjs",
      extrapolation: {
        label: "extrapolated (spec §4.2) — NOT measured",
        specTools: SPEC_TOOL_COUNT,
        beforeTokens: Math.round(perToolAvg * SPEC_TOOL_COUNT),
        afterTokens,
      },
    };

    log("── §4.2 before/after (estimated tokens) ──");
    log(
      `before  ${String(beforeTokens).padStart(8)}  (${CATALOG_SIZE} raw schemas, ~${results.before.perToolAvg}/tool)`,
    );
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
