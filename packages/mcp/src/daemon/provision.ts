/**
 * Daemon-side source provisioning — the `source.provision` /
 * `source.revalidate` handlers' whole body (design §3.3.1, §17 Task 8).
 *
 * This module is where `add-mcp`'s onboarding logic LIVES now. Before Task
 * 8 it ran inside the CLI process: `add-mcp.ts` opened the store, called
 * `store.secrets.reveal(...)` to obtain a stored credential, and performed
 * the onboarding fetch itself. That put plaintext credential material in an
 * operator CLI's heap for the duration of every re-sync.
 *
 * §3.3.1's decision is that **the daemon performs the credential-bearing
 * fetch on the client's behalf**, and the plaintext never leaves the
 * daemon. A fresh secret supplied at onboarding still travels client→daemon
 * once (the operator is providing it), but never daemon→client — and it is
 * never echoed in any response, log line, or error message.
 *
 * ## The anti-oracle shape, and what enforces it
 *
 * A client that can name BOTH a credential and a destination turns the
 * daemon into an exfiltration tool for secrets it holds precisely so
 * nobody else can read them. So the client never names both:
 *
 * - `source.revalidate` carries ONLY a namespace. `decodeRequest` rejects a
 *   `source.revalidate` object carrying a `url` key at all — the field is
 *   unrepresentable, not merely unused. `revalidateSource` below then
 *   derives the url AND the credential ref from the STORED row. A ref a
 *   client supplies is never honored because there is no field to supply
 *   one in.
 * - `source.provision` carries a url and MAY carry a secret, but that
 *   secret is the operator's own, supplied in the same request — it is the
 *   operator's data going in, not a stored credential being redirected out.
 *   A stored credential is reused for a provision ONLY when the request's
 *   url is byte-identical to the stored row's location (`urlUnchanged`),
 *   which is the same origin check §3.3.1 requires, taken against the
 *   strictest possible comparand.
 * - Redirects never carry the credential. `mcp-client.ts` refuses every 3xx
 *   outright (`McpClientError` kind `http_status`) rather than following it
 *   with headers attached, so a cross-origin redirect is never even
 *   requested — a stronger position than §3.3.1's "drops the credential".
 *
 * ## What crosses back
 *
 * `ProvisionPayload` — counts and a credential PRESENCE flag. Never a
 * repository row, never the secret, never a header, never a credentialRef.
 */
import { type ConduitStore, McpClientError, normalizeMcp, type RiskClass } from "@conduithq/sdk";
import { fetchToolsList } from "../mcp-fetch.js";

const NAMESPACE_PATTERN = /^[a-z0-9_-]+$/;

/**
 * The `source.provision` / `source.revalidate` response projection.
 *
 * A projection, like every other daemon answer (design D-B1): the atomic
 * write touches four tables and the caller needs none of their rows. It
 * needs what to PRINT — how many tools landed, in what risk classes, under
 * which addressing prefix, and whether a credential is now on file.
 *
 * `credential` is a two-valued PRESENCE flag, deliberately not a ref. A ref
 * is a handle to sealed material; a client holding one has half of the
 * `(credential, destination)` pair §3.3.1 exists to keep apart. "present"
 * and "absent" answer the operator's actual question ("did my secret
 * stick?") and answer nothing else.
 */
export interface ProvisionPayload {
  namespace: string;
  prefix: string;
  toolCount: number;
  counts: { safe: number; review: number; destructive: number };
  credential: "present" | "absent";
  /**
   * Operator-facing advisories the daemon produced while deciding — today
   * the one `--replace` retarget notice, which warns that manual policy
   * overrides carry over to the retargeted source.
   *
   * On the wire rather than re-derived client-side because the CLI no
   * longer has the state to derive it: "is this a retarget" is a comparison
   * against the STORED row, and the store is the daemon's. Absent when
   * there is nothing to say.
   */
  warnings?: string[];
}

