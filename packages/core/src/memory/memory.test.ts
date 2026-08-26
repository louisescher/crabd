import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ForgeContext, ForgeEvent } from '../forge/types.ts';
import { TRACKING_MARKER } from '../report/tracking.ts';
import { resolveMemoryTarget } from './commit.ts';
import { isCorrectionReply } from './gate.ts';
import { loadMemories, memorySlug, writeMemory } from './store.ts';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'crabd-memory-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function put(name: string, contents: string, dir = '.crabd/memory'): void {
  mkdirSync(join(cwd, dir), { recursive: true });
  writeFileSync(join(cwd, dir, name), contents, 'utf-8');
}

function memoryFile(body: string, recorded?: string, source?: string): string {
  const front = ['---', ...(source ? [`source: ${source}`] : []), ...(recorded ? [`recorded: ${recorded}`] : []), '---'];
  return `${front.join('\n')}\n\n${body}\n`;
}

describe('loadMemories', () => {
  it('returns nothing when the directory does not exist', () => {
    expect(loadMemories(cwd)).toEqual([]);
  });

  it('parses frontmatter, body, and path', () => {
    put('no-barrels.md', memoryFile('Do not flag missing barrel files.', '2026-08-12', 'https://example.com/c/1'));

    const [entry] = loadMemories(cwd);

    expect(entry).toMatchObject({
      name: 'no-barrels',
      body: 'Do not flag missing barrel files.',
      recorded: '2026-08-12',
      source: 'https://example.com/c/1',
      path: '.crabd/memory/no-barrels.md',
    });
  });

  it('prefers the frontmatter name over the filename', () => {
    put('whatever.md', '---\nname: real-name\n---\n\nBody.');
    expect(loadMemories(cwd)[0]?.name).toBe('real-name');
  });

  it('orders newest first so the caps drop the stalest', () => {
    put('old.md', memoryFile('Old.', '2026-01-01'));
    put('new.md', memoryFile('New.', '2026-08-01'));
    expect(loadMemories(cwd).map((m) => m.name)).toEqual(['new', 'old']);
  });

  it('applies the max-entries cap after ordering', () => {
    put('a.md', memoryFile('A.', '2026-01-01'));
    put('b.md', memoryFile('B.', '2026-02-01'));
    put('c.md', memoryFile('C.', '2026-03-01'));
    expect(loadMemories(cwd, { maxEntries: 2 }).map((m) => m.name)).toEqual(['c', 'b']);
  });

  it('applies the total character budget', () => {
    put('huge.md', memoryFile('x'.repeat(19_000), '2026-03-01'));
    put('also-big.md', memoryFile('y'.repeat(5_000), '2026-02-01'));
    expect(loadMemories(cwd).map((m) => m.name)).toEqual(['huge']);
  });

  it('skips a malformed file rather than failing the run', () => {
    put('broken.md', '---\nname: [unclosed\n---\n\nStill has a body.');
    put('fine.md', memoryFile('Fine.', '2026-08-01'));
    // Broken frontmatter degrades to a nameless-but-usable memory; nothing throws.
    expect(() => loadMemories(cwd)).not.toThrow();
    expect(loadMemories(cwd).map((m) => m.name)).toContain('fine');
  });

  it('ignores an empty memory and non-markdown files', () => {
    put('empty.md', '---\nrecorded: 2026-08-01\n---\n\n   \n');
    put('notes.txt', 'not a memory');
    expect(loadMemories(cwd)).toEqual([]);
  });

  it('reads from a configured directory', () => {
    put('one.md', memoryFile('Custom dir.'), 'docs/memory');
    expect(loadMemories(cwd, { dir: 'docs/memory' })[0]?.body).toBe('Custom dir.');
  });
});

describe('writeMemory', () => {
  it('round-trips through loadMemories', () => {
    const path = writeMemory(cwd, {
      name: 'No Barrel Files!',
      body: 'Imports are by full path here.',
      source: 'https://example.com/c/2',
      recorded: '2026-08-12',
    });

    expect(path).toBe('.crabd/memory/no-barrel-files.md');
    expect(loadMemories(cwd)[0]).toMatchObject({
      name: 'no-barrel-files',
      body: 'Imports are by full path here.',
      source: 'https://example.com/c/2',
    });
  });

  it('replaces a memory of the same slug instead of duplicating it', () => {
    writeMemory(cwd, { name: 'a-rule', body: 'First take.', recorded: '2026-08-01' });
    writeMemory(cwd, { name: 'A Rule', body: 'Refined take.', recorded: '2026-08-02' });

    const memories = loadMemories(cwd);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.body).toBe('Refined take.');
  });
});

