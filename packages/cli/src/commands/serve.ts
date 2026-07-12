import { runStdioServer } from "@conduithq/mcp";

/**
 * `conduit serve` — thin adapter over the shared stdio MCP server seam.
 * `runStdioServer` folds the M8 console.*→stderr redirect in as its first
 * runtime action, so "serve over stdio" structurally implies "stdout =
 * protocol frames only". Nothing here touches console.* or process.stdout.
 */
export async function serve(): Promise<void> {
  await runStdioServer({ env: process.env });
}
