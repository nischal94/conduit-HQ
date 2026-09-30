# Conduit preview 0.2.0-alpha.0 — install notes

This is an **alpha preview**, not a release. It is not on npm. The on-disk
state format can change before the first public release, and this preview
has no state migration: a later build may refuse your existing state, and
then you move `~/.conduit` aside (never delete it: it holds your master key
and sealed credentials; see "Moving to a later preview"). Report problems
as GitHub issues on this repository.

## Requirements

- Node.js 22 (22.12.0 or later) or Node.js 24. CI installs and runs each
  preview tarball on Node 22.12.0 and the latest Node 24 before it is
  released.
- Targets that CI tests: Linux x64 with glibc, and macOS on Apple silicon
  (arm64). Other combinations (Linux arm64, musl/Alpine, Intel macOS) are
  untested; they may work, but nothing has checked them. Windows is not
  supported (the daemon uses Unix sockets).
- Network access to the npm registry during install: the tarball contains
  Conduit's own code, and npm fetches its dependencies at the exact
  versions pinned in the tarball's `npm-shrinkwrap.json`. Those versions
  were at least three days old when the tarball was packed, and they
  passed `npm audit` at level `high`.

## 1. Download and verify

From the repository's Releases page, download both files for the tag
`v0.2.0-alpha.0`:

- `conduithq-cli-0.2.0-alpha.0.tgz`
- `conduithq-cli-0.2.0-alpha.0.tgz.sha256`

Verify the tarball before you install it. On macOS:

```bash
shasum -a 256 -c conduithq-cli-0.2.0-alpha.0.tgz.sha256
```

On Linux:

```bash
sha256sum -c conduithq-cli-0.2.0-alpha.0.tgz.sha256
```

Both print `conduithq-cli-0.2.0-alpha.0.tgz: OK`. If they do not, do not
install the file. The checksum proves the download is intact. It does not
prove who built the file: it is published in the same release as the
tarball. This preview has no signature or build attestation.

## 2. Install

```bash
npm install -g --ignore-scripts ./conduithq-cli-0.2.0-alpha.0.tgz
```

`--ignore-scripts` stops npm from running install-time scripts from any
package in the tree. Conduit needs none. Before a preview tarball is
released, CI installs it with these same flags into an isolated prefix.

This installs two commands: `conduit` and `conduit-mcp`. Check the version:

```bash
conduit --version
```

If `npm install -g` fails with `EACCES`, your Node is a system install
that npm cannot write to. Do not use `sudo`. Either install Node with a
version manager (nvm, fnm, or volta) or give npm a user-owned prefix:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"   # add this line to your shell profile
```

If `conduit` prints `Node … is not supported`, switch to Node 22.12+ or 24
(for example `nvm install 24 && nvm use 24`), then run the install command
again: a version manager keeps global packages per Node version.

## 3. See the approval gate work (no setup)

```bash
conduit demo
```

The demo runs in memory. It needs no key, no external network (it talks
only to a loopback server it starts itself), and no account, and it does
not open or create anything in `~/.conduit`. A local demo upstream exposes one
tool that needs approval. The demo approves one call to it and denies
another, then reports what the upstream actually received. It takes a few
seconds:

```
conduit demo — the approval gate, end to end (in memory). Running…

approve: paused before it ran; after approval the upstream received it 1 time, with the exact input
deny:    paused before it ran; after denial the upstream received it 0 times
replay:  approving the same call again was refused (conflict); upstream total is still 1

