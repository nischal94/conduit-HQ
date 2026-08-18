# State-directory / path-resolution boundary — dedicated threat model (§17)

**Date:** 2026-08-18
**Scope:** the state-directory base-resolution boundary, reasoned across ALL five
consumers as one system.
**Status:** design for a subsequent implementer. No implementation code here.
**Threat model:** same-UID is the accepted v1 limit; a victim naming a
`--state-dir` under an attacker-owned traversable parent is IN SCOPE. Attacker
owns a directory the victim's path traverses; can create / rename / replace /
symlink components in dirs they own; can hold a lock and bind a fake UDS in a
dir they control; CANNOT write inside a victim-owned 0700 directory.
**Asset:** the client's request payload. For `add-mcp` it carries
`CONDUIT_ADD_SECRET` (`source.provision.secret`) — reaching a fake daemon is
credential exfiltration.

This pass exists because a five-pass adversarial arc kept finding genuine breaks
here, each fix reasoning locally about one entry point. Pass 4 unified state-dir
canonicalization CLIENT-SIDE but justified skipping the daemon with "the kernel
resolves both spellings to one inode"; pass 5 proved that false — `path.join`
collapses `link/..` lexically before the kernel ever sees the path. A fix's
*reasoning*, not just its code, was wrong. This document writes down the actual
invariant so the fix can be designed once and be provably complete.

---

## 1. THE INVARIANT

> **There is exactly ONE effective state-directory base per process, produced by
> a single UID-anchored canonical resolver applied at the process's entry point;
> every downstream derivation in that process — boundary validation, socket / lock
> / db path derivation, master-key path, and the directory handed to any spawn —
> is computed from THAT one resolved value and never from the raw caller-supplied
> spelling. A base that cannot be safely canonicalized is refused, not accepted:
> a custom directory whose canonical form does not yet exist (production cannot
> auto-start a daemon there), and any base reached through an ancestor chain a
> different UID can rename or replace, are refusals — never a proceed on a raw
> string.**

The class this closes: every pass-5 finding is a case of *two derivations of the
same logical base disagreeing because at least one of them used a spelling the
kernel resolves differently than `path`'s lexical rules do.* P1 is the client's
own validation and its post-validation connect disagreeing across time (an
ancestor swap). P2-lexical is the client's resolver and the by-hand daemon's raw
`daemonPaths` disagreeing across processes. P2-HOME is the client's `os.homedir()`
and the spawned child's passwd-home disagreeing across the spawn boundary. All
three are "one base, computed two ways, that came out different." The invariant
forces one way.

**Where my hypothesis was refined by the evidence.** The brief's hypothesis is
correct in substance but its phrase "every consumer uses THAT identical value" is
too strong to be literally true, and the subtlety is load-bearing:

- The client and a by-hand daemon are **separate processes that never share a
  value** — they can only share an *algorithm* plus a *shared input*. The client
  resolves `resolveEffectiveStateDir(argv)`; the daemon must resolve
  `resolveEffectiveStateDir(argv)` over the SAME argv string, independently, and
  arrive at the same object. "One value" is really "one pure resolver, applied to
  the same operator-supplied argument, in every process." The daemon does NOT
  today do this (§2, consumer 2) — that is the P2-lexical hole.
- The client and the **auto-started** daemon child cannot share the argv at all —
  the child is zero-argument by construction (`spawn.ts:105`). Here agreement is
  achieved not by a shared string but by both sides being **pinned to the same
  UID-derived constant**: the client returns `DEFAULT_CONDUIT_DIR` for a
  default-classified dir (`state-dir-resolve.ts:225`), and the child derives the
  same constant from its own uid. This only holds if that constant is genuinely
  UID-anchored on both sides — which is exactly the P2-HOME hole (§4): today it is
  `os.homedir()`, which honors `HOME`, so a poisoned `HOME` desynchronizes them.

So the true invariant is **one resolver, one UID-anchored default constant** —
value-sharing where a value can flow (within a process), algorithm-plus-input
sharing where it cannot (across processes). The hypothesis's spirit is right; the
implementer must not read "identical value" as "pass a string between processes,"
which is impossible for the by-hand and auto-start paths.

