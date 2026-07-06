import {
  DEFAULT_CONFIG,
  type BackoffStrategy,
  type CrabdConfigPartial,
  type ModePartial,
  type RateLimitOnExhausted,
  type RateLimitTriggerScope,
  type ThinkingLevel,
} from './schema.ts';

/** A custom provider resolved into camelCase for runtime registration. */
export interface ResolvedCustomProvider {
  id: string;
  baseUrl: string;
  api?: string;
  apiKeyEnv?: string;
}

/** A resolved MCP server the agent can call tools from. */
export interface ResolvedMcpServer {
  name: string;
  url: string;
  transport?: 'streamable-http' | 'sse';
  headers?: Record<string, string>;
}

export interface ResolvedMode {
  name: string;
  enabled: boolean;
  model?: string;
  /** Accumulated per-mode instructions (all layers, in precedence order). */
  instructions: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
}

export interface ResolvedConfig {
  version: number;
  model: string;
  triggerPhrase: string;
  thinkingLevel: ThinkingLevel;
  providers: { allowlist: string[]; gatewayUrl: string | null; custom: ResolvedCustomProvider[] };
  permissions: { allowedAssociations: string[] };
  /** How crab'd presents itself in tracking comments. */
  appearance: { name: string; emoji: string; footer: boolean };
  review: { commentOnly: boolean };
  webSearch: { enabled: boolean; maxResults: number };
  prompt: {
    /** Accumulated global instructions (all layers, in precedence order). */
    instructions: string;
    /** Full system-prompt override, set only when the org permits it for this repo. */
    override?: string;
  };
  limits: { maxTurns: number; timeoutMinutes?: number };
  rateLimit: ResolvedRateLimit;
  modes: Record<string, ResolvedMode>;
  mcp: ResolvedMcpServer[];
}

/** Computed backoff for crab'd-level attempts / model switches. */
export interface ResolvedBackoff {
  strategy: BackoffStrategy;
  initialDelaySeconds: number;
  maxDelaySeconds: number;
  multiplier: number;
  jitter: boolean;
}

export interface ResolvedRateLimit {
  /** Ordered fallback model chain, tried after the primary. */
  fallbackModels: string[];
  maxRetries: number;
  maxWaitSeconds: number;
  triggerScope: RateLimitTriggerScope;
  /** Undefined = apply the per-mode default (review soft, others fail). */
  onExhausted?: RateLimitOnExhausted;
  backoff: ResolvedBackoff;
}

/** Named config layers, lowest → highest precedence. */
export interface ConfigLayers {
  defaults?: CrabdConfigPartial;
  /** From the org config repo — may carry `governance`. */
  org?: CrabdConfigPartial;
  /** The target repo's `.crabd.yml`. */
  repo?: CrabdConfigPartial;
  /** CI action inputs mapped to a partial. */
  inputs?: CrabdConfigPartial;
  /** Env-var overrides mapped to a partial. */
  env?: CrabdConfigPartial;
}

export interface ResolveOptions {
  layers: ConfigLayers;
  /** Target repo slug (`org/repo`), used to gate full prompt override. */
  repoSlug?: string;
}

interface NamedLayer {
  name: keyof ConfigLayers;
  config: CrabdConfigPartial;
}

const ORG_OR_BELOW: ReadonlySet<keyof ConfigLayers> = new Set(['defaults', 'org']);

function orderedLayers(layers: ConfigLayers): NamedLayer[] {
  const order: (keyof ConfigLayers)[] = ['defaults', 'org', 'repo', 'inputs', 'env'];
  const out: NamedLayer[] = [];
  for (const name of order) {
    const config = layers[name];
    if (config) out.push({ name, config });
  }
  return out;
}

/** For a locked path, only the defaults and org layers may contribute. */
function contributing(path: string, all: NamedLayer[], locked: ReadonlySet<string>): NamedLayer[] {
  return locked.has(path) ? all.filter((l) => ORG_OR_BELOW.has(l.name)) : all;
}

/** Highest contributing layer that defines the value wins. */
function pickScalar<T>(
  path: string,
  get: (c: CrabdConfigPartial) => T | undefined,
  all: NamedLayer[],
  locked: ReadonlySet<string>,
): T | undefined {
  let value: T | undefined;
  for (const layer of contributing(path, all, locked)) {
    const candidate = get(layer.config);
    if (candidate !== undefined) value = candidate;
  }
  return value;
}

/** Concatenate string fragments across all contributing layers, in precedence order. */
function accumulate(
  path: string,
  get: (c: CrabdConfigPartial) => string | undefined,
  all: NamedLayer[],
  locked: ReadonlySet<string>,
): string {
  const parts: string[] = [];
  for (const layer of contributing(path, all, locked)) {
    const fragment = get(layer.config)?.trim();
    if (fragment) parts.push(fragment);
  }
  return parts.join('\n\n');
}

/**
 * Reconcile a keyed list across layers: collect entries from every contributing
 * layer keyed by `key`, so a higher layer **overrides** a same-key entry and adds
 * new ones, rather than replacing the whole list. Used for `mcp` (by name) and
 * `providers.custom` (by id) so repos can reuse org definitions and extend them.
 */
