import type { ResolvedBackoff } from '@crabd/config';

/**
 * Compute the backoff delay (ms) before the `retryNumber`-th crab'd-level retry
 * (`retryNumber = 1` is the wait before the first fallback attempt).
 *
 * Delays are always **computed** — crab'd cannot honor a provider's `retry-after`
 * (the underlying framework drops the header) — and they stack on top of the
 * framework's own per-model retries. The result is clamped to `maxDelaySeconds`.
 *
 * `rng` is injectable so jitter is deterministic in tests.
 */
export function computeBackoffDelayMs(
  retryNumber: number,
  backoff: ResolvedBackoff,
  rng: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(retryNumber));
  const initial = Math.max(0, backoff.initialDelaySeconds);

  let seconds: number;
  switch (backoff.strategy) {
    case 'linear':
      seconds = initial * n;
      break;
    case 'constant':
      seconds = initial;
      break;
    case 'exponential':
    default:
      seconds = initial * backoff.multiplier ** (n - 1);
      break;
  }

  seconds = Math.min(seconds, Math.max(0, backoff.maxDelaySeconds));

  if (backoff.jitter) {
    // Equal jitter: keep at least half the delay and spread the rest. Avoids both
    // a thundering herd and near-zero waits that would defeat the backoff.
    seconds = seconds * (0.5 + rng() * 0.5);
  }

  return Math.round(seconds * 1000);
}
