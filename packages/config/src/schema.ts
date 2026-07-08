import * as v from 'valibot';

/**
 * The config schema for crab'd. Every layer (built-in defaults, org repo, repo
 * `.crabd.yml`, CI inputs, env) is a *partial* of this shape — all fields are
 * optional so layers only carry overrides. {@link resolveConfig} merges the
 * layers into a complete {@link ResolvedConfig}.
 *
 * Merge rules (see `merge.ts`):
 * - scalars: highest layer wins;
 * - `instructions` (prompt + per-mode): appended across ALL layers, in order;
 * - lists (`providers.allowlist`, `modes.*.tools`, `rate_limit.fallback_models`, ...): replaced by the highest layer;
 * - keys named in `governance.locked` (org only) cannot be overridden below the org layer.
 */

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const ThinkingLevelSchema = v.picklist(THINKING_LEVELS);
export type ThinkingLevel = v.InferOutput<typeof ThinkingLevelSchema>;

/** Per-mode dials. Mode keys are arbitrary — built-ins are mention/review/implement. */
export const ModePartialSchema = v.object({
  /** Whether this mode may run. */
  enabled: v.optional(v.boolean()),
  /** Model override for this mode (`<provider>/<model>`), allowlist-gated. */
  model: v.optional(v.string()),
  /** Extra instructions appended to the prompt for this mode (accumulates across layers). */
  instructions: v.optional(v.string()),
  /** Reasoning effort override for this mode. */
  thinking_level: v.optional(ThinkingLevelSchema),
  /** Forge tools this mode may call (list — replaced by the highest layer). */
  tools: v.optional(v.array(v.string())),
});
export type ModePartial = v.InferOutput<typeof ModePartialSchema>;

export const PromptPartialSchema = v.object({
  /** Global extra instructions, appended to crab'd's base prompt (accumulates across layers). */
  instructions: v.optional(v.string()),
  /** Repo opt-in to fully replace the base system prompt. Only effective if the org allowlists this repo. */
  allow_full_override: v.optional(v.boolean()),
  /** The replacement system prompt used when full override is permitted. */
  override: v.optional(v.string()),
});
export type PromptPartial = v.InferOutput<typeof PromptPartialSchema>;

/** A user-defined, OpenAI-compatible (or other) provider registered at runtime. */
export const CustomProviderSchema = v.object({
  /** Provider ID used in model specifiers, e.g. `my-llm` in `my-llm/model-name`. */
  id: v.string(),
  /** Endpoint root, e.g. `https://llm.internal/v1`. */
  base_url: v.string(),
  /** Wire protocol slug. Defaults to `openai-completions` (most OpenAI-compatible APIs). */
  api: v.optional(v.string()),
  /** Env var whose value is used as the API key for this provider. */
  api_key_env: v.optional(v.string()),
});
export type CustomProvider = v.InferOutput<typeof CustomProviderSchema>;

export const ProvidersPartialSchema = v.object({
  /** Provider IDs (`anthropic`, `openai`, `google`, `google-vertex`, `ollama`, custom, ...) crab'd may use. */
  allowlist: v.optional(v.array(v.string())),
  /** Optional org egress gateway all provider calls are routed through. */
  gateway_url: v.optional(v.nullable(v.string())),
  /** Custom providers registered at runtime (set your own OpenAI-compatible URLs). */
  custom: v.optional(v.array(CustomProviderSchema)),
});
export type ProvidersPartial = v.InferOutput<typeof ProvidersPartialSchema>;

export const PermissionsPartialSchema = v.object({
  /** Forge author-associations / roles allowed to trigger crab'd (e.g. OWNER, MEMBER, COLLABORATOR). */
  allowed_associations: v.optional(v.array(v.string())),
});
export type PermissionsPartial = v.InferOutput<typeof PermissionsPartialSchema>;

export const WebSearchPartialSchema = v.object({
  /** Whether the agent gets `web_search` / `fetch_url` tools to research current info. */
  enabled: v.optional(v.boolean()),
  /** Max results returned per search. */
  max_results: v.optional(v.number()),
});
export type WebSearchPartial = v.InferOutput<typeof WebSearchPartialSchema>;