function reconcileByKey<T>(
  path: string,
  get: (c: CrabdConfigPartial) => T[] | undefined,
  key: (item: T) => string,
  all: NamedLayer[],
  locked: ReadonlySet<string>,
): T[] {
  const merged = new Map<string, T>();
  for (const layer of contributing(path, all, locked)) {
    for (const item of get(layer.config) ?? []) merged.set(key(item), item);
  }
  return [...merged.values()];
}

function requireDefined<T>(value: T | undefined, path: string): T {
  if (value === undefined) {
    throw new Error(`crabd config: no value resolved for "${path}" (missing from defaults?)`);
  }
  return value;
}

/**
 * Resolve the layered config into a complete {@link ResolvedConfig}.
 *
 * The built-in {@link DEFAULT_CONFIG} is always merged in as the lowest layer,
 * so every non-list field has a value. Governance (`locked`, `full_override_repos`)
 * is read from the `org` layer only.
 */
export function resolveConfig(options: ResolveOptions): ResolvedConfig {
  const layers = orderedLayers({ ...options.layers, defaults: options.layers.defaults ?? DEFAULT_CONFIG });
  const orgLayer = layers.find((l) => l.name === 'org')?.config;
  const repoLayer = layers.find((l) => l.name === 'repo')?.config;
  const locked = new Set(orgLayer?.governance?.locked ?? []);

  const model = requireDefined(pickScalar('model', (c) => c.model, layers, locked), 'model');
  const triggerPhrase = requireDefined(
    pickScalar('trigger_phrase', (c) => c.trigger_phrase, layers, locked),
    'trigger_phrase',
  );
  const thinkingLevel = requireDefined(
    pickScalar('thinking_level', (c) => c.thinking_level, layers, locked),
    'thinking_level',
  );

  const allowlist = requireDefined(
    pickScalar('providers.allowlist', (c) => c.providers?.allowlist, layers, locked),
    'providers.allowlist',
  );
  const gatewayUrl = pickScalar('providers.gateway_url', (c) => c.providers?.gateway_url, layers, locked) ?? null;
  const customRaw = reconcileByKey('providers.custom', (c) => c.providers?.custom, (p) => p.id, layers, locked);
  const custom: ResolvedCustomProvider[] = customRaw.map((p) => ({
    id: p.id,
    baseUrl: p.base_url,
    ...(p.api ? { api: p.api } : {}),
    ...(p.api_key_env ? { apiKeyEnv: p.api_key_env } : {}),
  }));

  const allowedAssociations = requireDefined(
    pickScalar('permissions.allowed_associations', (c) => c.permissions?.allowed_associations, layers, locked),
    'permissions.allowed_associations',
  );

  // Appearance: name falls back to the default if blank (avoids a degenerate `****`);
  // emoji keeps '' as an explicit "no emoji" choice, so only `?? default` for the unset case.
  const appearanceName = (pickScalar('appearance.name', (c) => c.appearance?.name, layers, locked) ?? "crab'd").trim() || "crab'd";
  const appearanceEmoji = (pickScalar('appearance.emoji', (c) => c.appearance?.emoji, layers, locked) ?? '🦀').trim();
  const appearanceFooter = pickScalar('appearance.footer', (c) => c.appearance?.footer, layers, locked) ?? true;

  const commentOnly = pickScalar('review.comment_only', (c) => c.review?.comment_only, layers, locked) ?? false;
  const webSearchEnabled = pickScalar('web_search.enabled', (c) => c.web_search?.enabled, layers, locked) ?? true;
  const webSearchMax = pickScalar('web_search.max_results', (c) => c.web_search?.max_results, layers, locked) ?? 5;

  const maxTurns = requireDefined(
    pickScalar('limits.max_turns', (c) => c.limits?.max_turns, layers, locked),
    'limits.max_turns',
  );
  const timeoutMinutes = pickScalar('limits.timeout_minutes', (c) => c.limits?.timeout_minutes, layers, locked);
  const rateLimit = resolveRateLimit(layers, locked);
  const mcp = reconcileByKey('mcp', (c) => c.mcp, (s) => s.name, layers, locked) as ResolvedMcpServer[];

  const promptInstructions = accumulate('prompt.instructions', (c) => c.prompt?.instructions, layers, locked);

  return {
    version: requireDefined(pickScalar('version', (c) => c.version, layers, locked), 'version'),
    model,
    triggerPhrase,
    thinkingLevel,
    providers: { allowlist, gatewayUrl, custom },
    permissions: { allowedAssociations },
    appearance: { name: appearanceName, emoji: appearanceEmoji, footer: appearanceFooter },
    review: { commentOnly },
    webSearch: { enabled: webSearchEnabled, maxResults: webSearchMax },
    prompt: {
      instructions: promptInstructions,
      override: resolveOverride(options.repoSlug, orgLayer, repoLayer),
    },
    limits: { maxTurns, ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}) },
    rateLimit,
    modes: resolveModes(layers, locked),
    mcp,
  };
}

