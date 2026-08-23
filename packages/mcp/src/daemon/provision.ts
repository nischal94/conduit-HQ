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
import {
  type ConduitStore,
  McpClientError,
  normalizeMcp,
  type RiskClass,
  redactionTokens,
  redactTokens,
} from "@conduithq/sdk";
import { fetchToolsList } from "../mcp-fetch.js";

const NAMESPACE_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Hard cap on the UTF-8 bytes of any ONE tool's name or description, checked
 * before the atomic write (spec §2.2's bounded-input requirement).
 *
 * The other two onboarding bounds live in `mcp-fetch.ts`: `MAX_RESPONSE_BYTES`
 * bounds the whole response off the wire, and `MAX_TOOLS` bounds the tool
 * count. Neither bounds ONE tool's text, so an upstream advertising a single
 * tool with a multi-megabyte description passes both and lands that text in
 * the store — from where it is hydrated into the shared catalog, returned by
 * `describe`, and rendered into an agent's prompt. This cap closes that gap
 * at the same boundary as the other two: refuse, write nothing.
 *
 * Normative-local, chosen here. 16 KiB is far above any legitimate tool's
 * text (the largest real MCP descriptions run to hundreds of bytes) and far
 * below a size that matters to a prompt budget.
 */
export const MAX_TOOL_TEXT_BYTES = 16 * 1024;

/**
 * Refuses a `tools/list` whose per-tool text exceeds `MAX_TOOL_TEXT_BYTES`.
 *
 * Reads the RAW upstream entries rather than the normalized tools: the check
 * has to happen on what arrived, and `normalizeMcp` rewrites the name while
 * carrying the description through unchanged. Entries that are not
 * object-shaped are left alone — `normalizeMcp`'s own envelope validation
 * rejects those, and duplicating its verdict here would give one malformed
 * body two different refusals.
 *
 * Returns the offending tool's INDEX, never its text: the message crosses to
 * the client, and upstream-controlled text is exactly what must not ride
 * along (see `mapFetchError`'s F1 note — the same reflecting upstream that
 * echoes a credential in an error message can echo one in a description).
 */
function findOversizeToolText(rawTools: readonly unknown[]): number | undefined {
  for (let i = 0; i < rawTools.length; i++) {
    const entry = rawTools[i];
    if (typeof entry !== "object" || entry === null) continue;
    const { name, description } = entry as { name?: unknown; description?: unknown };
    if (typeof name === "string" && Buffer.byteLength(name, "utf8") > MAX_TOOL_TEXT_BYTES) {
      return i;
    }
    if (
      typeof description === "string" &&
      Buffer.byteLength(description, "utf8") > MAX_TOOL_TEXT_BYTES
    ) {
      return i;
    }
  }
  return undefined;
}

/**
 * True iff any credential token appears verbatim ANYWHERE in `rawTools` — as
 * a string value or an object KEY, at any depth (tool name, description,
 * input/output schema values and keys, nested).
 *
 * ## Why this scan exists (CX1, the §9.2 credential-reflection break)
 *
 * On the onboarding fetch the daemon has already revealed the stored
 * credential and sent it upstream as `authorization` (`fetchAndProvision`).
 * The ERROR paths already withhold upstream-controlled text
 * (`logRedactedDetail` + `mapFetchError`). A SUCCESSFUL `tools/list` whose
 * valid, sub-`MAX_TOOL_TEXT_BYTES` name / description / schema value / schema
 * KEY reflects that credential otherwise flows through `normalizeMcp` →
 * `store.provisionSource` → the shared catalog → `search`/`describe` → the
 * agent, UNREDACTED. A reflecting server is exactly the F1 threat, on the
 * success path.
 *
 * ## The shape: canonicalize-then-check, NOT a denylist of encodings
 *
 * `redactionTokens(onboardingAuth)` derives the SAME token set the shared
 * redaction primitive uses (`packages/sdk/pipeline/upstream.ts`): the full
 * header value plus each whitespace-separated segment long enough to be a
 * real secret. We match the credential VALUE itself, not a list of manglings.
 * A server that TRANSFORMS the secret before echoing (base64, url-encode,
 * split across fields) gets past this — that is a documented residual, a
 * narrower threat than a plain reflection, and adding per-encoding patterns
 * is the denylist whack-a-mole `~/.claude/rules/adversarial-convergence.md`
 * forbids. The structural guarantee is elsewhere: the credential lives only
 * in this request's scope and is never persisted (§9.2).
 *
 * The whole raw response is walked — every string value and every object key,
 * recursively — because a reflected credential can land in any of them, and a
 * key is as agent-visible as a value once it is a schema property name.
 */
function reflectsCredential(rawTools: readonly unknown[], tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const matches = (text: string): boolean => tokens.some((token) => text.includes(token));
  const stack: unknown[] = [...rawTools];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === "string") {
      if (matches(node)) return true;
    } else if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        // The KEY is scanned as well as the value: a reflected credential
        // used as a schema property name reaches `describe` and the agent
        // exactly as a value would.
        if (matches(key)) return true;
        stack.push(value);
      }
    }
  }
  return false;
}

