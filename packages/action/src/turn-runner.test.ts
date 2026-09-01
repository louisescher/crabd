import { describe, expect, it } from 'vitest';
import { classifyModelError } from '@crabd/core';
import { describeFatal, describeTurnError, isHarnessRecoveryFailure, retryErrorDetail } from './turn-runner.ts';

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

/**
 * What broke a real review run: the model hung for five minutes, flue retried the transient error,
 * the retry could not resume the conversation, and the run reported the harness message alone. The
 * provider's reason was on the retry log event's attributes the whole time and nothing read it.
 */
describe('retryErrorDetail', () => {
  it('reads the provider reason off a retry log event, so a later opaque failure stays classifiable', () => {
    // `waitForTransientModelRetry` passes `assistant.errorMessage`, so `error` is already a string.
    const detail = retryErrorDetail({ attempt: 1, maxRetries: 3, delayMs: 1900, error: '503 upstream timeout' });
    expect(detail).toBe('503 upstream timeout');
    expect(classifyModelError(detail)).toBe('transient_other');
  });

  it('flattens a serialized Error, which is what a non-string cause normalizes to', () => {
    const detail = retryErrorDetail({ error: { message: 'call failed', meta: { reason: '529 overloaded' } } });
    expect(classifyModelError(detail)).toBe('rate_limit');
  });

  it('stays empty for attributes that carry no error, so nothing overwrites a real reason', () => {
    expect(retryErrorDetail({ attempt: 1 })).toBe('');
    expect(retryErrorDetail(undefined)).toBe('');
    expect(retryErrorDetail('not an object')).toBe('');
  });
});

/**
 * The heap watchdog aborts the same way the max-turns budget does: a flag read out here, not
 * classified from the abort's message. Both flags have to be checked, in the right order, so the
 * tracking comment explains the actual reason instead of a generic error.
 */
describe('describeFatal', () => {
  it('classifies a resource-exhaustion abort ahead of everything else', () => {
    expect(describeFatal('crabd: aborted', true, true, 40, 60_000)).toEqual({
      kind: 'resource_exhausted',
      message: 'crabd: aborted',
    });
  });

  it('classifies a max_turns abort, carrying the configured ceiling', () => {
    expect(describeFatal('crabd: max_turns (40) exceeded', true, false, 40)).toEqual({
      kind: 'max_turns',
      message: 'crabd: max_turns (40) exceeded',
      maxTurns: 40,
    });
  });

  it('classifies a timeout by message content, carrying the configured minutes', () => {
    expect(describeFatal('the operation timed out', false, false, undefined, 120_000)).toEqual({
      kind: 'timeout',
      message: 'the operation timed out',
      timeoutMinutes: 2,
    });
  });

  it('falls back to a generic error for anything else', () => {
    expect(describeFatal('crabd: the model never called submit', false, false)).toEqual({
      kind: 'error',
      message: 'crabd: the model never called submit',
    });
  });
});

describe('isHarnessRecoveryFailure', () => {
  it('recognizes the assistant-tail rejection that pi-agent-core throws on resume', () => {
    expect(isHarnessRecoveryFailure('Cannot continue from message role: assistant')).toBe(true);
    // As it arrives in practice, with the retry reason joined on by `runAttempt`.
    expect(isHarnessRecoveryFailure('Cannot continue from message role: assistant | 503 upstream timeout')).toBe(true);
  });

  it('recognizes the other continue() refusals from the same guard', () => {
    expect(isHarnessRecoveryFailure('Cannot continue: no messages in context')).toBe(true);
    expect(isHarnessRecoveryFailure('No messages to continue from')).toBe(true);
  });

  it('leaves failures a fresh instance cannot fix alone', () => {
    // A deliberate budget abort must not buy a second full turn.
    expect(isHarnessRecoveryFailure('crabd: max_turns (40) exceeded')).toBe(false);
    expect(isHarnessRecoveryFailure('crabd: the model never called submit')).toBe(false);
    expect(isHarnessRecoveryFailure('429 Too Many Requests')).toBe(false);
    expect(isHarnessRecoveryFailure('400 invalid_request_error')).toBe(false);
    expect(isHarnessRecoveryFailure('')).toBe(false);
  });
});