/**
 * Resolve the `rate_limit` section. Scalars follow highest-layer-wins; `fallback_models`
 * is a value-list replaced wholesale by the highest contributing layer (like
 * `providers.allowlist`). `on_exhausted` stays optional — undefined means "apply the
 * per-mode default" downstream. All non-optional leaves are backed by DEFAULT_CONFIG.
 */
function resolveRateLimit(layers: NamedLayer[], locked: ReadonlySet<string>): ResolvedRateLimit {
  const rl = (c: CrabdConfigPartial) => c.rate_limit;
  const fallbackModels = requireDefined(
    pickScalar('rate_limit.fallback_models', (c) => rl(c)?.fallback_models, layers, locked),
    'rate_limit.fallback_models',
  );
  const maxRetries = requireDefined(
    pickScalar('rate_limit.max_retries', (c) => rl(c)?.max_retries, layers, locked),
    'rate_limit.max_retries',
  );
  const maxWaitSeconds = requireDefined(
    pickScalar('rate_limit.max_wait_seconds', (c) => rl(c)?.max_wait_seconds, layers, locked),
    'rate_limit.max_wait_seconds',
  );
  const triggerScope = requireDefined(
    pickScalar('rate_limit.trigger_scope', (c) => rl(c)?.trigger_scope, layers, locked),
    'rate_limit.trigger_scope',
  );
  const onExhausted = pickScalar('rate_limit.on_exhausted', (c) => rl(c)?.on_exhausted, layers, locked);
  const backoff: ResolvedBackoff = {
    strategy: requireDefined(
      pickScalar('rate_limit.backoff.strategy', (c) => rl(c)?.backoff?.strategy, layers, locked),
      'rate_limit.backoff.strategy',
    ),
    initialDelaySeconds: requireDefined(
      pickScalar('rate_limit.backoff.initial_delay_seconds', (c) => rl(c)?.backoff?.initial_delay_seconds, layers, locked),
      'rate_limit.backoff.initial_delay_seconds',
    ),
    maxDelaySeconds: requireDefined(
      pickScalar('rate_limit.backoff.max_delay_seconds', (c) => rl(c)?.backoff?.max_delay_seconds, layers, locked),
      'rate_limit.backoff.max_delay_seconds',
    ),
    multiplier: requireDefined(
      pickScalar('rate_limit.backoff.multiplier', (c) => rl(c)?.backoff?.multiplier, layers, locked),
      'rate_limit.backoff.multiplier',
    ),
    jitter: requireDefined(
      pickScalar('rate_limit.backoff.jitter', (c) => rl(c)?.backoff?.jitter, layers, locked),
      'rate_limit.backoff.jitter',
    ),
  };
  return {
    fallbackModels,
    maxRetries,
    maxWaitSeconds,
    triggerScope,
    ...(onExhausted !== undefined ? { onExhausted } : {}),
    backoff,
  };
}

/**
 * Full prompt override is permitted only when the org allowlists this repo AND the
 * repo opts in (`prompt.allow_full_override: true`) AND supplies `prompt.override`.
 * The override text is taken from the repo layer specifically — it is a repo-authored value.
 */
function resolveOverride(
  repoSlug: string | undefined,
  orgLayer: CrabdConfigPartial | undefined,
  repoLayer: CrabdConfigPartial | undefined,
): string | undefined {
  const allowedRepos = new Set(orgLayer?.governance?.full_override_repos ?? []);
  const permitted =
    repoSlug !== undefined &&
    allowedRepos.has(repoSlug) &&
    repoLayer?.prompt?.allow_full_override === true;
  const override = repoLayer?.prompt?.override;
  return permitted && override ? override : undefined;
}

function resolveModes(layers: NamedLayer[], locked: ReadonlySet<string>): Record<string, ResolvedMode> {
  const names = new Set<string>();
  for (const layer of layers) {
    for (const key of Object.keys(layer.config.modes ?? {})) names.add(key);
  }

  const modes: Record<string, ResolvedMode> = {};
  for (const name of names) {
    const get = <T>(pick: (m: ModePartial) => T | undefined) => (c: CrabdConfigPartial) => {
      const mode = c.modes?.[name];
      return mode ? pick(mode) : undefined;
    };
    modes[name] = {
      name,
      enabled: pickScalar(`modes.${name}.enabled`, get((m) => m.enabled), layers, locked) ?? true,
      model: pickScalar(`modes.${name}.model`, get((m) => m.model), layers, locked),
      instructions: accumulate(`modes.${name}.instructions`, get((m) => m.instructions), layers, locked),
      thinkingLevel: pickScalar(`modes.${name}.thinking_level`, get((m) => m.thinking_level), layers, locked),
      tools: pickScalar(`modes.${name}.tools`, get((m) => m.tools), layers, locked),
    };
  }
  return modes;
}

/** Extract the provider ID from a `<provider>/<model>` specifier. */
export function providerOf(modelSpecifier: string): string {
  const slash = modelSpecifier.indexOf('/');
  return slash === -1 ? modelSpecifier : modelSpecifier.slice(0, slash);
}
