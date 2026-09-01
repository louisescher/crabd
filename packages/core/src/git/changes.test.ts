import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changesForPaths, collectChangesSinceBaseline, hasChanges, snapshotBaseline } from './changes.ts';

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
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('collectChangesSinceBaseline', () => {
  it('excludes a file that was already untracked at baseline and is left unchanged', () => {
    writeFileSync(join(dir, 'ambient.txt'), 'pre-existing, never touched by the agent');
    const baseline = snapshotBaseline(dir);

    writeFileSync(join(dir, 'touched.txt'), 'the agent wrote this');

    const changes = collectChangesSinceBaseline(dir, baseline);
    const paths = changes.map((c) => c.path);
    expect(paths).toContain('touched.txt');
    expect(paths).not.toContain('ambient.txt');
  });

  it('includes a file that was already dirty at baseline but is changed again afterward', () => {
    writeFileSync(join(dir, 'keep.txt'), 'A2');
    const baseline = snapshotBaseline(dir);

    writeFileSync(join(dir, 'keep.txt'), 'A3');

    const changes = collectChangesSinceBaseline(dir, baseline);
    const change = changes.find((c) => c.path === 'keep.txt');
    expect(change).toEqual({ path: 'keep.txt', op: 'upsert', contentBase64: Buffer.from('A3').toString('base64') });
  });

  it('excludes a file that was already dirty at baseline and left with the same content', () => {
    writeFileSync(join(dir, 'stable.txt'), 'same throughout');
    const baseline = snapshotBaseline(dir);

    const changes = collectChangesSinceBaseline(dir, baseline);
    expect(changes.map((c) => c.path)).not.toContain('stable.txt');
  });

  it('includes a deletion that happens after the baseline', () => {
    const baseline = snapshotBaseline(dir);
    rmSync(join(dir, 'gone.txt'));

    const changes = collectChangesSinceBaseline(dir, baseline);
    expect(changes).toContainEqual({ path: 'gone.txt', op: 'delete' });
  });

  it('excludes a deletion that already happened at baseline time', () => {
    const baseline = snapshotBaseline(dir);
    const changes = collectChangesSinceBaseline(dir, baseline);
    expect(changes.map((c) => c.path)).not.toContain('gone.txt');
  });

  it('reports a dirty working tree', () => {
    expect(hasChanges(dir)).toBe(true);
  });
});

describe('snapshotBaseline', () => {
  it('never throws for a directory that is not a git repository', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'crabd-not-a-repo-'));
    try {
      expect(() => snapshotBaseline(notARepo)).not.toThrow();
      expect(snapshotBaseline(notARepo).size).toBe(0);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe('changesForPaths', () => {
  it('returns only the named paths, ignoring the rest of a dirty tree', () => {
    const changes = changesForPaths(dir, ['keep.txt']);
    expect(changes.map((c) => c.path)).toEqual(['keep.txt']);
    expect(changes[0]?.op).toBe('upsert');
  });

  it('emits a deletion for a path that no longer exists', () => {
    expect(changesForPaths(dir, ['gone.txt'])).toEqual([{ path: 'gone.txt', op: 'delete' }]);
  });

  it('deduplicates and drops empty paths', () => {
    expect(changesForPaths(dir, ['keep.txt', 'keep.txt', ''])).toHaveLength(1);
  });

  it('base64-encodes content so binary survives', () => {
    const [change] = changesForPaths(dir, ['keep.txt']);
    expect(Buffer.from(change!.contentBase64!, 'base64').toString('utf-8')).toBe(
      execFileSync('cat', [join(dir, 'keep.txt')], { encoding: 'utf-8' }),
    );
  });
});
