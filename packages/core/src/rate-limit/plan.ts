import type { RateLimitTriggerScope } from '@crabd/config';
import type { ModelErrorClass } from './classify.ts';

/**
 * Build the ordered attempt chain: the primary model first, then the fallback
 * models in order, capped by `maxRetries` (total attempts = maxRetries + 1). The
 * primary is always present even if `maxRetries` is 0. Empty/blank fallback
 * entries are dropped.
 */
export function buildAttemptChain(
  primaryModel: string,
  fallbackModels: string[],
  maxRetries: number,
): string[] {
  const chain = [primaryModel, ...fallbackModels.filter((m) => typeof m === 'string' && m.trim().length > 0)];
  const cap = Math.max(1, Math.floor(maxRetries) + 1);
  return chain.slice(0, cap);
}

/**
 * Whether an error class is in scope for retry/fallback under the configured
 * trigger scope:
 * - `rate-limit`: only rate-limit / overload (429 / 529 / "rate limit" / "overloaded").
 * - `transient` (default): rate limits, other transient errors (5xx / network /
 *   timeout), and quota/billing (which warrant a *cross-provider* fallback).
 * - `all`: any error, including otherwise-fatal ones.
 */
export function isInFallbackScope(errorClass: ModelErrorClass, scope: RateLimitTriggerScope): boolean {
  if (scope === 'all') return true;
  if (scope === 'rate-limit') return errorClass === 'rate_limit';
  return errorClass === 'rate_limit' || errorClass === 'transient_other' || errorClass === 'quota';
}
