import { describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../modes/review.ts';
import { buildRefuterPrompt, REFUTER_INSTRUCTIONS, survivesRefutation, type RefuterVerdict } from './verify.ts';

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: 'src/api/items.ts',
    line: 41,
    body: 'parseLimit passes the raw query value to Number() without checking for the empty string.',
    severity: 'major',
    category: 'correctness',
    shortSummary: 'parseLimit returns 0 for an empty limit param',
    failureScenario: 'a request to /items?limit= returns an empty page instead of the default 20',
    evidence: { location: 'src/api/items.ts:41', quote: 'const limit = Number(req.query.limit) || DEFAULT_LIMIT' },
    confidence: 8,
    ...over,
  };
}

const diff = [
  'diff --git a/src/api/items.ts b/src/api/items.ts',
  '--- a/src/api/items.ts',
  '+++ b/src/api/items.ts',
  '@@ -40,1 +40,2 @@',
  '+const limit = Number(req.query.limit) || DEFAULT_LIMIT;',
  'diff --git a/src/other.ts b/src/other.ts',
  '--- a/src/other.ts',
  '+++ b/src/other.ts',
  '@@ -1,1 +1,1 @@',
  '+const unrelated = true;',
  '',
].join('\n');

describe('buildRefuterPrompt', () => {
  it('passes the claim through verbatim', () => {
    const prompt = buildRefuterPrompt(finding(), { repoSlug: 'acme/app', diff });
    expect(prompt).toContain('`src/api/items.ts:41`');
    expect(prompt).toContain('parseLimit returns 0 for an empty limit param');
    expect(prompt).toContain('major (correctness)');
    expect(prompt).toContain('**Claimed failure:** a request to /items?limit=');
    expect(prompt).toContain('const limit = Number(req.query.limit) || DEFAULT_LIMIT');
  });

  it('includes only the hunk for the finding\'s own file', () => {
    const prompt = buildRefuterPrompt(finding(), { repoSlug: 'acme/app', diff });
    expect(prompt).toContain('src/api/items.ts b/src/api/items.ts');
    // Another file's changes would be noise and could pull the refuter off-task.
    expect(prompt).not.toContain('const unrelated = true;');
  });

  it('blinds the refuter to the reviewer\'s conclusions', () => {
    // This is the property the whole verify stage depends on: a refuter that can read the
    // reviewer's summary or verdict tends to agree with it rather than test the claim.
    const prompt = buildRefuterPrompt(finding(), { repoSlug: 'acme/app', diff });
    expect(prompt).not.toContain('REQUEST_CHANGES');
    expect(prompt).not.toContain('APPROVE');
    expect(prompt).not.toMatch(/summary/i);
    expect(prompt).not.toMatch(/verdict of the review|the reviewer concluded/i);
    // The blinding is stated once, in the standing instructions that apply to every refutation.
    expect(REFUTER_INSTRUCTIONS).toContain('You have not been told what the reviewer concluded');
  });

  it('hands over the question rather than a fixed procedure, and states the stakes', () => {
    const prompt = buildRefuterPrompt(finding(), { repoSlug: 'acme/app', diff });
    expect(prompt).toContain('Is this claim true?');
    expect(prompt).toContain('quote it, or construct the concrete input');
    expect(prompt).toContain("inline comment on a human's pull request");
    expect(prompt).toContain('under 150 words');
  });

  it('works without a diff, and without an evidence quote', () => {
    const prompt = buildRefuterPrompt(finding({ evidence: { location: '', quote: '' } }), { repoSlug: 'acme/app' });
    expect(prompt).toContain('## The claim to refute');
    expect(prompt).not.toContain('## The change at that location');
    expect(prompt).not.toContain('**Cited as evidence**');
  });

  it('frames refutation as the goal in the standing instructions', () => {
    expect(REFUTER_INSTRUCTIONS).toContain('try to REFUTE that claim');
    expect(REFUTER_INSTRUCTIONS).toContain('Refuting a claim is a success');
    // It must not wander into being a second reviewer.
    expect(REFUTER_INSTRUCTIONS).toContain('Do not report other problems you notice');
  });
});

describe('survivesRefutation', () => {
  const verdict = (over: Partial<RefuterVerdict> = {}): RefuterVerdict => ({
    verdict: 'CONFIRMED',
    confidence: 8,
    reason: 'reachable from the public handler',
    ...over,
  });

  it('keeps a confidently confirmed finding', () => {
    expect(survivesRefutation(verdict(), 7)).toBe(true);
  });

  it('drops a refuted finding regardless of confidence', () => {
    expect(survivesRefutation(verdict({ verdict: 'REFUTED', confidence: 10 }), 7)).toBe(false);
    expect(survivesRefutation(verdict({ verdict: 'REFUTED', confidence: 1 }), 7)).toBe(false);
  });

  it('keeps an uncertain finding out of the inline set', () => {
    expect(survivesRefutation(verdict({ verdict: 'UNCERTAIN' }), 7)).toBe(false);
  });

  it('drops a confirmation the refuter is not confident about', () => {
    expect(survivesRefutation(verdict({ confidence: 5 }), 7)).toBe(false);
    expect(survivesRefutation(verdict({ confidence: 7 }), 7)).toBe(true);
  });

  it('keeps the finding when the refuter produced nothing at all', () => {
    // A failed or timed-out extra call must not silently swallow a real finding.
    expect(survivesRefutation(undefined, 7)).toBe(true);
  });
});