export const AppearancePartialSchema = v.object({
  /** Display name crab'd uses when it refers to itself in tracking comments (default `crab'd`). */
  name: v.optional(v.string()),
  /**
   * Emoji prefixed to crab'd's tracking comments (default `🦀`). Set to `''` to show no
   * emoji. Only this brand emoji is governed — status glyphs (⚠️/⏳/➡️) are left as-is.
   */
  emoji: v.optional(v.string()),
  /**
   * Whether to append the `posted by <name>` footer (default `true`). When `false`, the
   * visible footer is dropped (along with the crab'd attribution link); the hidden marker
   * that lets crab'd reuse its comment across runs is always kept.
   */
  footer: v.optional(v.boolean()),
});
export type AppearancePartial = v.InferOutput<typeof AppearancePartialSchema>;
                                              
export const ContextPartialSchema = v.object({
  /**
   * Load the repo's own agent instructions (`AGENTS.md`, then `CLAUDE.md`) from the
   * checkout root and append them to the system prompt, so crab'd follows the same
   * project conventions your local agents do.
   */
  instruction_files: v.optional(v.boolean()),
  /**
   * Discover skills under `.agents/skills/` and `.claude/skills/` and list each skill's
   * name + description in the prompt. The agent reads a skill's `SKILL.md` itself (with
   * its file tools) when a task matches — progressive disclosure, no skill body preloaded.
   */
  skills: v.optional(v.boolean()),
  /**
   * Embed the entire PR diff in the prompt. Off by default: crab'd sends a compressed,
   * high-signal diff (low-signal files like lockfiles and generated output dropped, oversized
   * files clipped, omissions listed) so the agent spends fewer turns exploring. Turn this on
   * to send the full diff instead — the agent can always read any omitted file with its tools.
   */
  full_diff: v.optional(v.boolean()),
});
export type ContextPartial = v.InferOutput<typeof ContextPartialSchema>;

export const ReposPartialSchema = v.object({
  /**
   * Repositories (besides the trigger repo) the agent may **read** during a run. `'all'` grants
   * the App installation's full scope; a list of `owner/repo` (globs allowed, e.g. `org/*`) scopes
   * a least-privilege, read-only token. crab'd exposes that token to the model's shell so it can
   * `gh`/`git` those repos on demand. Requires the App-path or a PAT token — the broker is
   * single-repo and cannot grant this. Off (single-repo) by default.
   */
  read: v.optional(v.union([v.literal('all'), v.array(v.string())])),
});
export type ReposPartial = v.InferOutput<typeof ReposPartialSchema>;

/** A private registry crab'd authenticates by writing a managed `.npmrc` before the run. */
export const NpmRegistrySchema = v.object({
  /** Registry URL, e.g. `https://npm.pkg.github.com`. */
  registry: v.string(),
  /** Optional package scope this registry serves, e.g. `@myorg`. */
  scope: v.optional(v.string()),
  /**
   * Name of the env var holding the auth token, written into `.npmrc` as `${NAME}` (npm/pnpm
   * expand env vars at runtime). The named var is forwarded into the sandbox automatically. Omit
   * for GitHub Packages in the same org — crab'd falls back to the forge token.
   */
  token_env: v.optional(v.string()),
});
export type NpmRegistry = v.InferOutput<typeof NpmRegistrySchema>;

export const SandboxPartialSchema = v.object({
  /**
   * Names of environment variables (mapped from CI secrets on the crab'd step) to forward into
   * the model's shell — e.g. `NODE_AUTH_TOKEN` for a private registry. Only the **names** live in
   * config, never the values. Anything forwarded is readable by the model (network-capable shell).
   * Replaced (not merged) by the highest contributing layer.
   */
  env: v.optional(v.array(v.string())),
  /** Private registries crab'd authenticates by writing a managed `.npmrc` before the run. */
  npmrc: v.optional(v.array(NpmRegistrySchema)),
});
export type SandboxPartial = v.InferOutput<typeof SandboxPartialSchema>;

/**
 * How hard crab'd hones in when reviewing, on a 1–5 scale. `1` flags only merge-blocking
 * correctness/security issues; `2` (default) is high-signal-over-nitpicking; `3`–`5` are
 * increasingly nitpicky, lowering the bar for what counts as a finding and making crab'd
 * slower to conclude "no issues" or to hand out a clean APPROVE. Interpreted in the review
 * prompt (see `assemble.ts`).
 */
export const REVIEW_STRICTNESS_MIN = 1;
export const REVIEW_STRICTNESS_MAX = 5;
export const REVIEW_STRICTNESS_DEFAULT = 2;
export const ReviewStrictnessSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(REVIEW_STRICTNESS_MIN),
  v.maxValue(REVIEW_STRICTNESS_MAX),
);
export type ReviewStrictness = v.InferOutput<typeof ReviewStrictnessSchema>;

