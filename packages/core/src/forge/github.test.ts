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

// Mirrors UPDATE_BRANCH_POLLS / UPDATE_BRANCH_POLL_MS in github.ts.
const POLLS = 12;
const POLL_MS = 2_000;

function mockUpdateBranch(options: { putStatus?: number; putMessage?: string; pollShas: string[] }) {
  const requests: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  let getIndex = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });

    if (method === 'PUT' && url.includes('/pulls/7/update-branch')) {
      const status = options.putStatus ?? 202;
      const message = status >= 400 ? (options.putMessage ?? 'error') : 'Updating pull request branch.';
      return new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'GET' && new URL(url).pathname === '/repos/acme/app/pulls/7') {
      const sha = options.pollShas[Math.min(getIndex, options.pollShas.length - 1)];
      getIndex += 1;
      return new Response(JSON.stringify({ number: 7, head: { sha }, base: { sha: 'base' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  return { requests, getCalls: () => getIndex };
}

describe('GitHubForge.updateBranch', () => {
  afterEach(() => vi.useRealTimers());

  it('polls until the head sha moves, returning the new sha', async () => {
    vi.useFakeTimers();
    mockUpdateBranch({ pollShas: ['sha0', 'sha0', 'sha1'] });

    const promise = forge().updateBranch(7);
    await vi.advanceTimersByTimeAsync(POLL_MS); // first poll: unchanged
    await vi.advanceTimersByTimeAsync(POLL_MS); // second poll: moved

    await expect(promise).resolves.toEqual({ status: 'updated', headSha: 'sha1' });
  });

  it('returns a conflict with GitHub\'s message on a 422', async () => {
    mockUpdateBranch({ putStatus: 422, putMessage: 'Merge conflict', pollShas: ['sha0'] });

    await expect(forge().updateBranch(7)).resolves.toEqual({ status: 'conflict', message: 'Merge conflict' });
  });

  it('returns unsupported on a 403', async () => {
    mockUpdateBranch({ putStatus: 403, putMessage: 'Not Found', pollShas: ['sha0'] });

    await expect(forge().updateBranch(7)).resolves.toEqual({ status: 'unsupported', message: 'Not Found' });
  });

  it('reports up-to-date when the head never moves across every poll', async () => {
    vi.useFakeTimers();
    const mock = mockUpdateBranch({ pollShas: ['sha0'] });

    const promise = forge().updateBranch(7);
    await vi.advanceTimersByTimeAsync(POLLS * POLL_MS);

    await expect(promise).resolves.toEqual({ status: 'up-to-date' });
    expect(mock.getCalls()).toBe(1 + POLLS); // the initial head check, then every poll
  });

  it('forwards expectedHeadSha as expected_head_sha and skips the initial pulls.get', async () => {
    vi.useFakeTimers();
    const mock = mockUpdateBranch({ pollShas: ['sha1'] });

    const promise = forge().updateBranch(7, { expectedHeadSha: 'sha0' });
    await vi.advanceTimersByTimeAsync(POLL_MS);

    await expect(promise).resolves.toEqual({ status: 'updated', headSha: 'sha1' });
    expect(mock.getCalls()).toBe(1); // only the poll; no pre-check pulls.get
    const put = mock.requests.find((r) => r.method === 'PUT');
    expect(put?.body).toMatchObject({ expected_head_sha: 'sha0' });
  });
});
