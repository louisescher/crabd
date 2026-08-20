import { describe, expect, it } from 'vitest';
import { splitSections } from '../context/diff-parse.ts';
import { commentableLines } from '../context/diff-lines.ts';
import { buildDiffFromFiles } from './synth-diff.ts';

const modified = {
  filename: 'src/a.ts',
  status: 'modified',
  patch: ['@@ -1,3 +1,4 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;', ' const d = 5;'].join('\n'),
};

describe('buildDiffFromFiles', () => {
  it('produces sections the diff parsers can split by path', () => {
    const diff = buildDiffFromFiles([
      modified,
      { filename: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1,2 @@\n+const x = 1;\n+const y = 2;' },
      { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-const z = 1;' },
      { filename: 'src/moved.ts', status: 'renamed', previous_filename: 'src/old.ts', patch: '@@ -1 +1 @@\n-const q = 1;\n+const q = 2;' },
    ]);

    expect(splitSections(diff).map((s) => s.path)).toEqual(['src/a.ts', 'src/new.ts', 'src/gone.ts', 'src/moved.ts']);
  });

  it('keeps new-side line numbers anchorable', () => {
    const map = commentableLines(buildDiffFromFiles([modified]));
    expect([...(map.get('src/a.ts') ?? [])].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
  });

  it('marks a file whose patch the API withheld', () => {
    const diff = buildDiffFromFiles([{ filename: 'logo.png', status: 'modified' }]);
    expect(splitSections(diff).map((s) => s.path)).toEqual(['logo.png']);
    expect(diff).toContain('patch unavailable');
  });

  it('returns an empty diff for no files', () => {
    expect(buildDiffFromFiles([])).toBe('');
  });
});
