import { describe, expect, it } from "vitest";
import { isSupportedNode, UNSUPPORTED_NODE_LINE } from "./node-support.js";
import { INSTALL_NOTES_URL } from "./version.js";

describe("isSupportedNode — mirrors engines `>=22.12.0 <23 || >=24 <25`", () => {
  it.each([
    ["22.12.0", true],
    ["22.20.0", true],
    ["24.0.0", true],
    ["24.9.1", true],
    ["22.11.9", false],
    ["20.19.0", false],
    ["23.5.0", false],
    ["25.0.0", false],
    ["not-a-version", false],
  ])("%s → %s", (version, expected) => {
    expect(isSupportedNode(version)).toBe(expected);
  });

  it("the refusal names the running version, the fix, and the versioned notes", () => {
    expect(UNSUPPORTED_NODE_LINE("20.11.0")).toBe(
      `[conduit] Node 20.11.0 is not supported: this preview runs on Node 22 (22.12.0 or later) or Node 24. Switch to a supported Node, then install the tarball again (a version manager keeps global packages per Node version). Notes: ${INSTALL_NOTES_URL}\n`,
    );
  });
});
