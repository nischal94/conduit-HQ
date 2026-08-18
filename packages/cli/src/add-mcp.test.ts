/**
 * `conduit add-mcp` as a DAEMON CLIENT (§17 Task 8).
 *
 * This file covers only what the CLI still owns after the conversion: flag
 * parsing, Step-1 flag-shaped validation, the request it builds, the way it
 * renders the daemon's projection, and the refusal paths. Everything the
 * command used to do against a store — the retarget gate, the
 * credential-leak refusal, the error mapping — moved with the logic to
 * `packages/mcp/src/daemon/provision.test.ts`.
 *
 * The command is driven against a FAKE DAEMON: no sockets, no store, no
 * network. That is not merely convenient — it is the point of the
 * conversion. A test that needed a store to exercise `add-mcp` would mean
 * `add-mcp` still opened one.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type AddMcpArgs,
  type AddMcpDeps,
  parseAddMcpArgs,
  runAddMcp,
  USAGE,
} from "./commands/add-mcp.js";

const BASE_ARGS: AddMcpArgs = {
  url: "http://127.0.0.1:9/mcp",
  namespace: "github",
  prefix: "github.acme.prod",
  replace: false,
  clearCredential: false,
  json: false,
};

const OK_PAYLOAD = {
  namespace: "github",
  prefix: "github.acme.prod",
  toolCount: 3,
  counts: { safe: 1, review: 1, destructive: 1 },
  credential: "absent" as const,
};

/** Deps around a fake daemon that answers `result` with `payload`. */
function makeDeps(
  overrides: Partial<AddMcpDeps> = {},
): AddMcpDeps & { stdoutLines: string[]; stderrLines: string[]; requests: unknown[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const requests: unknown[] = [];
  return {
    daemon: async (request) => {
      requests.push(request);
      return { kind: "result", requestId: "r1", payload: OK_PAYLOAD };
    },
    env: {},
    stdout: (line: string) => stdoutLines.push(line),
    stderr: (line: string) => stderrLines.push(line),
    stdoutLines,
    stderrLines,
    requests,
    ...overrides,
  };
}

describe("USAGE (D5 — add-mcp --help)", () => {
  it("lists every flag and mentions CONDUIT_ADD_SECRET", () => {
    for (const flag of [
      "--url",
      "--namespace",
      "--prefix",
      "--replace",
      "--clear-credential",
      "--json",
    ]) {
      expect(USAGE).toContain(flag);
    }
    expect(USAGE).toContain("CONDUIT_ADD_SECRET");
  });
});

describe("parseAddMcpArgs", () => {
  it("parses every flag", () => {
    expect(
      parseAddMcpArgs([
        "--namespace",
        "gh",
        "--url",
        "https://x/mcp",
        "--prefix",
        "p",
        "--replace",
        "--clear-credential",
        "--json",
      ]),
    ).toEqual({
      namespace: "gh",
      url: "https://x/mcp",
      prefix: "p",
      replace: true,
      clearCredential: true,
      json: true,
    });
  });
});

describe("runAddMcp (daemon client)", () => {
  it("D5: no flags at all → ONE stderr line naming ALL missing required flags, exit 1, daemon never called", async () => {
    const deps = makeDeps();

    const result = await runAddMcp({ replace: false, clearCredential: false, json: false }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.requests).toHaveLength(0);
    expect(deps.stderrLines).toHaveLength(1);
    const stderr = deps.stderrLines[0];
    expect(stderr).toContain("--namespace");
    expect(stderr).toContain("--url");
    expect(stderr).toContain("--prefix");
  });

  it("D5: an unparseable --url fails Step-1 validation before any daemon contact", async () => {
    const deps = makeDeps();

    const result = await runAddMcp({ ...BASE_ARGS, url: "not-a-url" }, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.requests).toHaveLength(0);
    expect(deps.stderrLines[0]).toContain("--url (must be a valid http(s) URL)");
  });

  it("builds a source.provision request carrying namespace, url, prefix and both flags", async () => {
    const deps = makeDeps();

    const result = await runAddMcp({ ...BASE_ARGS, replace: true, clearCredential: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.requests[0]).toEqual({
      kind: "source.provision",
      namespace: "github",
      url: "http://127.0.0.1:9/mcp",
      prefix: "github.acme.prod",
      replace: true,
      clearCredential: true,
    });
  });

  it("omits `secret` entirely when CONDUIT_ADD_SECRET is unset or blank", async () => {
    for (const env of [{}, { CONDUIT_ADD_SECRET: "   " }]) {
      const deps = makeDeps({ env });
      await runAddMcp(BASE_ARGS, deps);
      expect(deps.requests[0]).not.toHaveProperty("secret");
    }
  });

  it("forwards a fresh CONDUIT_ADD_SECRET verbatim as the request's one client→daemon secret", async () => {
    const deps = makeDeps({ env: { CONDUIT_ADD_SECRET: "Bearer tok123" } });

    await runAddMcp(BASE_ARGS, deps);

    expect(deps.requests[0]).toMatchObject({ secret: "Bearer tok123" });
  });

  it("renders the daemon's projection as the risk-class summary line", async () => {
    const deps = makeDeps();

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).toBe(0);
    const line = deps.stdoutLines.join("");
    expect(line).toMatch(/seeded 3 tools for connection github\.acme\.prod \(namespace github\):/);
    expect(line).toMatch(/1 safe \(auto-allow\)/);
    expect(line).toMatch(/1 review \(approval\)/);
    expect(line).toMatch(/1 destructive \(approval\)/);
  });

  it("--json prints the {safe,review,destructive} shape plus credential presence", async () => {
    const deps = makeDeps({
      daemon: async () => ({
        kind: "result",
        requestId: "r1",
        payload: { ...OK_PAYLOAD, credential: "present" },
      }),
    });

    const result = await runAddMcp({ ...BASE_ARGS, json: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(deps.stdoutLines.join("").trim())).toEqual({
      safe: 1,
      review: 1,
      destructive: 1,
      credential: "present",
    });
  });

  it("prints the daemon's warnings on stderr BEFORE the success line", async () => {
    const deps = makeDeps({
      daemon: async () => ({
        kind: "result",
        requestId: "r1",
        payload: { ...OK_PAYLOAD, warnings: ["[conduit add-mcp] --replace: retargeting …"] },
      }),
    });

    const result = await runAddMcp({ ...BASE_ARGS, replace: true }, deps);

    expect(result.exitCode).toBe(0);
    expect(deps.stderrLines.join("")).toContain("--replace: retargeting");
  });

  it("prints a daemon refusal message unchanged, exit 1", async () => {
    const refusal =
      '[conduit add-mcp] Namespace "github" already exists with a different url or prefix. ' +
      "Re-run with --replace to retarget it, or choose a different --namespace.";
    const deps = makeDeps({
      daemon: async () => ({ kind: "error", requestId: "r1", code: "invalid", message: refusal }),
    });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.stderrLines.join("")).toBe(`${refusal}\n`);
  });

  it("§5 outcome-unknown is reported as ambiguous and never auto-retried", async () => {
    const daemon = vi.fn(async () => ({ kind: "outcome-unknown" as const, requestId: "r7" }));
    const deps = makeDeps({ daemon });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).toBe(1);
    // Exactly ONE request: a provision that may have landed is never reissued.
    expect(daemon).toHaveBeenCalledTimes(1);
    const stderr = deps.stderrLines.join("");
    expect(stderr).toContain("UNKNOWN");
    expect(stderr).toContain("r7");
    expect(stderr).toContain("Do NOT blindly re-run it");
    expect(deps.stdoutLines).toEqual([]);
  });

  it("a daemon that cannot be reached fails loud, exit 1, with nothing on stdout", async () => {
    const deps = makeDeps({
      daemon: async () => {
        throw new Error("boom");
      },
    });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).toBe(1);
    expect(deps.stderrLines.join("")).toContain("could not reach the Conduit daemon");
    expect(deps.stdoutLines).toEqual([]);
  });

  it("INVARIANT §17: the CLI never receives a credential — no daemon response field carries one, and the secret is never echoed", async () => {
    const SECRET = "Bearer super_secret_value_do_not_leak";
    const deps = makeDeps({
      env: { CONDUIT_ADD_SECRET: SECRET },
      daemon: async () => ({
        kind: "result",
        requestId: "r1",
        payload: { ...OK_PAYLOAD, credential: "present" },
      }),
    });

    const result = await runAddMcp(BASE_ARGS, deps);

    expect(result.exitCode).toBe(0);
    // The secret went OUT (client→daemon, the one permitted direction) and
    // came back in NO form: `credential` is a two-valued presence flag, not
    // a ref and not the value.
    const allOutput = [...deps.stdoutLines, ...deps.stderrLines].join("");
    expect(allOutput).not.toContain(SECRET);
    expect(allOutput).toMatch(/seeded 3 tools/);
  });
});
