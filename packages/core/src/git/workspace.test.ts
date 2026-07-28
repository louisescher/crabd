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
/** Sha of a merge of the branch into main, which is what `refs/pull/N/merge` resolves to. */
let mergeSha: string;

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

  // Stand in for `refs/pull/N/merge`: the change merged into its base, which is the ref both
  // forges hand a `pull_request` event by default.
  git(['checkout', '-q', '-b', 'merged', 'main']);
  git(['merge', '-q', '--no-ff', '-m', 'merge feat into main', 'feat']);
  mergeSha = git(['rev-parse', 'HEAD']);

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
    // main does not contain the change, so this is a real mismatch.
    expect(ws.containsPrHead).toBe(false);
  });

  it('reports a merge-ref checkout as containing the PR head, not as a mismatch to warn about', () => {
    git(['checkout', '-q', '--detach', mergeSha]);
    try {
      const ws = resolveWorkspace(dir, prHeadSha);
      expect(ws.matchesPrHead).toBe(false);
      expect(ws.containsPrHead).toBe(true);
    } finally {
      git(['checkout', '-q', 'main']);
    }
  });

  it('confirms a match when the checkout is the PR head', () => {
    git(['checkout', '-q', 'feat']);
    try {
      const ws = resolveWorkspace(dir, prHeadSha);
      expect(ws.matchesPrHead).toBe(true);
      expect(ws.containsPrHead).toBe(true);
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
      expect(ws.containsPrHead).toBeUndefined();
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
    const clone = mkdtempSync(join(tmpdir(), 'crabd-unreachable-'));
    try {
      // Shallow clone of main with no remote left: the PR head is neither in the object store
      // nor fetchable, so every attempt fails. `file://` because a plain local clone ignores
      // `--depth` and hardlinks every object in.
      execFileSync('git', ['clone', '-q', '--depth=1', '--branch', 'main', `file://${dir}`, clone]);
      execFileSync('git', ['remote', 'remove', 'origin'], { cwd: clone });

      expect(checkoutPrHead(clone, prHeadSha, 8)).toBe(false);
      expect(git(['rev-parse', 'HEAD'], clone)).toBe(baseSha);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("refuses to move a tree with tracked modifications rather than discarding the consumer's work", () => {
    const clone = mkdtempSync(join(tmpdir(), 'crabd-dirty-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth=1', '--branch', 'main', `file://${dir}`, clone]);
      // Stand in for a codegen step that rewrote a tracked file before the crab'd step.
      writeFileSync(join(clone, 'a.txt'), 'generated\n');

      expect(checkoutPrHead(clone, prHeadSha)).toBe(false);
      expect(git(['rev-parse', 'HEAD'], clone)).toBe(baseSha);
      expect(resolveWorkspace(clone).status).toContain('a.txt');
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('moves past untracked files, which a non-forced checkout leaves alone', () => {
    const clone = mkdtempSync(join(tmpdir(), 'crabd-untracked-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth=1', '--branch', 'main', `file://${dir}`, clone]);
      // What a cloud-auth step drops in the workspace. Blocking on this is why a real run
      // reviewed from the diff while sitting on a tree it could have moved.
      writeFileSync(join(clone, 'gha-creds-1234.json'), '{}\n');

      expect(checkoutPrHead(clone, prHeadSha)).toBe(true);
      expect(git(['rev-parse', 'HEAD'], clone)).toBe(prHeadSha);
      expect(resolveWorkspace(clone).status).toContain('gha-creds-1234.json');
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('moves onto a PR head already in the object store, without a remote', () => {
    const clone = mkdtempSync(join(tmpdir(), 'crabd-merge-'));
    try {
      // Full clone detached on the merge commit: the shape of a `refs/pull/N/merge` checkout,
      // where the PR head is a parent and no fetch is needed.
      execFileSync('git', ['clone', '-q', dir, clone]);
      execFileSync('git', ['checkout', '-q', '--detach', mergeSha], { cwd: clone });
      // No remote at all, so only the local-object path can succeed.
      execFileSync('git', ['remote', 'remove', 'origin'], { cwd: clone });

      expect(checkoutPrHead(clone, prHeadSha)).toBe(true);
      expect(resolveWorkspace(clone, prHeadSha).matchesPrHead).toBe(true);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('moves a clone onto the PR head fetched from origin', () => {
    const clone = mkdtempSync(join(tmpdir(), 'crabd-clone-'));
    try {
      // A shallow, single-branch clone of main — the shape a CI checkout has on `issue_comment`.
      execFileSync('git', ['clone', '-q', '--depth=1', '--branch', 'main', `file://${dir}`, clone]);
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
