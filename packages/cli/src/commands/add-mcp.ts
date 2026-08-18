import {
  DEFAULT_CONDUIT_DIR,
  daemonRequest,
  deadlineForRequest,
  type RpcPayloadFor,
  type RpcRequest,
  type RpcResponse,
} from "@conduithq/mcp";
import { type Answer, type AnswerContext, ask as askDaemon } from "./daemon-answer.js";

/**
 * `conduit add-mcp` — atomic onboarding / re-sync of an upstream MCP source
 * (design §2.2, §4), driven through the DAEMON since Task 8 (§17, §3.3.1).
 *
 * **This command opens no database, performs no fetch, and never sees a
 * stored credential.** Before the conversion it did all three: it called
 * `openStoreFromEnv`, then `store.secrets.reveal(...)` to obtain the stored
 * credential for its onboarding fetch, then performed that fetch itself.
 * §3.3.1 rules that out — not because the CLI is the agent (it is not, so
 * this was never a §9.2 violation on its face), but because shipping
 * plaintext across a new IPC boundary is the wrong default in a product
 * built on credential containment. The daemon now performs the
 * credential-bearing fetch on this command's behalf, and the plaintext
 * never leaves it.
 *
 * The one secret that still travels client→daemon is a FRESH
 * `CONDUIT_ADD_SECRET`: the operator is supplying it, in the same request
 * that names its destination. That is the operator's own data going in, not
 * a stored credential being redirected out — and it is never echoed back.
 *
 * **What this command may name, and what it may not.** It names a source
 * IDENTITY (namespace, and for a first onboarding the url and prefix the
 * operator typed). It cannot name a credential: no request shape has a
 * field for one. `source.revalidate` carries only a namespace, and the
 * daemon derives BOTH the url and the credential from its own stored row —
 * which is what stops a client from pairing a daemon-held secret with an
 * attacker-chosen destination.
 *
 * The single injectable dep is the daemon call itself (the DI seam that
 * replaced `openStore` + `fetchTools`), so tests drive the whole command
 * against a fake daemon with no sockets and no network.
 */

const NAMESPACE_PATTERN = /^[a-z0-9_-]+$/;

/** `conduit add-mcp --help` text (D5). dispatch.ts prints this directly
 * without invoking runAddMcp — no daemon contact, no network. */
export const USAGE = `Usage: conduit add-mcp --namespace <ns> --url <url> --prefix <prefix> [options]

Register an upstream MCP source with conduit-mcp (atomic onboarding/re-sync).

Required flags:
  --namespace <ns>   Namespace to register the source under (/^[a-z0-9_-]+$/)
  --url <url>        Upstream MCP server URL to fetch tools/list from
  --prefix <prefix>  Unique per-connection identifier for this source (not the tool-name path)

Options:
  --replace           Allow retargeting an existing namespace to a new url/prefix
  --clear-credential   Drop the stored credential instead of preserving it
  --json               Emit machine-readable JSON output instead of a summary line
  --help, -h            Show this help text

Environment:
  CONDUIT_ADD_SECRET  Authorization credential for the upstream fetch (never logged)`;

export interface AddMcpArgs {
  url?: string;
  namespace?: string;
  prefix?: string;
  replace: boolean;
  clearCredential: boolean;
  json: boolean;
}

export type AddMcpDaemonCall = (request: RpcRequest) => Promise<RpcResponse>;

export interface AddMcpDeps {
  /** The onboarding write goes through here, capability `add-mcp`. */
  daemon: AddMcpDaemonCall;
  env: NodeJS.ProcessEnv;
  /** Defaults to process stdout/stderr; captured in tests for the
   * secret-never-echoed assertion. */
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface AddMcpResult {
  exitCode: number;
}

/** Parses argv (post `add-mcp`) into AddMcpArgs. Unknown/missing flags are
 * left undefined/false; validation happens in `runAddMcp`, not here. */
export function parseAddMcpArgs(argv: string[]): AddMcpArgs {
  const args: AddMcpArgs = { replace: false, clearCredential: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case "--url": {
        const value = argv[++i];
        if (value !== undefined) {
          args.url = value;
        }
        break;
      }
      case "--namespace": {
        const value = argv[++i];
        if (value !== undefined) {
          args.namespace = value;
        }
        break;
      }
      case "--prefix": {
        const value = argv[++i];
        if (value !== undefined) {
          args.prefix = value;
        }
        break;
      }
      case "--replace":
        args.replace = true;
        break;
      case "--clear-credential":
        args.clearCredential = true;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        break;
    }
  }
  return args;
}

