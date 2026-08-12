import { describe, expect, it } from 'vitest';
import { classifyModelError } from '@crabd/core';
import { describeTurnError } from './turn-runner.ts';

/**
 * The pairing these tests protect: `handle.read()` rejects with an `AgentRunError` carrying only
 * `{ outcome, submissionId }`, so the provider's status is only available on the runtime's event
 * stream. If the two halves stop lining up, every rate limit classifies as fatal and the fallback
 * chain silently stops engaging — which is exactly how it broke during the flue 2 port.
 */
describe('describeTurnError', () => {
  it('surfaces the provider status from a serialized FlueError, so the classifier can see it', () => {
    // The real shape observed on the `operation` and `submission_settled` events.
    const flattened = describeTurnError({
      name: 'FlueError',
      message: 'dispatch(sub_01ABC) failed: 429: {"message":"Rate limit exceeded","type":"rate_limit_error"}',
      type: 'operation_failed',
      details: '',
      meta: { operation: 'dispatch(sub_01ABC)', reason: '429: {"message":"Rate limit exceeded"}' },
    });
    expect(flattened).toContain('429');
    expect(classifyModelError(flattened)).toBe('rate_limit');
  });

  it('reads the status out of meta even when the message alone does not carry it', () => {
    const flattened = describeTurnError({
      name: 'FlueError',
      message: 'Agent run failed.',
      meta: { reason: '429 rate_limit_error' },
    });
    expect(classifyModelError(flattened)).toBe('rate_limit');
  });

  it('keeps a 529 overload classifiable', () => {
    const flattened = describeTurnError({ message: 'call failed', meta: { reason: '529 overloaded' } });
    expect(classifyModelError(flattened)).toBe('rate_limit');
  });

  it('leaves a genuine fatal fatal, so a bad model id does not walk the chain', () => {
    const flattened = describeTurnError({
      name: 'FlueError',
      message: 'dispatch(sub_01ABC) failed: 404 status code (no body)',
      meta: { reason: '404 status code (no body)' },
    });
    expect(classifyModelError(flattened)).toBe('fatal');
  });

  it('handles a bare string and an empty error without throwing', () => {
    expect(describeTurnError('429 too many requests')).toBe('429 too many requests');
    expect(describeTurnError(undefined)).toBe('');
  });

  it('falls back to JSON for a shape it does not recognize', () => {
    expect(describeTurnError({ weird: true })).toBe('{"weird":true}');
  });
});
