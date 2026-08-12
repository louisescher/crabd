import { createProvider, envApiKeyAuth, type Model, type Provider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinProviders, getBuiltinModels, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import { providerOf, type ResolvedConfig, type ResolvedCustomProvider } from '@crabd/config';

/** crab'd's custom providers are OpenAI-compatible endpoints; the schema's `api` default says so. */
type OpenAiModel = Model<'openai-completions'>;

/**
 * Every model specifier a run could reach: the default, each mode's override, the rate-limit fallback
 * chain, and the verify model. A custom provider has no catalog to look models up in, so each one it
 * serves has to be declared, and this is the list of names to declare.
 */
function referencedModels(config: ResolvedConfig): string[] {
  const specs = [
    config.model,
    ...Object.values(config.modes).map((m) => m.model),
    ...config.rateLimit.fallbackModels,
    config.review.verify.model,
  ];
  return [...new Set(specs.filter((s): s is string => Boolean(s)))];
}

/** Declare one model for a custom provider, carrying whatever metadata the config supplied. */
function customModel(provider: ResolvedCustomProvider, modelId: string): OpenAiModel {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: provider.id,
    baseUrl: provider.baseUrl,
    // An unknown window makes the agent compact every turn and collapses the output cap to a single
    // token, so `context_window` is the field that matters most here. `reasoning` cannot be inferred
    // from the endpoint at all: only the config knows whether the served model produces it.
    reasoning: provider.reasoning ?? false,
    input: provider.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: provider.contextWindow ?? 0,
    maxTokens: provider.maxTokens ?? 0,
  };
}

function buildCustomProvider(provider: ResolvedCustomProvider, modelIds: string[]): Provider {
  const apiKeyEnv = provider.apiKeyEnv;
  return createProvider<'openai-completions'>({
    id: provider.id,
    name: provider.id,
    baseUrl: provider.baseUrl,
    auth: apiKeyEnv ? { apiKey: envApiKeyAuth(`${provider.id} API key`, [apiKeyEnv]) } : {},
    api: openAICompletionsApi(),
    models: modelIds.map((id) => customModel(provider, id)),
  }) as Provider;
}

/**
 * Re-declare a built-in provider with its endpoint pointed at the org egress gateway, keeping every
 * model's catalog metadata. v2 has no endpoint-override surface — replacing the provider with one
 * whose models carry the values you need is the documented way to change it.
 */
function buildGatewayProvider(providerId: string, gateway: string): Provider | undefined {
  let models: readonly OpenAiModel[];
  try {
    models = getBuiltinModels(providerId as BuiltinProvider) as unknown as readonly OpenAiModel[];
  } catch {
    return undefined;
  }
  if (models.length === 0) return undefined;
  const baseUrl = `${gateway.replace(/\/$/, '')}/${providerId}`;
  return createProvider<'openai-completions'>({
    id: providerId,
    name: providerId,
    baseUrl,
    auth: {},
    api: openAICompletionsApi(),
    models: models.map((m) => ({ ...m, baseUrl })),
  }) as Provider;
}

/**
 * The providers this run registers, or `undefined` to keep pi-ai's full built-in set.
 *
 * `start({ providers })` replaces the default set outright, so once anything custom is in play the
 * built-ins have to be passed alongside it or `anthropic/*` and friends stop resolving.
 */
export function buildProviders(config: ResolvedConfig): Provider[] | undefined {
  const hasCustom = config.providers.custom.length > 0;
  const gateway = config.providers.gatewayUrl;
  if (!hasCustom && !gateway) return undefined;

  const customIds = new Set(config.providers.custom.map((p) => p.id));
  const referenced = referencedModels(config);
  const providers = new Map<string, Provider>();

  for (const builtin of builtinProviders()) providers.set(builtin.id, builtin);

  // Egress gateway: route allowlisted built-ins through `${gateway}/<provider>`. Custom providers own
  // their URL already, and a local ollama endpoint is not an egress concern.
  if (gateway) {
    for (const id of config.providers.allowlist) {
      if (customIds.has(id) || id === 'ollama') continue;
      const replacement = buildGatewayProvider(id, gateway);
      if (replacement) providers.set(id, replacement);
    }
  }

  for (const provider of config.providers.custom) {
    const modelIds = referenced.filter((spec) => providerOf(spec) === provider.id).map((spec) => spec.slice(spec.indexOf('/') + 1));
    providers.set(provider.id, buildCustomProvider(provider, modelIds.length > 0 ? modelIds : ['default']));
  }

  return [...providers.values()];
}

/**
 * Custom-provider models whose context window is unknown. An unknown window is not a soft
 * degradation: threshold compaction cannot engage and every request goes out capped at one output
 * token, which reads as the model emitting a single reasoning token and never calling a tool.
 */
export function unsizedCustomModels(config: ResolvedConfig): string[] {
  const unsized = new Set(
    config.providers.custom.filter((p) => p.contextWindow === undefined).map((p) => p.id),
  );
  if (unsized.size === 0) return [];
  return referencedModels(config).filter((spec) => unsized.has(providerOf(spec)));
}
