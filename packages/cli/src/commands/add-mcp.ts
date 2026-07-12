import { openStoreFromEnv } from "@conduithq/mcp";
import { type ConduitStore, normalizeMcp, type RiskClass } from "@conduithq/sdk";
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

export interface AddMcpArgs {
  url?: string;
  namespace?: string;
  prefix?: string;
  replace: boolean;
  clearCredential: boolean;
  json: boolean;
}

export interface AddMcpDeps {
  /** Defaults to `fetchToolsList`; injectable so tests never touch the network. */
  fetchTools: (url: string) => Promise<unknown[]>;
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

export async function runAddMcp(args: AddMcpArgs, deps: AddMcpDeps): Promise<AddMcpResult> {
  const { namespace, url, prefix } = args;

  // Step 1: validate --namespace BEFORE any fetch/store access.
  if (namespace === undefined || !NAMESPACE_PATTERN.test(namespace)) {
    deps.stderr(
      `[conduit add-mcp] Invalid --namespace: must match /^[a-z0-9_-]+$/. Context: { namespace: ${JSON.stringify(namespace)} }\n`,
    );
    return { exitCode: 1 };
  }
  if (url === undefined || url.trim() === "") {
    deps.stderr(`[conduit add-mcp] Missing required --url.\n`);
    return { exitCode: 1 };
  }
  if (prefix === undefined || prefix.trim() === "") {
    deps.stderr(`[conduit add-mcp] Missing required --prefix.\n`);
    return { exitCode: 1 };
  }

  // Step 2: fetch tools/list — a hard precondition BEFORE any store write.
  let rawTools: unknown[];
  try {
    rawTools = await deps.fetchTools(url);
  } catch {
    deps.stderr(
      `[conduit add-mcp] upstream unreachable at ${url}; nothing was written. Re-run when reachable.\n`,
    );
    return { exitCode: 1 };
  }
  const tools = normalizeMcp({ namespace, tools: rawTools });

  // Step 3: open the store and READ existing state.
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

  // Step 4: C3 gate — refuse a silent retarget without --replace.
  if (
    existingSource !== undefined &&
    (existingSource.location !== url ||
      (existingConnection !== undefined && existingConnection.prefix !== prefix)) &&
    !args.replace
  ) {
    deps.stderr(
      `[conduit add-mcp] Namespace "${namespace}" already exists with a different url/prefix. ` +
        `Re-run with --replace to retarget it, or choose a different --namespace.\n`,
    );
    return { exitCode: 1 };
  }
  if (existingSource !== undefined && args.replace) {
    deps.stderr(
      `[conduit add-mcp] --replace: retargeting namespace "${namespace}" to a new upstream. ` +
        `Manual policy overrides (keyed by tool name) will carry over to the new upstream.\n`,
    );
  }

  // Step 5: C2 credential resolution — resolved BEFORE the atomic write.
  const suppliedSecret = deps.env.CONDUIT_ADD_SECRET;
  let credentialRef: string | undefined;
  let secretToStore: { ref: string; value: string } | undefined;

  if (args.clearCredential) {
    credentialRef = undefined;
    if (existingConnection?.credentialRef !== undefined) {
      await store.secrets.remove(existingConnection.credentialRef);
    }
  } else if (suppliedSecret !== undefined && suppliedSecret.trim() !== "") {
    credentialRef = derivedCredentialRef;
    secretToStore = { ref: derivedCredentialRef, value: suppliedSecret };
  } else if (existingConnection?.credentialRef !== undefined) {
    // Preserve-not-remove: read-then-rewrite the same ref, no secret write.
    credentialRef = existingConnection.credentialRef;
  } else {
    credentialRef = undefined;
  }

  // Step 6: build the atomic write and provision.
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
    tools,
  });

  // Step 7: success output — counts only, never per-tool names, never the secret.
  const counts = countsByRiskClass(tools);
  const credentialState = credentialRef !== undefined ? "present" : "absent";
  if (args.json) {
    deps.stdout(`${JSON.stringify({ ...counts, credential: credentialState })}\n`);
  } else {
    deps.stdout(
      `seeded ${tools.length} tools under ${prefix}: ${counts.safe} safe (auto-allow), ` +
        `${counts.review} review (approval), ${counts.destructive} destructive (approval)\n`,
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
