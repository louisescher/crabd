import { describe, expect, it } from 'vitest';
import { CRASH_MARKER, renderCrashNotice, TRACKING_MARKER, type CommentContext } from './tracking.ts';

const branding: CommentContext = { name: 'DevBot', emoji: '🐙', footer: true };

describe('renderCrashNotice', () => {
  it('carries the crash marker and never the tracking marker', () => {
    const body = renderCrashNotice(branding, { mode: 'mention', kind: 'crashed' });
    expect(body).toContain(CRASH_MARKER);
    expect(body).not.toContain(TRACKING_MARKER);
  });

  it('renders an actor as a leading mention', () => {
    const body = renderCrashNotice(branding, { mode: 'mention', kind: 'crashed', actor: 'octocat' });
    expect(body.startsWith('@octocat ')).toBe(true);
  });

  it('renders no leading mention when there is no actor', () => {
    const body = renderCrashNotice(branding, { mode: 'mention', kind: 'crashed' });
    expect(body.startsWith('@')).toBe(false);
  });

  it('renders a run logs link when the branding carries a runUrl', () => {
    const body = renderCrashNotice({ ...branding, runUrl: 'https://ci/run/1' }, { mode: 'mention', kind: 'crashed' });
    expect(body).toContain('[run logs](https://ci/run/1)');
  });

  it('renders no run logs link when the branding has no runUrl', () => {
    const body = renderCrashNotice(branding, { mode: 'mention', kind: 'crashed' });
    expect(body).not.toContain('run logs');
  });

  it('says it ran out of memory for a resource_exhausted kind', () => {
    const body = renderCrashNotice(branding, { mode: 'mention', kind: 'resource_exhausted' });
    expect(body).toContain('ran out of memory');
  });

  it('says it ran out of time for a timeout kind', () => {
    const body = renderCrashNotice(branding, { mode: 'mention', kind: 'timeout' });
    expect(body).toContain('ran out of time');
  });

  it('falls back to the generic wording for an unmapped or crashed kind', () => {
    const body = renderCrashNotice(branding, { mode: 'mention', kind: 'crashed' });
    expect(body).toContain('the run ended without reporting a result');
  });

  it('uses the mode verb, with mention and review rendering differently', () => {
    const mention = renderCrashNotice(branding, { mode: 'mention', kind: 'crashed' });
    const review = renderCrashNotice(branding, { mode: 'review', kind: 'crashed' });
    expect(mention).toContain('working on your request');
    expect(review).toContain('reviewing this pull request');
  });
});
