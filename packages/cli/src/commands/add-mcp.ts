import { openStoreFromEnv } from "@conduithq/mcp";
import {
  type ConduitStore,
  McpClientError,
  normalizeMcp,
  type RiskClass,
  type Tool,
} from "@conduithq/sdk";
import { fetchToolsList } from "../mcp-fetch.js";

/**
 * `conduit add-mcp` — atomic onboarding / re-sync of an upstream MCP source
 * (design §2.2, §4). READ CURRENT STATE FIRST: every second-run decision
 * (C3 retarget gate, C2 credential preserve-not-remove) resolves against the
 * read row before any write; the resolved writes then land in ONE
 * `provisionSource` transaction (C1).
 *
 * Injectable deps mirror the codebase's DI convention (createExecutionManager
 * takes a deps bag) so the command is unit-testable against a real store
 * without a network dependency: only `fetchTools` is mocked in tests.
 */

const NAMESPACE_PATTERN = /^[a-z0-9_-]+$/;

/** `conduit add-mcp --help` text (D5). dispatch.ts prints this directly
 * without invoking runAddMcp — no store open, no network. */
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

export interface AddMcpDeps {
  /** Defaults to `fetchToolsList`; injectable so tests never touch the network.
   * `opts.authorization` carries the resolved onboarding credential (the full
   * `Authorization` header value) — never logged, request-scoped only. */
  fetchTools: (url: string, opts?: { authorization?: string }) => Promise<unknown[]>;
  /** Defaults to `openStoreFromEnv`; injectable so tests can pre-open a store. */
  openStore: (env?: NodeJS.ProcessEnv) => Promise<{ store: ConduitStore }>;
  env: NodeJS.ProcessEnv;
  /** Defaults to console.log/console.error; captured in tests for the
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

/** True iff `value` parses as a URL with an http: or https: protocol. Used by
 * Step-1 validation (D5) so a bad url/scheme fails as a validation error rather
 * than throwing later out of `new URL()` (TypeError / ERR_INVALID_PROTOCOL). */
function isValidHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function countsByRiskClass(tools: readonly { riskClass: RiskClass }[]): {
  safe: number;
  review: number;
  destructive: number;
} {
  const counts = { safe: 0, review: 0, destructive: 0 };
  for (const tool of tools) {
    counts[tool.riskClass]++;
  }
  return counts;
}

/**
 * Maps a `fetchTools` rejection to the fail-loud stderr line (design §18-C4:
 * specific errors replace the old discard-all catch). An `McpClientError`
 * routes by `kind`; anything else (a plain network throw, a URL parse error)
 * falls back to today's unreachable line. Never interpolates the secret — the
 * client's messages carry no header material. Trailing newline is added by the
 * caller.
 */
function mapFetchError(cause: unknown, url: string): string {
  const unreachable = `[conduit add-mcp] upstream unreachable at ${url}; nothing was written. Re-run when reachable.`;
  if (!(cause instanceof McpClientError)) {
    return unreachable;
  }
  // The shared fallthrough: surface the client's own message verbatim. Used by
  // non-auth http_status (e.g. 404/500), cap (byte/tool-count breach), and
  // protocol — each carries a self-describing McpClientError.message.
  const clientMessage = `[conduit add-mcp] ${cause.message}; nothing was written.`;
  switch (cause.kind) {
    case "http_status":
      if (cause.status === 401 || cause.status === 403) {
        return `[conduit add-mcp] upstream requires authorization (HTTP ${cause.status}): set CONDUIT_ADD_SECRET; nothing was written.`;
      }
      // Other non-2xx (e.g. 404/500) — surface the client's own message.
      return clientMessage;
    case "cap":
    case "protocol":
      return clientMessage;
    case "timeout":
      return `[conduit add-mcp] upstream did not complete within the onboarding budget; nothing was written.`;
    case "network":
      return unreachable;
    default: {
      // Exhaustiveness: every McpClientError kind is handled above, so a future
      // sixth kind is a COMPILE error here (mirrors bin.ts's _exhaustive). The
      // runtime return is the prefixed fallback, not the bare kind string, so a
      // stale-compiled CLI against a newer SDK still emits a self-describing line
      // rather than a raw `"new_kind"` with no `[conduit add-mcp]` prefix.
      const _exhaustive: never = cause.kind;
      void _exhaustive;
      return unreachable;
    }
  }
}

export async function runAddMcp(args: AddMcpArgs, deps: AddMcpDeps): Promise<AddMcpResult> {
  // Step 1: collect ALL missing/invalid required flags into ONE stderr line
  // (D5 — single-pass validation) BEFORE any fetch/store access.
  const missing: string[] = [];
  if (args.namespace === undefined || !NAMESPACE_PATTERN.test(args.namespace)) {
    missing.push("--namespace (must match /^[a-z0-9_-]+$/)");
  }
  if (args.url === undefined || args.url.trim() === "") {
    missing.push("--url");
  } else if (!isValidHttpUrl(args.url)) {
    // Validate parseability + http(s) scheme HERE (D5 single-pass), so a
    // malformed url or a non-http scheme fails as a validation error with the
    // rest of the flags — never later as `new URL()` TypeError /
    // ERR_INVALID_PROTOCOL masquerading as "upstream unreachable".
    missing.push("--url (must be a valid http(s) URL)");
  }
  if (args.prefix === undefined || args.prefix.trim() === "") {
    missing.push("--prefix");
  }
  if (missing.length > 0) {
    deps.stderr(`[conduit add-mcp] Missing/invalid required flags: ${missing.join(", ")}.\n`);
    return { exitCode: 1 };
  }
  // Narrowed: all three are now known-defined, valid strings.
  const namespace: string = args.namespace as string;
  const url: string = args.url as string;
  const prefix: string = args.prefix as string;

  // Step 2: open the store and READ existing state FIRST (design §18-C4 D2).
  // The onboarding auth order requires read-before-fetch: the stored row and
  // its credential decide whether the fetch is authorized, and the retarget
  // credential-leak guard must refuse BEFORE any request goes to a new host.
  const { store } = await deps.openStore(deps.env);
  const sourceId = `src_${namespace}`;
  const integrationId = `int_${namespace}`;
  const connectionId = `conn_${namespace}`;
  const derivedCredentialRef = `cred_${namespace}`;

  const existingSource = await store.sources.get(sourceId);
  const existingIntegration = await store.integrations.getByNamespace(namespace);
  const existingConnection = existingIntegration
    ? (await store.connections.list()).find((c) => c.integrationId === existingIntegration.id)
    : undefined;

  // Step 2b: cross-namespace prefix collision — `connections.prefix` is
  // UNIQUE in the schema, so a DIFFERENT namespace already owning the
  // requested --prefix would otherwise surface as a raw UNIQUE constraint
  // error out of provisionSource, falling through to bin.ts's generic
  // `[conduit] Fatal:` handler. Checked here (read-first, before any write)
  // so it takes the same fail-loud path as every other precondition.
  const prefixOwner = await store.connections.getByPrefix(prefix);
  if (prefixOwner !== undefined && prefixOwner.integrationId !== integrationId) {
    deps.stderr(
      `[conduit add-mcp] prefix ${prefix} is already used by another source; nothing was written. ` +
        `Choose a different --prefix.\n`,
    );
    return { exitCode: 1 };
  }

  const urlUnchanged = existingSource !== undefined && existingSource.location === url;
  const suppliedSecret = deps.env.CONDUIT_ADD_SECRET;
  const hasFreshSecret = suppliedSecret !== undefined && suppliedSecret.trim() !== "";

  // Step 2c: retarget credential-leak guard (design §18-C4 D2 — supersedes
  // C2's preserve-not-remove for the retarget case). A `--replace` to a NEW
  // url while a stored credential exists is REFUSED OUTRIGHT unless the
  // operator supplies a fresh CONDUIT_ADD_SECRET (auth for the new upstream)
  // or --clear-credential (drop it): the stored secret is bound to the old
  // host and must never be sent to a different one. Checked before the fetch,
  // so nothing — not even the network request — reaches the new url.
  if (
    args.replace &&
    !urlUnchanged &&
    existingConnection?.credentialRef !== undefined &&
    !hasFreshSecret &&
    !args.clearCredential
  ) {
    deps.stderr(
      `[conduit add-mcp] refusing to retarget "${namespace}" to a new url while a stored ` +
        `credential exists: pass CONDUIT_ADD_SECRET for the new upstream or --clear-credential ` +
        `to drop it. Nothing was written.\n`,
    );
    return { exitCode: 1 };
  }

  // Step 3: C3 gate — refuse a silent retarget without --replace. The same
  // "does url/prefix actually differ" condition gates the --replace warning
  // below, so --replace on an unchanged source stays quiet.
  const isRetarget =
    existingSource !== undefined &&
    (existingSource.location !== url ||
      (existingConnection !== undefined && existingConnection.prefix !== prefix));
  if (isRetarget && !args.replace) {
    deps.stderr(
      `[conduit add-mcp] Namespace "${namespace}" already exists with a different url or prefix. ` +
        `Re-run with --replace to retarget it, or choose a different --namespace.\n`,
    );
    return { exitCode: 1 };
  }
  if (isRetarget && args.replace) {
    deps.stderr(
      `[conduit add-mcp] --replace: retargeting namespace "${namespace}" to a new url or prefix. ` +
        `Manual policy overrides (keyed by tool name) will carry over to the retargeted source.\n`,
    );
  }

  // Step 4: resolve the ONBOARDING auth for the fetch (design §18-C4 D2).
  // Order: a fresh CONDUIT_ADD_SECRET always wins; else a stored credential is
  // reused ONLY when the url is unchanged from the stored row (never sent to a
  // new host — the retarget guard above already refused the leak case); else
  // no auth (an unauthenticated onboarding fetch is legitimate, §9.1). The
  // resolved value is the full `Authorization` header; it is passed
  // request-scoped to the fetch and NEVER logged (mirrors
  // createStoreCredentialResolver's read path).
  let onboardingAuth: string | undefined;
  if (hasFreshSecret) {
    onboardingAuth = suppliedSecret;
  } else if (urlUnchanged && existingConnection?.credentialRef !== undefined) {
    const stored = await store.secrets.reveal(existingConnection.credentialRef);
    if (stored !== undefined && stored !== "") {
      onboardingAuth = stored;
    }
  }

  // Step 5: fetch + normalize tools/list — a hard precondition BEFORE any
  // store write. Every failure class takes the same fail-loud path (design
  // §2.2): a `[conduit add-mcp] ... nothing was written` line + exit 1, never
  // bin.ts's generic fatal handler. An `McpClientError` is mapped to a
  // kind-specific line (auth guidance on 401/403, the cap message verbatim,
  // the onboarding-budget line on timeout, the client message on protocol);
  // a network error (and any non-client throw) falls back to today's
  // unreachable line.
  let rawTools: unknown[];
  try {
    rawTools = await deps.fetchTools(
      url,
      onboardingAuth !== undefined ? { authorization: onboardingAuth } : undefined,
    );
  } catch (cause) {
    deps.stderr(`${mapFetchError(cause, url)}\n`);
    return { exitCode: 1 };
  }
  let tools: Tool[];
  try {
    tools = normalizeMcp({ namespace, tools: rawTools });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    deps.stderr(
      `[conduit add-mcp] upstream at ${url} returned an invalid tools/list; nothing was written. ` +
        `Re-run when the upstream is fixed. Context: { cause: ${JSON.stringify(detail)} }\n`,
    );
    return { exitCode: 1 };
  }

  // Step 6: C2 credential resolution — resolved BEFORE the atomic write.
  let credentialRef: string | undefined;
  let secretToStore: { ref: string; value: string } | undefined;
  // The deliberate deauth path (T-I2 amendment, user-approved): the old
  // secret's DELETE now travels INSIDE the same atomic provisionSource batch
  // as the source/integration/connection/tools write, via removeSecretRef.
  // A failure anywhere in that batch rolls back the delete too, so the old
  // secret + old connection stay fully intact on rejection — this is now a
  // storage-layer guarantee (batch rollback), not an ordering discipline.
  let secretRefToRemove: string | undefined;

  if (args.clearCredential) {
    credentialRef = undefined;
    if (existingConnection?.credentialRef !== undefined) {
      secretRefToRemove = existingConnection.credentialRef;
    }
  } else if (hasFreshSecret) {
    credentialRef = derivedCredentialRef;
    secretToStore = { ref: derivedCredentialRef, value: suppliedSecret as string };
  } else if (existingConnection?.credentialRef !== undefined) {
    // Preserve-not-remove: read-then-rewrite the same ref, no secret write.
    credentialRef = existingConnection.credentialRef;
  } else {
    credentialRef = undefined;
  }

  // Step 7: build the atomic write and provision.
  const source = { id: sourceId, type: "mcp" as const, namespace, location: url };
  const integration = { id: integrationId, sourceId, namespace };
  const connection = {
    id: connectionId,
    integrationId,
    prefix,
    ...(credentialRef !== undefined ? { credentialRef } : {}),
  };

  await store.provisionSource({
    source,
    integration,
    connection,
    ...(secretToStore !== undefined ? { secret: secretToStore } : {}),
    ...(secretRefToRemove !== undefined ? { removeSecretRef: secretRefToRemove } : {}),
    tools,
  });

  // Step 8: success output — counts only, never per-tool names, never the secret.
  const counts = countsByRiskClass(tools);
  const credentialState = credentialRef !== undefined ? "present" : "absent";
  if (args.json) {
    deps.stdout(`${JSON.stringify({ ...counts, credential: credentialState })}\n`);
  } else {
    deps.stdout(
      `seeded ${tools.length} tools for connection ${prefix} (namespace ${namespace}): ` +
        `${counts.safe} safe (auto-allow), ${counts.review} review (approval), ` +
        `${counts.destructive} destructive (approval)\n`,
    );
  }

  return { exitCode: 0 };
}

/** Production entrypoint wired into the CLI dispatch (bin.ts). */
export async function addMcp(argv: string[]): Promise<number> {
  const args = parseAddMcpArgs(argv);
  const result = await runAddMcp(args, {
    fetchTools: fetchToolsList,
    openStore: openStoreFromEnv,
    env: process.env,
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  });
  return result.exitCode;
}
