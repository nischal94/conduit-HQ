# @conduithq/mcp

A stdio MCP server for Conduit. It spawns as a subprocess of your MCP client
(Claude Desktop, Cursor, or any other client that supports stdio servers) and
exposes exactly two tools — `execute` and `check_execution` — over the real
Conduit SDK pipeline: catalog search/describe, the sandboxed `execute`
workflow, the policy engine, and the credential boundary (§9.2/§9.3). This
package adds no core logic of its own; it is a thin transport shell over
`@conduithq/sdk`.

## Quick start

1. Generate a master key:

   ```bash
   conduit key generate
   ```

   Mints `~/.conduit/master-key` (0600) — the default, file-based path. See
   `packages/cli/README.md`'s `conduit key` section for the full reference
   (refusals, rotation, crash recovery). Managing the key via
   `CONDUIT_MASTER_KEY` instead (containers, custom paths) remains supported —
   use the raw base64-of-32-random-bytes one-liner in that case:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

2. Onboard an upstream MCP source with `conduit add-mcp` (from the
   `@conduithq/cli` package — see `packages/cli/README.md` for the full flag
   reference, `CONDUIT_ADD_SECRET` credential onboarding, and the retarget
   refusal):

   ```bash
   CONDUIT_MASTER_KEY=<your key> \
   node <abs path>/packages/cli/dist/bin.js add-mcp \
     --url https://mcp.example.com/mcp --namespace github --prefix github.acme.prod
   ```

   `add-mcp` fetches the upstream's `tools/list` first and writes NOTHING
   unless the fetch succeeds. Nothing is published to npm yet, so the client
   config snippet below points `command`/`args` at the built file directly:

   ```json
   {
     "mcpServers": {
       "conduit": {
         "command": "node",
         "args": ["<abs path>/packages/mcp/dist/bin.js"]
       }
     }
   }
   ```

   For a default-path key generated via `conduit key generate`, no
   `CONDUIT_MASTER_KEY` entry is needed — the server resolves the key from
   `~/.conduit/master-key` automatically. If you're managing the key via the
   env var instead (containers, custom paths), add it to the `env` block:

   ```json
   "env": { "CONDUIT_MASTER_KEY": "<your key>" }
   ```

   `CONDUIT_DB` is omitted deliberately: Node never expands `~`, so a literal
   `~/.conduit/conduit.db` would be treated as a relative path from the MCP
   client's own working directory (often `/`), and the server fails to start.
   The built-in default already resolves to an absolute path via `homedir()`
   — see the env vars table below. If you need a custom location, use an
   absolute path (e.g. `/Users/you/.conduit/conduit.db`), never `~`.

   `chmod 600` the client config file after editing it if it holds a key via
   the env variant above.

3. Paste the snippet into your client's MCP config (e.g. Claude Desktop's
   `claude_desktop_config.json`), then **restart the client** (see
   Troubleshooting — most MCP clients only load servers at startup).

4. If a call pauses for approval, resume it from a separate process while the
   agent waits:

   ```bash
   # Pre-publish, invoke the built CLI directly (same form as step 2); once
   # published, `conduit approvals …` is the installed alias.
   node <abs path>/packages/cli/dist/bin.js approvals list             # oldest-first queue
   node <abs path>/packages/cli/dist/bin.js approvals approve <execId> # or: deny <execId>
   ```

   See `packages/cli/README.md` for the full `conduit` command reference.

## Env vars

| Var | Meaning | Default |
| --- | --- | --- |
| `CONDUIT_DB` | Path to the SQLite database file. Node does not expand `~` — if you set this yourself, use an absolute path. | `~/.conduit/conduit.db`, resolved via `homedir()` (created on first run, directory mode `0700`) |
| `CONDUIT_MASTER_KEY` | The SecretBox key, **base64 encoding of exactly 32 bytes**. Overrides the key file when set; the process exits nonzero at startup if malformed. | optional when `~/.conduit/master-key` exists (env overrides file) |
| `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` | Set to `1` to allow calls to loopback/private-network upstreams. **Dev/demo only** — prints a loud stderr warning at startup when enabled. | off (fail-closed; §9.3) |
| `CONDUIT_APPROVAL_TTL` | How long a paused execution stays approvable, in **milliseconds**. | `259200000` (72 hours) |

## `--doctor`

Run `conduit-mcp --doctor` (or `node dist/bin.js --doctor`) to validate your
config without going through a client restart loop. It checks, in order: the
master key decodes to 32 bytes, the database opens at `CONDUIT_DB`, how many
sources are in the catalog (with a seeding hint if empty), and whether the
private-egress opt-in is enabled. Each check prints its own pass/fail line to
stderr and the command exits nonzero on the first failure — this is the
troubleshooting doc's first step before touching your MCP client at all.
Note that on a previously-unopened or legacy db, `--doctor` WRITES (canary
bootstrap, file-permission healing) — it is a diagnostic that initializes,
not a read-only check.

## Troubleshooting

- **Tools don't appear in the client.** Most MCP clients only load servers at
  startup. After adding or editing the Conduit entry in your client's config,
  restart the client (or open a new chat, depending on the client). On macOS,
  Claude Desktop's server logs land at
  `~/Library/Logs/Claude/mcp-server-*.log` — check there first.
- **Egress blocked.** By default, calls to loopback/private-network upstreams
  fail closed (§9.3). The agent-visible error deliberately does not name the
  override — an agent should not be taught to ask its human to flip a
  security control. If you're running a local/demo upstream on purpose, set
  `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1` in the server's env.
- **Wrong master key fails at startup, not first use.** A key canary is
  verified during store open, so a well-formed but non-matching key fails
  loud at startup rather than on the first tool call that resolves a
  credential. See `packages/cli/README.md`'s `conduit key` section for
  rotation and crash recovery.
- **A call timed out but may have finished.** MCP clients default to a ~60s
  request timeout, which can race the sandbox's own default wall-clock cap.
  If the client gives up before the response arrives, the execution still
  settles and persists — only the id delivery is lost. Pass a `requestKey`
  when you call `execute` so you can recover the outcome by that key via
  `check_execution` even if you never saw the `executionId`.
- **Back up the database before upgrading.** The store is a single SQLite
  file at `CONDUIT_DB` — copy it, and `~/.conduit/master-key` alongside it
  (a db backup only decrypts under the key that was live when it was taken),
  before upgrading `@conduithq/mcp` or running a schema migration.
- **Upstream compatibility.** v1 calls MCP-over-HTTP upstreams only. Other
  source types fail closed as "not yet callable."