---

## 2. THE CONSUMER TABLE

`resolveEffectiveStateDir` has exactly ONE non-test call site today:
`client.ts:267`. Every other consumer derives paths from a raw spelling. That is
the whole defect surface in one sentence.

| # | Consumer (file:line) | Base it computes TODAY | Divergence | Base it MUST compute |
|---|---|---|---|---|
| 1 | **Client** — `daemonRequest`, `client.ts:267` | `resolveEffectiveStateDir(opts.stateDir)` → default-branch returns `DEFAULT_CONDUIT_DIR`, custom-branch returns `canonicalOfMissing(stateDir)`. Both `assertStateDir` (`:360`) and `daemonPaths` (`:268`) thread this one value. | The resolver is correct as far as it goes, but (a) it does not enforce the ancestor-chain rule (§3), so P1 survives, and (b) `isDefaultStateDir` / classification reads the RAW input (`:297`), which is fine, but the NOT_FOUND acceptance at `:360-363` silently blesses a custom dir the resolver could not canonicalize to an existing object (§5). | Same resolver, PLUS: (i) refuse a base whose ancestor chain is writable by another uid before any socket byte; (ii) refuse a custom base whose canonical form is NOT_FOUND (§5). |
| 2 | **Daemon** — `runDaemon`, `conduitd.ts:394` (`daemonPaths(opts.stateDir)`); reached via `bin.ts:340` `runDaemon({ stateDir: override ?? DEFAULT_CONDUIT_DIR })`; zero-arg spawn via `spawn.ts:105` → `DEFAULT_CONDUIT_DIR`. | **RAW `opts.stateDir`** — the argv spelling straight from `takeStateDir`, never canonicalized. `daemonPaths` then `join`s lexically (`conduitd.ts:118-131`). | **This is P2-lexical.** A by-hand `--state-dir <attacker>/link/../custom` binds the socket/locks under the LEXICALLY-collapsed `<attacker>/custom`, while a client resolving the same argv canonicalizes through the symlink to the real custom dir. Client and daemon **cannot meet** — or worse, meet under an attacker-owned dir. `ensureStateDir` (`:483`) validates the raw dir too, so validation and derivation agree *with each other* but both on the WRONG object. | `resolveEffectiveStateDir(opts.stateDir)` at the daemon entry (`bin.ts --daemon`, before `runDaemon`), and pass that resolved base as `opts.stateDir`. Then `daemonPaths`, `ensureStateDir`, and the bind all land on the same object the client's resolver reaches from the same argv. |
| 3 | **Offline doctor** — `doctorOffline`, `bin.ts:191-192` (`daemonPaths(stateDir)`), `stateDir` from `bin.ts:312` (`parsed.stateDir ?? DEFAULT_CONDUIT_DIR`). | **RAW** parsed `--state-dir`. Key file at `join(stateDir, "master-key")` (`:198`), db + locks via raw `daemonPaths`. | Diagnoses whatever the LEXICAL path points at. `<attacker>/link/../custom` makes the doctor inspect / report on attacker-planted files as if they were the victim's install — a diagnostic that lies. It takes the maintenance lock in the lexical dir too, so it can be spoofed into "no daemon" against a dir a real daemon serves under a different spelling. | `resolveEffectiveStateDir(parsed.stateDir ?? DEFAULT_CONDUIT_DIR)` before `daemonPaths`. Offline never spawns, so the custom-NOT_FOUND refusal (§5) does NOT apply to it — a sick install legitimately has a not-yet-existent or partially-existent dir; it must still resolve kernel-faithfully (which `canonicalOfMissing` already does) but proceed to report, not refuse. |
| 4 | **key** — `key.ts:58,203` (`daemonPaths(deps.conduitDir).maintenanceLockDb`); `runKeyGenerate`/`runKeyRotate` derive `join(deps.conduitDir, "master-key"/"conduit.db"/…)`. Production `deps.conduitDir = DEFAULT_CONDUIT_DIR` (`:60`); no `--state-dir` surface. | `DEFAULT_CONDUIT_DIR` directly (the raw constant), lexically joined. | No `--state-dir` surface means no *attacker-supplied* spelling reaches it — the ancestor-swap/lexical vectors do not apply. BUT it inherits the default-derivation, so it shares the **P2-HOME** hole (§4): if `DEFAULT_CONDUIT_DIR` honors a poisoned `HOME`, `key generate`/`rotate` create the key file and db under a `HOME`-chosen dir while the auto-started daemon (passwd-home) serves a different one. The auto-started daemon then cannot find the key. | Derive from the SAME UID-anchored default constant the daemon child derives (§4). `key` does not need the resolver (no custom spelling); it needs the fixed default. Applying `resolveEffectiveStateDir(deps.conduitDir)` is a correct no-op (idempotent on the constant) and is the cheapest way to guarantee it never drifts. |
| 5 | **default-dir helper** — `env.ts:15` `DEFAULT_CONDUIT_DIR = join(homedir(), ".conduit")`; `homedir()` = `os.homedir()`. | `os.homedir()` — **honors `$HOME`** on POSIX. | **This is P2-HOME.** The client (full env, `HOME` set) computes `join($HOME, ".conduit")`; the zero-arg daemon child (env stripped to `PATH` only, `spawn.ts:140` / `daemonSpawnEnv`) computes `homedir()` with `HOME` UNSET → passwd home. `HOME=/tmp/x` → client binds `/tmp/x/.conduit`, child binds `/home/<user>/.conduit`. They never meet. | A single UID-derived default that does NOT consult `HOME`: `userInfo().homedir` (the passwd entry for the real uid), used by BOTH the client and the child. Then both sides agree regardless of `HOME`, because neither reads it. See §4. |