/**
 * True iff `value` parses as an http(s) URL that carries NO credential in
 * itself — no `user:pass@` userinfo (F3).
 *
 * A url with a credential in it is an operator error caught at intake: the
 * secret belongs in `CONDUIT_ADD_SECRET` (a request-scoped header the daemon
 * reveals and forgets), never in the url, which is persisted as the source's
 * `location` and can resurface in a later refusal frame. The daemon
 * re-validates this too (`provision.ts`) — it is the authorization boundary
 * — but rejecting here keeps the typo a local, FLAG-shaped error.
 */
function isValidHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return parsed.username === "" && parsed.password === "";
}

/** True iff `value` parses as a URL carrying `user`/`pass` userinfo (F3). */
function urlHasUserinfo(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.username !== "" || parsed.password !== "";
}

/**
 * This command's operator prose for the shared daemon-answer reduction
 * (`daemon-answer.ts`). The reduction decides the SHAPE of every non-result
 * answer — a non-`result` is a REFUSAL, never an empty success, because
 * reporting a provision as landed when the daemon never confirmed it would
 * tell an operator their source is onboarded when no rows exist.
 */
const ADD_MCP_CONTEXT: AnswerContext = {
  // §5's ambiguity. The connection died after the request bytes went out,
  // so the atomic write may have landed and may not have. Never retried
  // automatically: a blind re-issue against a source that DID provision
  // would re-run the whole onboarding fetch, and (with --clear-credential)
  // could drop a credential the first attempt already replaced. The
  // operator is pointed at the read that settles it. The shared reduction
  // appends the client's cause detail — an asymmetry against `approvals`
  // until this extraction, and the cause is as actionable here: it
  // separates a misbehaving daemon from a dropped connection.
  outcomeUnknown: (requestId) =>
    `[conduit add-mcp] The outcome of this provisioning is UNKNOWN: the daemon connection ` +
    `was lost after the request was sent, so the source may or may not have been written ` +
    `(requestId ${requestId}). Do NOT blindly re-run it — check whether the source ` +
    `is registered first.`,
  // The daemon's own typed refusal. Its message is client-safe by
  // construction and already carries the operator's next move — for a
  // provisioning refusal it is the same `[conduit add-mcp] ... nothing was
  // written` line this command printed before the conversion, so the
  // terminal output is unchanged. The code is deliberately NOT prefixed
  // onto it here, unlike `approvals`.
  refused: (_code, message) => message,
  desync: (kind) => `[conduit add-mcp] failed: protocol desync (unexpected ${kind} frame).`,
  unreachable: (detail) => `[conduit add-mcp] could not reach the Conduit daemon: ${detail}`,
};

function ask<K extends RpcRequest["kind"]>(
  deps: AddMcpDeps,
  request: Extract<RpcRequest, { kind: K }>,
): Promise<Answer<RpcPayloadFor<K>>> {
  return askDaemon<K>(deps.daemon, request, ADD_MCP_CONTEXT);
}

