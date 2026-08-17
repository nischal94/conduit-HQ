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
    case "serve": {
      // `--state-dir <path>` is deliberately UNDOCUMENTED in `--help`: it
      // points the daemon client at a non-default state directory, which
      // only makes sense next to a daemon someone started by hand there
      // (design §3.1's supported override path). It grants nothing a
      // caller could not already do by running the daemon themselves, and
      // it is NOT an environment variable precisely so a client's ambient
      // env can never redirect which database is served (§9.3).
      const at = args.indexOf("--state-dir");
      const stateDir = at === -1 ? undefined : args[at + 1];
      if (at !== -1 && (stateDir === undefined || stateDir.startsWith("--"))) {
        process.stderr.write("[conduit] serve: --state-dir requires a path argument\n");
        return 1;
      }
      await serve(stateDir !== undefined ? { stateDir } : {});
      return 0;
    }
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
