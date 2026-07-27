import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkoutPrHead, resolveWorkspace } from './workspace.ts';

let dir: string;
/** Sha of the commit standing in for the PR head (a second commit on a branch). */
let prHeadSha: string;
/** Sha of the default-branch commit — what a bare `actions/checkout` leaves you on. */
let baseSha: string;

function git(args: string[], cwd = dir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'crabd-ws-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base commit']);
  baseSha = git(['rev-parse', 'HEAD']);

  git(['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  git(['commit', '-q', '-am', 'the change under review']);
  prHeadSha = git(['rev-parse', 'HEAD']);

  git(['checkout', '-q', 'main']);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveWorkspace', () => {
  it('reports branch, HEAD, and recent commits for a clean tree', () => {
    const ws = resolveWorkspace(dir);

    expect(ws.branch).toBe('main');
    expect(ws.headSha).toBe(baseSha);
    expect(ws.status).toBe('');
    expect(ws.recentCommits[0]).toContain('base commit');
    // No expected sha was supplied, so there is nothing to compare against.
    expect(ws.matchesPrHead).toBeUndefined();
    expect(ws.expectedHeadSha).toBeUndefined();
  });

  it('flags a mismatch when the checkout is not the PR head', () => {
    const ws = resolveWorkspace(dir, prHeadSha);

    expect(ws.matchesPrHead).toBe(false);
    expect(ws.expectedHeadSha).toBe(prHeadSha);
  });

  it('confirms a match when the checkout is the PR head', () => {
    git(['checkout', '-q', 'feat']);
    try {
      expect(resolveWorkspace(dir, prHeadSha).matchesPrHead).toBe(true);
    } finally {
      git(['checkout', '-q', 'main']);
    }
  });

  it('reports uncommitted changes', () => {
    writeFileSync(join(dir, 'dirty.txt'), 'x\n');
    try {
      expect(resolveWorkspace(dir).status).toContain('dirty.txt');
    } finally {
      rmSync(join(dir, 'dirty.txt'));
    }
  });

  it('degrades to empty state outside a git repository rather than throwing', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'crabd-nogit-'));
    try {
      const ws = resolveWorkspace(notARepo, prHeadSha);
      expect(ws.headSha).toBeUndefined();
      expect(ws.status).toBe('');
      expect(ws.recentCommits).toEqual([]);
      // Unknowable, so left unset — the prompt must not claim a mismatch it cannot prove.
      expect(ws.matchesPrHead).toBeUndefined();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('reports a detached HEAD with no branch', () => {
    git(['checkout', '-q', '--detach', prHeadSha]);
    try {
      const ws = resolveWorkspace(dir);
      expect(ws.branch).toBeUndefined();
      expect(ws.headSha).toBe(prHeadSha);
    } finally {
      git(['checkout', '-q', 'main']);
    }
  });
});

describe('checkoutPrHead', () => {
  it('returns false without moving the tree when the sha is unreachable', () => {
    const before = git(['rev-parse', 'HEAD']);
    // No `origin` remote is configured, so every fetch attempt fails.
    expect(checkoutPrHead(dir, prHeadSha, 8)).toBe(false);
    expect(git(['rev-parse', 'HEAD'])).toBe(before);
  });

  it('refuses to move a dirty tree rather than discarding the consumer\'s files', () => {
    const clone = mkdtempSync(join(tmpdir(), 'crabd-dirty-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth=1', '--branch', 'main', dir, clone]);
      // Stand in for a build artifact produced by an earlier workflow step.
      writeFileSync(join(clone, 'built.js'), 'artifact\n');

      expect(checkoutPrHead(clone, prHeadSha)).toBe(false);
      expect(git(['rev-parse', 'HEAD'], clone)).toBe(baseSha);
      expect(resolveWorkspace(clone).status).toContain('built.js');
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('moves a clone onto the PR head fetched from origin', () => {
    const clone = mkdtempSync(join(tmpdir(), 'crabd-clone-'));
    try {
      // A shallow, single-branch clone of main — the shape a CI checkout has on `issue_comment`.
      execFileSync('git', ['clone', '-q', '--depth=1', '--branch', 'main', dir, clone]);
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: clone });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: clone });

      expect(resolveWorkspace(clone, prHeadSha).matchesPrHead).toBe(false);
      expect(checkoutPrHead(clone, prHeadSha)).toBe(true);
      expect(resolveWorkspace(clone, prHeadSha).matchesPrHead).toBe(true);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});
