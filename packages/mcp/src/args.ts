/**
 * The shared `--state-dir <path>` parser, used by BOTH bins.
 *
 * `--state-dir` points a process at a non-default state directory, which
 * selects which daemon — and therefore which database — is reached. It is
 * the OPERATOR-BY-HAND path design §3.1 sanctions, and it is an argument
 * rather than an environment variable on purpose: auto-start constructs the
 * child's environment from an allowlist and strips every `CONDUIT_*`, so an
 * env-based override would be both ignored there and, if honored, exactly
 * the client-chosen redirection §9.3 removes. A client can never reach it;
 * only a person running the command can.
 *
 * It lives in this package because both bins that accept it must agree on
 * what it means. The `conduit` CLI (`serve`, `add-mcp`, `approvals`) and the
 * `conduit-mcp` daemon bin previously each parsed it, and the two
 * implementations were textually different reads of the same flag; a daemon
 * started under one reading and a client pointed at it under the other
 * silently reach different databases. `mcp` is the lower package — `cli`
 * already imports from it — so there is exactly one direction the shared
 * parser can go.
 *
 * Deliberately UNDOCUMENTED in either `--help`: it grants nothing a caller
 * could not already do by running the daemon themselves.
 *
 * `--state-dir=<path>` is deliberately NOT accepted. Neither bin supported
 * it before, so adding it here would be a new feature rather than a
 * unification — but with one parser, adding it later lands in both bins at
 * once instead of in one of them.
 */

/**
 * The parse outcome: the flag was absent, present with a path, or present
 * without one.
 *
 * A modelled `error` rather than a throw or a silent default: "the operator
 * typed `--state-dir` and gave no path" must not fall back to the DEFAULT
 * state directory, which would run the command against a different database
 * than the one they were reaching for.
 */
export type StateDirParse = { rest: string[]; stateDir?: string } | { error: string };

/**
 * Extracts `--state-dir <path>` from `args`, returning the remaining argv
 * alongside it.
 *
 * `errorPrefix` carries each bin's own convention (`[conduit] serve:` vs
 * `[conduitd]`) so the shared parser does not flatten two distinct
 * operator-facing surfaces into one voice.
 */
export function takeStateDir(errorPrefix: string, args: readonly string[]): StateDirParse {
  const at = args.indexOf("--state-dir");
  if (at === -1) return { rest: [...args] };
  const stateDir = args[at + 1];
  // A following token that is itself a flag is a MISSING path, not a path
  // that happens to look like a flag: `--state-dir --json` means the
  // operator forgot the argument, and consuming `--json` as a directory
  // would point the command at a nonexistent path AND drop the flag.
  if (stateDir === undefined || stateDir.startsWith("--")) {
    return { error: `${errorPrefix} --state-dir requires a path argument\n` };
  }
  return { rest: [...args.slice(0, at), ...args.slice(at + 2)], stateDir };
}
