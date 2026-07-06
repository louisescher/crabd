import { describe, expect, it } from 'vitest';
import type { ResolvedBackoff } from '@crabd/config';
import { classifyModelError } from './classify.ts';
import { computeBackoffDelayMs } from './backoff.ts';
import { buildAttemptChain, isInFallbackScope } from './plan.ts';
import { runWithFallback } from './run.ts';

const backoff = (o: Partial<ResolvedBackoff> = {}): ResolvedBackoff => ({
  strategy: 'exponential',
  initialDelaySeconds: 2,
  maxDelaySeconds: 30,
  multiplier: 2,
  jitter: false,
  ...o,
});

describe('classifyModelError', () => {
  it('classifies rate limits / overload (incl. 529 which the framework misses)', () => {
    expect(classifyModelError('429 Too Many Requests')).toBe('rate_limit');
    expect(classifyModelError('prompt failed: 429 {"type":"rate_limit_error"}')).toBe('rate_limit');
    expect(classifyModelError('rate limit reached')).toBe('rate_limit');
    expect(classifyModelError('Overloaded')).toBe('rate_limit');
    expect(classifyModelError('529 overloaded_error')).toBe('rate_limit');
  });

  it('classifies other transient failures (5xx / network / timeout)', () => {
    expect(classifyModelError('503 Service Unavailable')).toBe('transient_other');
    expect(classifyModelError('500 internal server error')).toBe('transient_other');
    expect(classifyModelError('fetch failed')).toBe('transient_other');
    expect(classifyModelError('socket hang up')).toBe('transient_other');
    expect(classifyModelError('request timed out')).toBe('transient_other');
    expect(classifyModelError('ETIMEDOUT')).toBe('transient_other');
  });

  it('classifies hard quota/billing (checked before rate-limit)', () => {
    expect(classifyModelError('insufficient_quota')).toBe('quota');
    expect(classifyModelError('You exceeded your current quota')).toBe('quota');
    expect(classifyModelError('billing hard limit reached')).toBe('quota');
    // OpenAI shape: 429 status but a quota cause → quota wins.
    expect(classifyModelError('429 You exceeded your current quota, insufficient_quota')).toBe('quota');
  });

  it('treats everything else as fatal', () => {
    expect(classifyModelError('400 invalid_request_error')).toBe('fatal');
    expect(classifyModelError('401 authentication_error')).toBe('fatal');
    expect(classifyModelError('tool execution failed')).toBe('fatal');
    expect(classifyModelError('')).toBe('fatal');
    expect(classifyModelError(undefined)).toBe('fatal');
  });
});

describe('computeBackoffDelayMs', () => {
  it('exponential grows by the multiplier (jitter off)', () => {
    expect(computeBackoffDelayMs(1, backoff())).toBe(2000);
    expect(computeBackoffDelayMs(2, backoff())).toBe(4000);
    expect(computeBackoffDelayMs(3, backoff())).toBe(8000);
  });

  it('clamps to max_delay_seconds', () => {
    // 2 * 2^5 = 64s, clamped to 30s.
    expect(computeBackoffDelayMs(6, backoff())).toBe(30000);
  });

  it('linear grows by the retry number', () => {
    expect(computeBackoffDelayMs(1, backoff({ strategy: 'linear' }))).toBe(2000);
    expect(computeBackoffDelayMs(3, backoff({ strategy: 'linear' }))).toBe(6000);
  });

  it('constant is flat', () => {
    expect(computeBackoffDelayMs(1, backoff({ strategy: 'constant' }))).toBe(2000);
    expect(computeBackoffDelayMs(5, backoff({ strategy: 'constant' }))).toBe(2000);
  });

  it('equal jitter keeps [0.5x, 1x] of the base delay', () => {
    const cfg = backoff({ jitter: true });
    expect(computeBackoffDelayMs(1, cfg, () => 0)).toBe(1000); // 0.5 * 2000
    expect(computeBackoffDelayMs(1, cfg, () => 1)).toBe(2000); // 1.0 * 2000
    expect(computeBackoffDelayMs(1, cfg, () => 0.5)).toBe(1500); // 0.75 * 2000
  });
});

describe('buildAttemptChain', () => {
  it('puts the primary first, then fallbacks in order', () => {
    expect(buildAttemptChain('a', ['b', 'c'], 4)).toEqual(['a', 'b', 'c']);
  });

  it('always includes the primary even with no fallbacks or zero retries', () => {
    expect(buildAttemptChain('a', [], 4)).toEqual(['a']);
    expect(buildAttemptChain('a', ['b'], 0)).toEqual(['a']);
  });

  it('caps total attempts at max_retries + 1', () => {
    expect(buildAttemptChain('a', ['b', 'c', 'd'], 1)).toEqual(['a', 'b']);
  });

  it('drops blank fallback entries', () => {
    expect(buildAttemptChain('a', ['', '   ', 'b'], 4)).toEqual(['a', 'b']);
  });
});

