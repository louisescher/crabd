import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const GIT_SHIM = join(here, '..', 'sandbox-bin', 'git');
const GH_SHIM = join(here, '..', 'sandbox-bin', 'gh');

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], cwd?: string): Result {
  try {
    const stdout = execFileSync(bin, args, { cwd, encoding: 'utf-8', timeout: 5000 });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string; stderr?: string };
    return { status: e.status ?? null, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('sandbox-bin/git', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'crabd-sandbox-git-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lets a read-only "status" through', () => {
    const result = run(GIT_SHIM, ['status'], dir);
    expect(result.status).toBe(0);
  });

  it('lets a read-only "log" through', () => {
    const result = run(GIT_SHIM, ['log', '--oneline'], dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('initial');
  });

  it.each([
    ['commit', '-m', 'x'],
    ['push'],
    ['pull'],
    ['merge', 'main'],
    ['restore', 'a.txt'],
    ['worktree', 'list'],
    ['add', '.'],
    ['reset', '--hard'],
    ['checkout', 'main'],
    ['stash'],
    ['rebase', 'main'],
    ['cherry-pick', 'HEAD'],
    ['tag', 'v1'],
    ['remote', 'add', 'x', 'y'],
    ['apply', '/dev/null'],
    ['credential', 'fill'],
  ])('refuses "git %s"', (...args) => {
    const result = run(GIT_SHIM, args, dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not available in this sandbox');
  });

  it.each([['config', '--local', '--list'], ['ls-remote', '--help'], ['merge-base', 'HEAD', 'HEAD']])(
    'allows "git %s", which cannot change the checkout or its branches',
    (...args) => {
      const result = run(GIT_SHIM, args, dir);
      expect(result.stderr).not.toContain('is not available in this sandbox');
    },
  );

  it('refuses a write subcommand even behind a global -C option', () => {
    const result = run(GIT_SHIM, ['-C', '/tmp', 'push']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"git push" is not available in this sandbox');
  });

  it('refuses a write subcommand even behind a global -c option', () => {
    const result = run(GIT_SHIM, ['-c', 'user.name=x', 'merge', 'x'], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"git merge" is not available in this sandbox');
  });
});

describe('sandbox-bin/gh', () => {
  it('refuses "gh api" with an explicit -X POST', () => {
    const result = run(GH_SHIM, ['api', 'repos/octocat/hello-world', '-X', 'POST']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not available in this sandbox');
  });

  it('refuses "gh api" with --method=DELETE', () => {
    const result = run(GH_SHIM, ['api', 'repos/octocat/hello-world', '--method=DELETE']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not available in this sandbox');
  });

  it('refuses "gh api" with a -f field, a request body', () => {
    const result = run(GH_SHIM, ['api', 'repos/octocat/hello-world', '-f', 'field=value']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gh api with a request body');
  });

  it('does not refuse a bare read path', () => {
    const result = run(GH_SHIM, ['api', 'repos/octocat/hello-world']);
    expect(result.stderr).not.toContain('is not available in this sandbox');
  });

  // The sandbox token carries `contents: read` and nothing else, and the forge answers a missing
  // permission with 404. Refused here with the reason, each costs one tool call. Let through, they
  // cost a run: one spent six of them before deciding the repository was private.
  it.each([
    ['pr', ['pr', 'view', '3615', '--comments']],
    ['issue', ['issue', 'list']],
    ['run', ['run', 'view', '123']],
    ['api under /pulls', ['api', 'repos/octocat/hello-world/pulls/1']],
    ['api under /issues', ['api', 'repos/octocat/hello-world/issues/3/comments']],
    ['api under /reviews', ['api', 'repos/octocat/hello-world/pulls/1/reviews']],
    ['api under /actions', ['api', 'repos/octocat/hello-world/actions/runs/1']],
    ['api with a query string', ['api', 'repos/octocat/hello-world/pulls?state=open']],
  ])('refuses %s, naming the missing permission', (_label, args) => {
    const result = run(GH_SHIM, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reads repository files only');
    expect(result.stderr).toContain('in your context');
  });

  it.each([
    ['a file', ['api', 'repos/octocat/hello-world/contents/README.md']],
    ['a tree', ['api', 'repos/octocat/hello-world/git/trees/main']],
    ['code search', ['search', 'code', 'needle']],
  ])('leaves %s alone, which is what the token was minted for', (_label, args) => {
    const result = run(GH_SHIM, args);
    expect(result.stderr).not.toContain('cannot work in this sandbox');
    expect(result.stderr).not.toContain('is not available in this sandbox');
  });
});
