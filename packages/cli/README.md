# @conduithq/cli

The minimal `conduit` command (spec §17 step 3).

**Most subcommands open no database.** A background daemon owns
`~/.conduit/conduit.db`, and `serve`, `add-mcp` and `approvals` are thin
clients of it over a Unix socket, auto-starting one if none is running. See
[The daemon](../mcp/README.md#the-daemon) for lifecycle, stopping, and the
refusals you may see.

`conduit key` is the deliberate exception: it still opens the store directly,
because rotation is stop-first and cannot ask the daemon to re-encrypt the
database out from under itself. It excludes the daemon with a kernel lock
instead (see [Rotation walkthrough](#rotation-walkthrough)).

| Command | What it does | How it reaches the store |
| --- | --- | --- |
| `conduit serve` | Runs the stdio MCP server (identical to `conduit-mcp`). | Daemon client (`execute`, `check_execution` reads) |
| `conduit add-mcp` | Onboards or re-syncs an upstream MCP source. | Daemon client (`source.provision`) — the credential-bearing fetch runs daemon-side |
| `conduit approvals list\|approve\|deny` | The human approval queue. | Daemon client (`approvals.list`, `approvals.resume`) |
| `conduit key generate` | Mints the master key. | Direct store, under the maintenance lock |
| `conduit key rotate` | Rotates the master key. | Direct store, under the maintenance lock; re-seal via `reencryptSecrets` (`@conduithq/sdk`) |

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

   The **daemon** fetches the upstream's `tools/list` first (5s timeout) and
   writes NOTHING unless the fetch succeeds — a dead upstream leaves zero
   rows. The CLI itself never opens the store, never performs the fetch, and
   never sees a stored credential: it sends the request and renders the
   answer. On success it prints a risk-class count summary (e.g.
   `seeded 12 tools for connection github.acme.prod (namespace github): 8 safe (auto-allow), 3 review (approval), 1 destructive (approval)`),
   stating the fail-closed §10.2 policy defaults. No policy rows are written.

   - **Credential (optional):** supply it via the `CONDUIT_ADD_SECRET` env
     var — never a flag (keeps it out of argv and shell history). It travels
     once from the CLI to the daemon, which performs the authenticated fetch
     and seals it at rest; no response field and no log line ever carries it
     back. Re-running `add-mcp` without `CONDUIT_ADD_SECRET` PRESERVES an
     existing credential; `--clear-credential` is the only deliberate deauth.
     A re-sync reuses the stored credential **only when the `--url` is
     unchanged** — retargeting to a new url while a credential exists is
     refused outright (see Re-sync below), because a stored secret is bound
     to the host it was issued for and is never sent to a different one.
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
   - **If the daemon connection drops after your decision was sent**, the
     outcome is genuinely unknown — it may or may not have applied. The CLI
     says so, prints no `approved`/`denied` line, and exits non-zero. Do not
     retry it: run `conduit approvals list` to see whether the execution is
     still awaiting a decision. A retried decision could apply a second time.

   This replaces the interim `scripts/approve-demo.mjs` flow.

## Env vars

Shared with `@conduithq/mcp` (one `resolveEnv` implementation).

**Which process reads them depends on the command**, and after the daemon
conversion the answer is simpler than it used to be: **`conduit key` is the
only command that still reads `CONDUIT_DB` / `CONDUIT_MASTER_KEY` from its own
environment**, because it is the only one that still opens the database
directly (deliberately — rotation is stop-first, see below).

`serve`, `approvals` and `add-mcp` are all **daemon clients**: they open no
store, and the daemon reads these variables instead. A client's environment
does not reach an auto-started daemon at all — the daemon's environment is
*constructed*, so every `CONDUIT_*` is stripped. To set one for the daemon,
start it by hand (`conduit-mcp --daemon`) with the variable in its own
environment.

| Var | Meaning | Default |
| --- | --- | --- |
| `CONDUIT_DB` | Path to the SQLite database file. **Read only by `conduit key`.** `serve`/`approvals`/`add-mcp` reach the daemon, which serves exactly the default database (§9.3) and discards any inherited value — a `serve` client whose environment sets it gets a typed `refused-custom-db` handshake refusal and exits non-zero, and `key rotate` refuses outright when it is set. Node does not expand `~` — use an absolute path. | `~/.conduit/conduit.db`, resolved via `homedir()` (created on first run, directory mode `0700`) |
| `CONDUIT_MASTER_KEY` | The SecretBox key, **base64 encoding of exactly 32 bytes**. **Read by the daemon and by `conduit key`** — not by `serve`, `approvals` or `add-mcp`, none of which open a store. A client's value never transfers to an auto-started daemon; set it for a daemon you start by hand, or use the key file. `key generate` and `key rotate` both refuse when it is set. Malformed values fail startup non-zero. | optional when `~/.conduit/master-key` exists (env overrides file) |
| `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` | Set to `1` to allow calls to loopback/private-network upstreams. **Dev/demo only.** It belongs to the **daemon**, which runs the sandbox and makes every upstream call — including the replay behind `approvals approve`, which no longer resumes in-process. Setting it on a `serve` client prints a stderr warning saying it does not transfer. | off (fail-closed; §9.3) |
| `CONDUIT_APPROVAL_TTL` | How long a paused execution stays approvable, in **milliseconds**. Read by whichever process runs the execution — the daemon. | `259200000` (72 hours) |
| `CONDUIT_ADD_SECRET` | `add-mcp` only: the upstream credential to store for this source. Read from the CLI's env and forwarded to the daemon in the provisioning request — the one secret that legitimately crosses client→daemon, since it is the operator supplying their own data. Never a flag, never echoed back. | none (optional — unauthenticated sources are legitimate) |

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
(fsynced temp file, hard-linked into place, directory fsynced) and prints
(the path shown here is illustrative — the actual output substitutes the
expanded absolute path, e.g. `/Users/you/.conduit/master-key`, not the
literal `~`):

```
[ConduitKey] master key generated at ~/.conduit/master-key (0600).
Next steps:
  1. Your MCP client config no longer needs CONDUIT_MASTER_KEY for default-path setups.
  2. Onboard an upstream: conduit add-mcp --url <url> --namespace <ns> --prefix <prefix>
  3. Stop-first rule: run this BEFORE wiring clients; see packages/cli/README.md.
```

### Rotation walkthrough

Rotation is **stop-first**, and this is now enforced by the kernel rather
than merely asked of you. `rotate` takes the **maintenance lock
exclusively** for its whole run. A live daemon holds that same lock SHARED
for its entire lifetime, so the two cannot overlap in either order:

- **Daemon running → rotate refuses**, immediately and non-blocking, having
  read and written nothing:

  ```
  [ConduitKey] rotate refused: another process owns ~/.conduit — the maintenance lock is held. Last acquired by daemon (pid 4711) at 2026-08-16T12:04:00.000Z (may be stale). rotate is stop-first: stop every conduit process and MCP client (the daemon exits on SIGTERM), then re-run. Nothing was read or written.
  ```

- **Rotation running → a starting daemon exits** `rotation in progress`
  (exit code 4), and clients fail fast rather than spinning. Once rotation
  releases the lock, the next request starts a daemon normally.

The holder line is a lead, not a verdict — hence "may be stale". A daemon
that was SIGKILLed leaves its row behind, so the pid named may already be
gone.

This replaces the old write-lock preflight, which asked "is the database
busy right now?" — a liveness *query*, and one that could not close the
window in which an unrelated client auto-started a daemon between the check
and the re-seal. The lock closes it by construction.

What the lock still cannot do is reach *inside* an already-running process:
an MCP client holding a stale in-memory copy of the old key is not a
database writer, so stopping your clients remains an operator obligation.

1. **Stop clients and the daemon.** Quit every MCP client, then stop the
   daemon with SIGTERM (`pkill -f 'bin.js --daemon'`). It drains and exits 0.
   If you skip this, `rotate` refuses and names the holder — no harm done.
2. **Rotate:**

   ```bash
   conduit key rotate
   ```

   This re-seals every stored secret under a fresh key inside one write
   transaction, backs up the old key to `master-key.bak`, promotes the new
   key to `master-key` in place, and prints how many secrets were re-sealed.
3. **Restart clients.** Any process started before rotation still holds the
   old key in memory and must be restarted. The next client request
   auto-starts a fresh daemon, which reads the new key.

If rotation reports the database is locked while it holds the maintenance
lock, the writer is **not** a conduit daemon (no daemon can be running) —
find and stop that process, then re-run.

`conduit key generate` sits behind the same lock, because its check for
already-sealed rows inspects the same database.

`rotate` refuses for env-managed keys (`CONDUIT_MASTER_KEY` set) and for
custom `CONDUIT_DB` paths — see "Env-key and custom-path installs" below.

### Crash recovery

Rotation writes the new key to `master-key.next` before touching the db, and
only renames it to `master-key` after the re-seal succeeds. If `master-key.next`
exists, a re-run refuses (pointing you here) — but `master-key.next` existing
does NOT by itself mean a prior rotation crashed. It equally means another
rotation is **currently in flight right now**, on this host or another one
sharing `~/.conduit`, possibly mid-re-seal with `.next` holding the ONLY
persisted copy of its new key.

**Before following any recovery step below, first make ABSOLUTELY SURE no
`conduit key rotate` is currently running anywhere.** Deleting or overwriting
`master-key.next` while a rotation is genuinely in flight destroys that
run's only copy of the new key — its re-seal can then commit against a key
that no longer exists anywhere, permanently sealing the db. Only once you
have confirmed no rotation is running does the manual recovery below apply:

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
  rotation.** Restore the pre-rotation key from the backup — but the key
  alone is not enough: `master-key.bak` only decrypts the db that was live
  when THAT rotation ran, so undoing a completed rotation also requires
  restoring the PAIRED pre-rotation db backup, not just the key file (see
  "Backup rule" below). Restoring the key alone against the current
  (post-rotation) db will not open it.

  ```bash
  cp ~/.conduit/master-key.bak ~/.conduit/master-key
  # AND restore the db backup taken before that same rotation, if undoing:
  cp /path/to/your/pre-rotation-backup/conduit.db ~/.conduit/conduit.db
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
contend for the write lock. Stop the daemon (SIGTERM) first; unlike `rotate`,
this raw `sqlite3` invocation takes no maintenance lock and nothing will
refuse on your behalf.

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
  §9.3 boundary as the server, and for the same reason: the resumed replay
  runs **in the daemon**, not in the `approvals` process. The agent-visible
  error deliberately does not name the override. For a local/demo upstream,
  set `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1` in the **daemon's** environment
  and start it by hand — setting it on the `approvals` or `serve` client has
  no effect.
- **Tools don't appear in the client after `add-mcp`.** A source added
  through one daemon client is visible to every other one with no restart —
  the daemon is the sole owner and caches nothing across requests. So the
  server itself needs no restart; but most MCP *clients* only load servers at
  startup, so restart the client. For deeper checks, `conduit-mcp --doctor`
  asks the running daemon for its source count without a client restart loop.
- **A call timed out but may have finished.** Pass a `requestKey` to
  `execute` so the outcome is recoverable via `check_execution` even if the
  id delivery was lost (see `packages/mcp/README.md`).
- **A wrong master key fails at startup, not first use.** The key canary is
  verified during store open, so a non-matching key (well-formed but wrong)
  is a loud startup error, not a surprise on the first tool call that
  resolves a credential. See `conduit key` above for rotation and recovery.
- **Back up the database before upgrading.** The store is a single SQLite
  file at `~/.conduit/conduit.db` — copy it, and `~/.conduit/master-key`
  alongside it (see "Backup rule" under `conduit key` above), before
  upgrading or running a migration. Stop the daemon first so you copy a
  quiesced file.
