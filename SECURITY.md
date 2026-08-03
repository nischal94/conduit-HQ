# Security Policy

Conduit is a credential boundary: agents call tools through it precisely so
that secrets, policy, and egress control live in one audited place. We treat
vulnerability reports against Conduit with the same seriousness we ask you
to place in it.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately via
[GitHub private vulnerability reporting](../../security/advisories/new)
("Report a vulnerability" on the repo's Security tab). Include what you can:
affected package (`@conduithq/sdk`, `@conduithq/mcp`, `@conduithq/cli`),
reproduction steps, and impact as you understand it.

You can expect:

- **Acknowledgement within 72 hours.**
- An assessment and expected timeline within 7 days.
- Credit in the fix's release notes if you want it (say so in the report).

Please give us reasonable time to ship a fix before public disclosure.

## Scope

Especially interesting reports (these break invariants the spec promises):

- **Credential-boundary breaks (spec §9.2):** any path that lets sealed
  secrets reach the sandbox heap, agent-authored code, the agent, or the
  model.
- **SSRF / egress-policy bypasses (spec §9.3):** reaching private address
  space through the upstream caller despite the fail-closed default.
- **Sandbox escapes or resource-limit bypasses (spec §16).**
- **Policy-engine bypasses (spec §10):** executing a blocked or
  approval-gated tool without the gate firing.
- **Trace redaction failures (spec §11):** secret material persisted
  unredacted.

Out of scope: vulnerabilities requiring an already-compromised host account
(Conduit's threat model is the agent, not the operator), and issues in
upstream MCP servers themselves.

## Supported versions

Pre-1.0: only the latest release / `main` receives security fixes.
