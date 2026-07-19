import { describe, expect, it } from "vitest";
import { COMMANDS, dispatch, VERSION } from "./dispatch.js";

describe("dispatch (design §6 — pure arg→route function)", () => {
  it("routes a known command to its route decision", () => {
    const result = dispatch(["serve"]);
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.command).toBe("serve");
      expect(result.args).toEqual([]);
    }
  });

  it("routes add-mcp with trailing args passed through", () => {
    const result = dispatch(["add-mcp", "--client", "claude"]);
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.command).toBe("add-mcp");
      expect(result.args).toEqual(["--client", "claude"]);
    }
  });

  it("routes approvals", () => {
    const result = dispatch(["approvals"]);
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.command).toBe("approvals");
    }
  });

  it("unknown command → error result with non-zero exit code and usage text", () => {
    const result = dispatch(["bogus-command"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.exitCode).toBeGreaterThan(0);
      expect(result.stderr).toMatch(/usage/i);
      expect(result.stderr).toMatch(/bogus-command/);
    }
  });

  it("no arguments → error result with usage text (not a silent no-op)", () => {
    const result = dispatch([]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.exitCode).toBeGreaterThan(0);
      expect(result.stderr).toMatch(/usage/i);
    }
  });

  it("--version → prints the version string to stdout", () => {
    const result = dispatch(["--version"]);
    expect(result.kind).toBe("version");
    if (result.kind === "version") {
      expect(result.stdout.trim()).toBe(VERSION);
    }
  });

  it("--help → lists all three commands", () => {
    const result = dispatch(["--help"]);
    expect(result.kind).toBe("help");
    if (result.kind === "help") {
      for (const command of COMMANDS) {
        expect(result.stdout).toContain(command);
      }
    }
  });

  it("-v → behaves like --version (version on stdout)", () => {
    const result = dispatch(["-v"]);
    expect(result.kind).toBe("version");
    if (result.kind === "version") {
      expect(result.stdout.trim()).toBe(VERSION);
    }
  });

  it("-h → behaves like --help (lists all three commands)", () => {
    const result = dispatch(["-h"]);
    expect(result.kind).toBe("help");
    if (result.kind === "help") {
      for (const command of COMMANDS) {
        expect(result.stdout).toContain(command);
      }
    }
  });

  it("COMMANDS contains exactly the four routed commands", () => {
    expect(COMMANDS).toEqual(["serve", "add-mcp", "approvals", "key"]);
  });

  it("--help mentions add-mcp's flags (D5)", () => {
    const result = dispatch(["--help"]);
    expect(result.kind).toBe("help");
    if (result.kind === "help") {
      expect(result.stdout).toContain("--namespace");
      expect(result.stdout).toContain("--url");
      expect(result.stdout).toContain("--prefix");
    }
  });

  it("add-mcp --help → help result, not routed to the command (D5)", () => {
    const result = dispatch(["add-mcp", "--help"]);
    expect(result.kind).toBe("help");
    if (result.kind === "help") {
      expect(result.stdout).toContain("--namespace");
      expect(result.stdout).toContain("--url");
      expect(result.stdout).toContain("--prefix");
      expect(result.stdout).toContain("--replace");
      expect(result.stdout).toContain("--clear-credential");
      expect(result.stdout).toContain("--json");
      expect(result.stdout).toContain("CONDUIT_ADD_SECRET");
    }
  });

  it("add-mcp -h → same as --help (D5)", () => {
    const result = dispatch(["add-mcp", "-h"]);
    expect(result.kind).toBe("help");
    if (result.kind === "help") {
      expect(result.stdout).toContain("--namespace");
    }
  });

  it("add-mcp --namespace --help → routed (--help is the namespace VALUE, not a help request)", () => {
    const result = dispatch(["add-mcp", "--namespace", "--help"]);
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.command).toBe("add-mcp");
      expect(result.args).toEqual(["--namespace", "--help"]);
    }
  });

  it("add-mcp --url -h → routed (-h is the url VALUE, not a help request)", () => {
    const result = dispatch(["add-mcp", "--url", "-h"]);
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.args).toEqual(["--url", "-h"]);
    }
  });

  it("add-mcp --replace --help → help (--replace is boolean; help legitimately follows)", () => {
    const result = dispatch(["add-mcp", "--replace", "--help"]);
    expect(result.kind).toBe("help");
    if (result.kind === "help") {
      expect(result.stdout).toContain("--namespace");
    }
  });

  it("add-mcp --namespace foo --help → help (help is in a flag position, not a value)", () => {
    const result = dispatch(["add-mcp", "--namespace", "foo", "--help"]);
    expect(result.kind).toBe("help");
    if (result.kind === "help") {
      expect(result.stdout).toContain("--prefix");
    }
  });

  it("routes `key` with its args", () => {
    expect(dispatch(["key", "generate"])).toEqual({
      kind: "route",
      command: "key",
      args: ["generate"],
    });
  });

  it("`key --help`, `key generate --help`, `key rotate -h` print the family usage, exit 0", () => {
    for (const argv of [
      ["key", "--help"],
      ["key", "generate", "--help"],
      ["key", "rotate", "-h"],
    ]) {
      const result = dispatch(argv);
      expect(result.kind).toBe("help");
    }
  });
});
