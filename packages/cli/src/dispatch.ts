import { USAGE as ADD_MCP_USAGE } from "./commands/add-mcp.js";

export const VERSION = "0.1.0";

export const COMMANDS = ["serve", "add-mcp", "approvals"] as const;

export type Command = (typeof COMMANDS)[number];

const HELP = `conduit ${VERSION} — Conduit CLI

Usage: conduit <command> [options]

Commands:
  serve      Run the Conduit MCP server (stdio transport)
  add-mcp    Register conduit-mcp with an MCP client
             (--namespace <ns> --url <url> --prefix <prefix> [--replace] [--clear-credential] [--json])
  approvals  Manage pending tool-call approvals

Flags:
  --help     Show this help text
  --version  Show the CLI version

Run "conduit add-mcp --help" for add-mcp's full flag reference.`;

function usage(unknown?: string): string {
  const reason = unknown ? `Unknown command: ${unknown}\n\n` : "";
  return `${reason}Usage: conduit <command> [options]\n\nCommands: ${COMMANDS.join(", ")}\n\nRun "conduit --help" for details.`;
}

export type DispatchResult =
  | { kind: "route"; command: Command; args: string[] }
  | { kind: "help"; stdout: string }
  | { kind: "version"; stdout: string }
  | { kind: "error"; exitCode: number; stderr: string };

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/**
 * Pure arg→route function (design §6). Takes argv (without the node/script
 * entries) and returns a route decision. Never touches process.stdout,
 * process.stderr, or process.exit — the caller (bin.ts) is responsible for
 * acting on the result.
 */
export function dispatch(argv: string[]): DispatchResult {
  const [first, ...rest] = argv;

  if (first === undefined) {
    return { kind: "error", exitCode: 1, stderr: usage() };
  }

  if (first === "--version" || first === "-v") {
    return { kind: "version", stdout: `${VERSION}\n` };
  }

  if (first === "--help" || first === "-h") {
    return { kind: "help", stdout: `${HELP}\n` };
  }

  if (isCommand(first)) {
    // D5: add-mcp --help/-h is intercepted here — printed directly, never
    // routed into runAddMcp (no store open, no network, exit 0).
    if (first === "add-mcp" && (rest.includes("--help") || rest.includes("-h"))) {
      return { kind: "help", stdout: `${ADD_MCP_USAGE}\n` };
    }
    return { kind: "route", command: first, args: rest };
  }

  return { kind: "error", exitCode: 1, stderr: `${usage(first)}\n` };
}