export const ReviewPartialSchema = v.object({
  /**
   * When true, crab'd posts every review as a plain COMMENT — it never formally
   * approves or requests changes (so it can't block or approve a PR). The verdict is
   * still computed and shown in the summary.
   */
  comment_only: v.optional(v.boolean()),
  /**
   * Review strictness, `1`–`5` (default `2`). Higher = more nitpicky: crab'd lowers the bar
   * for what counts as a finding, keeps digging instead of concluding "no issues," and is
   * more reluctant to APPROVE. `1` flags only merge-blocking issues.
   */
  strictness: v.optional(ReviewStrictnessSchema),
});
export type ReviewPartial = v.InferOutput<typeof ReviewPartialSchema>;

export const LimitsPartialSchema = v.object({
  /** Hard ceiling on tool-calling turns. The run is stopped if it's exceeded. */
  max_turns: v.optional(v.number()),
  /** Hard wall-clock timeout for a run, enforced via the agent's durability. */
  timeout_minutes: v.optional(v.number()),
});
export type LimitsPartial = v.InferOutput<typeof LimitsPartialSchema>;

export const BACKOFF_STRATEGIES = ['exponential', 'linear', 'constant'] as const;
export const BackoffStrategySchema = v.picklist(BACKOFF_STRATEGIES);
export type BackoffStrategy = v.InferOutput<typeof BackoffStrategySchema>;

/** Which classes of model error trigger crab'd's retry + fallback. */
export const RATE_LIMIT_TRIGGER_SCOPES = ['transient', 'rate-limit', 'all'] as const;
export const RateLimitTriggerScopeSchema = v.picklist(RATE_LIMIT_TRIGGER_SCOPES);
export type RateLimitTriggerScope = v.InferOutput<typeof RateLimitTriggerScopeSchema>;

/** What crab'd does once the fallback chain / wait budget is exhausted. */
export const RATE_LIMIT_ON_EXHAUSTED = ['soft', 'fail'] as const;
export const RateLimitOnExhaustedSchema = v.picklist(RATE_LIMIT_ON_EXHAUSTED);
export type RateLimitOnExhausted = v.InferOutput<typeof RateLimitOnExhaustedSchema>;

/**
 * Computed backoff between crab'd-level attempts / model switches. Note: crab'd
 * cannot honor a provider's `retry-after` (the underlying framework drops it), so
 * these delays are always computed, and they stack on the framework's own
 * per-model retries.
 */
export const BackoffPartialSchema = v.object({
  strategy: v.optional(BackoffStrategySchema),
  initial_delay_seconds: v.optional(v.number()),
  max_delay_seconds: v.optional(v.number()),
  multiplier: v.optional(v.number()),
  jitter: v.optional(v.boolean()),
});
export type BackoffPartial = v.InferOutput<typeof BackoffPartialSchema>;

export const RateLimitPartialSchema = v.object({
  /**
   * Ordered fallback model chain (`<provider>/<model>`), tried in order after the
   * primary model is exhausted. Cross-provider is supported. Empty = no fallback.
   * Replaced (not merged) by the highest contributing layer.
   */
  fallback_models: v.optional(v.array(v.string())),
  /** Cap on crab'd-level attempts across the chain (primary + fallbacks). */
  max_retries: v.optional(v.number()),
  /** Total wall-clock budget (seconds) crab'd spends handling rate limits before giving up. */
  max_wait_seconds: v.optional(v.number()),
  /** Which error classes trigger retry/fallback (`transient` | `rate-limit` | `all`). */
  trigger_scope: v.optional(RateLimitTriggerScopeSchema),
  /**
   * Behavior when the chain / budget is exhausted. Unset = per-mode default
   * (review soft-finishes, other modes fail the check).
   */
  on_exhausted: v.optional(RateLimitOnExhaustedSchema),
  backoff: v.optional(BackoffPartialSchema),
});
export type RateLimitPartial = v.InferOutput<typeof RateLimitPartialSchema>;

/** A remote MCP server whose tools are exposed to the agent. */
export const McpServerSchema = v.object({
  name: v.string(),
  url: v.string(),
  transport: v.optional(v.picklist(['streamable-http', 'sse'])),
  headers: v.optional(v.record(v.string(), v.string())),
});
export type McpServer = v.InferOutput<typeof McpServerSchema>;

