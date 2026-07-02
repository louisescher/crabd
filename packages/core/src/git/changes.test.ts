import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectChanges, hasChanges } from './changes.ts';

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'crabd-git-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'keep.txt'), 'A');
  writeFileSync(join(dir, 'gone.txt'), 'B');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  // Working-tree changes: modify, delete, add-new.
  writeFileSync(join(dir, 'keep.txt'), 'A2');
  rmSync(join(dir, 'gone.txt'));
  writeFileSync(join(dir, 'new.txt'), 'C');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('collectChanges', () => {
  it('emits upsert (base64) for modified/added and delete for removed files', () => {
    const byPath = new Map(collectChanges(dir).map((c) => [c.path, c]));

    expect(byPath.get('keep.txt')).toEqual({
      path: 'keep.txt',
      op: 'upsert',
      contentBase64: Buffer.from('A2').toString('base64'),
    });
    expect(byPath.get('new.txt')).toEqual({
      path: 'new.txt',
      op: 'upsert',
      contentBase64: Buffer.from('C').toString('base64'),
    });
    expect(byPath.get('gone.txt')).toEqual({ path: 'gone.txt', op: 'delete' });
  });

  it('reports a dirty working tree', () => {
    expect(hasChanges(dir)).toBe(true);
  });
});