describe('memorySlug', () => {
  it('normalizes to a safe filename stem', () => {
    expect(memorySlug('No Barrel Files!')).toBe('no-barrel-files');
    expect(memorySlug('../../etc/passwd')).toBe('etc-passwd');
    expect(memorySlug('!!!')).toBe('memory');
  });
});

const repo = { owner: 'o', name: 'r', slug: 'o/r', defaultBranch: 'main', isPrivate: true };

function ctx(pullRequest?: Partial<ForgeContext['pullRequest']>): ForgeContext {
  return {
    repo,
    comments: [],
    changedFiles: [],
    ...(pullRequest
      ? {
          pullRequest: {
            number: 1,
            title: 't',
            body: '',
            author: 'alice',
            labels: [],
            state: 'open',
            headRef: 'feat/x',
            baseRef: 'main',
            headSha: 'abc',
            fromFork: false, isDraft: false,
            ...pullRequest,
          } as ForgeContext['pullRequest'],
        }
      : {}),
  };
}

describe('resolveMemoryTarget', () => {
  it('targets the pull request branch under `branch`', () => {
    expect(resolveMemoryTarget('branch', ctx({}))).toEqual({ kind: 'branch', branch: 'feat/x' });
  });

  it('falls back to a dedicated pull request when there is no pull request, never to main', () => {
    const target = resolveMemoryTarget('branch', ctx());
    expect(target).toEqual({ kind: 'pr', branch: 'crabd/memory', baseBranch: 'main' });
  });

  it('skips on a fork rather than redirecting to the default branch', () => {
    const target = resolveMemoryTarget('branch', ctx({ fromFork: true }));
    expect(target.kind).toBe('skip');
    expect(target.kind === 'skip' && target.reason).toContain('fork');
  });

  it('uses a dedicated pull request under `pr`, forks included', () => {
    expect(resolveMemoryTarget('pr', ctx({ fromFork: true }))).toEqual({
      kind: 'pr',
      branch: 'crabd/memory',
      baseBranch: 'main',
    });
  });

  it('commits to the default branch under `main`', () => {
    expect(resolveMemoryTarget('main', ctx({}))).toEqual({ kind: 'main', branch: 'main' });
  });

  it('skips under `off`', () => {
    expect(resolveMemoryTarget('off', ctx({})).kind).toBe('skip');
  });
});

const actor = { login: 'alice', association: 'MEMBER', isBot: false };

describe('isCorrectionReply', () => {
  const comment = { id: 5, body: 'that is deliberate', author: 'alice', createdAt: '2026-08-12T12:00:00Z' };
  const event: ForgeEvent = {
    forge: 'github',
    kind: 'issue_comment',
    action: 'created',
    repo,
    actor,
    comment,
    raw: {},
  };

  it('is true for a reply in a thread rooted at a crab\'d finding', () => {
    const context = { ...ctx({}), replyThread: { path: 'a.ts', comments: [], rootIsCrabd: true } };
    expect(isCorrectionReply(context, event)).toBe(true);
  });

  it('is false for a reply in a thread a human started', () => {
    const context = { ...ctx({}), replyThread: { path: 'a.ts', comments: [], rootIsCrabd: false } };
    expect(isCorrectionReply(context, event)).toBe(false);
  });

  it('is true for an issue comment where crab\'d already spoke', () => {
    const context = {
      ...ctx({}),
      comments: [{ id: 1, body: `working...${TRACKING_MARKER}`, author: 'crabd', createdAt: '2026-08-12T11:00:00Z' }],
    };
    expect(isCorrectionReply(context, event)).toBe(true);
  });

  it('is false when crab\'d has not commented on the subject', () => {
    const context = {
      ...ctx({}),
      comments: [{ id: 1, body: 'a human comment', author: 'bob', createdAt: '2026-08-12T11:00:00Z' }],
    };
    expect(isCorrectionReply(context, event)).toBe(false);
  });

  it('is false when crab\'d only commented after the reply', () => {
    const context = {
      ...ctx({}),
      comments: [{ id: 9, body: `later${TRACKING_MARKER}`, author: 'crabd', createdAt: '2026-08-12T13:00:00Z' }],
    };
    expect(isCorrectionReply(context, event)).toBe(false);
  });

  it('is false for a bot, so crab\'d cannot teach itself', () => {
    const botEvent: ForgeEvent = { ...event, actor: { ...actor, isBot: true } };
    const context = { ...ctx({}), replyThread: { path: 'a.ts', comments: [], rootIsCrabd: true } };
    expect(isCorrectionReply(context, botEvent)).toBe(false);
  });

  it('is false with no triggering comment at all (a plain pull_request event)', () => {
    const noComment: ForgeEvent = { ...event, comment: undefined };
    expect(isCorrectionReply(ctx({}), noComment)).toBe(false);
  });
});
