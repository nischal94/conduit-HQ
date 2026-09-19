import type { ToolRepository } from "./store/store.js";
import type { Projection, Tool } from "./types.js";

/** The default profile's allowlist: the full current catalog (§4.2). Not a legal namespace. */
export const ALL_TOOLS = "*" as const;

export interface ScopeGrant {
  projections: { code: boolean; direct: boolean; discovery: boolean };
  /** Namespaces or qualified tool names (A2), or `ALL_TOOLS`. */
  allow: readonly string[] | typeof ALL_TOOLS;
}

/** An IMMUTABLE snapshot: one grant + one tool-name set, read together (§5.2). */
export interface EffectiveScope {
  projections: ScopeGrant["projections"];
  /** True iff the projection flag is on AND the tool is in catalog ∩ allow. */
  permits: (projection: Projection, qualifiedName: string) => boolean;
  /** catalog ∩ allow at snapshot time. */
  listing: Tool[];
}

/**
 * Async because profile and tool reads are store reads. Rejects → the call
 * fails as infra (fail closed). A missing profile row for a named client
 * → every flag false and an empty listing (fail closed, never the default).
 * The daemon implements it in Lane B; Lane A declares it and ships the
 * default-profile resolver.
 */
export type ScopeResolver = (clientId: string | null) => Promise<EffectiveScope>;

export const DEFAULT_PROFILE_GRANT: ScopeGrant = {
  projections: { code: true, direct: false, discovery: false },
  allow: ALL_TOOLS,
};

/** §8.3 grammar: `namespace.local`; the namespace alphabet has no dot. */
export function namespaceOf(qualifiedName: string): string | undefined {
  const dot = qualifiedName.indexOf(".");
  return dot <= 0 ? undefined : qualifiedName.slice(0, dot);
}

export function buildEffectiveScope(grant: ScopeGrant, tools: readonly Tool[]): EffectiveScope {
  const inCatalog = new Set(tools.map((t) => t.name));
  const allow = grant.allow === ALL_TOOLS ? ALL_TOOLS : new Set(grant.allow);
  const granted = (name: string): boolean => {
    if (allow === ALL_TOOLS || allow.has(name)) return true;
    const ns = namespaceOf(name);
    return ns !== undefined && allow.has(ns);
  };
  const projections = { ...grant.projections };
  return {
    projections,
    permits: (projection, name) => projections[projection] && inCatalog.has(name) && granted(name),
    listing: tools.filter((t) => granted(t.name)),
  };
}

/** A scope that permits nothing and lists nothing (fail closed). */
const DENY_ALL: EffectiveScope = {
  projections: { code: false, direct: false, discovery: false },
  permits: () => false,
  listing: [],
};

/**
 * The default profile, read fresh from the store on every call (D-A3). The
 * default profile is the UNNAMED one: for any non-null clientId this resolver
 * answers DENY_ALL — D11 must hold inside the function, not only at its call
 * sites. Narrow parameter so a `{ tools: { list } }` stub satisfies it (F10a).
 */
export function defaultScopeResolver(store: {
  tools: Pick<ToolRepository, "list">;
}): ScopeResolver {
  return async (clientId) =>
    clientId === null
      ? buildEffectiveScope(DEFAULT_PROFILE_GRANT, await store.tools.list())
      : DENY_ALL;
}