/**
 * Reduces a URL to the operator-safe form `origin + path`: userinfo,
 * query, and fragment are all stripped.
 *
 * Every one of those three can carry a credential — `user:pass@host`,
 * `?token=…`, `#access_token=…` — and a stored url reaches an
 * operator-facing refusal frame verbatim on a later revalidation failure.
 * A refusal must never be the channel that echoes a secret an operator once
 * put in a url (§9.2). Intake rejects userinfo outright (see
 * `isValidHttpUrl`), so on the happy path there is nothing to strip; this is
 * the belt-and-braces render used wherever a url — stored or supplied —
 * crosses into a message a human reads.
 *
 * Falls back to the fixed placeholder when the value does not parse as a
 * URL at all, rather than interpolating raw unparseable bytes.
 */
function sanitizeUrlForOperator(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "<unparseable url>";
  }
  return `${parsed.origin}${parsed.pathname}`;
}

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
 * interpolates a secret OR any upstream-controlled text: the only fields
 * that reach a message are the namespace, the prefix, and the url rendered
 * origin+path (`sanitizeUrlForOperator`). The upstream's own error text — the
 * one place a hostile server could echo a credential we sent (F1) — is
 * NEVER forwarded; it is logged daemon-side, credential-redacted, and the
 * client is told a fixed category instead (`mapFetchError`).
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
  /**
   * DAEMON-side operator log. The onboarding fetch failure detail — which is
   * upstream-controlled text (§9.2, F1) — is written here, credential-
   * redacted, and NEVER forwarded to the client. Absent in unit tests that
   * do not assert on the log; present on the real connection path where
   * `connection.ts` supplies the daemon's own `log`.
   */
  log?: (line: string) => void;
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

/**
 * True iff `value` parses as an http(s) URL that carries NO credential in
 * itself — no `user:pass@` userinfo.
 *
 * A url with userinfo is an operator error worth a clear refusal, not a
 * value to accept and later echo: the secret belongs in
 * `CONDUIT_ADD_SECRET`, which travels as a request-scoped header the daemon
 * reveals and forgets, never in the url, which is stored as the source's
 * `location` and reappears verbatim in a later revalidation-failure frame.
 * Rejecting it at intake is both the §9.2 credential-in-url defense and the
 * more correct behavior — a url is an address, not a place to hide a token.
 *
 * `username`/`password` are checked rather than a substring scan for `@`:
 * the WHATWG URL parser has already located the authority's userinfo
 * component, so this asks the parsed structure the exact question instead of
 * pattern-matching the raw string.
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

/**
 * Maps a `fetchTools` rejection to the operator-facing refusal line —
 * a FIXED category per error kind, never the upstream's own message text.
 *
 * ## Why the upstream text can never reach the client (F1, the §9.2 line)
 *
 * The `cap` and `protocol` arms used to interpolate `cause.message`. That
 * message is an `McpClientError` whose text embeds the upstream server's own
 * JSON-RPC error string (`mcp-client.ts`'s `describeRpcError` on the
 * `initialize` and `tools/list` rejection paths). On THIS onboarding path
 * the daemon has already revealed the stored credential and sent it upstream
 * (`fetchAndProvision` below), so a malicious upstream that echoes the
 * `Authorization` value back inside its error message would have that value
 * flow verbatim into the `ProvisionRefused` frame and out to the add-mcp
 * client — a stored-credential exfiltration.
 *
 * `mcp-client.ts`'s own comment notes that upstream text is only made safe
 * by `upstream.ts`'s serve-time sanitization, and Task 8 moved this fetch
 * daemon-side where that sanitization does NOT run. The fix is not to
 * re-run a redaction over the client-bound text (a denylist over unbounded
 * upstream output never converges — see
 * `~/.claude/rules/adversarial-convergence.md`) but to STOP forwarding it:
 * the client is told a fixed category naming its next move, and no byte of
 * upstream-controlled text crosses to it.
 *
 * The operator who runs the daemon still gets the detail — logged
 * daemon-side and credential-redacted (`logRedactedDetail`), correlated by
 * the namespace and url the refusal already names — so nothing debuggable is
 * lost; it is simply disclosed to the daemon's own log rather than to an
 * arbitrary add-mcp caller.
 *
 * The url is rendered origin+path (`sanitizeUrlForOperator`) as a second
 * belt to the intake userinfo rejection.
 */
