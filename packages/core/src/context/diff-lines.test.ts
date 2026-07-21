import { describe, expect, it } from 'vitest';
import { commentableLines } from './diff-lines.ts';

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
