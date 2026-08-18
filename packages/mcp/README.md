# @conduithq/mcp

A stdio MCP server for Conduit. It spawns as a subprocess of your MCP client
(Claude Desktop, Cursor, or any other client that supports stdio servers) and
exposes exactly two tools — `execute` and `check_execution` — over the real
Conduit SDK pipeline: catalog search/describe, the sandboxed `execute`
workflow, the policy engine, and the credential boundary (§9.2/§9.3). This
package adds no core logic of its own; it is a thin transport shell over
`@conduithq/sdk`.

The server **opens no database**. A background daemon (`conduitd`, this same
binary under `--daemon`) owns `~/.conduit/conduit.db`, and the stdio server is
a thin client of it over a Unix socket — see [The daemon](#the-daemon) below.
That is what lets a source added in one process appear in a live session
without a restart, and what keeps §5.5 paused approvals alive between agent
sessions.

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

## The daemon

One process owns the store. `conduitd` holds `~/.conduit/conduit.db`, runs the
sandbox, makes every upstream call, and serves each surface — `conduit serve`,
`conduit approvals`, `conduit add-mcp`, and the default `--doctor` — over a
Unix socket at `~/.conduit/conduitd.sock`.

Everything the daemon owns lives together under the state directory (mode
`0700`):

| Path | What it is |
| --- | --- |
| `~/.conduit/conduit.db` | The store. The daemon is its only writer. |
| `~/.conduit/conduitd.sock` | The endpoint clients connect to. |
| `~/.conduit/conduitd.log` | Daemon stdout/stderr (mode `0600`) — where to look when a client reports it could not start one. |
| `~/.conduit/conduitd-lifecycle.lock.db` | Singleton enforcement: exactly one daemon per state directory. |
| `~/.conduit/conduitd-maintenance.lock.db` | Held SHARED by a live daemon; taken EXCLUSIVE by `conduit key rotate/generate` and `--doctor --offline`. |

The database path is a property of the state directory, not of the ambient
environment — `CONDUIT_DB` does not move it (see the env-var table below).

### Starting: auto-start

You do not normally start a daemon by hand. A client that finds none running
spawns one and completes its request against it. The spawn is deliberately
constrained:

- **The daemon's environment is constructed, not inherited.** The child gets
  exactly one variable — a fixed `PATH` — so no `CONDUIT_*` value and no
  `HOME` from a client's environment reaches it. The executable is resolved
  from the installed package, never through a `PATH` lookup.
- **The spawn budget is one per request.** A client that spawns and still
  cannot reach a daemon fails rather than spawning again; retry loops are how
  fork bombs happen. Waiting on a daemon that is merely still starting does
  not consume the budget.
- **It is detached and logged.** The daemon outlives the client that started
  it, writing to `~/.conduit/conduitd.log`.

To run one in the foreground instead — for debugging, or to give it an
environment an auto-started daemon could not inherit (a `CONDUIT_MASTER_KEY`,
or the private-egress opt-in):

```bash
conduit-mcp --daemon
```

### Stopping: SIGTERM

**SIGTERM (or SIGINT) is the only stop mechanism** — there is no
`conduit daemon stop` command, and no pid file is written. Send the signal to
the `--daemon` process:

```bash
pkill -f 'bin.js --daemon'      # or: kill <pid>
```

A signalled daemon drains rather than dropping work: it stops accepting new
connections, immediately ends connections that never got past the readiness
handshake, and gives work already in flight up to 30 seconds to finish. It
then removes its endpoint (only if the socket on disk is still the one it
bound), releases the maintenance lock and finally the lifecycle lock, and
exits 0. A successor started afterwards reads back the same durable approval
state.

If a daemon is killed outright (SIGKILL, power loss) rather than signalled,
the next daemon to start sweeps what it stranded: executions left durably
`running` are terminalized as `failed` with an ambiguous-outcome cause. They
are **never replayed** — a killed execution's upstream calls may already have
landed, so re-running them would be an unauthorized side effect.

### Two refusals you will see

Both are the daemon exiting on purpose, and both name themselves on stderr:

- **`already running`** (exit code 3) — another daemon already holds the
  lifecycle lock for this state directory. This is the singleton working as
  intended, not an error to route around: the daemon that is already up is
  the one to use. It is what a losing side of a start race prints.
- **`rotation in progress`** (exit code 4) — `conduit key rotate` holds the
  maintenance lock exclusively, so no daemon may open the store beside it.
  Wait for rotation to finish; the next request starts a daemon normally.

A *client* that meets a rotation fails fast with the same reading rather than
spinning against it:

```
[conduit] Daemon unavailable: key rotation is in progress. Context: {stateDir: ~/.conduit} — retry once rotation finishes
```

Refusing costs nothing — the spawn budget is left intact, so the first request
after rotation releases the lock starts a daemon and completes normally.

When a client cannot reach or start a daemon at all, the error names the log
to read:

```
[conduit] Daemon unavailable: no daemon could be reached or started within the deadline. Context: {stateDir: ~/.conduit, deadlineMs: 30000} — see ~/.conduit/conduitd.log for why the daemon exited
```

### Capacity

The daemon runs at most 4 executions concurrently with 16 more queued. Past
that, clients get a typed refusal (`daemon busy: 16 requests queued behind 4
active`) rather than an unbounded wait.

## Env vars

**Which process reads these depends on the path.** The stdio MCP server
(`conduit-mcp` with no flag, and `conduit serve`) does not open the database
at all: the **daemon** owns `~/.conduit/conduit.db` and the server reaches it
over a Unix socket. So on that path these variables belong to the daemon's
environment, not the client's — the daemon's environment is *constructed*, not
inherited, and every `CONDUIT_*` is stripped when a client auto-starts one.

**Setting these in your MCP client config therefore has no effect on the
daemon.** They reach a daemon only when you start one by hand
(`conduit-mcp --daemon`), in whose environment you set them. `--doctor
--offline` reads the key directly, since it inspects the install rather than
asking the daemon.

| Var | Meaning | Default |
| --- | --- | --- |
| `CONDUIT_DB` | Path to the SQLite database file. **Refused on every daemon-backed path** — the stdio server and the default `--doctor`: a client whose environment sets it gets a typed `refused-custom-db` handshake refusal and exits non-zero, because the daemon serves exactly the default database (§9.3). The daemon derives its own database from its state directory and discards any inherited value, so `--doctor --offline` also inspects the default path, not this one. In v1 a custom `CONDUIT_DB` is therefore a **direct-store, no-daemon** install: only `conduit key` still honors it (and `key rotate` refuses outright when it is set). Unset it to use the daemon. Node does not expand `~` — use an absolute path. | `~/.conduit/conduit.db`, resolved via `homedir()` (created on first run, directory mode `0700`) |
| `CONDUIT_MASTER_KEY` | The SecretBox key, **base64 encoding of exactly 32 bytes**. **Read by the daemon, not by `serve`** — a client's value never transfers to an auto-started daemon; set it in the environment of a daemon you start by hand, or use the key file. Also read directly by `--doctor --offline` (which resolves the key without opening the store) and by `conduit key`. Malformed values fail startup non-zero. | optional when `~/.conduit/master-key` exists (env overrides file) |
| `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS` | Set to `1` to allow calls to loopback/private-network upstreams. **Dev/demo only.** **Belongs to the daemon** — it runs the sandbox and makes every upstream call, and a client's value does not transfer (§9.3 default-only). Setting it on a serve client prints a stderr warning saying exactly that. | off (fail-closed; §9.3) |
| `CONDUIT_APPROVAL_TTL` | How long a paused execution stays approvable, in **milliseconds**. Read by the process that runs the execution — the daemon on the serve path. | `259200000` (72 hours) |

## `--doctor`

Two modes, for two different questions. Both write their findings to
**stderr** (pipe with `2>&1` if you are capturing them). This is the
troubleshooting doc's first step before touching your MCP client at all.

### `conduit-mcp --doctor` — is my install healthy?

Asks the **running daemon** about its own health over the socket,
auto-starting one if none is running. That is the more truthful diagnosis: a
command that opened its own store would tell you whether *a* store opens,
when what you need to know is whether *the* store your agent will use is
healthy.

```
ok: daemon reachable (handshake accepted)
ok: daemon owns the database at ~/.conduit/conduit.db
egress opt-in: off (fail-closed default)
ok: 3 source(s) in catalog
ok: 5 connection(s) advertised
```

The database path and the effective egress setting come from the daemon's
handshake — on a live install this is the only mode that can report them,
since `--offline` refuses while a daemon is running. An empty catalog appends
a seeding hint (``— onboard one with `conduit add-mcp` ``). Exits 0 on
success, non-zero on any failure, and an unreachable daemon points you at
`--offline`.

It uses the same read the `serve` role already carries, so diagnosing grants
no privilege the agent surface does not already have.

### `conduit-mcp --doctor --offline` — my install is sick

For when the daemon will not start or the key is wrong. It takes the
maintenance lock **exclusively**, so it deliberately refuses to run beside a
live daemon or a rotation — an inspection racing a rotation would report a key
file and a database belonging to different moments:

```
offline diagnosis refused: the maintenance lock is held, so a daemon is running or a key rotation is in progress. Last acquired by daemon (pid 4711) at 2026-08-16T12:04:00.000Z (may be stale). An offline inspection beside a live owner would report a state nobody was ever in. Stop the daemon (SIGTERM) or wait for the rotation, then re-run — or run `conduit-mcp --doctor` to ask the live daemon instead.
```

The holder line is a **lead, not a verdict** — hence "may be stale". A
cleanly-released lock clears its row, but a SIGKILLed holder leaves one
behind, so the pid named may already be gone.

It **never opens the database** — no creating, healing, migrating, or canary
bootstrapping. It answers from the filesystem and from key resolution alone:

```
ok: key decodes (32 bytes), source: file
egress opt-in: off (fail-closed default)
ok: key file present at ~/.conduit/master-key (mode 0600)
ok: database present at ~/.conduit/conduit.db (mode 0600)
note: offline mode does not open the database, so it cannot confirm the key DECRYPTS it. Run `conduit-mcp --doctor` against a live daemon for that.
```

A file wider than `0600` is reported with the `chmod` that fixes it. A missing
or malformed key is *reported*, not thrown — the file findings underneath are
exactly what you need next. The exit code tracks the key only (0 if it
resolves, 1 if not); file findings do not change it. On a fresh install where
nothing exists yet, it reports rather than refusing — nothing can hold a lock
in a directory that does not exist, and the diagnostic never creates the state
it inspects.

## Troubleshooting

- **Tools don't appear in the client.** Most MCP clients only load servers at
  startup. After adding or editing the Conduit entry in your client's config,
  restart the client (or open a new chat, depending on the client). On macOS,
  Claude Desktop's server logs land at
  `~/Library/Logs/Claude/mcp-server-*.log` — check there first.
- **The server won't start / "Daemon unavailable".** The client could not
  reach or start a daemon within its deadline. Read
  `~/.conduit/conduitd.log` — the daemon writes there why it exited. If the
  message says a key rotation is in progress, wait for it to finish. If the
  daemon is up but sick, `conduit-mcp --doctor --offline` inspects the
  install without opening the database (stop the daemon first, or it
  refuses).
- **Egress blocked.** By default, calls to loopback/private-network upstreams
  fail closed (§9.3). The agent-visible error deliberately does not name the
  override — an agent should not be taught to ask its human to flip a
  security control. If you're running a local/demo upstream on purpose, set
  `CONDUIT_UNSAFE_ALLOW_PRIVATE_EGRESS=1` **in the daemon's environment** —
  it makes the upstream calls. Setting it on the stdio client has no effect
  (it prints a warning saying so), because an auto-started daemon inherits
  nothing; start one by hand with the variable set instead.
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
  file at `~/.conduit/conduit.db` — copy it, and `~/.conduit/master-key`
  alongside it (a db backup only decrypts under the key that was live when it
  was taken), before upgrading `@conduithq/mcp` or running a schema
  migration. Stop the daemon first so you copy a quiesced file.
- **Upstream compatibility.** v1 calls MCP-over-HTTP upstreams only. Other
  source types fail closed as "not yet callable."
