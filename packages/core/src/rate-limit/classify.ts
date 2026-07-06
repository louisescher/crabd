/**
 * Provider-agnostic classification of a model error.
 *
 * The underlying agent framework (Flue → pi-ai) collapses every provider
 * exception to a plain string — there is no typed error, HTTP status field, or
 * `retry-after` header to inspect. So rate-limit detection is necessarily
 * string/regex-based, applied uniformly across all providers (Anthropic, OpenAI,
 * OpenRouter, Google, Ollama, …). This mirrors Flue's own retryable classifier,
 * adds `529` (which Flue misses), and splits hard quota/billing errors into their
 * own class (futile to retry on the same model, but a valid reason to fall back to
 * a different provider).
 */
export type ModelErrorClass = 'rate_limit' | 'transient_other' | 'quota' | 'fatal';

/** Hard limits: retrying the same model is futile, but another provider may work. */
const QUOTA =
  /insufficient[_\s-]?quota|quota\s+exceeded|exceeded your (?:current )?quota|\bbilling\b|payment required|\b402\b|go ?usage ?limit|usagelimit/i;

/** Rate limiting / overload — the classic transient class. Includes 529 (overloaded). */
const RATE_LIMIT = /\b429\b|\b529\b|rate[_\s-]?limit|too many requests|overloaded/i;

/** Other transient failures: server 5xx, network, timeouts. */
const TRANSIENT =
  /\b(?:500|502|503|504)\b|service[_\s-]?unavailable|server[_\s-]?error|internal server error|network[_\s-]?error|connection[_\s-]?(?:reset|refused|closed|lost)|socket hang up|fetch failed|timed?\s?out|\btimeout\b|econnreset|etimedout|terminated/i;

/**
 * Classify a model-error message. Quota is checked first so a message that carries
 * both `429` and `insufficient_quota` (OpenAI's shape) is treated as quota, not a
 * plain rate limit.
 */
export function classifyModelError(message: string | undefined | null): ModelErrorClass {
  if (!message) return 'fatal';
  if (QUOTA.test(message)) return 'quota';
  if (RATE_LIMIT.test(message)) return 'rate_limit';
  if (TRANSIENT.test(message)) return 'transient_other';
  return 'fatal';
}