function mapFetchError(cause: unknown, url: string): string {
  const safeUrl = sanitizeUrlForOperator(url);
  const unreachable = `[conduit add-mcp] upstream unreachable at ${safeUrl}; nothing was written. Re-run when reachable.`;
  if (!(cause instanceof McpClientError)) {
    return unreachable;
  }
  switch (cause.kind) {
    case "http_status":
      if (cause.status === 401 || cause.status === 403) {
        return `[conduit add-mcp] upstream requires authorization (HTTP ${cause.status}): set CONDUIT_ADD_SECRET; nothing was written.`;
      }
      // Fixed category — the upstream's status is a small integer we chose to
      // surface, never its free-text body.
      return `[conduit add-mcp] the upstream rejected the request during onboarding (HTTP ${cause.status ?? "error"}); nothing was written. See the daemon log for the upstream's detail.`;
    case "cap":
      // The upstream's response exceeded the onboarding size/tool cap. Fixed
      // wording — cause.message would carry upstream-echoed text (F1).
      return `[conduit add-mcp] the upstream's onboarding response exceeded a size/tool limit; nothing was written. See the daemon log for the upstream's detail.`;
    case "protocol":
      // A malformed/hostile JSON-RPC exchange. cause.message embeds the
      // server's own error string, which is where a credential echo would
      // ride (F1) — so it is logged daemon-side, never returned.
      return `[conduit add-mcp] the upstream returned an invalid MCP handshake or tools/list during onboarding (protocol error); nothing was written. See the daemon log for the upstream's detail.`;
    case "timeout":
      return `[conduit add-mcp] upstream did not complete within the onboarding budget; nothing was written.`;
    case "network":
      return unreachable;
    default: {
      // Exhaustiveness: a future sixth kind is a COMPILE error here. The
      // runtime return stays the fixed fallback so a stale build still
      // emits a self-describing line — and, being fixed, still forwards no
      // upstream text.
      const _exhaustive: never = cause.kind;
      void _exhaustive;
      return unreachable;
    }
  }
}

/**
 * Writes the onboarding-failure detail to the DAEMON's log, credential-
 * redacted (F1). This is the ONLY place the upstream's own error text is
 * disclosed — to the operator who runs the daemon, never to the add-mcp
 * client — and even here every token derivable from the credential that was
 * sent upstream is replaced with `[redacted]` first, because a hostile
 * upstream echoes what we sent.
 *
 * `onboardingAuth` is the exact value put on the request's `authorization`
 * header, so its redaction tokens are precisely what a reflecting upstream
 * could have bounced back into `cause.message`. When no credential was sent
 * (unauthenticated onboarding) there is nothing to redact and the detail is
 * logged as-is — still only to the daemon log.
 *
 * Best-effort and total: a `log` sink is absent in some unit tests, and a
 * failure to write a diagnostic must never turn a clean refusal into a
 * throw.
 */
/**
 * Normative-local (CX5): byte cap on the sanitized upstream detail in a log
 * line. Larger than the 64-byte version-string cap — a log line legitimately
 * carries more diagnostic text — but bounded so one hostile upstream message
 * cannot dominate the daemon log.
 */
const LOG_DETAIL_MAX_BYTES = 512;

/**
 * Encodes already-redacted upstream detail as ONE printable log line (CX5).
 *
 * The operator is told to inspect the daemon log, so the upstream's own error
 * text — C0/C1 controls, `ESC`, `CR`, `LF`, CSI/OSC sequences intact — would
 * otherwise be interpreted by `tail`/`cat`: forged log records, cursor moves,
 * terminal manipulation. Same allowlist shape as `sanitizeVersionForDisplay`
 * (printable ASCII survives, everything else is dropped), so no encoding of a
 * control character gets through and the residue of a stripped sequence
 * (`[2J` after its `ESC` is removed) is inert. The result is capped by UTF-8
 * BYTES; it runs on text that is already credential-redacted, so the cap can
 * never bisect a redaction.
 *
 * Applied per input the caller has already redacted — redact THEN sanitize —
 * mirroring `sanitizeUpstreamText`'s order.
 */
