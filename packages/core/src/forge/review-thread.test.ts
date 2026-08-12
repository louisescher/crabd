import { describe, expect, it } from 'vitest';
import { FINDING_MARKER } from '../report/tracking.ts';
import { buildReviewThread, type RawReviewComment } from './review-thread.ts';

/** A GitHub-shaped review comment: explicit `in_reply_to_id` threading. */
function gh(overrides: Partial<RawReviewComment> & { id: number }): RawReviewComment {
  return {
    body: 'a comment',
    user: { login: 'alice' },
    created_at: `2026-08-12T10:0${overrides.id}:00Z`,
    path: 'src/app.ts',
    line: 42,
    diff_hunk: '@@ -1 +1 @@\n-old\n+new',
    ...overrides,
  };
}

/** A Forgejo-shaped review comment: no reply ids, diff `position` instead of a line. */
function fj(overrides: Partial<RawReviewComment> & { id: number }): RawReviewComment {
  return {
    body: 'a comment',
    user: { login: 'alice' },
    created_at: `2026-08-12T10:0${overrides.id}:00Z`,
    path: 'src/app.ts',
    original_position: 7,
    ...overrides,
  };
}

describe('buildReviewThread — GitHub threading', () => {
  it('collects a three-deep reply chain, root first', () => {
    const raw = [
      gh({ id: 1, body: `finding${FINDING_MARKER}`, user: { login: 'crabd[bot]' } }),
      gh({ id: 2, in_reply_to_id: 1, body: 'no, this is deliberate' }),
      gh({ id: 3, in_reply_to_id: 2, body: 'agreed' }),
    ];

    const thread = buildReviewThread(raw, 3);

    expect(thread?.comments.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(thread?.path).toBe('src/app.ts');
    expect(thread?.line).toBe(42);
    expect(thread?.diffHunk).toContain('+new');
  });

  it('walks up from a mid-thread comment, not just the leaf', () => {
    const raw = [gh({ id: 1 }), gh({ id: 2, in_reply_to_id: 1 }), gh({ id: 3, in_reply_to_id: 1 })];
    expect(buildReviewThread(raw, 2)?.comments.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it('excludes comments belonging to a different thread on the same file', () => {
    const raw = [
      gh({ id: 1 }),
      gh({ id: 2, in_reply_to_id: 1 }),
      gh({ id: 8, line: 99 }),
      gh({ id: 9, in_reply_to_id: 8, line: 99 }),
    ];
    expect(buildReviewThread(raw, 2)?.comments.map((c) => c.id)).toEqual([1, 2]);
  });

  it('marks a thread rooted at a crab\'d finding', () => {
    const raw = [gh({ id: 1, body: `**major** — bug here\n\n${FINDING_MARKER}` }), gh({ id: 2, in_reply_to_id: 1 })];
    expect(buildReviewThread(raw, 2)?.rootIsCrabd).toBe(true);
  });

  it("does not mark a thread a human started", () => {
    const raw = [gh({ id: 1, body: 'why is this here?' }), gh({ id: 2, in_reply_to_id: 1 })];
    expect(buildReviewThread(raw, 2)?.rootIsCrabd).toBe(false);
  });

  it('falls back to original_line when the line has scrolled out of the diff', () => {
    const raw = [gh({ id: 1, line: null, original_line: 17 })];
    expect(buildReviewThread(raw, 1)?.line).toBe(17);
  });

  it('survives a cycle in the reply chain rather than hanging', () => {
    const raw = [gh({ id: 1, in_reply_to_id: 2 }), gh({ id: 2, in_reply_to_id: 1 })];
    expect(buildReviewThread(raw, 1)?.comments.length).toBeGreaterThan(0);
  });

  it('returns undefined when the triggering comment is not in the list', () => {
    expect(buildReviewThread([gh({ id: 1 })], 999)).toBeUndefined();
  });
});

describe('buildReviewThread — Forgejo (no reply ids)', () => {
  it('groups co-located comments into one thread', () => {
    const raw = [
      fj({ id: 1, body: `finding${FINDING_MARKER}` }),
      fj({ id: 2, body: 'that is intentional' }),
      fj({ id: 3, original_position: 20, body: 'unrelated comment further down the file' }),
    ];

    const thread = buildReviewThread(raw, 2);

    expect(thread?.comments.map((c) => c.id)).toEqual([1, 2]);
    expect(thread?.rootIsCrabd).toBe(true);
    // `position` is a diff offset, not a line number, and must never be presented as one.
    expect(thread?.line).toBeUndefined();
  });

  it('keeps threads on different files apart', () => {
    const raw = [fj({ id: 1 }), fj({ id: 2, path: 'src/other.ts' })];
    expect(buildReviewThread(raw, 1)?.comments.map((c) => c.id)).toEqual([1]);
  });

  it('stays a thread of one when there is no anchor to group on', () => {
    const raw = [
      fj({ id: 1, original_position: undefined, position: undefined }),
      fj({ id: 2, original_position: undefined, position: undefined }),
    ];
    expect(buildReviewThread(raw, 1)?.comments.map((c) => c.id)).toEqual([1]);
  });
});
