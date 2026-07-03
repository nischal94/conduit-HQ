import type { SecretRepository } from "./store/store.js";
import type { Connection } from "./types.js";

/**
 * Credential resolution (spec §5.3 step 3, §9.2): binds
 * `Connection.credentialRef → secret` at call time, host-side, and turns
 * it into material for the outbound upstream request — the only place a
 * secret is ever injected. The interface is the seam (same discipline as
 * Sandbox/Catalog/ConduitStore): the §5.3 pipeline consumes this contract,
 * never a concrete resolver.
 *
 * Deliberately absent from this vocabulary: the sandbox, tool paths,
 * policies. A resolver sees a Connection and nothing about who asked —
 * the §9.2 exclusion zones (sandbox heap, agent code, agent, model) are
 * upheld by *where the return value flows*, which is the pipeline's
 * responsibility, pinned by the INVARIANT §9.2 test.
 */
export interface CredentialResolver {
  /**
   * Resolve a connection's credential fresh, per call — never cached, so
   * rotation and revocation take effect on the very next tool call
   * ("at call time", spec §5.3). Connections without a credentialRef are
   * legitimate (spec §9.1: auth optional) and resolve to empty material.
   *
   * Fails loudly when a declared credentialRef cannot be resolved: a
   * connection that promises auth must never degrade into an
   * unauthenticated upstream request (fail closed).
   */
  resolve(connection: Connection): Promise<UpstreamAuth>;
}

/**
 * Authenticated request material, ready to merge into the outbound
 * upstream request. Carrier of the secret from the store boundary to the
 * upstream caller — both host-side; it must never be serialized into
 * anything the sandbox, agent, or model can read (spec §9.2).
 */
export interface UpstreamAuth {
  headers: Readonly<Record<string, string>>;
}

/**
 * The stored secret is the complete `Authorization` header value —
 * `Bearer ghp_x`, `token abc`, `Basic dXNlcjpwdw==`. The spec defines no
 * auth-scheme vocabulary (§9.1/§9.2 are about the boundary, not header
 * formats), so Phase 0 doesn't invent one: one mechanism covers every
 * header-based scheme, and the scheme lives with the secret at setup
 * time. Richer schemes (query params, signing) extend UpstreamAuth
 * behind the seam without touching call sites.
 */
const AUTH_HEADER = "Authorization";

export function createStoreCredentialResolver(secrets: SecretRepository): CredentialResolver {
  return {
    async resolve(connection: Connection): Promise<UpstreamAuth> {
      const ref = connection.credentialRef;
      if (ref === undefined) {
        return { headers: {} };
      }
      const secret = await secrets.reveal(ref);
      if (secret === undefined || secret === "") {
        throw new Error(
          `[CredentialResolver] Failed to resolve credential: ref missing or empty in secret store. Context: { connection: ${connection.prefix}, ref: ${ref} }`,
        );
      }
      return { headers: { [AUTH_HEADER]: secret } };
    },
  };
}
