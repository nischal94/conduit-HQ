import { USAGE as ADD_MCP_USAGE } from "./commands/add-mcp.js";
import { KEY_USAGE } from "./commands/key.js";

export const VERSION = "0.1.0";

export const COMMANDS = ["serve", "add-mcp", "approvals", "key"] as const;

export type Command = (typeof COMMANDS)[number];

const HELP = `conduit ${VERSION} — Conduit CLI

Usage: conduit <command> [options]

Commands:
  serve      Run the Conduit MCP server (stdio transport)
  add-mcp    Register conduit-mcp with an MCP client
             (--namespace <ns> --url <url> --prefix <prefix> [--replace] [--clear-credential] [--json])
  approvals  Manage pending tool-call approvals
  key        Manage the master key (generate | rotate)

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
 * add-mcp's value-taking flags (mirrors parseAddMcpArgs). A `--help`/`-h` token
 * sitting in the VALUE position of one of these (e.g. `--namespace --help`) is
 * the flag's argument, not a help request — so it must fall through to
 * validation (exit 1), not print help (exit 0). Boolean flags (--replace,
 * --clear-credential, --json) take no value, so a `--help` after them is a
 * genuine help request.
 */
const ADD_MCP_VALUE_FLAGS = new Set(["--url", "--namespace", "--prefix"]);

/**
 * True iff a `--help`/`-h` token appears in a FLAG position anywhere in `rest`
 * — i.e. at least one such token is NOT the value of a preceding value-taking
 * flag. `add-mcp --namespace --help` → false (help is the namespace value);
 * `add-mcp --help`, `add-mcp -h`, `add-mcp --replace --help` → true.
 */
function requestsAddMcpHelp(rest: string[]): boolean {
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if ((token === "--help" || token === "-h") && !ADD_MCP_VALUE_FLAGS.has(rest[i - 1] ?? "")) {
      return true;
    }
  }
  return false;
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
    // routed into runAddMcp (no store open, no network, exit 0). Only honored
    // when help sits in a FLAG position: `--namespace --help` is a namespace
    // VALUE (falls through to validation), not a help request.
    if (first === "add-mcp" && requestsAddMcpHelp(rest)) {
      return { kind: "help", stdout: `${ADD_MCP_USAGE}\n` };
    }
    // key has NO value-taking flags, so any --help/-h token anywhere in rest
    // is a genuine help request — no flag-vs-value disambiguation needed.
    if (first === "key" && rest.some((token) => token === "--help" || token === "-h")) {
      return { kind: "help", stdout: `${KEY_USAGE}\n` };
    }
    return { kind: "route", command: first, args: rest };
  }

  return { kind: "error", exitCode: 1, stderr: `${usage(first)}\n` };
}