function sanitizeDetailForLog(redacted: string): string {
  const printable = redacted.replace(/[^\x20-\x7e]/g, "");
  if (printable.length <= LOG_DETAIL_MAX_BYTES) return printable;
  // Printable ASCII is one byte per character, so `.length` IS the byte length
  // and no multi-byte character can be bisected. The `...` marker is ASCII, so
  // the result stays pure printable-ASCII and at most `LOG_DETAIL_MAX_BYTES`.
  return `${printable.slice(0, LOG_DETAIL_MAX_BYTES - 3)}...`;
}

function logRedactedDetail(
  log: ((line: string) => void) | undefined,
  namespace: string,
  url: string,
  onboardingAuth: string | undefined,
  cause: unknown,
): void {
  if (log === undefined) return;
  const raw = cause instanceof Error ? cause.message : String(cause);
  const tokens = onboardingAuth !== undefined ? redactionTokens(onboardingAuth) : [];
  // Redact first, THEN encode to one printable capped line (CX5).
  const detail = sanitizeDetailForLog(redactTokens(raw, tokens));
  try {
    log(
      `[conduitd] Onboarding fetch failed: upstream detail withheld from client. Context: {namespace: ${namespace}, url: ${sanitizeUrlForOperator(url)}, cause: ${detail}}`,
    );
  } catch {
    // A diagnostic write must never fail the refusal it is describing.
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
    ...(deps.log !== undefined ? { log: deps.log } : {}),
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
    ...(deps.log !== undefined ? { log: deps.log } : {}),
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
  log?: (line: string) => void;
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
  const safeUrl = sanitizeUrlForOperator(url);

  let rawTools: unknown[];
  try {
    rawTools = await args.fetchTools(
      url,
      args.onboardingAuth !== undefined ? { authorization: args.onboardingAuth } : undefined,
    );
  } catch (cause) {
    // F1: the upstream's own error text is disclosed to the DAEMON log
    // (credential-redacted), never to the client; the client gets a fixed
    // category from `mapFetchError`.
    logRedactedDetail(args.log, namespace, url, args.onboardingAuth, cause);
    throw new ProvisionRefused(mapFetchError(cause, url));
  }

  // The third onboarding bound (§2.2), alongside `MAX_RESPONSE_BYTES` and
  // `MAX_TOOLS` in `mcp-fetch.ts`: neither of those bounds ONE tool's text,
  // so this is checked here, still BEFORE any write. The index localizes the
  // fault for the operator without forwarding a byte of upstream text.
  const oversizeIndex = findOversizeToolText(rawTools);
  if (oversizeIndex !== undefined) {
    throw new ProvisionRefused(
      `[conduit add-mcp] upstream at ${safeUrl} advertised a tool whose name or description ` +
        `exceeds the ${MAX_TOOL_TEXT_BYTES}-byte per-tool limit (tool index ${oversizeIndex}); ` +
        `nothing was written.`,
    );
  }

  // CX1 (§9.2): when a credential was sent, refuse a response that reflects it
  // BEFORE `normalizeMcp` and BEFORE any write. A reflecting upstream can echo
  // the `authorization` value in a tool name, description, schema value, or
  // schema KEY, from where it would flow unredacted to the agent. The refusal
  // names NO upstream bytes and NO tool index — the index itself could echo —
  // and we REJECT rather than redact-and-store, which would silently change
  // the tools' semantics. See `reflectsCredential` for the canonicalize-then-
  // check shape and the documented transform residual.
  if (args.onboardingAuth !== undefined) {
    const tokens = redactionTokens(args.onboardingAuth);
    if (reflectsCredential(rawTools, tokens)) {
      throw new ProvisionRefused(
        `[conduit add-mcp] upstream at ${safeUrl} reflected credential material in its ` +
          `tools/list; nothing was written.`,
      );
    }
  }

  let tools: Awaited<ReturnType<typeof normalizeMcp>>;
  try {
    tools = normalizeMcp({ namespace, tools: rawTools });
  } catch (cause) {
    // F1: `normalizeMcp`'s detail is derived from the upstream's tools/list
    // BODY — upstream-controlled text that could echo the credential we sent
    // (a reflecting server can put it in a tool description). So it is
    // withheld from the client and logged daemon-side, redacted, exactly
    // like the fetch-failure detail above.
    logRedactedDetail(args.log, namespace, url, args.onboardingAuth, cause);
    throw new ProvisionRefused(
      `[conduit add-mcp] upstream at ${safeUrl} returned an invalid tools/list; nothing was ` +
        `written. Re-run when the upstream is fixed. See the daemon log for the upstream's detail.`,
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