/**
 * A refusal the OPERATOR must see verbatim: a precondition the daemon
 * checked against its own state and declined. Distinct from a thrown
 * error — these are expected outcomes of a well-formed request (the
 * namespace already points elsewhere, the upstream is unreachable, the
 * retarget would leak a credential), and each names the operator's next
 * move.
 *
 * `connection.ts` turns this into an `error` frame with code `invalid`, and
 * the CLI prints `.message` unchanged. Nothing constructed here ever
 * interpolates a secret: the only fields that reach a message are the
 * namespace, the prefix, the url, and the shared client's own error text
 * (which carries no header material — see `mcp-client.ts`).
 */
export class ProvisionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionRefused";
  }
}

/** What the daemon needs to provision, injected so tests need no sockets. */
export interface ProvisionDeps {
  store: ConduitStore;
  /** Defaults to the real onboarding fetch; mocked in tests. */
  fetchTools?: (url: string, opts?: { authorization?: string }) => Promise<unknown[]>;
}

/**
 * The stored rows a namespace resolves to, read as ONE triple.
 *
 * Both handlers need exactly this lookup, and both derive the source id the
 * same way (`src_${namespace}`). Keeping the derivation and the three reads
 * in one place is a §3.3.1 property, not a tidiness one: `revalidate`'s
 * whole anti-oracle argument is that its url comes from the row this lookup
 * returns, so if its lookup could ever diverge from `provision`'s — a
 * different id prefix, a different connection-selection rule — the two
 * handlers would be resolving "the same namespace" to different rows, and
 * the url `revalidate` fetches would no longer be the one `provision`
 * wrote. Any change to the derivation now changes both by construction.
 *
 * Connection selection matches the pre-existing behavior exactly: the first
 * connection whose `integrationId` matches, or `undefined` when the
 * integration is absent.
 */
async function readStoredSource(
  store: ConduitStore,
  namespace: string,
): Promise<{
  sourceId: string;
  source: Awaited<ReturnType<ConduitStore["sources"]["get"]>>;
  integration: Awaited<ReturnType<ConduitStore["integrations"]["getByNamespace"]>>;
  connection: Awaited<ReturnType<ConduitStore["connections"]["list"]>>[number] | undefined;
}> {
  const sourceId = `src_${namespace}`;
  const source = await store.sources.get(sourceId);
  const integration = await store.integrations.getByNamespace(namespace);
  const connection = integration
    ? (await store.connections.list()).find((c) => c.integrationId === integration.id)
    : undefined;
  return { sourceId, source, integration, connection };
}

