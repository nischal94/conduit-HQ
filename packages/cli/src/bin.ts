#!/usr/bin/env node
import { addMcp } from "./commands/add-mcp.js";
import { approvals } from "./commands/approvals.js";
import { runKey } from "./commands/key.js";
import { serve } from "./commands/serve.js";
import { type Command, dispatch } from "./dispatch.js";

// NOTE: this bin does NOT redirect stdout globally. Only `conduit serve`
// redirects stdout (via runStdioServer, so MCP framing isn't corrupted) —
// see design §6. Every other command prints normally.

async function runCommand(command: Command, args: string[]): Promise<number> {
  switch (command) {
    case "serve":
      await serve();
      return 0;
    case "add-mcp":
      return addMcp(args);
    case "approvals":
      return approvals(args);
    case "key":
      return (await runKey(args)).exitCode;
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const result = dispatch(argv);

  switch (result.kind) {
    case "help":
      process.stdout.write(result.stdout);
      return;
    case "version":
      process.stdout.write(result.stdout);
      return;
    case "error":
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
      return;
    case "route":
      process.exitCode = await runCommand(result.command, result.args);
      return;
  }
}

main().catch((error) => {
  console.error(`[conduit] Fatal: ${String(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
});
