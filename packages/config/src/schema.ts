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
 * - lists (`providers.allowlist`, `modes.*.tools`, ...): replaced by the highest layer;
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

export const LimitsPartialSchema = v.object({
  /** Hard ceiling on tool-calling turns. The run is stopped if it's exceeded. */
  max_turns: v.optional(v.number()),
  /** Hard wall-clock timeout for a run, enforced via the agent's durability. */
  timeout_minutes: v.optional(v.number()),
});
export type LimitsPartial = v.InferOutput<typeof LimitsPartialSchema>;

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
  prompt: v.optional(PromptPartialSchema),
  limits: v.optional(LimitsPartialSchema),
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
  prompt: {
    instructions: '',
    allow_full_override: false,
  },
  limits: {
    max_turns: 40,
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