Two facts fall straight out of this table:

1. **The fix is overwhelmingly a "move the existing resolver up one level"
   change.** Consumers 2, 3, 4 already have `resolveEffectiveStateDir` importable;
   they simply don't call it. The dangerous work is consumers 1 (ancestor rule +
   NOT_FOUND refusal) and 5 (the default constant), not re-architecting the daemon.

2. **The daemon spawn path (`spawnDaemon` → child derives default) and the client
   default-branch (returns `DEFAULT_CONDUIT_DIR`) already agree on the DEFAULT dir
   *by construction*** — but only as strongly as the default constant is
   UID-anchored. Fixing §5-helper is what makes that pre-existing agreement true.

---

## 3. THE ANCESTOR-CHAIN RULE (closes P1)

### 3.1 Why 0700 on the leaf is not enough

`assertStateDir` (`state-dir.ts:65-112`) proves the LEAF directory is a non-symlink,
self-owned, 0700, ACL-free directory. It says nothing about the **chain of
ancestors** the path traverses to reach that leaf. The threat model grants the
attacker ownership of a directory the victim's path traverses. Two consequences:

- **P1 existing-dir variant:** the attacker owns a parent of the (validated) leaf.
  `assertStateDir` passes at time T. The attacker `rename()`s the validated leaf
  out (a parent owner can rename an entry it does not own the target of) and drops
  a replacement — their own 0700 dir holding a lock and a fake UDS — at the same
  path before the client's `connect()` at T+Δ. The 0700 mode on the *original*
  leaf never stopped this: renaming the directory entry is the parent's right, not
  the leaf's. The client connects to the attacker's socket and writes the secret.

- **P1 ancestor-swap NOT_FOUND variant:** a custom dir is accepted as NOT_FOUND
  (`client.ts:360-363`), the client falls to row 4 and spawns / probes; the
  attacker, owning an ancestor, creates the whole leaf (with lock + fake UDS)
  in the window. The client connects unvalidated. (§5 refuses this at the source
  for production; the ancestor rule is the defense for every path that DOES
  proceed.)

The leaf being unwritable-by-others is necessary but not sufficient: **the
guarantee the client needs is that no other uid can influence which object the
leaf pathname resolves to, which is a property of the whole ancestor chain.**

### 3.2 Precisely when a canonical path is unsafe

