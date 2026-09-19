import { describe, expect, it } from "vitest";
import {
  ALL_TOOLS,
  buildEffectiveScope,
  DEFAULT_PROFILE_GRANT,
  defaultScopeResolver,
  namespaceOf,
} from "./scope.js";
import type { Tool } from "./types.js";

function tool(name: string): Tool {
  return {
    name,
    namespace: name.slice(0, name.indexOf(".")),
    inputSchema: { type: "object" },
    outputSchema: {},
    riskClass: "safe",
    sourceSemantics: { kind: "mcp" },
  };
}

const catalog = [tool("github.issues.list"), tool("github.repos.delete"), tool("slack.post")];

describe("namespaceOf (§8.3 grammar)", () => {
  it("returns the text before the first dot", () => {
    expect(namespaceOf("github.issues.list")).toBe("github");
    expect(namespaceOf("a-.b")).toBe("a-");
  });
  it("returns undefined for a name with no dot (not a qualified name)", () => {
    expect(namespaceOf("execute")).toBeUndefined();
  });
});

describe("buildEffectiveScope (§5.2)", () => {
  it("INVARIANT §5.2: the default profile permits every catalog tool on code and nothing on direct/discovery", () => {
    const scope = buildEffectiveScope(DEFAULT_PROFILE_GRANT, catalog);
    expect(scope.permits("code", "github.issues.list")).toBe(true);
    expect(scope.permits("direct", "github.issues.list")).toBe(false);
    expect(scope.permits("discovery", "github.issues.list")).toBe(false);
    expect(scope.listing.map((t) => t.name)).toEqual(catalog.map((t) => t.name));
  });

  it("INVARIANT §5.2 (#9): a profile only narrows — listing is catalog ∩ allow, never wider than allow", () => {
    const scope = buildEffectiveScope(
      {
        projections: { code: true, direct: true, discovery: true },
        allow: ["slack", "github.issues.list", "ghost.tool"],
      },
      catalog,
    );
    expect(scope.listing.map((t) => t.name).sort()).toEqual(["github.issues.list", "slack.post"]);
    expect(scope.permits("direct", "ghost.tool")).toBe(false); // granted but not in catalog
    expect(scope.permits("direct", "github.repos.delete")).toBe(false); // in catalog, not granted
  });

  it("INVARIANT §5.2 (#8): a namespace entry grows with its namespace; a tool-level entry does not", () => {
    const grant = {
      projections: { code: true, direct: true, discovery: false },
      allow: ["slack", "github.issues.list"],
    };
    const grown = [...catalog, tool("slack.delete_channel"), tool("github.issues.create")];
    const scope = buildEffectiveScope(grant, grown);
    expect(scope.permits("direct", "slack.delete_channel")).toBe(true);
    expect(scope.permits("direct", "github.issues.create")).toBe(false);
  });

  it("INVARIANT §5.2 (#16): a projection flag turned off revokes exactly as removing the grant does", () => {
    const scope = buildEffectiveScope(
      { projections: { code: false, direct: true, discovery: false }, allow: ALL_TOOLS },
      catalog,
    );
    expect(scope.permits("code", "github.issues.list")).toBe(false);
    expect(scope.permits("direct", "github.issues.list")).toBe(true);
  });

  it("a snapshot is immutable: later catalog changes do not change permits", () => {
    const live = [...catalog];
    const scope = buildEffectiveScope(DEFAULT_PROFILE_GRANT, live);
    live.push(tool("late.tool"));
    expect(scope.permits("code", "late.tool")).toBe(false);
  });
});

describe("defaultScopeResolver (D-A3, D11)", () => {
  it("reads the store on every call for the default profile (clientId null)", async () => {
    let listed = 0;
    const store = {
      tools: {
        list: async () => {
          listed++;
          return catalog;
        },
      },
    };
    const resolve = defaultScopeResolver(store);
    await resolve(null);
    await resolve(null);
    expect(listed).toBe(2);
    expect((await resolve(null)).permits("code", "slack.post")).toBe(true);
  });
  it("INVARIANT §5.2 (D11): a NAMED client id gets DENY-ALL from the default resolver, never the default grant, and the store is not read", async () => {
    let listed = 0;
    const resolve = defaultScopeResolver({
      tools: {
        list: async () => {
          listed++;
          return catalog;
        },
      },
    });
    const named = await resolve("acme");
    expect(named.permits("code", "slack.post")).toBe(false);
    expect(named.projections).toEqual({ code: false, direct: false, discovery: false });
    expect(named.listing).toEqual([]);
    expect(listed).toBe(0);
  });
});