/** The decoded `source.provision` request, minus its `kind`. */
export interface ProvisionInput {
  namespace: string;
  url: string;
  prefix: string;
  secret?: string;
  replace: boolean;
  clearCredential: boolean;
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

/** True iff `value` parses as a URL with an http: or https: protocol. */
function isValidHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Maps a `fetchTools` rejection to the operator-facing refusal line.
 *
 * Unchanged in wording from the pre-Task-8 CLI-side mapping, so the
 * conversion is invisible in the terminal. An `McpClientError` routes by
 * `kind`; anything else falls back to the unreachable line. **Never
 * interpolates the secret** — the shared client's messages carry no header
 * material by construction (`mcp-client.ts` builds headers from
 * `endpoint.headers` verbatim and never renders them into an error).
 */
function mapFetchError(cause: unknown, url: string): string {
  const unreachable = `[conduit add-mcp] upstream unreachable at ${url}; nothing was written. Re-run when reachable.`;
  if (!(cause instanceof McpClientError)) {
    return unreachable;
  }
  const clientMessage = `[conduit add-mcp] ${cause.message}; nothing was written.`;
  switch (cause.kind) {
    case "http_status":
      if (cause.status === 401 || cause.status === 403) {
        return `[conduit add-mcp] upstream requires authorization (HTTP ${cause.status}): set CONDUIT_ADD_SECRET; nothing was written.`;
      }
      return clientMessage;
    case "cap":
    case "protocol":
      return clientMessage;
    case "timeout":
      return `[conduit add-mcp] upstream did not complete within the onboarding budget; nothing was written.`;
    case "network":
      return unreachable;
    default: {
      // Exhaustiveness: a future sixth kind is a COMPILE error here. The
      // runtime return stays the prefixed fallback so a stale build still
      // emits a self-describing line.
      const _exhaustive: never = cause.kind;
      void _exhaustive;
      return unreachable;
    }
  }
}

/**
 * `source.provision` — atomic onboarding / re-sync of an upstream MCP
 * source, performed entirely inside the daemon.
 *
 * READ CURRENT STATE FIRST, exactly as the CLI version did: every
 * second-run decision (the retarget gate, the credential preserve-not-
 * remove rule, and above all the credential-leak refusal) resolves against
 * the stored row BEFORE any request goes out, so a refusal happens before
 * the network rather than after it.
 */
export async function provisionSourceRequest(
  input: ProvisionInput,
  deps: ProvisionDeps,
): Promise<ProvisionPayload> {
  const { store } = deps;
  const fetchTools = deps.fetchTools ?? fetchToolsList;

  // Step 1: validation. Re-checked daemon-side even though the CLI checks
  // the same things: the daemon is the authorization boundary and a
  // hand-crafted frame is not obliged to have passed through any CLI.
  const invalid: string[] = [];
  if (!NAMESPACE_PATTERN.test(input.namespace)) {
    invalid.push("namespace (must match /^[a-z0-9_-]+$/)");
  }
  if (!isValidHttpUrl(input.url)) {
    invalid.push("url (must be a valid http(s) URL)");
  }
  if (input.prefix.trim() === "") {
    invalid.push("prefix");
  }
  if (invalid.length > 0) {
    throw new ProvisionRefused(
      `[conduit add-mcp] Missing/invalid required flags: ${invalid.join(", ")}.`,
    );
  }

  const { namespace, url, prefix } = input;
  const integrationId = `int_${namespace}`;
  const connectionId = `conn_${namespace}`;
  const derivedCredentialRef = `cred_${namespace}`;

  const {
    sourceId,
    source: existingSource,
    connection: existingConnection,
  } = await readStoredSource(store, namespace);

  // Step 2: cross-namespace prefix collision. `connections.prefix` is
  // UNIQUE in the schema, so a different namespace owning this prefix
  // would otherwise surface as a raw constraint error out of
  // provisionSource. Checked read-first so it takes the same fail-loud
  // path as every other precondition.
  const prefixOwner = await store.connections.getByPrefix(prefix);
  if (prefixOwner !== undefined && prefixOwner.integrationId !== integrationId) {
    throw new ProvisionRefused(
      `[conduit add-mcp] prefix ${prefix} is already used by another source; nothing was written. ` +
        `Choose a different --prefix.`,
    );
  }

  const urlUnchanged = existingSource !== undefined && existingSource.location === url;
  const suppliedSecret = input.secret;
  const hasFreshSecret = suppliedSecret !== undefined && suppliedSecret.trim() !== "";

  // Step 3: THE CREDENTIAL-LEAK REFUSAL (§3.3.1's core requirement, and
  // the reason this whole module moved daemon-side).
  //
  // A `--replace` to a NEW url while a stored credential exists is REFUSED
  // OUTRIGHT unless the operator supplies a fresh secret for the new
  // upstream, or explicitly drops the stored one. The stored secret is
  // bound to the old host and must never be sent to a different one.
  //
  // Checked BEFORE the fetch, so nothing — not even a connection attempt —
  // reaches the new url. This is the second of the two locks on the
  // anti-oracle property; the first is that no request shape lets a client
  // name a credential at all.
  if (
    input.replace &&
    !urlUnchanged &&
    existingConnection?.credentialRef !== undefined &&
    !hasFreshSecret &&
    !input.clearCredential
  ) {
    throw new ProvisionRefused(
      `[conduit add-mcp] refusing to retarget "${namespace}" to a new url while a stored ` +
        `credential exists: pass CONDUIT_ADD_SECRET for the new upstream or --clear-credential ` +
        `to drop it. Nothing was written.`,
    );
  }

  // Step 4: the retarget gate — refuse a silent retarget without --replace.
  const isRetarget =
    existingSource !== undefined &&
    (existingSource.location !== url ||
      (existingConnection !== undefined && existingConnection.prefix !== prefix));
  if (isRetarget && !input.replace) {
    throw new ProvisionRefused(
      `[conduit add-mcp] Namespace "${namespace}" already exists with a different url or prefix. ` +
        `Re-run with --replace to retarget it, or choose a different --namespace.`,
    );
  }

  const warnings: string[] = [];
  if (isRetarget && input.replace) {
    warnings.push(
      `[conduit add-mcp] --replace: retargeting namespace "${namespace}" to a new url or prefix. ` +
        `Manual policy overrides (keyed by tool name) will carry over to the retargeted source.`,
    );
  }

  // Step 5: resolve the onboarding auth. THE REVEAL HAPPENS HERE, inside
  // the daemon, and the revealed value goes exactly one place: the
  // request-scoped `authorization` header of the fetch below. It is never
  // returned, never logged, never put in an error message.
  //
  // Order: a fresh operator-supplied secret always wins; else a stored
  // credential is reused ONLY when the url is byte-identical to the stored
  // row's (never sent to a new host — Step 3 already refused the leak
  // case); else no auth, which is a legitimate unauthenticated onboarding
  // fetch (§9.1).
  let onboardingAuth: string | undefined;
  if (hasFreshSecret) {
    onboardingAuth = suppliedSecret;
  } else if (urlUnchanged && existingConnection?.credentialRef !== undefined) {
    const stored = await store.secrets.reveal(existingConnection.credentialRef);
    if (stored !== undefined && stored !== "") {
      onboardingAuth = stored;
    }
  }

  const payload = await fetchAndProvision({
    store,
    fetchTools,
    namespace,
    url,
    prefix,
    onboardingAuth,
    ids: { sourceId, integrationId, connectionId, derivedCredentialRef },
    ...(existingConnection?.credentialRef !== undefined
      ? { existingCredentialRef: existingConnection.credentialRef }
      : {}),
    hasFreshSecret,
    ...(suppliedSecret !== undefined ? { suppliedSecret } : {}),
    clearCredential: input.clearCredential,
  });
  return { ...payload, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * `source.revalidate` — re-fetch and re-provision a source the daemon
 * already has on file, using the credential it already holds.
 *
 * **The client supplies nothing but a namespace.** The url, the prefix, and
 * the credential ref all come from the stored row. That is the entire
 * anti-oracle argument in one function: there is no input by which a client
 * could pair a stored credential with a destination of its choosing,
 * because the only input is an identity the daemon looks up.
 *
 * A namespace with no stored source is a refusal, not an implicit
 * onboarding: onboarding requires a url, and the one place a url may be
 * supplied is `source.provision`, where the operator is providing their own
 * destination alongside their own secret.
 */
export async function revalidateSourceRequest(
  namespace: string,
  deps: ProvisionDeps,
): Promise<ProvisionPayload> {
  const { store } = deps;
  const fetchTools = deps.fetchTools ?? fetchToolsList;

  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new ProvisionRefused(
      `[conduit add-mcp] Missing/invalid required flags: namespace (must match /^[a-z0-9_-]+$/).`,
    );
  }

  // The SAME lookup `provision` performs, by construction — see
  // `readStoredSource` for why the §3.3.1 derivation must not be able to
  // diverge between the two handlers.
  const { sourceId, source, integration, connection } = await readStoredSource(store, namespace);

  if (source === undefined || integration === undefined || connection === undefined) {
    throw new ProvisionRefused(
      `[conduit add-mcp] no source is registered under namespace "${namespace}"; nothing was ` +
        `written. Run "conduit add-mcp --namespace ${namespace} --url <url> --prefix <prefix>" ` +
        `to onboard it first.`,
    );
  }

  // BOTH halves derived from the stored row. The url is the source's own
  // `location` — never anything the client said — and the credential is
  // revealed from the connection's own ref. A client cannot influence
  // either.
  const url = source.location;
  let onboardingAuth: string | undefined;
  if (connection.credentialRef !== undefined) {
    const stored = await store.secrets.reveal(connection.credentialRef);
    if (stored !== undefined && stored !== "") {
      onboardingAuth = stored;
    }
  }

  return fetchAndProvision({
    store,
    fetchTools,
    namespace,
    url,
    prefix: connection.prefix,
    onboardingAuth,
    ids: {
      sourceId,
      integrationId: integration.id,
      connectionId: connection.id,
      derivedCredentialRef: `cred_${namespace}`,
    },
    ...(connection.credentialRef !== undefined
      ? { existingCredentialRef: connection.credentialRef }
      : {}),
    hasFreshSecret: false,
    clearCredential: false,
  });
}

/**
 * The shared tail both handlers run: fetch `tools/list` as a hard
 * precondition, then land ONE atomic `provisionSource` transaction.
 *
 * The fetch is a precondition BEFORE any write (design §2.2): every failure
 * class refuses with `nothing was written` and leaves the store untouched.
 * The write itself is the store's own multi-table batch — source,
 * integration, connection, optional secret upsert or delete, and tools —
 * all-or-nothing, and it runs in the process that owns the database rather
 * than in a second opener of it.
 */
async function fetchAndProvision(args: {
  store: ConduitStore;
  fetchTools: (url: string, opts?: { authorization?: string }) => Promise<unknown[]>;
  namespace: string;
  url: string;
  prefix: string;
  onboardingAuth: string | undefined;
  ids: {
    sourceId: string;
    integrationId: string;
    connectionId: string;
    derivedCredentialRef: string;
  };
  existingCredentialRef?: string;
  hasFreshSecret: boolean;
  suppliedSecret?: string;
  clearCredential: boolean;
}): Promise<ProvisionPayload> {
  const { store, namespace, url, prefix, ids } = args;

  let rawTools: unknown[];
  try {
    rawTools = await args.fetchTools(
      url,
      args.onboardingAuth !== undefined ? { authorization: args.onboardingAuth } : undefined,
    );
  } catch (cause) {
    throw new ProvisionRefused(mapFetchError(cause, url));
  }

  let tools: Awaited<ReturnType<typeof normalizeMcp>>;
  try {
    tools = normalizeMcp({ namespace, tools: rawTools });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ProvisionRefused(
      `[conduit add-mcp] upstream at ${url} returned an invalid tools/list; nothing was written. ` +
        `Re-run when the upstream is fixed. Context: { cause: ${JSON.stringify(detail)} }`,
    );
  }

  // Credential resolution, resolved BEFORE the atomic write. The deliberate
  // deauth path's DELETE travels INSIDE the same batch via
  // `removeSecretRef`, so a failure anywhere rolls the delete back too.
  let credentialRef: string | undefined;
  let secretToStore: { ref: string; value: string } | undefined;
  let secretRefToRemove: string | undefined;

  if (args.clearCredential) {
    credentialRef = undefined;
    if (args.existingCredentialRef !== undefined) {
      secretRefToRemove = args.existingCredentialRef;
    }
  } else if (args.hasFreshSecret) {
    credentialRef = ids.derivedCredentialRef;
    secretToStore = { ref: ids.derivedCredentialRef, value: args.suppliedSecret as string };
  } else if (args.existingCredentialRef !== undefined) {
    // Preserve-not-remove: rewrite the same ref, no secret write.
    credentialRef = args.existingCredentialRef;
  } else {
    credentialRef = undefined;
  }

  await store.provisionSource({
    source: { id: ids.sourceId, type: "mcp" as const, namespace, location: url },
    integration: { id: ids.integrationId, sourceId: ids.sourceId, namespace },
    connection: {
      id: ids.connectionId,
      integrationId: ids.integrationId,
      prefix,
      ...(credentialRef !== undefined ? { credentialRef } : {}),
    },
    ...(secretToStore !== undefined ? { secret: secretToStore } : {}),
    ...(secretRefToRemove !== undefined ? { removeSecretRef: secretRefToRemove } : {}),
    tools,
  });

  // Counts and a presence flag — never the ref, never the secret.
  return {
    namespace,
    prefix,
    toolCount: tools.length,
    counts: countsByRiskClass(tools),
    credential: credentialRef !== undefined ? "present" : "absent",
  };
}
