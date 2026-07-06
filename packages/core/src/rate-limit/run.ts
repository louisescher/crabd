import type { RateLimitTriggerScope, ResolvedBackoff } from '@crabd/config';
import { classifyModelError } from './classify.ts';
import { computeBackoffDelayMs } from './backoff.ts';
import { isInFallbackScope } from './plan.ts';

export interface RunWithFallbackOptions<T> {
  /** Ordered model chain: primary first, then fallbacks (see {@link buildAttemptChain}). */
  chain: string[];
  triggerScope: RateLimitTriggerScope;
  backoff: ResolvedBackoff;
  /** Total wall-clock budget (ms) for the whole sequence. */
  maxWaitMs: number;
  /** Run one attempt on `model`. Resolves with the result, or throws on failure. */
  runOnce: (model: string, index: number) => Promise<T>;
  /** Called just before crab'd waits and switches to the next model (e.g. to update the comment). */
  onSwitch?: (info: { fromModel: string; nextModel: string; attempt: number; waitMs: number }) => void;
  /**
   * Treat a thrown error as fatal (rethrow immediately) regardless of its message
   * — e.g. a deliberate `max_turns` abort that must not be mistaken for a rate limit.
   */
  isFatal?: (error: unknown) => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  rng?: () => number;
}

export interface RunSuccess<T> {
  ok: true;
  result: T;
  model: string;
  index: number;
  attempts: number;
  /** True when a fallback model (not the primary) produced the result. */
  fellBack: boolean;
}

export interface RunExhausted {
  ok: false;
  attempts: number;
  lastModel: string;
  lastError: string;
}

export type RunOutcome<T> = RunSuccess<T> | RunExhausted;

/**
 * Walk the model chain once (primary → fallbacks), retrying on in-scope (rate-limit /
 * transient / quota) failures with computed backoff between switches, bounded by a
 * total wall-clock budget. Stops when a model succeeds, the chain ends, or the budget
 * runs out. Out-of-scope (fatal) errors and errors flagged by `isFatal` propagate as
 * thrown exceptions — the caller's generic error path handles those.
 *
 * The framework already retries the *same* model internally before `runOnce` rejects,
 * so this loop's job is to move to a *different* model and to bound the total wait.
 */
export async function runWithFallback<T>(options: RunWithFallbackOptions<T>): Promise<RunOutcome<T>> {
  const { chain, triggerScope, backoff, maxWaitMs, runOnce } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const rng = options.rng ?? Math.random;
  const isFatal = options.isFatal ?? (() => false);

  const startedAt = now();
  let lastError = '';
  let lastModel = chain[0] ?? '';
  let attempts = 0;

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    lastModel = model;
    attempts = i + 1;

    try {
      const result = await runOnce(model, i);
      return { ok: true, result, model, index: i, attempts, fellBack: i > 0 };
    } catch (error) {
      if (isFatal(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      if (!isInFallbackScope(classifyModelError(message), triggerScope)) throw error;

      const hasNext = i + 1 < chain.length;
      const remainingMs = maxWaitMs - (now() - startedAt);
      if (!hasNext || remainingMs <= 0) break;

      const waitMs = Math.min(computeBackoffDelayMs(i + 1, backoff, rng), remainingMs);
      options.onSwitch?.({ fromModel: model, nextModel: chain[i + 1]!, attempt: i + 2, waitMs });
      if (waitMs > 0) await sleep(waitMs);
    }
  }

  return { ok: false, attempts, lastModel, lastError };
}
