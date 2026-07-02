import {
  DEFAULT_CONFIG,
  type CrabdConfigPartial,
  type ModePartial,
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
  review: { commentOnly: boolean };
  webSearch: { enabled: boolean; maxResults: number };
  prompt: {
    /** Accumulated global instructions (all layers, in precedence order). */
    instructions: string;
    /** Full system-prompt override, set only when the org permits it for this repo. */
    override?: string;
  };
  limits: { maxTurns: number; timeoutMinutes?: number };
  modes: Record<string, ResolvedMode>;
  mcp: ResolvedMcpServer[];
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

  const commentOnly = pickScalar('review.comment_only', (c) => c.review?.comment_only, layers, locked) ?? false;
  const webSearchEnabled = pickScalar('web_search.enabled', (c) => c.web_search?.enabled, layers, locked) ?? true;
  const webSearchMax = pickScalar('web_search.max_results', (c) => c.web_search?.max_results, layers, locked) ?? 5;

  const maxTurns = requireDefined(
    pickScalar('limits.max_turns', (c) => c.limits?.max_turns, layers, locked),
    'limits.max_turns',
  );
  const timeoutMinutes = pickScalar('limits.timeout_minutes', (c) => c.limits?.timeout_minutes, layers, locked);
  const mcp = reconcileByKey('mcp', (c) => c.mcp, (s) => s.name, layers, locked) as ResolvedMcpServer[];

  const promptInstructions = accumulate('prompt.instructions', (c) => c.prompt?.instructions, layers, locked);

  return {
    version: requireDefined(pickScalar('version', (c) => c.version, layers, locked), 'version'),
    model,
    triggerPhrase,
    thinkingLevel,
    providers: { allowlist, gatewayUrl, custom },
    permissions: { allowedAssociations },
    review: { commentOnly },
    webSearch: { enabled: webSearchEnabled, maxResults: webSearchMax },
    prompt: {
      instructions: promptInstructions,
      override: resolveOverride(options.repoSlug, orgLayer, repoLayer),
    },
    limits: { maxTurns, ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}) },
    modes: resolveModes(layers, locked),
    mcp,
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
