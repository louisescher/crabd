import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaticTokenAuth } from '../auth/types.ts';
import { ForgejoForge } from './forgejo.ts';
import type { ForgeRepo } from './types.ts';

const repo: ForgeRepo = { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true };

function forge() {
  return new ForgejoForge({
    auth: new StaticTokenAuth('forgejo', 'tok'),
    repo,
    baseUrl: 'https://forge.example.com/api/v1',
  });
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(responder: (call: Call) => { status: number; body: string }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers as Record<string, string>) ?? {},
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const { status, body } = responder(call);
    return new Response(body, { status });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('ForgejoForge request shaping', () => {
  it('posts a tracking comment with the token header to the issue comments endpoint', async () => {
    const calls = mockFetch(() => ({ status: 201, body: JSON.stringify({ id: 99 }) }));
    const ref = await forge().createTrackingComment(7, 'working');
    expect(ref).toEqual({ id: 99, target: 7 });
    expect(calls[0]?.url).toBe('https://forge.example.com/api/v1/repos/acme/app/issues/7/comments');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.Authorization).toBe('token tok');
    expect(calls[0]?.body).toEqual({ body: 'working' });
  });

  it('maps review findings to Forgejo new_position', async () => {
    const calls = mockFetch(() => ({ status: 200, body: '{}' }));
    await forge().postReview(3, {
      body: 'summary',
      event: 'REQUEST_CHANGES',
      comments: [{ path: 'a.ts', line: 20, body: 'fix' }],
    });
    expect(calls[0]?.url).toBe('https://forge.example.com/api/v1/repos/acme/app/pulls/3/reviews');
    expect(calls[0]?.body).toMatchObject({
      event: 'REQUEST_CHANGES',
      comments: [{ path: 'a.ts', new_position: 20, body: 'fix' }],
    });
  });

  it('posts a reaction to a comment', async () => {
    const calls = mockFetch(() => ({ status: 201, body: '{}' }));
    await forge().reactToComment(55, 'eyes');
    expect(calls[0]?.url).toBe('https://forge.example.com/api/v1/repos/acme/app/issues/comments/55/reactions');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ content: 'eyes' });
  });

  it('maps Forgejo permission levels to associations (owner is Forgejo-specific)', async () => {
    const cases: Array<[string, string]> = [
      ['owner', 'OWNER'], // Forgejo/Gitea org owners — GitHub never returns this
      ['admin', 'OWNER'],
      ['write', 'COLLABORATOR'],
      ['read', 'NONE'],
      ['none', 'NONE'],
    ];
    for (const [permission, expected] of cases) {
      mockFetch((call) => {
        expect(call.url).toBe('https://forge.example.com/api/v1/repos/acme/app/collaborators/someone/permission');
        return { status: 200, body: JSON.stringify({ permission }) };
      });
      const actor = await forge().resolveActor('someone');
      expect(actor.association, `${permission} -> ${expected}`).toBe(expected);
    }
  });

  it('flags [bot] logins as bots regardless of permission', async () => {
    mockFetch(() => ({ status: 200, body: JSON.stringify({ permission: 'read' }) }));
    const actor = await forge().resolveActor('renovate[bot]');
    expect(actor.isBot).toBe(true);
    expect(actor.association).toBe('NONE');
  });

  it('decodes a base64 org config file', async () => {
    mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ content: Buffer.from('model: openai/gpt-5.5').toString('base64'), encoding: 'base64' }),
    }));
    const text = await forge().readOrgConfig('acme/.crabd-config', '.crabd.yml');
    expect(text).toBe('model: openai/gpt-5.5');
  });

  it('returns undefined for a missing org config file', async () => {
    mockFetch(() => ({ status: 404, body: '' }));
    expect(await forge().readOrgConfig('acme/.crabd-config', '.crabd.yml')).toBeUndefined();
  });
});
