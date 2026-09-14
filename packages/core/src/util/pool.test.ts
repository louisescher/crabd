import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './pool.ts';

describe('mapWithConcurrency', () => {
  it('keeps the order of the input', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it('never exceeds the given width', async () => {
    let live = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 4, async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 1));
      live -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('returns an empty array for no items without calling the mapper', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 8, async () => {
      calls += 1;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('propagates the first rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('stops handing out work once a call has failed', async () => {
    const seen: number[] = [];
    await expect(
      mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), 2, async (n) => {
        seen.push(n);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (n === 0) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(seen.length).toBeLessThan(40);
  });

  it('runs everything when the width is larger than the input', async () => {
    const out = await mapWithConcurrency([1, 2], 100, async (n) => n + 1);
    expect(out).toEqual([2, 3]);
  });
});
