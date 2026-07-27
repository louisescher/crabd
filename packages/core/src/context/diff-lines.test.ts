import { describe, expect, it } from 'vitest';
import {
  commentableLines,
  describeCommentableLines,
  expandCommentableLines,
  snapToCommentableLine,
} from './diff-lines.ts';

describe('commentableLines', () => {
  it('records added and context lines on the new side, skipping removed lines', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;', // context → new line 1
      '-const b = 2;', // removed → no new-side line
      '+const b = 3;', // added → new line 2
      '+const c = 4;', // added → new line 3
      ' const d = 5;', // context → new line 4
      '',
    ].join('\n');

    const map = commentableLines(diff);
    expect([...(map.get('src/a.ts') ?? [])].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
  });

  it('handles multiple hunks with the offset from each header', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '+first',
      '@@ -10,2 +20,2 @@',
      ' ctx',
      '+added',
      '',
    ].join('\n');

    const map = commentableLines(diff);
    expect([...(map.get('x.ts') ?? [])].sort((a, b) => a - b)).toEqual([1, 20, 21]);
  });

  it('separates lines by file across multiple sections', () => {
    const diff = [
      'diff --git a/one.ts b/one.ts',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
      'diff --git a/two.ts b/two.ts',
      '--- a/two.ts',
      '+++ b/two.ts',
      '@@ -5,0 +6,1 @@',
      '+c',
      '',
    ].join('\n');

    const map = commentableLines(diff);
    expect([...(map.get('one.ts') ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...(map.get('two.ts') ?? [])]).toEqual([6]);
  });

  it('keys renames by the new path', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1,1 +1,1 @@',
      '+renamed',
      '',
    ].join('\n');

    const map = commentableLines(diff);
    expect(map.has('new.ts')).toBe(true);
    expect(map.has('old.ts')).toBe(false);
  });

  it('returns an empty map for a non-diff string', () => {
    expect(commentableLines('not a diff').size).toBe(0);
  });
});

describe('describeCommentableLines', () => {
  it('collapses contiguous lines into ranges and keeps singletons bare', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' one',
      ' two',
      '+three',
      '@@ -40,1 +41,1 @@',
      '+forty-one',
      '@@ -90,2 +91,3 @@',
      ' ninety-one',
      '+ninety-two',
      ' ninety-three',
      '',
    ].join('\n');

    expect(describeCommentableLines(diff)).toEqual([{ path: 'src/a.ts', ranges: ['1-3', '41', '91-93'] }]);
  });

  it('describes each changed file separately', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '+a',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -5,1 +5,1 @@',
      '+b',
      '',
    ].join('\n');

    expect(describeCommentableLines(diff)).toEqual([
      { path: 'a.ts', ranges: ['1'] },
      { path: 'b.ts', ranges: ['5'] },
    ]);
  });

  it('returns nothing for a non-diff string', () => {
    expect(describeCommentableLines('not a diff')).toEqual([]);
  });
});

describe('expandCommentableLines', () => {
  it('round-trips describeCommentableLines output back to the original line sets', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' one',
      ' two',
      '+three',
      '@@ -90,1 +91,1 @@',
      '+ninety-one',
      '',
    ].join('\n');

    const original = commentableLines(diff);
    const round = expandCommentableLines(describeCommentableLines(diff));
    expect([...round.keys()]).toEqual([...original.keys()]);
    expect([...(round.get('src/a.ts') ?? [])].sort((a, b) => a - b)).toEqual(
      [...(original.get('src/a.ts') ?? [])].sort((a, b) => a - b),
    );
  });

  it('expands bare numbers and ranges alike', () => {
    const map = expandCommentableLines([{ path: 'x.ts', ranges: ['3', '7-9'] }]);
    expect([...(map.get('x.ts') ?? [])].sort((a, b) => a - b)).toEqual([3, 7, 8, 9]);
  });

  it('skips malformed ranges rather than producing NaN keys', () => {
    const map = expandCommentableLines([{ path: 'x.ts', ranges: ['oops', '', '5'] }]);
    expect([...(map.get('x.ts') ?? [])]).toEqual([5]);
  });

  it('omits a file whose ranges yield nothing', () => {
    expect(expandCommentableLines([{ path: 'x.ts', ranges: ['nope'] }]).has('x.ts')).toBe(false);
  });
});

describe('snapToCommentableLine', () => {
  const lines = new Map([['src/a.ts', new Set([10, 11, 12, 40])]]);

  it('returns the line unchanged when it is already legal', () => {
    expect(snapToCommentableLine(lines, 'src/a.ts', 11, 5)).toBe(11);
  });

  it('snaps a near miss to the closest legal line', () => {
    expect(snapToCommentableLine(lines, 'src/a.ts', 14, 5)).toBe(12);
    expect(snapToCommentableLine(lines, 'src/a.ts', 8, 5)).toBe(10);
  });

  it('refuses to snap beyond the tolerance', () => {
    expect(snapToCommentableLine(lines, 'src/a.ts', 25, 5)).toBeUndefined();
    expect(snapToCommentableLine(lines, 'src/a.ts', 100, 5)).toBeUndefined();
  });

  it('breaks a tie toward the earlier line, deterministically', () => {
    // 11 is equidistant from 10 and 12 in a set that omits it.
    const tie = new Map([['x.ts', new Set([10, 12])]]);
    expect(snapToCommentableLine(tie, 'x.ts', 11, 5)).toBe(10);
  });

  it('returns undefined for a file with no commentable lines at all', () => {
    expect(snapToCommentableLine(lines, 'other.ts', 10, 5)).toBeUndefined();
  });
});
