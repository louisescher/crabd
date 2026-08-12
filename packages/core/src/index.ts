// Forge domain + adapters
export * from './forge/types.ts';
export { GitHubForge, type GitHubForgeOptions } from './forge/github.ts';
export { ForgejoForge, type ForgejoForgeOptions } from './forge/forgejo.ts';
export { buildReviewThread, type RawReviewComment, type ReviewThread } from './forge/review-thread.ts';

// Auth
export { StaticTokenAuth, type AuthProvider } from './auth/types.ts';
export { GitHubAppAuth, normalizePrivateKey, type GitHubAppAuthOptions } from './auth/github-app.ts';
export {
  BrokerAuth,
  DEFAULT_BROKER_AUDIENCE,
  DEFAULT_BROKER_URL,
  isOidcAvailable,
  type BrokerAuthOptions,
} from './auth/broker.ts';

// Trigger detection + parsing
export {
  BUILTIN_MODES,
  detectTrigger,
  type DetectOptions,
  type TriggerResult,
} from './trigger/detect.ts';
export { parseGitHubEvent } from './trigger/parse-github.ts';

// Context assembly
export {
  assemblePrompt,
  compressDiff,
  criticalReviewReminder,
  renderAnchorableLines,
  renderFileContents,
  renderWorkspace,
  type AssembledPrompt,
  type AssembleOptions,
} from './context/assemble.ts';
export {
  buildRefuterPrompt,
  REFUTER_INSTRUCTIONS,
  RefuterVerdictSchema,
  survivesRefutation,
  type RefuterVerdict,
} from './context/verify.ts';
export {
  commentableLines,
  describeCommentableLines,
  expandCommentableLines,
  snapToCommentableLine,
  type AnchorableFile,
} from './context/diff-lines.ts';
export {
  loadProjectContext,
  type LoadProjectContextOptions,
  type ProjectContext,
  type SkillSummary,
} from './context/project.ts';
export {
  frontmatterString,
  parseFrontmatter,
  splitFrontmatter,
  type Frontmatter,
} from './context/frontmatter.ts';

// Memory
export {
  DEFAULT_MEMORY_DIR,
  loadMemories,
  memorySlug,
  writeMemory,
  type LoadMemoriesOptions,
  type MemoryEntry,
  type WriteMemoryInput,
} from './memory/store.ts';
export {
  commitMemories,
  resolveMemoryTarget,
  type CommitMemoriesInput,
  type CommitMemoriesResult,
  type MemoryTarget,
} from './memory/commit.ts';
export { isCorrectionReply } from './memory/gate.ts';

// Policy
export { authorizeActor, type AuthorizationResult } from './policy/trust.ts';
export {
  assertProvidersAllowed,
  checkProviderAllowlist,
  type ProviderCheckResult,
} from './policy/providers.ts';

// Modes
export {
  getMode,
  listModes,
  registerMode,
  type FinalizeContext,
  type FinalizeResult,
  type ModeDefinition,
  type ValidateContext,
  type ValidateResult,
} from './modes/registry.ts';
export { registerBuiltinModes } from './modes/builtins.ts';
export { mentionMode, MentionOutputSchema, type MentionOutput } from './modes/mention.ts';
export {
  applyFindingGates,
  partitionFindings,
  reviewMode,
  ReviewFindingSchema,
  ReviewOutputSchema,
  REVIEW_SEVERITIES,
  type ReviewFinding,
  type ReviewOutput,
  type ReviewSeverity,
} from './modes/review.ts';
export { implementMode, ImplementOutputSchema, type ImplementOutput } from './modes/implement.ts';
export { commitWorkingChanges, subjectNumber } from './modes/shared.ts';

// Git
export { collectChanges, hasChanges } from './git/changes.ts';
export { checkoutPrHead, resolveWorkspace, type WorkspaceState } from './git/workspace.ts';

// Rate limiting
export {
  buildAttemptChain,
  classifyModelError,
  computeBackoffDelayMs,
  isInFallbackScope,
  runWithFallback,
  type ModelErrorClass,
  type RunExhausted,
  type RunOutcome,
  type RunSuccess,
  type RunWithFallbackOptions,
} from './rate-limit/index.ts';

// Report
export {
  DEFAULT_BRANDING,
  renderError,
  renderFailure,
  renderProgress,
  renderRateLimited,
  renderRateLimitExhausted,
  renderResult,
  renderWorking,
  TRACKING_MARKER,
  FINDING_MARKER,
  type Branding,
  type CommentContext,
  type FailureKind,
  type FailureRender,
  type RateLimitedRender,
  type RateLimitExhaustedRender,
  type ResultRender,
} from './report/tracking.ts';

// Run orchestration
export {
  prepareRun,
  type ClassifyCandidate,
  type ClassifyFn,
  type ClassifyRequest,
  type PrepareInput,
  type PrepareOutcome,
  type RunMemory,
  type RunPlan,
} from './run/prepare.ts';
export { finalizeRun, reportRunError, type FinalizeInput } from './run/finalize.ts';
