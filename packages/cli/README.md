# @conduithq/cli

The minimal `conduit` command (spec §17 step 3). Subcommands over the same
SDK pipeline and security boundary the `/mcp` server uses — this package adds
no core logic of its own; every command calls a shared seam:

| Command | What it does | Seam it calls |
| --- | --- | --- |
| `conduit serve` | Runs the stdio MCP server (identical to `conduit-mcp`). | `runStdioServer` (`@conduithq/mcp`) |
| `conduit add-mcp` | Onboards or re-syncs an upstream MCP source. | `provisionSource` (`@conduithq/sdk`) |
| `conduit approvals list\|approve\|deny` | The human approval queue. | `listPaused` + `createApprovalRuntime` |
| `conduit key generate\|rotate` | Mints or rotates the master key. | `key-lifecycle` (`@conduithq/sdk`) |

Nothing is published to npm yet — run the built file directly:
`node <abs path>/packages/cli/dist/bin.js <command>` (build with `npm run build`
in this package). `--help` and `--version` are available at the top level.

## Quick start

1. Generate a master key:

   ```bash
   conduit key generate
   ```

   Mints `~/.conduit/master-key` (0600). See `conduit key` below for the full
   reference, refusals, and the env-var alternative.

2. Onboard an upstream MCP source:

   ```bash
   CONDUIT_MASTER_KEY=<your key> \
   conduit add-mcp --url https://mcp.example.com/mcp --namespace github --prefix github.acme.prod
   ```

   `add-mcp` fetches the upstream's `tools/list` first (5s timeout) and writes
   NOTHING unless the fetch succeeds — a dead upstream leaves zero rows. On
   success it prints a risk-class count summary (e.g.
   `seeded 12 tools for connection github.acme.prod (namespace github): 8 safe (auto-allow), 3 review (approval), 1 destructive (approval)`),
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
         "args": ["<abs path>/packages/cli/dist/bin.js", "serve"]
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

   `chmod 600` the client config file after editing it if it holds a key via
   the env variant above. Restart the client after config changes (most MCP
   clients only load servers at startup). `conduit serve` and the
   `conduit-mcp` bin run the same shared startup — stdout carries protocol
   frames ONLY; every diagnostic goes to stderr (invariant M8, pinned on both
   doors).

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
| `CONDUIT_MASTER_KEY` | The SecretBox key, **base64 encoding of exactly 32 bytes**. Overrides the key file when set; commands exit non-zero at startup if malformed. | optional when `~/.conduit/master-key` exists (env overrides file) |
| `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` | Set to `1` to allow calls to loopback/private-network upstreams. **Dev/demo only.** Applies to `serve` AND `approvals approve` (both doors compose the same §9.3 egress boundary). | off (fail-closed; §9.3) |
| `CONDUIT_APPROVAL_TTL` | How long a paused execution stays approvable, in **milliseconds**. | `259200000` (72 hours) |
| `CONDUIT_ADD_SECRET` | `add-mcp` only: the upstream credential to store for this source. Read from env, never a flag; never echoed. | none (optional — unauthenticated sources are legitimate) |

## `conduit key`

Manages the master key that encrypts secrets at rest (`~/.conduit/master-key`,
0600). Run `conduit key --help` for the summary; the full procedures are here.

### `conduit key generate`

Mints a new master key at `~/.conduit/master-key` (0600). Refuses in three
cases, each naming the way forward:

- **`CONDUIT_MASTER_KEY` is set.** Env overrides any key file, so a differing
  file would be a delayed lockout. Unset the env var for a fresh install and
  re-run; an env-key install with a populated db cannot migrate to file keys
  in v1 — keep the env key, or delete the db and re-onboard.
- **The key file already exists.** To change keys, run `conduit key rotate`
  instead.
- **The default db already holds sealed secrets under some other key.** A
  fresh key can't decrypt them. Locate the original key, or delete the db and
  re-onboard.

On the happy path it writes the key file via durable-staging publication
(fsynced temp file, hard-linked into place, directory fsynced) and prints:

```
[ConduitKey] master key generated at ~/.conduit/master-key (0600).
Next steps:
  1. Your MCP client config no longer needs CONDUIT_MASTER_KEY for default-path setups.
  2. Onboard an upstream: conduit add-mcp --url <url> --namespace <ns> --prefix <prefix>
  3. Stop-first rule: run this BEFORE wiring clients; see packages/cli/README.md.
```

