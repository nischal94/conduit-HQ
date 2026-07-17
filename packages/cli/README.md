# @conduithq/cli

The minimal `conduit` command (spec §17 step 3). Three subcommands over the
same SDK pipeline and security boundary the `/mcp` server uses — this package
adds no core logic of its own; every command calls a shared seam:

| Command | What it does | Seam it calls |
| --- | --- | --- |
| `conduit serve` | Runs the stdio MCP server (identical to `conduit-mcp`). | `runStdioServer` (`@conduithq/mcp`) |
| `conduit add-mcp` | Onboards or re-syncs an upstream MCP source. | `provisionSource` (`@conduithq/sdk`) |
| `conduit approvals list\|approve\|deny` | The human approval queue. | `listPaused` + `createApprovalRuntime` |

Nothing is published to npm yet — run the built file directly:
`node <abs path>/packages/cli/dist/bin.js <command>` (build with `npm run build`
in this package). `--help` and `--version` are available at the top level.

## Quick start

1. Generate a master key (base64 encoding of 32 random bytes):

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

2. Onboard an upstream MCP source:

   ```bash
   CONDUIT_MASTER_KEY=<your key> \
   conduit add-mcp --url https://mcp.example.com/mcp --namespace github --prefix github.acme.prod
   ```

   `add-mcp` fetches the upstream's `tools/list` first (5s timeout) and writes
   NOTHING unless the fetch succeeds — a dead upstream leaves zero rows. On
   success it prints a risk-class count summary (e.g.
   `seeded 12 tools under github.acme.prod: 8 safe (auto-allow), 3 review (approval), 1 destructive (approval)`),
   stating the fail-closed §10.2 policy defaults. No policy rows are written.

   - **Credential (optional):** supply it via the `CONDUIT_ADD_SECRET` env
     var — never a flag (keeps it out of argv and shell history). It is
     SecretBox-encrypted at rest and never appears in any output. Re-running
     `add-mcp` without `CONDUIT_ADD_SECRET` PRESERVES an existing credential;
     `--clear-credential` is the only deliberate deauth.
   - **Re-sync:** re-running with the same `--url` refreshes the tool catalog
     (upstream adds/removes picked up). Changing `--url` or `--prefix` for an
     existing namespace is refused unless you pass `--replace` — retargeting
     an operator's trust is a conscious act, and manual policy overrides
     (keyed by tool name) carry over to the new upstream.
   - **Rows onboarded before this release:** the upstream's original wire
     name is now stored at normalize time and used at serve time to call
     tools whose names don't survive namespacing byte-for-byte (e.g. a
     hyphenated upstream name). A source onboarded before this change won't
     have that stored name — one `add-mcp --replace` re-sync against the
     same `--url` fully repairs it; nothing else is needed.
   - `--json` emits `{safe, review, destructive}` + `credential: present|absent`.
   - **`--namespace` vs `--prefix`:** the agent-facing tool name is always
     `<namespace>.<tool>` (e.g. `github.get_me`) — `--namespace` is the tool
     path, not `--prefix`. `--prefix` is a separate, per-connection unique
     identifier (surfaced in onboarding output and re-sync/retarget checks);
     it does not appear in the tool name a client calls.

3. Serve the catalog to an MCP client (Claude Desktop, Cursor, …):

   ```json
   {
     "mcpServers": {
       "conduit": {
         "command": "node",
         "args": ["<abs path>/packages/cli/dist/bin.js", "serve"],
         "env": {
           "CONDUIT_MASTER_KEY": "<your key>"
         }
       }
     }
   }
   ```

   `chmod 600` the client config file after editing it — it now holds your
   master key. Restart the client after config changes (most MCP clients only
   load servers at startup). `conduit serve` and the `conduit-mcp` bin run the
   same shared startup — stdout carries protocol frames ONLY; every diagnostic
   goes to stderr (invariant M8, pinned on both doors).

4. When a call pauses for approval, decide it from your terminal while the
   agent waits:

   ```bash
   conduit approvals list                 # oldest-first queue: id · tool · waiting-since · expiry
   conduit approvals approve <execId>     # or: deny <execId>
   ```

   - A row past its TTL shows `EXPIRED (finalizes on next resume)` — the label
     is computed at display time; `list` never writes.
   - `approve`/`deny` print the resulting outcome status. On `expired` (either
     verb) the CLI states explicitly that no tool call was made. `conflict`
     and `failed` exit non-zero.
   - If the approved script pauses again on a NEW approval (chained
     `require_approval` calls), the CLI says so, names the tool waiting, and
     points you back to `approvals list`.

   This replaces the interim `scripts/approve-demo.mjs` flow.

## Env vars

Shared with `@conduithq/mcp` (one `resolveEnv` implementation):

| Var | Meaning | Default |
| --- | --- | --- |
| `CONDUIT_DB` | Path to the SQLite database file. Node does not expand `~` — if you set this yourself, use an absolute path. | `~/.conduit/conduit.db`, resolved via `homedir()` (created on first run, directory mode `0700`) |
| `CONDUIT_MASTER_KEY` | The SecretBox key, **base64 encoding of exactly 32 bytes**. Required — commands exit non-zero at startup if missing or malformed. | none (required) |
| `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` | Set to `1` to allow calls to loopback/private-network upstreams. **Dev/demo only.** Applies to `serve` AND `approvals approve` (both doors compose the same §9.3 egress boundary). | off (fail-closed; §9.3) |
| `CONDUIT_APPROVAL_TTL` | How long a paused execution stays approvable, in **milliseconds**. | `259200000` (72 hours) |
| `CONDUIT_ADD_SECRET` | `add-mcp` only: the upstream credential to store for this source. Read from env, never a flag; never echoed. | none (optional — unauthenticated sources are legitimate) |

## Troubleshooting

- **`add-mcp` says "upstream unreachable" / "invalid tools/list".** Nothing
  was written — the store is only touched after a successful fetch AND
  normalize. Fix the upstream (or the URL) and re-run; the command is
  idempotent.
- **Egress blocked on `approve`.** Approvals compose the same fail-closed
  §9.3 boundary as the server. The agent-visible error deliberately does not
  name the override. For a local/demo upstream, set
  `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1` in the env of the process doing the
  approving (and of `serve`).
- **Tools don't appear in the client after `add-mcp`.** The server hydrates
  its catalog per request, but most MCP clients only load servers at startup —
  restart the client. For deeper checks, `conduit-mcp --doctor` validates the
  key/db/catalog without a client restart loop.
- **A call timed out but may have finished.** Pass a `requestKey` to
  `execute` so the outcome is recoverable via `check_execution` even if the
  id delivery was lost (see `packages/mcp/README.md`).
- **Back up the database before upgrading.** The store is a single SQLite
  file at `CONDUIT_DB` — copy it before upgrading or running a migration.
