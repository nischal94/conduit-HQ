// Imports only the dependency-free version.ts, so the guard loads on any Node.
import { INSTALL_NOTES_URL } from "./version.js";

export function isSupportedNode(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return (major === 22 && minor >= 12) || major === 24;
}

export function UNSUPPORTED_NODE_LINE(version: string): string {
  return `[conduit] Node ${version} is not supported: this preview runs on Node 22 (22.12.0 or later) or Node 24. Switch to a supported Node, then install the tarball again (a version manager keeps global packages per Node version). Notes: ${INSTALL_NOTES_URL}\n`;
}
