import { runStdioServer } from "@conduithq/mcp";

/**
 * `conduit serve` — thin adapter over the shared stdio MCP server seam.
 * `runStdioServer` folds the M8 console.*→stderr redirect in as its first
 * runtime action, so "serve over stdio" structurally implies "stdout =
 * protocol frames only". Nothing here touches console.* or process.stdout.
 *
 * Since Task 6 this process opens no database: `runStdioServer` reaches one
 * only through the daemon, over the capability-scoped `serve` RPC set.
 */
export interface ServeOptions {
  /**
   * The daemon state directory. Omitted in production, where
   * `runStdioServer` defaults to the directory derived from the
   * authenticated OS uid (design §3.1).
   *
   * Threaded as a CODE-level parameter and never read from the
   * environment: the state directory selects which database is served and
   * which socket is trusted, so a client-settable env override would hand
   * back exactly the control §9.3's default-only decision removes. The
   * supported way to point at another directory is to start the daemon by
   * hand and tell the client where — which is what the integration suite
   * does, and the same posture `CONDUIT_MASTER_KEY` already takes.
   */
  stateDir?: string;
}

export async function serve(opts: ServeOptions = {}): Promise<void> {
  await runStdioServer({
    env: process.env,
    ...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
  });
}
