import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripCheckoutCredentials } from './credentials.ts';

let dir: string;

function git(args: string[], cwd = dir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function localConfigKeys(): string[] {
  try {
    return git(['config', '--local', '--name-only', '--list'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crabd-creds-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base commit']);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('stripCheckoutCredentials', () => {
  it('removes the v4 extraheader', () => {
    git(['config', '--local', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic SECRET']);

    const removed = stripCheckoutCredentials(dir);

    expect(removed).toEqual(['http.https://github.com/.extraheader']);
    expect(localConfigKeys()).not.toContain('http.https://github.com/.extraheader');
  });

  it('removes the v6 includeIf entries', () => {
    const credentials = join(dir, 'git-credentials.config');
    writeFileSync(credentials, '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic SECRET\n');
    git(['config', '--local', `includeIf.gitdir:${dir}/.git.path`, credentials]);
    git(['config', '--local', `includeIf.gitdir:${dir}/.git/worktrees/*.path`, credentials]);

    const removed = stripCheckoutCredentials(dir);

    expect(removed).toHaveLength(2);
    expect(localConfigKeys().filter((key) => key.startsWith('includeif.gitdir:'))).toEqual([]);
  });

  it('leaves unrelated config alone', () => {
    git(['config', '--local', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic SECRET']);

    stripCheckoutCredentials(dir);

    expect(git(['config', '--local', 'user.email'])).toBe('t@example.com');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('reports nothing removed on a checkout that carries no credentials', () => {
    expect(stripCheckoutCredentials(dir)).toEqual([]);
  });

  it('does not throw outside a git repository', () => {
    const empty = mkdtempSync(join(tmpdir(), 'crabd-nogit-'));
    try {
      expect(stripCheckoutCredentials(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
