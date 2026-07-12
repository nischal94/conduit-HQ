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

  it("COMMANDS contains exactly the three routed commands", () => {
    expect(COMMANDS).toEqual(["serve", "add-mcp", "approvals"]);
  });
});
