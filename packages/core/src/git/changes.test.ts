import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changesForPaths,
  collectChangesSinceBaseline,
  hasChanges,
  snapshotBaseline,
  TooManyChangesError,
} from './changes.ts';
import { SensitivePathError } from './sensitive.ts';

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

describe('collectChangesSinceBaseline: the file ceiling', () => {
  let wide: string;

  function wideGit(args: string[]): void {
    execFileSync('git', args, { cwd: wide });
  }

  beforeAll(() => {
    wide = mkdtempSync(join(tmpdir(), 'crabd-wide-'));
    execFileSync('git', ['init', '-q'], { cwd: wide });
    wideGit(['config', 'user.email', 't@example.com']);
    wideGit(['config', 'user.name', 'Test']);
    writeFileSync(join(wide, 'seed.txt'), 'seed');
    wideGit(['add', '-A']);
    wideGit(['commit', '-q', '-m', 'init']);
  });

  afterAll(() => rmSync(wide, { recursive: true, force: true }));

  it('throws once the change count passes the ceiling', () => {
    const baseline = snapshotBaseline(wide);
    for (let i = 0; i < 12; i++) writeFileSync(join(wide, `f${i}.txt`), `content ${i}`);

    expect(() => collectChangesSinceBaseline(wide, baseline, { maxFiles: 5 })).toThrow(TooManyChangesError);
  });

  it('reports the count, the ceiling, and a sample of paths', () => {
    const baseline = snapshotBaseline(wide);
    for (let i = 0; i < 12; i++) writeFileSync(join(wide, `f${i}.txt`), `changed ${i}`);

    try {
      collectChangesSinceBaseline(wide, baseline, { maxFiles: 5 });
      expect.unreachable('expected a TooManyChangesError');
    } catch (error) {
      const tooMany = error as TooManyChangesError;
      expect(tooMany.fileCount).toBe(12);
      expect(tooMany.maxFiles).toBe(5);
      expect(tooMany.sample).toHaveLength(10);
      expect(tooMany.sample.every((path) => path.endsWith('.txt'))).toBe(true);
    }
  });

  it('allows a change set exactly at the ceiling', () => {
    const baseline = snapshotBaseline(wide);
    for (let i = 0; i < 12; i++) writeFileSync(join(wide, `f${i}.txt`), `again ${i}`);

    const changes = collectChangesSinceBaseline(wide, baseline, { maxFiles: 12 });
    expect(changes).toHaveLength(12);
    expect(changes[0]?.contentBase64).toBeDefined();
  });

  it('leaves the change set unbounded when no ceiling is given', () => {
    const baseline = snapshotBaseline(wide);
    for (let i = 0; i < 12; i++) writeFileSync(join(wide, `f${i}.txt`), `unbounded ${i}`);

    expect(collectChangesSinceBaseline(wide, baseline)).toHaveLength(12);
    expect(collectChangesSinceBaseline(wide, baseline, { maxFiles: 0 })).toHaveLength(12);
  });
});

// The case this guards against, end to end. A repository with the secret scan off ran a repo-wide
// `prettier --write`, which reformatted the `gha-creds-*.json` that `google-github-actions/auth`
// writes into the workspace. The rewrite changed its hash, the baseline stopped recognising it as
// pre-existing, and it went into the commit.
describe('collectChangesSinceBaseline: credentials in the checkout', () => {
  let repo: string;

  function run(args: string[]): void {
    execFileSync('git', args, { cwd: repo });
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'crabd-creds-'));
    run(['init', '-q']);
    run(['config', 'user.email', 't@example.com']);
    run(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'init']);
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('drops a workflow-generated credentials file a formatter rewrote after the baseline', () => {
    writeFileSync(join(repo, 'gha-creds-07aacde2c992b73b.json'), '{"type":"external_account"}');
    const baseline = snapshotBaseline(repo);

    writeFileSync(join(repo, 'gha-creds-07aacde2c992b73b.json'), '{\n  "type": "external_account"\n}\n');
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2;\n');

    const changes = collectChangesSinceBaseline(repo, baseline);
    expect(changes.map((c) => c.path)).toEqual(['app.ts']);
  });

  it('drops it even when it appears for the first time mid-run', () => {
    const baseline = snapshotBaseline(repo);
    writeFileSync(join(repo, 'gha-creds-deadbeef.json'), '{"type":"service_account"}');
    writeFileSync(join(repo, 'app.ts'), 'export const a = 3;\n');

    const changes = collectChangesSinceBaseline(repo, baseline);
    expect(changes.map((c) => c.path)).toEqual(['app.ts']);
    rmSync(join(repo, 'gha-creds-deadbeef.json'));
  });

  it('refuses the whole commit when an untracked path looks like a credential', () => {
    const baseline = snapshotBaseline(repo);
    writeFileSync(join(repo, '.env'), 'API_KEY=live-key\n');

    let thrown: unknown;
    try {
      collectChangesSinceBaseline(repo, baseline);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SensitivePathError);
    expect((thrown as SensitivePathError).paths).toEqual(['.env']);
    rmSync(join(repo, '.env'));
  });

  it('commits a tracked credential-shaped path, which the repository chose to track', () => {
    writeFileSync(join(repo, 'fixtures.pem'), 'placeholder\n');
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'add fixture']);

    const baseline = snapshotBaseline(repo);
    writeFileSync(join(repo, 'fixtures.pem'), 'updated placeholder\n');

    const changes = collectChangesSinceBaseline(repo, baseline);
    expect(changes.map((c) => c.path)).toEqual(['fixtures.pem']);
  });

  it('allows an untracked .env.example, which repositories add on purpose', () => {
    const baseline = snapshotBaseline(repo);
    writeFileSync(join(repo, '.env.example'), 'API_KEY=\n');

    const changes = collectChangesSinceBaseline(repo, baseline);
    expect(changes.map((c) => c.path)).toContain('.env.example');
    rmSync(join(repo, '.env.example'));
  });
});