/** Org-only governance. Meaningful only in the org config repo's `.crabd.yml`. */
export const GovernancePartialSchema = v.object({
  /** Dot-paths (e.g. `providers.allowlist`) that lower layers cannot override. */
  locked: v.optional(v.array(v.string())),
  /** Repo slugs (`org/repo`) permitted to use full prompt override. */
  full_override_repos: v.optional(v.array(v.string())),
});
export type GovernancePartial = v.InferOutput<typeof GovernancePartialSchema>;

export const CrabdConfigPartialSchema = v.object({
  version: v.optional(v.literal(1)),
  /** Default model specifier `<provider>/<model>`. */
  model: v.optional(v.string()),
  /** Mention phrase that triggers crab'd (e.g. `/crabd`). */
  trigger_phrase: v.optional(v.string()),
  thinking_level: v.optional(ThinkingLevelSchema),
  providers: v.optional(ProvidersPartialSchema),
  permissions: v.optional(PermissionsPartialSchema),
  appearance: v.optional(AppearancePartialSchema),
  review: v.optional(ReviewPartialSchema),
  web_search: v.optional(WebSearchPartialSchema),
  context: v.optional(ContextPartialSchema),
  repos: v.optional(ReposPartialSchema),
  sandbox: v.optional(SandboxPartialSchema),
  prompt: v.optional(PromptPartialSchema),
  limits: v.optional(LimitsPartialSchema),
  rate_limit: v.optional(RateLimitPartialSchema),
  modes: v.optional(v.record(v.string(), ModePartialSchema)),
  /** Remote MCP servers whose tools the agent may call. */
  mcp: v.optional(v.array(McpServerSchema)),
  governance: v.optional(GovernancePartialSchema),
});
export type CrabdConfigPartial = v.InferOutput<typeof CrabdConfigPartialSchema>;

/** Built-in defaults — the lowest config layer. */
export const DEFAULT_CONFIG: CrabdConfigPartial = {
  version: 1,
  model: 'anthropic/claude-sonnet-5',
  trigger_phrase: '/crabd',
  thinking_level: 'medium',
  providers: {
    // Empty = allow any provider. crab'd works with zero config; set this to restrict egress.
    allowlist: [],
    gateway_url: null,
  },
  permissions: {
    allowed_associations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
  },
  appearance: {
    name: "crab'd",
    emoji: '🦀',
    footer: true,
  },
  review: {
    comment_only: false,
    strictness: REVIEW_STRICTNESS_DEFAULT,
  },
  web_search: {
    enabled: true,
    max_results: 5,
  },
  context: {
    // On by default: the repo's own AGENTS.md/CLAUDE.md and skills are exactly the
    // conventions a human's agent would follow, so crab'd honors them too.
    instruction_files: true,
    skills: true,
    // Off by default: send a compressed diff, not the whole thing — fewer tokens, fewer
    // exploration turns. Opt in for the full diff.
    full_diff: false,
  },
  // Off by default: no cross-repo access, no forwarded secrets. Both are opt-in and
  // governance-lockable, since they put credentials / other repos in front of the model.
  repos: {},
  sandbox: { env: [], npmrc: [] },
  prompt: {
    instructions: '',
    allow_full_override: false,
  },
  limits: {
    max_turns: 40,
  },
  rate_limit: {
    // Opt-in fallback: no chain by default. Backoff governs waits between model
    // switches and stacks on the framework's own per-model retries.
    fallback_models: [],
    max_retries: 4,
    max_wait_seconds: 180,
    trigger_scope: 'transient',
    // on_exhausted intentionally unset — resolved per-mode (review soft, others fail).
    backoff: {
      strategy: 'exponential',
      initial_delay_seconds: 2,
      max_delay_seconds: 30,
      multiplier: 2,
      jitter: true,
    },
  },
  modes: {
    mention: { enabled: true, tools: ['comment', 'commit'] },
    review: { enabled: true, tools: ['comment', 'review'] },
    implement: { enabled: true, tools: ['comment', 'commit', 'open_pr'] },
  },
};

/** Parse and validate a partial config object (e.g. from parsed YAML). Throws on invalid shape. */
export function parseConfigObject(input: unknown): CrabdConfigPartial {
  return v.parse(CrabdConfigPartialSchema, input);
}