### Rotation walkthrough

Rotation is **stop-first**: every conduit process and MCP client must be
stopped before you run it, or the write-lock preflight will refuse.

1. **Stop clients.** Quit/stop every MCP client and any `conduit serve` /
   `conduit-mcp` process pointed at the default db.
2. **Rotate:**

   ```bash
   conduit key rotate
   ```

   This re-seals every stored secret under a fresh key inside one write
   transaction, backs up the old key to `master-key.bak`, promotes the new
   key to `master-key` in place, and prints how many secrets were re-sealed.
3. **Restart clients.** Any process started before rotation still holds the
   old key in memory and must be restarted.

`rotate` refuses for env-managed keys (`CONDUIT_MASTER_KEY` set) and for
custom `CONDUIT_DB` paths — see "Env-key and custom-path installs" below.

### Crash recovery

Rotation writes the new key to `master-key.next` before touching the db, and
only renames it to `master-key` after the re-seal succeeds. If rotation is
interrupted mid-flight, `master-key.next` is left behind and a re-run refuses
(pointing you here). Recover manually:

- **The db won't open, and `master-key.next` is present.** The rename to
  `master-key` never completed but the re-seal did — the db is under the
  *new* key. Promote it:

  ```bash
  mv ~/.conduit/master-key.next ~/.conduit/master-key
  ```

- **The db still opens under the OLD key (`master-key`).** The re-seal never
  committed — `master-key.next` is stale and meaningless. Delete it and
  re-run rotation:

  ```bash
  rm ~/.conduit/master-key.next
  conduit key rotate
  ```

- **Last resort — neither key opens the db, or you need to undo a completed
  rotation.** Restore the pre-rotation key from the backup (only safe if your
  db backup is from before that rotation too — see "Backup rule" below):

  ```bash
  cp ~/.conduit/master-key.bak ~/.conduit/master-key
  ```

Whichever of `master-key` / `master-key.next` actually opens the db is the
live key — that's the one to promote.

### Canary-corruption recovery

Every db carries a small "key canary" row used to verify the key fails loud
at startup rather than at first real decrypt. If the canary row itself is
corrupted (but the master key is otherwise correct — a real secret still
decrypts), the store reports `canary-corruption` at open. Recover by deleting
the canary row and reopening (it's recreated automatically under the
verified key):

```bash
sqlite3 ~/.conduit/conduit.db "DELETE FROM secrets WHERE ref = '__conduit.key-canary.v1__'"
```

### Hygiene re-run

Rotation runs a best-effort `PRAGMA wal_checkpoint(TRUNCATE); VACUUM;` after
promoting the new key, to purge old-key ciphertext left behind in the WAL and
free pages. If that step fails, rotation still succeeds (it's a warning, not
a failure) — re-run it yourself once every conduit process is stopped:

```bash
sqlite3 ~/.conduit/conduit.db "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"
```

Only run this against a stopped db — a live writer can make `VACUUM` block or
contend for the write lock.

### Env-key and custom-`CONDUIT_DB` installs

`conduit key rotate` is defined only for the default db + key-file pair (one
global key file can't serve N dbs, and an env-managed key has no file to
rotate in place). For env-managed keys or a custom `CONDUIT_DB`, the v1
rotation story is **delete-and-re-onboard**: pick a new key, delete the db,
and re-run onboarding. (`conduit key import` — migrating an env-managed
install to file keys — is a deferred v2 path, not built.)

### Backup rule

Always back up `conduit.db` and `master-key` **together, as a pair**. A db
backup only decrypts correctly under the key that was live when it was
taken — an old db backup paired with a post-rotation key (or vice versa)
won't open. If you rotate, your next backup must capture the new key file
alongside the db.

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
- **A wrong master key fails at startup, not first use.** The key canary is
  verified during store open, so a non-matching key (well-formed but wrong)
  is a loud startup error, not a surprise on the first tool call that
  resolves a credential. See `conduit key` above for rotation and recovery.
- **Back up the database before upgrading.** The store is a single SQLite
  file at `CONDUIT_DB` — copy it, and `~/.conduit/master-key` alongside it
  (see "Backup rule" under `conduit key` above), before upgrading or running
  a migration.
