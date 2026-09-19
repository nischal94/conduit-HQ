export type {
  Catalog,
  DescribeOptions,
  SearchHit,
  SearchOptions,
  ToolDescription,
} from "./catalog.js";
export { InMemoryCatalog } from "./catalog.js";
export type { CredentialResolver, UpstreamAuth } from "./credentials.js";
export { createStoreCredentialResolver } from "./credentials.js";
export type {
  BuildExecuteToolOptions,
  ConnectionListing,
  ExecuteToolDefinition,
  ToolInvoker,
} from "./execute.js";
export {
  buildExecuteTool,
  createCatalogToolHost,
  createScopedCatalogToolHost,
  estimateTokens,
} from "./execute.js";
export type {
  ApprovalDecision,
  ApprovalDecisions,
  PendingCallIdentity,
} from "./execution/decisions.js";
export { createInMemoryApprovalDecisions, identitiesMatch } from "./execution/decisions.js";
export { matchesPending, toSandboxJournal } from "./execution/journal.js";
export type {
  ExecutionManager,
  ExecutionManagerDeps,
  ExecutionOutcome,
  ResumeOutcome,
} from "./execution/manager.js";
export { createExecutionManager } from "./execution/manager.js";
export { scrubCredential } from "./execution/scrub.js";
export type { NormalizeMcpOptions } from "./normalize/mcp.js";
export { normalizeMcp } from "./normalize/mcp.js";
export type {
  NormalizedOpenApi,
  NormalizeOpenApiOptions,
} from "./normalize/openapi.js";
export { normalizeOpenApi } from "./normalize/openapi.js";
export type { DispatchCell, DispatchState } from "./pipeline/dispatch.js";
export { createDispatchCell } from "./pipeline/dispatch.js";
export type { EgressOptions } from "./pipeline/egress.js";
export { assertEgressAllowed, createPinnedLookup, isPrivateAddress } from "./pipeline/egress.js";
export type { CallErrorKind, GuestErrorName } from "./pipeline/errors.js";
export {
  ConduitCallError,
  ConduitOutcomeAmbiguous,
  GUEST_ERROR_NAMES,
  infraError,
  NON_MEMOIZABLE_ERROR_NAMES,
  OUTCOME_AMBIGUOUS_ERROR_NAME,
  policyError,
  upstreamError,
} from "./pipeline/errors.js";
export type { CreateToolInvokerOptions, ToolInvokerDeps } from "./pipeline/invoker.js";
export { createToolInvoker } from "./pipeline/invoker.js";
export type {
  McpBudget,
  McpClient,
  McpEndpoint,
  McpSession,
} from "./pipeline/mcp-client.js";
export { createMcpClient, McpClientError } from "./pipeline/mcp-client.js";
export type {
  UpstreamCaller,
  UpstreamOutcome,
  UpstreamRequest,
} from "./pipeline/upstream.js";
export { createMcpUpstreamCaller, redactionTokens, redactTokens } from "./pipeline/upstream.js";
export type {
  PolicyEngine,
  PolicyEvaluationRequest,
  PolicyTarget,
  PolicyVerdict,
  PolicyVerdictSource,
} from "./policy.js";
export { createStorePolicyEngine } from "./policy.js";
export { deriveRiskClass } from "./risk.js";
export {
  logSandboxDiagnosticsTo,
  moduleRecoveries,
  QuickJSSandbox,
  type SandboxDiagnostic,
  setSandboxDiagnostic,
} from "./sandbox/quickjs.js";
export type {
  ExecutionRequest,
  ExecutionSeeds,
  InterruptReason,
  JournalEntry,
  Sandbox,
  SandboxError,
  SandboxLimits,
  SandboxResult,
  ToolHost,
} from "./sandbox/sandbox.js";
export { DEFAULT_SANDBOX_LIMITS, generateSeeds } from "./sandbox/sandbox.js";
export type { EffectiveScope, ScopeGrant, ScopeResolver } from "./scope.js";
export {
  ALL_TOOLS,
  buildEffectiveScope,
  DEFAULT_PROFILE_GRANT,
  defaultScopeResolver,
  namespaceOf,
} from "./scope.js";
export { SecretBox } from "./secrets.js";
export {
  CANARY_REF,
  ensureKeyCanary,
  KeyCanaryError,
  ReencryptError,
  reencryptSecrets,
  type StoreKeyContext,
} from "./store/key-lifecycle.js";
export type { SqliteStoreOptions } from "./store/sqlite.js";
export { openSqliteStore } from "./store/sqlite.js";
export type {
  ConduitStore,
  ConnectionRepository,
  ExecutionRepository,
  IntegrationRepository,
  PolicyRepository,
  SecretRepository,
  SourceRepository,
  ToolRepository,
  TraceRepository,
} from "./store/store.js";
export type {
  Connection,
  DirectCall,
  Execution,
  ExecutionBase,
  ExecutionKind,
  ExecutionStatus,
  Integration,
  JsonSchema,
  LegacyPendingApproval,
  PendingApproval,
  Policy,
  PolicyAction,
  Projection,
  ResultState,
  RiskClass,
  Source,
  SourceSemantics,
  SourceType,
  StoredPendingApproval,
  Tool,
  TraceEvent,
} from "./types.js";
export {
  hasProvenance,
  isPendingApproval,
  isValidProjectionForKind,
  NEWER_BUILD_SENTINEL,
  NOT_NAMEABLE_CALL_ID,
  PROJECTIONS,
} from "./types.js";
