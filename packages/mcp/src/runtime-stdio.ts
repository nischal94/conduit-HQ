import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonUnavailable, daemonRequest } from "./daemon/client.js";
import type { RpcRequest, RpcResponse } from "./daemon/rpc.js";
import { DEFAULT_CONDUIT_DIR } from "./env.js";
import type { CatalogListing } from "./payloads.js";
import { createConduitMcpServer, type DaemonCall, deadlineForRequest } from "./server.js";

// The per-round-trip budget is KIND-DEPENDENT and lives with the
// constants it must stay ordered against — see `deadlineForRequest` and
// the ordering constraint documented at `EXECUTE_CLIENT_DEADLINE_MS` in
// server.ts. A single flat budget here was a correctness defect: it
// bounded the whole round trip below the daemon's own worst legal answer
// time for an execute, so routine slowness surfaced as §5 ambiguity.

/**
 * Starts the Conduit MCP server on stdio. Shared by the `conduit-mcp` bin
 * and `conduit serve`.
 *
 * Since Task 6 (§17, deviation D-B1) this process opens NO database. The
 * daemon is the sole opener of `~/.conduit/conduit.db`; everything this
 * server needs — the catalog listing, executions, execution lookups —
 * arrives over the capability-scoped `serve` RPC set. Two consequences
 * worth stating, because they are the point of the change:
 *
 * - **§9.2 strengthens.** Credentials resolve inside the daemon and never
 *   enter the process the agent talks to. This holds only because §3.3.1
 *   forbids credential-returning RPCs — the split by itself would move
 *   plaintext outward, not inward.
 * - **Hot reload arrives.** A source added via `add-mcp` is visible to
 *   every running `serve` on its next `tools/list`, with no restart,
 *   because the daemon is the only writer and this process caches
 *   nothing.
 */
export interface RunStdioServerOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * The daemon state directory. Defaults to `DEFAULT_CONDUIT_DIR`, which
   * derives from the authenticated OS uid (design §3.1) — production
   * NEVER passes this.
   *
   * It is a CODE-level parameter, deliberately not an environment
   * variable: the state directory determines which database is served
   * and which socket is trusted, so a client-settable env override would
   * hand exactly the control §9.3's default-only decision removes. Tests
   * that need a throwaway daemon pass it here, the same way an operator
   * starting a daemon BY HAND is the only supported way to point one
   * elsewhere (design §3.1 on `CONDUIT_MASTER_KEY`).
   */
  stateDir?: string;
}

export async function runStdioServer(opts: RunStdioServerOptions = {}): Promise<void> {
  // M8: stdout carries protocol frames ONLY. Route console.* to stderr as
  // defense-in-depth; the spawned-bin stdout-purity test pins the invariant.
  // UNCHANGED by the daemon conversion, and deliberately still FIRST: the
  // daemon client below writes diagnostics of its own, and every one of
  // them must already be on the safe side of this redirect.
  const toStderr = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(" ")}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.error = toStderr;

  const env = opts.env ?? process.env;

  /**
   * The `serve` daemon seam. Auto-start lives inside `daemonRequest`, so
   * "no daemon at boot" is an ordinary first call rather than a special
   * path (design §3.3: "daemon absent at boot is a first-class path").
   */
  const stateDir = opts.stateDir ?? DEFAULT_CONDUIT_DIR;
  const daemon: DaemonCall = (request: RpcRequest): Promise<RpcResponse> =>
    daemonRequest({
      stateDir,
      role: "serve",
      request,
      deadlineMs: deadlineForRequest(request),
    });

  // Startup diagnostics come from the daemon's own handshake-backed view,
  // not from this process's environment. That is the §9.3 default-only
  // decision made visible: a client-side CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS
  // does NOT transfer to the daemon, so reporting the client's env here
  // would tell the operator the opposite of what is in force. A client
  // whose env sets CONDUIT_DB is refused outright at handshake, which
  // surfaces below as a startup failure rather than a silent mismatch.
  let listing: CatalogListing;
  try {
    // Through `daemonRequest` directly rather than the `DaemonCall` seam:
    // the seam is deliberately kind-agnostic (it is what `server.ts`
    // injects), while this one startup read wants the typed payload the
    // generic gives, and it is issued before the server exists anyway.
    const response = await daemonRequest({
      stateDir,
      role: "serve",
      request: { kind: "catalog.listing" },
      deadlineMs: deadlineForRequest({ kind: "catalog.listing" }),
    });
    if (response.kind !== "result") {
      // A refusal here is terminal and worth the daemon's own words:
      // `refused-custom-db` is the common one (§9.3 item 3) and it names
      // the exact fix. Startup-error compatibility is by CODE and
      // actionable guidance, not byte-identity (design §5).
      const detail =
        response.kind === "error"
          ? `${response.code}: ${response.message}`
          : `daemon returned ${response.kind}`;
      console.error(`[ConduitMcp] Cannot start: the daemon refused this client. ${detail}`);
      process.exit(1);
    }
    // No cast: `catalog.listing` is typed to its projection. The remaining
    // defensiveness is about VALUES rather than shape — see the
    // `sourceCount` read below, which no longer assumes the field arrived.
    listing = response.payload;
  } catch (error) {
    // DaemonUnavailable already carries the state dir, the deadline, and
    // the path of the daemon log that explains why the child exited —
    // everything the operator needs to act. Anything else is unexpected
    // and printed as-is rather than dressed up.
    console.error(
      error instanceof DaemonUnavailable
        ? error.message
        : `[ConduitMcp] Cannot reach the Conduit daemon: ${
            error instanceof Error ? error.message : String(error)
          }`,
    );
    process.exit(1);
  }

  // A plain `=== 0` since the client's payload seam guards `catalog.listing`
  // structurally: a payload whose `sourceCount` is missing or not a finite
  // number is REFUSED there and never reaches this line, so the branch above
  // took the `response.kind !== "result"` exit. The `typeof` hedge this
  // replaced existed only because the seam guarded `approvals.list` alone,
  // and it substituted "print the onboarding hint" for an answer the daemon
  // never gave — a plausible default in place of a refusal.
  if (listing.sourceCount === 0) {
    console.error("[ConduitMcp] 0 sources in catalog — onboard one with `conduit add-mcp`");
  }
  // Kept for the operator who set the flag on the CLIENT and would
  // otherwise be told nothing: v1 daemons are default-only, so the
  // setting they exported is NOT what the daemon is running under.
  if (env.CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS === "1") {
    console.error(
      "[ConduitMcp] WARNING: CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1 is set in THIS client's " +
        "environment, but the daemon does not inherit it (§9.3 default-only). Set it in the " +
        "daemon's own environment if you truly want private-network egress open — dev/demo only.",
    );
  }

  const server = createConduitMcpServer({ daemon });
  await server.connect(new StdioServerTransport());
}