export async function runAddMcp(args: AddMcpArgs, deps: AddMcpDeps): Promise<AddMcpResult> {
  // Step 1: collect ALL missing/invalid required flags into ONE stderr line
  // (D5 — single-pass validation) BEFORE contacting the daemon. The daemon
  // re-validates the same things (it is the authorization boundary and a
  // hand-crafted frame need not have come through any CLI), but catching
  // them here keeps a typo a local error rather than a round trip, and
  // keeps the message a FLAG-shaped one — the daemon does not know which
  // flag spelled a field.
  const missing: string[] = [];
  if (args.namespace === undefined || !NAMESPACE_PATTERN.test(args.namespace)) {
    missing.push("--namespace (must match /^[a-z0-9_-]+$/)");
  }
  if (args.url === undefined || args.url.trim() === "") {
    missing.push("--url");
  } else if (urlHasUserinfo(args.url)) {
    // A distinct, actionable message for the credential-in-url case (F3):
    // the operator put a secret in the url, and the fix is a different flag,
    // not a re-spelling of the url.
    missing.push(
      "--url (a credential in the url is not allowed: put the secret in CONDUIT_ADD_SECRET, not the url)",
    );
  } else if (!isValidHttpUrl(args.url)) {
    missing.push("--url (must be a valid http(s) URL)");
  }
  if (args.prefix === undefined || args.prefix.trim() === "") {
    missing.push("--prefix");
  }
  if (missing.length > 0) {
    deps.stderr(`[conduit add-mcp] Missing/invalid required flags: ${missing.join(", ")}.\n`);
    return { exitCode: 1 };
  }
  const namespace: string = args.namespace as string;
  const url: string = args.url as string;
  const prefix: string = args.prefix as string;

  // Step 2: the one daemon round trip. A fresh CONDUIT_ADD_SECRET rides
  // along verbatim — the operator's own data, travelling client→daemon
  // once, never returned. It is read straight from the environment into
  // the request and is never logged, never rendered, and never placed in
  // any error line: nothing below reads it again.
  const suppliedSecret = deps.env.CONDUIT_ADD_SECRET;
  const hasFreshSecret = suppliedSecret !== undefined && suppliedSecret.trim() !== "";
  const request: RpcRequest = {
    kind: "source.provision",
    namespace,
    url,
    prefix,
    replace: args.replace,
    clearCredential: args.clearCredential,
    ...(hasFreshSecret ? { secret: suppliedSecret as string } : {}),
  };

  const answer = await ask(deps, request);
  if (!answer.ok) {
    deps.stderr(answer.line);
    return { exitCode: answer.exitCode };
  }
  // No cast: `source.provision` is typed to `ProvisionPayload`. This is the
  // site where a blind cast was worst — it threw AFTER the daemon had already
  // committed the provision, turning a successful onboarding into a fatal
  // error the operator would rationally re-run.
  const result = answer.payload;

  // Step 3: advisories the daemon produced while deciding (today: the
  // --replace retarget notice). Printed to stderr before the success line,
  // matching the pre-conversion ordering — the warning was emitted before
  // the fetch, so it reached the terminal first.
  //
  // `?? []` handles genuine ABSENCE only. The field is optional on the wire
  // (the daemon omits it when there is nothing to say), so an absent
  // `warnings` is a well-formed answer. A PRESENT-but-not-an-array
  // `warnings` is a protocol fault, and the client's payload seam refuses
  // that before it reaches here rather than letting `?? []` swallow it as
  // "no advisories".
  for (const warning of result.warnings ?? []) {
    deps.stderr(`${warning}\n`);
  }

  // Step 4: success output — counts only, never per-tool names, never the
  // secret. `credential` is the daemon's PRESENCE flag, not a ref.
  if (args.json) {
    deps.stdout(`${JSON.stringify({ ...result.counts, credential: result.credential })}\n`);
  } else {
    deps.stdout(
      `seeded ${result.toolCount} tools for connection ${result.prefix} (namespace ${result.namespace}): ` +
        `${result.counts.safe} safe (auto-allow), ${result.counts.review} review (approval), ` +
        `${result.counts.destructive} destructive (approval)\n`,
    );
  }

  return { exitCode: 0 };
}

export interface AddMcpOptions {
  /** Defaults to the uid-derived `DEFAULT_CONDUIT_DIR` (design §3.1). */
  stateDir?: string;
}

/** Production entrypoint wired into the CLI dispatch (bin.ts). */
export async function addMcp(argv: string[], opts: AddMcpOptions = {}): Promise<number> {
  const stateDir = opts.stateDir ?? DEFAULT_CONDUIT_DIR;
  const args = parseAddMcpArgs(argv);
  const result = await runAddMcp(args, {
    daemon: (request) =>
      daemonRequest({
        stateDir,
        role: "add-mcp",
        request,
        // Per-kind, via the shared table: a provision performs an outbound
        // onboarding fetch daemon-side, so it carries the derived provision
        // budget rather than a plain read's.
        deadlineMs: deadlineForRequest(request),
        // Auto-start is gated STRUCTURALLY inside `daemonRequest` (F5): it
        // spawns only for the canonical default directory. A custom
        // `--state-dir` is refused with the by-hand start command — this
        // command no longer computes that boundary.
      }),
    env: process.env,
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  });
  return result.exitCode;
}
