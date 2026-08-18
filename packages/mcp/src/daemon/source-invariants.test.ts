/**
 * §3.3.1 anti-oracle invariants, exercised end to end against a REAL
 * spawned daemon, real UDS frames, and real HTTP upstreams (§17 Task 8).
 *
 * Everything here is deliberately unmocked at the seams that matter. The
 * property under test is that a CLIENT cannot cause a daemon-held
 * credential to reach a destination of the client's choosing — and a mocked
 * fetch or an in-process daemon would test the shape of the code rather
 * than the behavior of the system. So: a spawned child daemon holding a
 * real encrypted store, a hand-crafted frame written straight onto the
 * socket (bypassing `add-mcp.ts` entirely, because an attacker would), and
 * two real HTTP servers that RECORD every header they are sent.
 *
 * The recording is the assertion. "The credential was not sent" is not
 * provable from the daemon's answer — only from the fact that the origin
 * which should never have been contacted saw no `Authorization` header, and
 * in the strongest cases saw no request at all.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { daemonPaths } from "./conduitd.js";
import { encodeFrame, FrameDecoder } from "./frames.js";
import { bundleDaemonHelper, type HelperBundle } from "./helpers/bundle.js";

const TIMEOUT = 60_000;
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

let HELPER = "";
let bundle: HelperBundle | undefined;

beforeAll(async () => {
  bundle = await bundleDaemonHelper();
  HELPER = bundle.helper;
}, TIMEOUT);

afterAll(() => {
  bundle?.cleanup();
});

let dir: string | undefined;
const children: ChildProcess[] = [];
const sockets: Socket[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.length = 0;
  await Promise.all(
    children.map((child) => {
      if (child.exitCode !== null) return Promise.resolve();
      if (!child.killed) child.kill("SIGKILL");
      return new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }),
  );
  children.length = 0;
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers.length = 0;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function newStateDir(): string {
  dir = mkdtempSync(join(tmpdir(), "cd-src-"));
  return dir;
}

// --- A recording MCP upstream ------------------------------------------
//
// Speaks just enough streamable-HTTP MCP for `fetchToolsList` to complete
// (initialize → initialized → tools/list), and records the headers of every
// request it receives. `requests` is what the invariants assert against.

interface Upstream {
  origin: string;
  /** Every request seen, in order: method, url, and the full header bag. */
  requests: { method: string; url: string; headers: NodeJS.Dict<string | string[]> }[];
  /** Convenience: did ANY request carry an Authorization header? */
  sawAuthorization(): boolean;
}

const TOOLS = [
  {
    name: "list_issues",
    description: "List open issues",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

/**
 * Starts a recording upstream. `mode` selects the behavior:
 * - `"mcp"`: a working MCP server.
 * - `"redirect"`: 302s every POST to `redirectTo` (the cross-origin case).
 */
async function startUpstream(
  mode: "mcp" | "redirect" = "mcp",
  redirectTo?: () => string,
): Promise<Upstream> {
  const requests: Upstream["requests"] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    // Drain the body before answering — the client sends a JSON-RPC POST.
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      if (mode === "redirect") {
        res.writeHead(302, { location: redirectTo?.() ?? "http://127.0.0.1:1/mcp" });
        res.end();
        return;
      }
      let parsed: { id?: string; method?: string } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        // Non-JSON body: fall through to the 202 branch.
      }
      if (parsed.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "sess-1",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            },
          }),
        );
        return;
      }
      if (parsed.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { tools: TOOLS } }));
        return;
      }
      // notifications/initialized and DELETE: 202, empty.
      res.writeHead(202);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    sawAuthorization: () =>
      requests.some(
        (r) => r.headers.authorization !== undefined || r.headers.Authorization !== undefined,
      ),
  };
}

// --- Daemon + client plumbing (mirrors conduitd.test.ts) ----------------

interface Daemon {
  child: ChildProcess;
  lines: string[];
  waitForLine(match: string, timeoutMs?: number): Promise<string>;
}