Let `C = canonicalOfMissing(base)` — the kernel-faithful resolved path (every
existing component realpath'd, `..` applied to the resolved prefix,
`state-dir-resolve.ts:97-118`). Walk the chain of **existing** ancestor directories
of `C`, from the filesystem root down to and including the leaf if it exists.

`C` is **unsafe** if ANY existing component `D` on that chain satisfies either:

1. `lstat(D).uid !== ourUid` AND `D` is not a root-owned system directory
   trusted on the platform (`/`, `/Users`, `/home`, `/private`, `/var` — the
   directories every user's home necessarily traverses, owned by root, mode
   `0755`, not attacker-controllable under the same-UID model). A non-root,
   non-us owner is an attacker-owned traversal point → refuse.
2. `D` is group- or world-**writable** (`lstat(D).mode & 0o022`) AND not sticky
   (`& 0o1000`) — a writable non-sticky ancestor lets any uid rename/replace the
   next component. (A sticky world-writable dir like `/tmp` only lets the *owner*
   of an entry rename it, so `/tmp` itself is not disqualifying; the child dir
   the victim created under it, self-owned 0700, is the real leaf and is checked
   on its own terms.)

Refusal is a typed `StateDirError` (a new code, e.g. `UNSAFE_ANCESTOR`), reported
by the client as a boundary break — never accepted as "fresh install."

### 3.3 How to check it with `node:fs` primitives

- Resolve once to `C` via the existing `canonicalOfMissing` (kernel-faithful —
  this is the canonicalize half of canonicalize-then-check; do NOT re-parse the
  raw spelling).
