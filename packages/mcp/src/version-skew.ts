import { AGENT_VERSION } from "./env.js";

/**
 * Version skew between a CLI client and the daemon it just handshook with.
 *
 * Spec §4: skew is diagnosed LOUDLY and never acted on automatically. This
 * module produces one stderr line and nothing else — no client kills or
 * restarts the daemon on its own, and skew never blocks a request.
 * `protocol` remains the wire-compatibility gate; `agentVersion` is a
 * diagnostic, so a build mismatch is a warning about what an operator may
 * want to do, not a refusal.
 *
 * The daemon-supplied version string is UNTRUSTED DISPLAY INPUT. It arrives
 * over a socket and lands on a terminal, so it is sanitized before it is
 * ever printed.
 */

/** Printable-ASCII only, capped: a stale daemon must not get terminal-escape injection. */
export function sanitizeVersionForDisplay(v: string): string {
  // An ALLOWLIST, not a denylist of known-bad escapes: everything outside
  // printable ASCII goes, so no encoding of a control character survives.
  return v.replace(/[^\x20-\x7e]/g, "").slice(0, 64);
}

/**
 * One stderr line when the daemon's build differs from this client's, null
 * when they match. The ABSENT arm names the signal path: a daemon old
 * enough to omit agentVersion also predates the control capability, so
 * `conduit daemon stop` cannot reach it (spec §4).
 */
export function skewWarningLine(daemonVersion: string | undefined): string | null {
  if (daemonVersion === AGENT_VERSION) return null;
  if (daemonVersion === undefined) {
    return (
      `conduit: the running daemon is an older build (it reports no version) and predates ` +
      `the control API. Stop it by signal — find the process running with --daemon and send ` +
      `it SIGTERM (safe: paused approvals are durable) — and the next command starts a ` +
      `matching daemon.`
    );
  }
  return (
    `conduit: daemon is ${sanitizeVersionForDisplay(daemonVersion)}, this CLI is ` +
    `${AGENT_VERSION} — run \`conduit daemon stop\`; the next command auto-starts a ` +
    `matching daemon.`
  );
}
