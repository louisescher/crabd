import { providerOf, type ResolvedConfig } from '@crabd/config';

export interface ProviderCheckResult {
  ok: boolean;
  /** Human-readable violations, e.g. `mode "review" model openai/gpt-5.5 uses provider "openai" (not allowlisted)`. */
  violations: string[];
}

/**
 * Verify every model that could be used (the default model, each mode's override,
 * and every rate-limit fallback model) targets an allowlisted provider. This is the
 * egress guardrail: repo code must only reach approved LLM providers — including the
 * models crab'd would fall back to when the primary is rate-limited.
 */
export function checkProviderAllowlist(config: ResolvedConfig): ProviderCheckResult {
  // An empty allowlist means "allow any provider" — crab'd works with zero config.
  // Set a non-empty allowlist (and lock it at the org level) to restrict egress.
  if (config.providers.allowlist.length === 0) return { ok: true, violations: [] };

  const allow = new Set(config.providers.allowlist);
  const violations: string[] = [];

  const check = (model: string, where: string) => {
    const provider = providerOf(model);
    if (!allow.has(provider)) {
      violations.push(`${where} model ${model} uses provider "${provider}", which is not allowlisted`);
    }
  };

  check(config.model, 'default');
  for (const [name, mode] of Object.entries(config.modes)) {
    if (mode.model) check(mode.model, `mode "${name}"`);
  }
  for (const model of config.rateLimit.fallbackModels) {
    check(model, 'rate_limit fallback');
  }

  return { ok: violations.length === 0, violations };
}

/** Assert the provider allowlist holds, throwing with all violations otherwise. */
export function assertProvidersAllowed(config: ResolvedConfig): void {
  const result = checkProviderAllowlist(config);
  if (!result.ok) {
    throw new Error(`crabd provider allowlist violated:\n- ${result.violations.join('\n- ')}`);
  }
}
