export { type StateDirParse, takeStateDir } from "./args.js";
export {
  type DaemonRequestOptions,
  DaemonUnavailable,
  daemonRequest,
  type RpcResponseFor,
} from "./daemon/client.js";
/** Exit codes are part of the §3.5 client contract — see conduitd.ts. */
export {
  type DaemonPaths,
  daemonPaths,
  EXIT_ALREADY_RUNNING,
  EXIT_ROTATION_IN_PROGRESS,
  MAINTENANCE_ROLE_DAEMON,
  MAINTENANCE_ROLE_DOCTOR,
  MAINTENANCE_ROLE_GENERATE,
  MAINTENANCE_ROLE_ROTATE,
} from "./daemon/conduitd.js";
/**
 * The §3.5 lock primitives. `key rotate` / `key generate` are the §3.4
 * deliberate exception — they stay DIRECT-db and take the maintenance lock
 * themselves rather than routing through the daemon — so the CLI package
 * needs the acquisition and the diagnostic reader, not just the client.
 */
export {
  acquireExclusive,
  acquireExclusiveIfPresent,
  describeHolder,
  type ExclusiveAcquisition,
  type HeldLock,
  type LockHolder,
  readLockHolder,
} from "./daemon/locks.js";
export {
  type ProvisionDeps,
  type ProvisionInput,
  type ProvisionPayload,
  ProvisionRefused,
  provisionSourceRequest,
  revalidateSourceRequest,
} from "./daemon/provision.js";
export type { Capability, RpcRequest, RpcResponse } from "./daemon/rpc.js";
/**
 * `key generate` creates its own state directory under the §3.2 boundary
 * BEFORE taking the maintenance lock (F4: creates-then-locks), so it needs
 * the same mkdir-then-assert primitive the daemon uses rather than a bare
 * `mkdirSync`.
 */
export { assertStateDir, ensureStateDir, StateDirError } from "./daemon/state-dir.js";
/**
 * `key` (in the `cli` package) derives its paths from `deps.conduitDir`
 * (`DEFAULT_CONDUIT_DIR` in production, a temp dir in tests). It has no custom
 * `--state-dir` surface, so it does not need the classifier — it needs the
 * SAME single resolver every other consumer runs, applied to its own base, so
 * it can never drift from the daemon it shares a directory with (§17 §2,
 * consumer 4). On the default constant this resolve is a no-op; the value is
 * that it is the SAME no-op the daemon and client perform.
 */
export {
  canonicalOfMissing,
  isDefaultStateDir,
  resolveEffectiveStateDir,
  sameDirectoryIdentity,
} from "./daemon/state-dir-resolve.js";
export {
  DEFAULT_CONDUIT_DIR,
  DEFAULT_KEY_FILE,
  ensureDbDir,
  ensureDbFile,
  KEYGEN_ONE_LINER,
  type ResolvedEnv,
  type ResolveEnvOptions,
  resolveEnv,
} from "./env.js";
export {
  fetchToolsList,
  MAX_RESPONSE_BYTES,
  MAX_TOOLS,
  ONBOARDING_DEADLINE_MS,
} from "./mcp-fetch.js";
export {
  CHECK_EXECUTION_TOOL,
  estimateDefinitionTokens,
  executionToCheckPayload,
  extendExecuteDefinition,
  isCheckPayloadShape,
  isExecutePayloadShape,
  isResumePayloadShape,
  outcomeToPayload,
  type PausedListRow,
  pausedToListRow,
  type ResumePayload,
  type RpcPayloadFor,
  resumeToPayload,
} from "./payloads.js";
export { type ApprovalRuntime, createApprovalRuntime } from "./runtime.js";
export { type RunStdioServerOptions, runStdioServer } from "./runtime-stdio.js";
export {
  type ConduitMcpServerOptions,
  createConduitMcpServer,
  type DaemonCall,
  deadlineForRequest,
  RESUME_CLIENT_DEADLINE_MS,
} from "./server.js";
export { openStoreClientFromEnv, openStoreFromEnv } from "./store-open.js";
export {
  createSkewReporter,
  sanitizeVersionForDisplay,
  skewWarningLine,
} from "./version-skew.js";
