// Forge domain + adapters
export * from './forge/types.ts';
export { GitHubForge, type GitHubForgeOptions } from './forge/github.ts';
export { ForgejoForge, type ForgejoForgeOptions } from './forge/forgejo.ts';

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
  type AssembledPrompt,
  type AssembleOptions,
} from './context/assemble.ts';

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
} from './modes/registry.ts';
export { registerBuiltinModes } from './modes/builtins.ts';
export { mentionMode, MentionOutputSchema, type MentionOutput } from './modes/mention.ts';
export { reviewMode, ReviewOutputSchema, type ReviewOutput } from './modes/review.ts';
export { implementMode, ImplementOutputSchema, type ImplementOutput } from './modes/implement.ts';
export { commitWorkingChanges, subjectNumber } from './modes/shared.ts';

// Git
export { collectChanges, hasChanges } from './git/changes.ts';

// Report
export {
  renderError,
  renderProgress,
  renderResult,
  renderWorking,
  TRACKING_MARKER,
  type ResultRender,
} from './report/tracking.ts';

// Run orchestration
export { prepareRun, type PrepareInput, type PrepareOutcome, type RunPlan } from './run/prepare.ts';
export { finalizeRun, reportRunError, type FinalizeInput } from './run/finalize.ts';