- Walk `C`'s ancestor prefixes. For each, `lstatSync(prefix, { bigint: true })`
  (NOT `stat` — a symlink component is itself already disqualified by
  `assertStateDir` for the leaf, and on ancestors an `lstat` that reveals a
  symlink means the canonical walk already followed it, so compare against the
  realpath'd `C` prefix). Check `uid` and `mode` per §3.2.
- The `(dev, ino)` discipline that passes 3/4 established (`state-dir-resolve.ts:48-57`,
  `directoryIdentity` with `bigint: true`) is what makes "the leaf I validated is
  the leaf I connect to" checkable: capture `(dev, ino)` of the leaf at
  validation, and after `connect()` succeeds but before the first write,
  `fstat` the connected socket's directory (or re-`lstat` the leaf) and confirm
  the `(dev, ino)` is unchanged. A mismatch means the leaf was swapped in the
  window → abort with NO bytes sent.

### 3.4 TOCTOU: what is structurally closed vs best-effort (adversarial-convergence)

Be honest about which races the invariant *closes* and which it only *mitigates*,
so this does not become a denylist that never converges:

- **Structurally closed** — the *cross-process, cross-spelling* disagreement (P2
  lexical and HOME). Once every consumer runs one resolver over one input / one
  UID-anchored constant, there is no second derivation to disagree with. This is
  a canonicalize-then-check shape, not a pattern list: it converges because there
  is exactly one normal form.

- **Structurally closed** — the *ancestor ownership* gate for the same-UID model.
  Under same-UID, only root and the victim own the trusted chain; an attacker-owned
  ancestor is a definite, enumerable break (a uid comparison), not an open-ended
  pattern space. It converges.

- **Best-effort, defense-in-depth** — the *residual leaf-swap race between
  validation and connect* for a base whose ancestor chain we could NOT fully
  vouch for (e.g. a legitimately world-writable-sticky ancestor like a custom dir
  under `/tmp` in a test). The `(dev, ino)` re-check (§3.3) narrows the window to
  "swapped in the microseconds between two syscalls," and the 0700 leaf means only
  the leaf's owner (us) can populate it — but a determined same-owner race is
  inside our own trust boundary and not a boundary break. **For the DEFAULT dir
  and any custom dir whose whole chain is us/root-owned, there is no residual race
  — the ancestor rule closes it structurally.** The best-effort label applies only
  to bases we explicitly chose to permit despite a not-fully-trusted ancestor, and
  it is documented as such rather than patched pattern-by-pattern.

This split IS the convergence criterion: the boundary breaks (cross-process
disagreement, attacker-owned ancestor) are fixed structurally and re-running the
adversarial pass must return only (a) documented out-of-scope items or (b) the
best-effort residual leaf-swap on a deliberately-permitted untrusted ancestor.

---

## 4. THE DEFAULT-HELPER FIX (closes P2-HOME)

### 4.1 The single UID-derived default

`env.ts:15` becomes anchored to the passwd entry for the real uid, not `$HOME`:

- Use `os.userInfo().homedir` — the home directory from the **password database
  for the effective uid**, which does NOT consult `$HOME`. This is precisely the
  fallback `os.homedir()` uses only *when `HOME` is unset*; making it the
  unconditional source removes `HOME` from the computation on every path.
- `DEFAULT_CONDUIT_DIR = join(userInfo().homedir, ".conduit")`.

Rationale, stated so a later reader does not "fix" it back: the daemon child is
deliberately `HOME`-stripped (`spawn.ts:130-140` documents that omitting `HOME`
forces `homedir()` to the passwd fallback — "the uid the kernel authenticated, not
a string the client chose"). That comment describes the CHILD's behavior. The
CLIENT, running with a full environment, gets the OTHER branch of `homedir()` and
honors `HOME`. The two were never guaranteed to agree — `spawn.ts`'s own reasoning
is correct for the child and silently wrong for the client. Anchoring the default
to `userInfo().homedir` on BOTH sides makes the child's intended property
("authenticated uid, not a client string") the property of every consumer, which
is what the invariant requires.

### 4.2 Every call site that must switch

`DEFAULT_CONDUIT_DIR` is a module constant (`env.ts:15`) imported everywhere, so
the switch is **one edit** at the definition. What must be verified after it:

- `env.ts:16` `DEFAULT_KEY_FILE` (derived from it) — inherits the fix.
- `state-dir-resolve.ts:21,142,225` (`isDefaultStateDir`, `resolveEffectiveStateDir`
  default branch) — now classify against the passwd-anchored default.
- `spawn.ts:30,106` (`spawnDaemon` cwd/log) and the child's own derivation via
  `bin.ts`/`env.ts` — both sides now compute the same constant with `HOME` absent
  *or* present, so the spawn boundary is provably symmetric.
- `key.ts:60` (`PROD_DEPS.conduitDir`) — inherits the fix.
- `conduitd.ts` `daemonEnv`/`openStoreFromEnv` db derivation — db lives under the
  resolved state dir (`daemonPaths.db`), so it follows.

### 4.3 How client and HOME-stripped child provably agree

After 4.1, the agreement is a two-line proof rather than an environmental
coincidence:

1. The client's default-classified base is `DEFAULT_CONDUIT_DIR =
   join(userInfo().homedir, ".conduit")`, computed with `HOME` irrelevant.
2. The child computes the identical expression from its own (same) uid, `HOME`
   absent — same passwd entry, same string.

Neither reads `HOME`, so `HOME=/tmp/x` changes nothing on either side. The
poisoned-HOME auto-start test (§6) pins exactly this.

---

## 5. THE NOT_FOUND / FRESH-INSTALL RULE

The current client accepts NOT_FOUND uniformly (`client.ts:355-363`: any
`StateDirError` with code `NOT_FOUND` is swallowed and the loop proceeds). That is
correct for the default dir on a fresh install and WRONG for a custom dir, because
the two have opposite safe responses.

- **Custom dir, canonical form NOT_FOUND → REFUSE.** Production cannot auto-start a
  daemon for a custom directory (`spawnDaemon` is zero-argument and can only ever
  start the DEFAULT-dir daemon — `spawn.ts:78-93`; the auto-start gate at
  `client.ts:296-297` already refuses a custom production dir). So a custom dir
  that does not yet exist can never be *served* by an auto-start; accepting it as
  "fresh install, proceed" only opens the P1 ancestor-swap window (the attacker
  creates the leaf in the gap). There is no legitimate auto-start outcome to
  protect, so the safe answer is the same refusal the auto-start gate already
  gives: "no daemon for this custom dir; start one by hand:
  `conduit-mcp --daemon --state-dir <dir>`." The offline doctor (consumer 3) is
  the intentional exception — it never spawns and its whole job is inspecting a
  not-yet-healthy install, so it resolves kernel-faithfully and REPORTS rather than
  refusing.

- **Default dir NOT_FOUND (genuine fresh install) → PROCEED via the kernel-faithful
  parent-walk.** On a first run nothing has created `~/.conduit`. This is the one
  case that must not be a dead end. The base is the passwd-anchored
  `DEFAULT_CONDUIT_DIR` (§4), so it is not attacker-chosen; `canonicalOfMissing`
  already walks it kernel-faithfully (`state-dir-resolve.ts:97-118` — existing
  components realpath'd, non-existent tail lexical-and-thus-unforgeable), and the
  ancestor rule (§3) is applied to the EXISTING prefix of that walk (the home dir
  and up, all us/root-owned). The client proceeds to row 4 and spawns; the
  daemon's `ensureStateDir` (`state-dir.ts:130-133`) creates the leaf 0700 and
  re-asserts under the same boundary. A dangling-symlink-at-the-leaf spoof is
  already excluded by `isGenuinelyAbsent` (`state-dir-resolve.ts:68-76`, `lstat`
  so a dangling symlink does not read as absent).

The distinction is: **default NOT_FOUND is a fresh install we can safely
materialize under a UID-anchored, ancestor-vouched path; custom NOT_FOUND is a
directory production can never serve, so proceeding only exposes a race.**

---

## 6. TEST MATRIX (the implementer must satisfy)

Deterministic unit tests over real inodes in a temp tree, plus the real-process
end-to-end suites (`client.test.ts` / `conduitd.test.ts`) for the meet tests.
Each carries an `INVARIANT §17:` prefix.

**Must be closed (boundary breaks):**

1. **Reverse-alias client / by-hand-daemon end-to-end MEET** — start a real daemon
   with `--state-dir <attacker>/link/../custom` (raw argv, `link`→real custom via
   `symlinkSync`), and a client `daemonRequest({ stateDir: same argv })`. After the
   fix both resolve to the real custom object and the round-trip SUCCEEDS. Pins P2-lexical
   at the process boundary, not just the unit level (`state-dir-resolve.test.ts:55`
   is the unit half; this is the missing process half).
2. **Ancestor-swap-after-validation sends NO socket bytes** — validate a leaf,
   then (simulating the parent-owner rename) swap the leaf's `(dev, ino)` before
   connect; assert the client aborts with the swap error and the fake socket
   receives ZERO bytes (the secret never leaves). Pins §3.3.
3. **Attacker-owned ancestor is refused** — a custom base whose existing parent is
   owned by another uid (or is world-writable non-sticky) → `UNSAFE_ANCESTOR`
   refusal, no spawn, no connect. Pins §3.2.
4. **Poisoned-HOME auto-start MEET** — set `HOME=/tmp/x`, auto-start via the real
   spawn path, assert client and daemon bind the SAME passwd-anchored
   `~/.conduit` and the round-trip succeeds. Pins §4.
5. **Custom-NOT_FOUND refusal** — production `daemonRequest` for a
   canonically-non-existent custom dir refuses with the by-hand start command; no
   spawn fires. Pins §5.

**Must NOT regress (legitimate paths):**

6. **Real default trailing-slash / relative / `.` spellings** still classify as
   default and resolve to `DEFAULT_CONDUIT_DIR` (identity, `state-dir-resolve.ts:141`
   contract preserved).
7. **Legitimate custom dir** (self-owned 0700 leaf, us/root-owned chain, exists)
   validates, derives socket/locks inside itself, and a by-hand daemon + client on
   that dir meet.
8. **Offline doctor on a not-yet-existent / sick custom dir** still REPORTS (does
   not refuse) — the §5 custom-NOT_FOUND refusal applies to the auto-starting
   client only, never to `doctorOffline`.

---

## 7. INVARIANT §17 rows to add (`INVARIANTS.md`)

Append these rows (status ⏳ until each pinning test lands in the same commit as
its implementation, per the ledger rule):

```
| §17 — ONE effective state-dir base: every consumer (client validation + path derivation, by-hand daemon, offline doctor, key, spawn) derives from a single UID-anchored canonical resolver over the same operator input; no raw-spelling derivation survives, so a client and a by-hand daemon on the same `--state-dir` argv meet at one filesystem object regardless of symlink/`..` spelling | `packages/mcp/src/daemon/state-dir-resolve.test.ts` (unit) + `client.test.ts`/`conduitd.test.ts` ("INVARIANT §17: reverse-alias client and by-hand daemon meet at one object") | ⏳ |
| §17 — the state-dir base is refused if any existing ancestor of its canonical form is owned by another uid or is world/group-writable-non-sticky (ancestor-chain rule); a leaf whose (dev,ino) changed between validation and connect aborts with NO request bytes sent | `packages/mcp/src/daemon/state-dir.test.ts` / `client.test.ts` ("INVARIANT §17: attacker-owned ancestor refused" + "INVARIANT §17: leaf swap after validation sends zero bytes") | ⏳ |
| §17 — the default state directory is UID-anchored to the passwd entry (`userInfo().homedir`), never `$HOME`: a poisoned `HOME` cannot desynchronize the client and the HOME-stripped auto-started daemon child — both bind the same `~/.conduit` | `packages/mcp/src/env.test.ts` + `client.test.ts` ("INVARIANT §17: poisoned-HOME auto-start — client and daemon meet") | ⏳ |
| §17 — NOT_FOUND is classified by base kind: a custom state dir whose canonical form does not exist is REFUSED with the by-hand start command (production cannot auto-start a custom daemon); the default dir on a genuine fresh install proceeds via the kernel-faithful parent-walk and is materialized 0700 by the daemon | `packages/mcp/src/daemon/client.test.ts` ("INVARIANT §17: custom NOT_FOUND refused, default NOT_FOUND proceeds") | ⏳ |
```

---

## Appendix — evidence index (file:line grounding every claim)

- Client single resolver call site: `client.ts:267`, threaded into `assertStateDir`
  (`:360`) and `daemonPaths` (`:268`); NOT_FOUND acceptance `:355-363`; auto-start
  gate `:287-297`; custom-dir refusal `:479-487`.
- Resolver: `state-dir-resolve.ts` — `directoryIdentity` `:48-57`,
  `isGenuinelyAbsent` `:68-76`, `canonicalOfMissing` `:97-118`, `isDefaultStateDir`
  `:141-143`, `sameDirectoryIdentity` `:167-184`, `resolveEffectiveStateDir`
  `:224-227`.
- Leaf validation (no ancestor check): `state-dir.ts:65-112`; `ensureStateDir`
  `:130-133`.
- Daemon raw-base derivation: `conduitd.ts:118-131` (`daemonPaths` lexical join),
  `:392-394` (`runDaemon` raw `opts.stateDir`), `:483` (`ensureStateDir`);
  `bin.ts:330-340` (`--daemon` passes raw parsed override).
- Offline doctor raw base: `bin.ts:191-198,312`.
- key raw default: `key.ts:58-65,203`, `:257,274,417-419`.
- Default helper (HOME-honoring): `env.ts:15` (`os.homedir()`).
- Zero-arg spawn + HOME-strip: `spawn.ts:70-72` (`daemonSpawnEnv` = `{PATH}` only),
  `:105-115` (`spawnDaemon` hardcodes `DEFAULT_CONDUIT_DIR`), `:130-140` (HOME-strip
  reasoning).
- The lexical-escape demonstration (unit): `state-dir-resolve.test.ts:55-108`
  (existing-dir reverse-alias), `:110-139` (fresh-install parent-symlink variant).
- Shared argv parser (the one input both processes must resolve identically):
  `args.ts:50-62`; client wiring `cli/src/bin.ts:22-64`.
- The asset: `cli/src/commands/add-mcp.ts:245-260` (`CONDUIT_ADD_SECRET` →
  `source.provision.secret`, client→daemon once), daemon call `:314`.
