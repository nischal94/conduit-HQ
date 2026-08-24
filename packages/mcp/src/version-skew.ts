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
  //
  // The residue of a stripped sequence is left alone DELIBERATELY: removing
  // the ESC from `<ESC>[2J` leaves the literal text `[2J`, which no terminal
  // interprets without its introducer. Stripping escape BODIES too would
  // mean matching known sequence shapes — the denylist-over-unbounded-input
  // shape that never converges, and the one we refuse.
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

/**
 * A once-per-caller skew reporter: an `onHandshake` callback that emits at
 * most ONE line, however many daemon calls flow through it.
 *
 * The "once" is a property of the RETURNED closure, so the caller decides
 * the scope by where it holds the result. Every production caller holds one
 * at MODULE scope, making "once per process" true by construction rather
 * than by the incidental fact that a command entrypoint runs once — a
 * per-invocation flag would silently become "once per invocation" the day
 * anything called the entrypoint twice.
 *
 * A MATCHING handshake leaves the latch unset: the null line is not a
 * report, so a later mismatched daemon (one process outliving a daemon
 * restart) still gets its warning.
 *
 * It reports and returns. Skew never blocks the request that carried the
 * handshake, and nothing here stops or restarts the daemon (spec §4).
 */
export function createSkewReporter(
  write: (line: string) => void,
): (info: { agentVersion: string | undefined }) => void {
  let warned = false;
  return (info) => {
    if (warned) return;
    const line = skewWarningLine(info.agentVersion);
    if (line !== null) {
      warned = true;
      write(line);
    }
  };
}
