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
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderTokenDemoHtml } from "./token-demo-html.mjs";
import { CATALOG_SIZE } from "./token-demo-upstream.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_DIST = join(ROOT, "packages", "mcp", "dist", "index.js");
const CLI_BIN = join(ROOT, "packages", "cli", "dist", "bin.js");
const UPSTREAM_SCRIPT = join(ROOT, "scripts", "token-demo-upstream.mjs");
const DEMO_DIR = join(ROOT, "demo");
const SPEC_TOOL_COUNT = 1600; // spec §4.2's headline catalog size (extrapolation only; design doc D6)
const MAX_AFTER_TOKENS = 1044 + 256; // the two INVARIANT §4.2 pins, summed
const MIN_RATIO = 20; // conservative floor; measured 264.3x at the 800-tool catalog

const log = (line) => process.stderr.write(`[token-demo] ${line}\n`);

function fail(reason) {
  throw new Error(`[token-demo] ${reason}`);
}

for (const distPath of [MCP_DIST, CLI_BIN]) {
  if (!existsSync(distPath)) {
    process.stderr.write(
      `[token-demo] missing built dist ${distPath} — build first: (cd packages/mcp && node_modules/.bin/tsup) and (cd packages/cli && node_modules/.bin/tsup)\n`,
    );
    process.exit(1);
  }
}

const { estimateDefinitionTokens } = await import(pathToFileURL(MCP_DIST));

/** Spawns the upstream and resolves its OS-assigned port from stderr. */
function startUpstream() {
  const child = spawn(process.execPath, [UPSTREAM_SCRIPT], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let buffer = "";
  let crash = null;
  child.stderr.on("data", (chunk) => {
    buffer += chunk;
  });
  child.on("exit", (code, signal) => {
    crash = { code, signal };
  });
  const port = new Promise((resolvePort, rejectPort) => {
    const timer = setTimeout(
      () => rejectPort(new Error("[token-demo] upstream did not print PORT= within 5s")),
      5000,
    );
    child.stderr.on("data", () => {
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
  const diagnostics = () => {
    const crashPart = crash ? `crashed (code=${crash.code}, signal=${crash.signal})` : "running";
    const tail = buffer.trim().slice(-500) || "(empty)";
    return `${crashPart}; stderr tail: ${tail}`;
  };
  return { child, port, diagnostics };
}

/** Runs a child to completion, collecting stdout/stderr. */
function run(command, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`[token-demo] ${command} timed out after 60000ms`));
    }, 60000);
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(new Error(`[token-demo] failed to spawn ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

// Task 9 upgraded the demo upstream to minimal streamable HTTP: it now
// requires a real initialize handshake (session id + protocol version on
// every request past initialize) before it will answer tools/list — the
// bare single-POST dialect this fetched previously is gone by design (D1).
// `fetchRawTools` speaks the same minimal handshake so the "before" side
// still measures the upstream's real tools/list payload, unaffected by the
// handshake itself (which is not part of either token count).
const UPSTREAM_PROTOCOL_VERSION = "2025-06-18";

/** POSTs one JSON-RPC request/notification to the upstream, honestly failing
 * loud with the same diagnostics fetchRawTools has always surfaced. */
async function postUpstream(port, diagnostics, body, headers) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(
      `upstream ${body.method} request failed (port ${port}): ${msg}\nupstream diagnostics: ${diagnostics()}`,
    );
  }
  if (!response.ok) {
    // Surface the strict fixture's own explanation (its rpcError body) plus
    // upstream diagnostics instead of discarding them — a bare status hides
    // WHY it failed (e.g. the 404 "unknown or expired Mcp-Session-Id").
    const bodyText = await response.text().catch(() => "");
    fail(
      `upstream ${body.method} responded ${response.status}: ${bodyText.slice(0, 300)}\n` +
        `upstream diagnostics: ${diagnostics()}`,
    );
  }
  return response;
}

/** Fetches the raw tools/list from the upstream — the "before" surface.
 * Speaks the upstream's required streamable-HTTP handshake first (Task 9);
 * only the tools/list payload itself is counted toward the token estimate. */
async function fetchRawTools(port, diagnostics) {
  const initResponse = await postUpstream(port, diagnostics, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    // The fixture validates the full initialize shape (protocolVersion +
    // capabilities + clientInfo) like a conforming MCP server — a bare
    // `initialize` with no params is a 400 there, as it should be.
    params: {
      protocolVersion: UPSTREAM_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "token-demo", version: "0.0.0" },
    },
  });
  const sessionId = initResponse.headers.get("mcp-session-id");
  if (!sessionId) {
    fail(`upstream initialize response missing Mcp-Session-Id header`);
  }
  const sessionHeaders = {
    "mcp-session-id": sessionId,
    "mcp-protocol-version": UPSTREAM_PROTOCOL_VERSION,
  };

  await postUpstream(
    port,
    diagnostics,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionHeaders,
  );

  const response = await postUpstream(
    port,
    diagnostics,
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    sessionHeaders,
  );
  let body;
  try {
    body = await response.json();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(
      `upstream tools/list body was not valid JSON: ${msg}\nupstream diagnostics: ${diagnostics()}`,
    );
  }
  if (body?.error !== undefined) {
    fail(
      `upstream tools/list returned a JSON-RPC error: ${JSON.stringify(body.error)}\n` +
        `upstream diagnostics: ${diagnostics()}`,
    );
  }
  const tools = body?.result?.tools;
  if (!Array.isArray(tools)) {
    fail(
      `upstream tools/list response missing result.tools\nupstream diagnostics: ${diagnostics()}`,
    );
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
    env: curatedEnv(env),
    stderr: "pipe",
  });
  let capturedStderr = "";
  transport.stderr?.on("data", (chunk) => {
    capturedStderr += chunk;
  });
  try {
    await client.connect(transport);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await client.close().catch(() => {});
    fail(
      `conduit serve connect failed: ${msg}. serve stderr: ${capturedStderr.trim() || "(empty)"}`,
    );
  }
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
  }
}

const sumTokens = (tools) =>
  tools.reduce((total, tool) => total + estimateDefinitionTokens(tool), 0);

/** Minimal env for spawned bins — never leak ambient vars like CONDUIT_ADD_SECRET. */
function curatedEnv(env) {
  return {
    CONDUIT_DB: env.CONDUIT_DB,
    CONDUIT_MASTER_KEY: env.CONDUIT_MASTER_KEY,
    PATH: process.env.PATH ?? "",
  };
}

export async function runTokenDemo() {
  const stateDir = await mkdtemp(join(tmpdir(), "conduit-token-demo-"));
  const { child: upstream, port: portPromise, diagnostics } = startUpstream();
  try {
    const port = await portPromise;
    log(`upstream listening on 127.0.0.1:${port}`);

    // BEFORE: what an agent faces with every raw schema injected directly.
    const rawTools = await fetchRawTools(port, diagnostics);
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
      curatedEnv(env),
    );
    if (addMcp.code !== 0) {
      fail(`conduit add-mcp exited ${addMcp.code}: ${addMcp.stderr.trim()}`);
    }
    let ingested;
    try {
      ingested = JSON.parse(addMcp.stdout);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      fail(
        `add-mcp --json output was not valid JSON: ${msg}. stdout: ${addMcp.stdout.slice(0, 500)}`,
      );
    }
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