describe('isInFallbackScope', () => {
  it('rate-limit scope: only rate limits', () => {
    expect(isInFallbackScope('rate_limit', 'rate-limit')).toBe(true);
    expect(isInFallbackScope('transient_other', 'rate-limit')).toBe(false);
    expect(isInFallbackScope('quota', 'rate-limit')).toBe(false);
    expect(isInFallbackScope('fatal', 'rate-limit')).toBe(false);
  });

  it('transient scope: rate limits, transient, and quota (cross-provider) — not fatal', () => {
    expect(isInFallbackScope('rate_limit', 'transient')).toBe(true);
    expect(isInFallbackScope('transient_other', 'transient')).toBe(true);
    expect(isInFallbackScope('quota', 'transient')).toBe(true);
    expect(isInFallbackScope('fatal', 'transient')).toBe(false);
  });

  it('all scope: everything, including fatal', () => {
    expect(isInFallbackScope('fatal', 'all')).toBe(true);
    expect(isInFallbackScope('rate_limit', 'all')).toBe(true);
  });
});

describe('runWithFallback', () => {
  // A fake clock: sleep advances "wall-clock" time so budget checks are deterministic.
  function harness(maxWaitMs = 180_000) {
    let t = 0;
    const sleeps: number[] = [];
    const switches: Array<{ fromModel: string; nextModel: string; attempt: number; waitMs: number }> = [];
    return {
      sleeps,
      switches,
      base: {
        triggerScope: 'transient' as const,
        backoff: backoff(),
        maxWaitMs,
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
          sleeps.push(ms);
        },
        rng: () => 1,
        onSwitch: (info: { fromModel: string; nextModel: string; attempt: number; waitMs: number }) =>
          switches.push(info),
      },
    };
  }

  it('succeeds on the primary without waiting or switching', async () => {
    const h = harness();
    const outcome = await runWithFallback<string>({
      ...h.base,
      chain: ['a'],
      runOnce: async (model) => `ran ${model}`,
    });
    expect(outcome).toMatchObject({ ok: true, model: 'a', index: 0, attempts: 1, fellBack: false });
    expect(h.sleeps).toEqual([]);
    expect(h.switches).toEqual([]);
  });

  it('falls back to the next model on a rate-limit, with backoff', async () => {
    const h = harness();
    const outcome = await runWithFallback<string>({
      ...h.base,
      chain: ['a', 'b'],
      runOnce: async (model) => {
        if (model === 'a') throw new Error('429 Too Many Requests');
        return `ran ${model}`;
      },
    });
    expect(outcome).toMatchObject({ ok: true, model: 'b', attempts: 2, fellBack: true });
    expect(h.sleeps).toEqual([2000]); // exponential retry #1, jitter rng=1 → full delay
    expect(h.switches).toEqual([{ fromModel: 'a', nextModel: 'b', attempt: 2, waitMs: 2000 }]);
  });

  it('reports exhaustion when every model is rate-limited', async () => {
    const h = harness();
    const outcome = await runWithFallback<string>({
      ...h.base,
      chain: ['a', 'b'],
      runOnce: async () => {
        throw new Error('429 rate limit');
      },
    });
    expect(outcome).toMatchObject({ ok: false, attempts: 2, lastModel: 'b' });
    if (!outcome.ok) expect(outcome.lastError).toContain('429');
  });

  it('stops early when the wait budget is exhausted (does not reach later models)', async () => {
    const h = harness(1000); // budget < a single 2000ms backoff
    const outcome = await runWithFallback<string>({
      ...h.base,
      chain: ['a', 'b', 'c'],
      runOnce: async () => {
        throw new Error('overloaded');
      },
    });
    // a fails → wait min(2000,1000)=1000 → b fails → remaining 0 → stop before c.
    expect(outcome).toMatchObject({ ok: false, attempts: 2 });
    expect(h.sleeps).toEqual([1000]);
  });

  it('rethrows an out-of-scope (fatal) error instead of falling back', async () => {
    const h = harness();
    await expect(
      runWithFallback<string>({
        ...h.base,
        chain: ['a', 'b'],
        runOnce: async () => {
          throw new Error('400 invalid_request_error');
        },
      }),
    ).rejects.toThrow('invalid_request_error');
    expect(h.switches).toEqual([]);
  });

  it('rethrows immediately when isFatal flags the error (e.g. max_turns abort)', async () => {
    const h = harness();
    await expect(
      runWithFallback<string>({
        ...h.base,
        chain: ['a', 'b'],
        isFatal: () => true,
        runOnce: async () => {
          throw new Error('429'); // would be in-scope, but isFatal wins
        },
      }),
    ).rejects.toThrow('429');
    expect(h.switches).toEqual([]);
  });
});
