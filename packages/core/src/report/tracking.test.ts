import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRANDING,
  renderError,
  renderProgress,
  renderRateLimitExhausted,
  renderResult,
  renderWorking,
  TRACKING_MARKER,
  type Branding,
} from './tracking.ts';

const custom: Branding = { name: 'DevBot', emoji: '🐙', footer: true };
const noEmoji: Branding = { name: 'DevBot', emoji: '', footer: true };
const noFooter: Branding = { name: 'DevBot', emoji: '🐙', footer: false };

describe('tracking branding — name', () => {
  it('uses the configured name in the header instead of crab\'d', () => {
    const body = renderWorking(custom, 'mention');
    expect(body).toContain('**DevBot** is working');
    expect(body).not.toContain("crab'd");
  });

  it('applies to progress, result, error, and exhausted comments', () => {
    expect(renderProgress(custom, 'mention', 'step one')).toContain('**DevBot**');
    expect(renderResult(custom, { mode: 'implement', summary: 'Done' })).toContain('DevBot');
    expect(renderError(custom, 'mention', 'boom')).toContain('**DevBot** hit an error');
    expect(renderRateLimitExhausted(custom, { mode: 'review', attempts: 2, soft: true })).toContain('**DevBot**');
  });
});

describe('tracking branding — emoji', () => {
  it('uses the configured emoji as the lead prefix', () => {
    expect(renderWorking(custom, 'mention')).toMatch(/^🐙 \*\*DevBot\*\*/);
  });

  it('renders no leading emoji (and no stray space) when emoji is empty', () => {
    const body = renderWorking(noEmoji, 'mention');
    expect(body).toMatch(/^\*\*DevBot\*\* is working/);
    expect(body).not.toContain('🦀');
  });

  it('leaves status glyphs untouched even without a brand emoji', () => {
    expect(renderError(noEmoji, 'mention', 'boom')).toMatch(/^⚠️ \*\*DevBot\*\*/);
    expect(renderRateLimitExhausted(noEmoji, { mode: 'review', attempts: 1, soft: true })).toMatch(/^⏳/);
  });
});

describe('tracking branding — footer', () => {
  it('shows the attribution footer by default', () => {
    const body = renderWorking(custom, 'mention');
    expect(body).toContain('posted by [DevBot](https://github.com/louisescher/crabd)');
    expect(body).toContain('🐙 posted by');
    expect(body.endsWith(TRACKING_MARKER)).toBe(true);
  });

  it('drops the visible footer when disabled but keeps the hidden marker', () => {
    const body = renderWorking(noFooter, 'mention');
    expect(body).not.toContain('posted by');
    expect(body).not.toContain('<sub>');
    // The marker must survive so crab'd can find and reuse its comment.
    expect(body.endsWith(TRACKING_MARKER)).toBe(true);
  });

  it('keeps the marker on result comments with the footer off', () => {
    const body = renderResult(noFooter, { mode: 'implement', summary: 'Done', prUrl: 'http://pr/1' });
    expect(body).toContain('Done');
    expect(body).not.toContain('posted by');
    expect(body.endsWith(TRACKING_MARKER)).toBe(true);
  });
});

describe('DEFAULT_BRANDING', () => {
  it('reproduces the original crab\'d appearance', () => {
    expect(renderWorking(DEFAULT_BRANDING, 'mention')).toMatch(/^🦀 \*\*crab'd\*\* is working/);
    expect(renderWorking(DEFAULT_BRANDING, 'mention')).toContain("🦀 posted by [crab'd]");
  });
});
