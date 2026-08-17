#!/usr/bin/env node
import { addMcp } from "./commands/add-mcp.js";
import { approvals } from "./commands/approvals.js";
import { runKey } from "./commands/key.js";
import { serve } from "./commands/serve.js";
import { type Command, dispatch } from "./dispatch.js";

// NOTE: this bin does NOT redirect stdout globally. Only `conduit serve`
// redirects stdout (via runStdioServer, so MCP framing isn't corrupted) —
// see design §6. Every other command prints normally.

/**
 * Extracts the shared `--state-dir <path>` flag, returning the remaining
 * argv alongside it.
 *
 * Deliberately UNDOCUMENTED in `--help`: it points a daemon client at a
 * non-default state directory, which only makes sense next to a daemon
 * someone started by hand there (design §3.1's supported override path). It
 * grants nothing a caller could not already do by running the daemon
 * themselves, and it is NOT an environment variable precisely so a client's
 * ambient env can never redirect which database is reached (§9.3).
 *
 * Shared by every daemon-client command rather than reimplemented per
 * command: `serve` (Task 6) and `approvals` (Task 7) must agree on how a
 * test or operator names the daemon, or the two clients silently reach
 * different databases.
 */
function takeStateDir(
  command: string,
  args: string[],
): { rest: string[]; stateDir?: string } | { error: string } {
  const at = args.indexOf("--state-dir");
  if (at === -1) return { rest: args };
  const stateDir = args[at + 1];
  if (stateDir === undefined || stateDir.startsWith("--")) {
    return { error: `[conduit] ${command}: --state-dir requires a path argument\n` };
  }
  return { rest: [...args.slice(0, at), ...args.slice(at + 2)], stateDir };
}

async function runCommand(command: Command, args: string[]): Promise<number> {
  switch (command) {
    case "serve": {
      const parsed = takeStateDir("serve", args);
      if ("error" in parsed) {
        process.stderr.write(parsed.error);
        return 1;
      }
      await serve(parsed.stateDir !== undefined ? { stateDir: parsed.stateDir } : {});
      return 0;
    }
    case "add-mcp":
      return addMcp(args);
    case "approvals": {
      const parsed = takeStateDir("approvals", args);
      if ("error" in parsed) {
        process.stderr.write(parsed.error);
        return 1;
      }
      return approvals(
        parsed.rest,
        parsed.stateDir !== undefined ? { stateDir: parsed.stateDir } : {},
      );
    }
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