function spawnDaemon(stateDir: string): Daemon {
  const child = spawn(process.execPath, [HELPER, stateDir], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, CONDUIT_MASTER_KEY: TEST_KEY },
  });
  children.push(child);
  const lines: string[] = [];
  const waiters: Array<{ match: string; resolve: (line: string) => void }> = [];
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter !== undefined && line.includes(waiter.match)) {
          waiters.splice(i, 1);
          waiter.resolve(line);
        }
      }
    }
  });
  return {
    child,
    lines,
    waitForLine(match: string, timeoutMs = TIMEOUT): Promise<string> {
      const existing = lines.find((line) => line.includes(match));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for daemon line "${match}". Seen: ${JSON.stringify(lines)}`,
              ),
            ),
          timeoutMs,
        );
        waiters.push({
          match,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
  };
}

interface Client {
  socket: Socket;
  send(msg: unknown): void;
  next(timeoutMs?: number): Promise<unknown>;
}

function connectClient(socketPath: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    sockets.push(socket);
    const decoder = new FrameDecoder();
    const received: unknown[] = [];
    const waiters: Array<(msg: unknown) => void> = [];
    socket.on("data", (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        const waiter = waiters.shift();
        if (waiter) waiter(msg);
        else received.push(msg);
      }
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      resolve({
        socket,
        send: (msg: unknown) => socket.write(encodeFrame(msg)),
        next(timeoutMs = TIMEOUT): Promise<unknown> {
          const buffered = received.shift();
          if (buffered !== undefined) return Promise.resolve(buffered);
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error("timed out waiting for a frame")),
              timeoutMs,
            );
            waiters.push((msg) => {
              clearTimeout(timer);
              res(msg);
            });
          });
        },
      });
    });
  });
}

/** Boots a daemon and returns a handshaken client on the given capability. */
async function bootWithClient(capability: string): Promise<{ daemon: Daemon; client: Client }> {
  const stateDir = newStateDir();
  const daemon = spawnDaemon(stateDir);
  await daemon.waitForLine("listening");
  const client = await connectClient(daemonPaths(stateDir).socket);
  expect(await client.next()).toEqual({ kind: "ready" });
  client.send({ kind: "handshake", protocol: 1, capability });
  expect(await client.next()).toMatchObject({ kind: "handshake.ok" });
  return { daemon, client };
}

/** Provisions a source through the daemon and asserts it landed. */
async function provision(
  client: Client,
  args: {
    namespace: string;
    url: string;
    prefix: string;
    secret?: string;
    replace?: boolean;
    clearCredential?: boolean;
  },
): Promise<unknown> {
  client.send({
    kind: "source.provision",
    namespace: args.namespace,
    url: args.url,
    prefix: args.prefix,
    replace: args.replace ?? false,
    clearCredential: args.clearCredential ?? false,
    ...(args.secret !== undefined ? { secret: args.secret } : {}),
  });
  return client.next();
}

const SECRET = "Bearer super_secret_value_do_not_leak";

describe("§3.3.1 anti-oracle invariants", () => {
  it(
    "INVARIANT §17: a client naming a foreign destination cannot cause any stored credential to be sent there",
    async () => {
      // The legitimate upstream: onboarded WITH a secret, so the daemon now
      // holds a credential bound to this origin.
      const legit = await startUpstream();
      // The attacker's destination — a second, unrelated origin that must
      // never receive the credential the daemon is holding.
      const foreign = await startUpstream();

      const { client } = await bootWithClient("add-mcp");
      const provisioned = await provision(client, {
        namespace: "github",
        url: `${legit.origin}/mcp`,
        prefix: "github.acme.prod",
        secret: SECRET,
      });
      expect(provisioned).toMatchObject({ kind: "result" });
      expect(legit.sawAuthorization()).toBe(true);

      // THE ATTACK: a hand-crafted `source.revalidate` frame carrying a
      // `url` field, written straight onto the socket. This bypasses
      // `add-mcp.ts` completely — which is the point, since an attacker
      // holding a socket does not go through the CLI. It is the exact
      // shape §3.3.1 forbids: "use the credential you hold for github,
      // against MY url."
      client.send({
        kind: "source.revalidate",
        namespace: "github",
        url: `${foreign.origin}/mcp`,
      });
      const refusal = await client.next();

      // Rejected BY CONSTRUCTION: `decodeRequest`'s extra-key strictness
      // means the field is unrepresentable, so this never reaches a
      // handler that could act on it. `invalid` is the right code — the
      // client sent something malformed, and it is told to fix it.
      expect(refusal).toMatchObject({ kind: "error", code: "invalid" });
      expect((refusal as { message: string }).message).toContain("url");

      // THE LOAD-BEARING ASSERTION: the foreign origin was never contacted
      // at all, so it certainly never saw the credential.
      expect(foreign.requests).toEqual([]);
      expect(foreign.sawAuthorization()).toBe(false);

      // And the well-formed revalidate — namespace only — still works, and
      // still goes to the STORED url rather than anything a client named.
      const before = legit.requests.length;
      client.send({ kind: "source.revalidate", namespace: "github" });
      expect(await client.next()).toMatchObject({ kind: "result" });
      expect(legit.requests.length).toBeGreaterThan(before);
      expect(foreign.requests).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a cross-origin redirect never carries a stored credential",
    async () => {
      // `second` is where the redirect points. It must never see a request
      // carrying the credential — and in fact must never see one at all,
      // because the shared MCP client refuses every 3xx outright rather
      // than following it (a stronger position than §3.3.1's "drops the
      // credential on a cross-origin hop").
      const second = await startUpstream();
      const redirector = await startUpstream("redirect", () => `${second.origin}/mcp`);

      const { client } = await bootWithClient("add-mcp");

      // Onboard against the redirector WITH a secret. The provision itself
      // fails (the fetch is refused at the 302), which is the correct
      // outcome: nothing is written and no credential is chased across the
      // origin boundary.
      const answer = await provision(client, {
        namespace: "github",
        url: `${redirector.origin}/mcp`,
        prefix: "github.acme.prod",
        secret: SECRET,
      });
      expect(answer).toMatchObject({ kind: "error", code: "invalid" });

      // The redirector saw the credential — it is the origin the operator
      // named, so that is legitimate.
      expect(redirector.sawAuthorization()).toBe(true);

      // THE LOAD-BEARING ASSERTION: the SECOND origin saw no request, and
      // therefore no Authorization header. A redirect-following client
      // would have delivered the operator's secret to it.
      expect(second.requests).toEqual([]);
      expect(second.sawAuthorization()).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: no response to any add-mcp RPC echoes the secret, in any field",
    async () => {
      const upstream = await startUpstream();
      const { client, daemon } = await bootWithClient("add-mcp");

      const provisioned = await provision(client, {
        namespace: "github",
        url: `${upstream.origin}/mcp`,
        prefix: "github.acme.prod",
        secret: SECRET,
      });
      expect(provisioned).toMatchObject({ kind: "result" });

      // A revalidate reuses the STORED credential daemon-side — the path
      // most likely to leak it back, since the daemon has just read the
      // plaintext out of the store.
      client.send({ kind: "source.revalidate", namespace: "github" });
      const revalidated = await client.next();
      expect(revalidated).toMatchObject({ kind: "result" });

      // Whole-frame scan, not a field check: the secret must appear
      // NOWHERE in anything the daemon wrote back, whatever shape a future
      // projection takes.
      for (const frame of [provisioned, revalidated]) {
        expect(JSON.stringify(frame)).not.toContain(SECRET);
      }
      // The payload says only that a credential is on file, never what it is.
      expect(revalidated).toMatchObject({ payload: { credential: "present" } });

      // Nor in the daemon's own log (§11 forbids secret material in any
      // daemon-visible line).
      expect(daemon.lines.join("\n")).not.toContain(SECRET);

      // The upstream, meanwhile, DID receive it — proving the credential
      // was genuinely in play and the scan above is not vacuous.
      expect(upstream.sawAuthorization()).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "INVARIANT §17: a source added via one client is visible to another with no restart",
    async () => {
      // The §17 startup-reload caveat closing (design §4). This is the
      // SOURCE-shaped version of the cross-client invariant: Task 7 pinned
      // the approvals-shaped one, but a source could not be added through
      // the daemon until `source.provision` became real.
      const upstream = await startUpstream();
      const stateDir = newStateDir();
      const daemon = spawnDaemon(stateDir);
      await daemon.waitForLine("listening");

      // Client A: a long-lived `serve` connection, established BEFORE the
      // source exists and never reconnected.
      const serve = await connectClient(daemonPaths(stateDir).socket);
      expect(await serve.next()).toEqual({ kind: "ready" });
      serve.send({ kind: "handshake", protocol: 1, capability: "serve" });
      expect(await serve.next()).toMatchObject({ kind: "handshake.ok" });

      serve.send({ kind: "catalog.listing" });
      const before = (await serve.next()) as { payload: { sourceCount: number } };
      expect(before.payload.sourceCount).toBe(0);
      expect(before.payload).toMatchObject({ connections: [] });

      // Client B: a separate `add-mcp` connection provisions a source.
      const adder = await connectClient(daemonPaths(stateDir).socket);
      expect(await adder.next()).toEqual({ kind: "ready" });
      adder.send({ kind: "handshake", protocol: 1, capability: "add-mcp" });
      expect(await adder.next()).toMatchObject({ kind: "handshake.ok" });
      expect(
        await provision(adder, {
          namespace: "github",
          url: `${upstream.origin}/mcp`,
          prefix: "github.acme.prod",
        }),
      ).toMatchObject({ kind: "result" });

      // THE ASSERTION: the SAME still-connected serve client — no restart,
      // no reconnect, no new handshake — sees the new source on its next
      // call. Before the daemon owned the store, this required restarting
      // the serve process.
      serve.send({ kind: "catalog.listing" });
      const after = (await serve.next()) as {
        payload: { sourceCount: number; connections: { prefix: string }[] };
      };
      expect(after.payload.sourceCount).toBe(1);
      expect(after.payload.connections).toEqual([
        { prefix: "github.acme.prod", label: "github tools" },
      ]);
    },
    TIMEOUT,
  );
});