PASS
Next: follow step 4 of https://github.com/nischal94/conduit-HQ/blob/v0.2.0-alpha.0/docs/alpha/INSTALL.md to govern your own agent's calls.
```

The counts come from the upstream's own record of the calls it received,
not from Conduit's report. The demo exits 1 if any count is wrong.

## 4. Govern your own agent's calls

> **Not yet verified end to end.** Nobody has run this walkthrough against
> GitHub's remote MCP server yet; the founder's own run is still pending.
> Two things are unverified: that the server accepts a fine-grained token
> scoped to one repository, and that its create-issue tool pauses for
> approval. If either fails, stop and report it (see "Tell us how it went").

This walkthrough uses GitHub, with a token that can touch ONE scratch
repository, so your first governed call has a small, known blast radius.

1. **Make a scratch repository** on GitHub (for example
   `YOUR_USER/conduit-scratch`), then create a **fine-grained personal
   access token** limited to that one repository, with **Issues: Read and
   write**.

2. **Mint the master key.** It seals every stored credential:

   ```bash
   conduit key generate
   ```

3. **Onboard GitHub's MCP server** — yourself, in your own terminal, not
   through your agent. The credential is the full `Authorization` header
   value: the word `Bearer`, a space, then the token from step 1 (for
   example `Bearer <token>`). Type it at a hidden prompt so it never lands
   in your shell history. It travels to Conduit in an environment
   variable and is encrypted at rest; Conduit never passes it to your agent
   or the model. The subshell keeps the value out of your shell afterwards
   and stops a paste from feeding the prompt; `set +x` keeps shell tracing
   from printing it. (An agent that has shell access and runs as your user
   can read anything you can, including `~/.conduit`. Conduit's boundary
   covers what flows through Conduit, not your agent's own shell.)

   ```bash
   (
     set +x
     printf 'Authorization header value (e.g. Bearer <token>): '
     IFS= read -rs TOKEN; echo
     [ -n "$TOKEN" ] || { echo 'No value read; add-mcp not run.' >&2; exit 1; }
     CONDUIT_ADD_SECRET="$TOKEN" conduit add-mcp \
       --url https://api.githubcopilot.com/mcp/ \
       --namespace github --prefix github.scratch
   )
   ```

   It prints how many tools it found in each risk class, and the policy
   for each class: `safe` runs without asking; `review` and `destructive`
   pause for your approval. Conduit classifies each tool from the hints its
   upstream publishes. The output shows counts only, not the class of each
   tool. Check that the `review` or `destructive` count is above zero. If
   both are zero, stop here and report it (see "Tell us how it went").
   Step 5 then tests the create-issue tool itself: the call must pause.

4. **Point Claude Code at Conduit.** Pin both Node and Conduit by absolute
   path: a client started outside this shell (for example the desktop app)
   may not have your Node on its PATH:

   ```bash
   claude mcp add --scope user conduit -- "$(command -v node)" "$(realpath "$(command -v conduit)")" serve
   ```

   If you later switch Node versions, run this command again.

   Restart Claude Code (or open a new session) so it loads the server.

5. **Ask your agent for a write.** For example: *"Create an issue in
   YOUR_USER/conduit-scratch titled 'hello from conduit'."* Conduit is
   designed to pause this call before it reaches GitHub. The agent should
   then report that the call is waiting for approval and tell you to run
   `conduit approvals list`. If the call runs without a pause, stop here
   and report it (see "Tell us how it went").

6. **Decide it** in a second terminal:

   ```bash
   conduit approvals list
   ```

   Under the table, each paused call has two ready-to-run lines, one to
   deny and one to approve. Read the call first, then copy the line for
   your decision.

7. **Go back to your agent and say it was approved.** The agent then
   checks the execution and reports the result. The issue should appear in
   your scratch repository. Conduit is designed so that nothing runs before
   you approve, and so that a denied call never reaches GitHub.

## Tell us how it went (3 minutes)

This preview exists to learn two things: how long the first run takes you,
and whether you need different tool access for different agents. Please
fill in the short form, whether it went well or not:
[Alpha feedback](https://github.com/nischal94/conduit-HQ/issues/new?template=alpha-feedback.yml).

## When something goes wrong

- `conduit daemon status` shows whether the background daemon is running
  and which version it is.
- `conduit-mcp --doctor` asks the running daemon for its health.
  `conduit-mcp --doctor --offline` diagnoses an install whose daemon will
  not start.
- The daemon writes its log to `~/.conduit/conduitd.log`.
- To report a problem, open an issue on this repository with: the output of
  `conduit --version` and `node --version`, your OS, the command you ran,
  and its full output. **Never paste a token, the contents of `~/.conduit`,
  or your master key.**

## Moving to a later preview

Download and verify the new tarball as in step 1. In the install line,
replace `NEW_VERSION` with the version in the new file's name.

```bash
conduit daemon stop
npm install -g --ignore-scripts ./conduithq-cli-NEW_VERSION.tgz
conduit demo
```

If the new daemon refuses your existing state, move it aside instead of
deleting it (it holds your master key and sealed credentials):

```bash
mv ~/.conduit ~/.conduit.previous
```

## Known limits of this preview

- One authority profile: every connected client shares the same tool access.
- No trace viewer. Executions are traced in the local database only.
- No service install: the daemon starts on first use and runs until
  `conduit daemon stop`.
- No state migration between previews: moving `~/.conduit` aside is the
  upgrade path when a new build refuses old state.

## Uninstall

```bash
conduit daemon stop
npm uninstall -g @conduithq/cli
```

Your state stays in `~/.conduit`. It holds the master key and your sealed
credentials. Delete it only if you intend to lose them:

```bash
rm -rf ~/.conduit
```
