#!/usr/bin/env node
import { takeStateDir as parseStateDir } from "@conduithq/mcp";
import { addMcp } from "./commands/add-mcp.js";
import { approvals } from "./commands/approvals.js";
import { daemonCommand } from "./commands/daemon.js";
import { runKey } from "./commands/key.js";
import { serve } from "./commands/serve.js";
import { type Command, dispatch } from "./dispatch.js";

// NOTE: this bin does NOT redirect stdout globally. Only `conduit serve`
// redirects stdout (via runStdioServer, so MCP framing isn't corrupted) —
// see design §6. Every other command prints normally.

/**
 * Extracts the shared `--state-dir <path>` flag under THIS bin's error
 * convention.
 *
 * The parse itself lives in the mcp package (`args.ts`) so the daemon bin
 * and every client here read the flag identically — two readings of the
 * same flag would let a daemon and a client pointed at it silently reach
 * different databases. Only the `[conduit] <command>:` prefix is local.
 */
function takeStateDir(
  command: string,
  args: string[],
): { rest: string[]; stateDir?: string } | { error: string } {
  return parseStateDir(`[conduit] ${command}:`, args);
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
    case "add-mcp": {
      // Threaded since Task 8, for the same reason `serve` and `approvals`
      // thread it: this command now selects a DAEMON, and therefore which
      // database it provisions into. Read from the flag only, never the
      // environment.
      const parsed = takeStateDir("add-mcp", args);
      if ("error" in parsed) {
        process.stderr.write(parsed.error);
        return 1;
      }
      return addMcp(
        parsed.rest,
        parsed.stateDir !== undefined ? { stateDir: parsed.stateDir } : {},
      );
    }
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
    case "daemon": {
      // Threaded for the same reason `approvals` threads it: the state
      // directory selects WHICH daemon this command inspects or stops.
      const parsed = takeStateDir("daemon", args);
      if ("error" in parsed) {
        process.stderr.write(parsed.error);
        return 1;
      }
      return daemonCommand(
        parsed.rest,
        parsed.stateDir !== undefined ? { stateDir: parsed.stateDir } : {},
      );
    }
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
