import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaticTokenAuth } from '../auth/types.ts';
import { GitHubForge } from './github.ts';
import type { ForgeEvent, ForgeRepo } from './types.ts';

const repo: ForgeRepo = { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true };

function forge() {
  return new GitHubForge({ auth: new StaticTokenAuth('github', 'tok'), repo });
}

const event = {
  forge: 'github',
  kind: 'pull_request',
  action: 'opened',
  repo,
  actor: { login: 'dev', association: 'OWNER', isBot: false },
  pullRequest: {
    number: 7,
    title: 'big',
    body: '',
    author: 'dev',
    labels: [],
    state: 'open',
    headRef: 'feat',
    baseRef: 'main',
    headSha: 'abc',
    fromFork: false, isDraft: false,
  },
  raw: {},
} as ForgeEvent;

function file(i: number) {
  return {
    filename: `src/file-${i}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: `@@ -1 +1 @@\n-const a = ${i};\n+const a = ${i + 1};`,
  };
}

const TOO_LARGE = JSON.stringify({
  message: "Sorry, the diff exceeded the maximum number of files (300).",
  errors: [{ resource: 'PullRequest', field: 'diff', code: 'too_large' }],
});

function mockGitHub(options: { pages: number; diffStatus: number }): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    urls.push(url);
    const accept = new Headers((init.headers ?? {}) as Record<string, string>).get('accept') ?? '';
    if (url.includes('/issues/7/comments')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/pulls/7/files')) {
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      const body = JSON.stringify(Array.from({ length: 100 }, (_, i) => file((page - 1) * 100 + i)));
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (page < options.pages) {
        headers.link = `<https://api.github.com/repos/acme/app/pulls/7/files?per_page=100&page=${page + 1}>; rel="next"`;
      }
      return new Response(body, { status: 200, headers });
    }
    if (url.includes('/pulls/7') && accept.includes('diff')) {
      if (options.diffStatus === 200) return new Response('diff --git a/src/file-0.ts b/src/file-0.ts\n', { status: 200 });
      const body = options.diffStatus === 406 ? TOO_LARGE : JSON.stringify({ message: 'Server Error' });
      return new Response(body, { status: options.diffStatus, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe('GitHubForge.getContext', () => {
  it('rebuilds the diff from per-file patches when GitHub refuses one that big', async () => {
    mockGitHub({ pages: 4, diffStatus: 406 });

    const context = await forge().getContext(event);

    expect(context.changedFiles).toHaveLength(400);
    expect(context.diff).toContain('diff --git a/src/file-0.ts b/src/file-0.ts');
    expect(context.diff).toContain('diff --git a/src/file-399.ts b/src/file-399.ts');
  });

  it('pages past the first 100 changed files', async () => {
    const urls = mockGitHub({ pages: 3, diffStatus: 200 });

    const context = await forge().getContext(event);

    expect(context.changedFiles).toHaveLength(300);
    expect(urls.filter((u) => u.includes('/pulls/7/files'))).toHaveLength(3);
  });

  it('stops paging at the file cap instead of walking an unbounded PR', async () => {
    mockGitHub({ pages: 50, diffStatus: 406 });

    const context = await forge().getContext(event);

    expect(context.changedFiles).toHaveLength(1000);
  });

  it('still fails loudly on an error that is not the size limit', async () => {
    mockGitHub({ pages: 1, diffStatus: 500 });

    await expect(forge().getContext(event)).rejects.toThrow();
  });
});
