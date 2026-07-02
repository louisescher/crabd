import { describe, expect, it, vi } from 'vitest';
import { createBroker } from './index.ts';
import { extractClaims } from './verify.ts';

describe('extractClaims', () => {
  it('splits the repository claim into owner and repo', () => {
    expect(extractClaims({ repository: 'acme/app', repository_owner: 'acme' })).toEqual({
      owner: 'acme',
      repo: 'app',
      ownerLogin: 'acme',
    });
  });

  it('throws on a missing or malformed repository claim', () => {
    expect(() => extractClaims({})).toThrow(/repository/);
    expect(() => extractClaims({ repository: 'no-slash' })).toThrow(/repository/);
  });
});

function broker(overrides: { verify?: unknown; mint?: unknown } = {}) {
  return createBroker({
    audience: 'crabd-broker',
    verify: (overrides.verify as never) ?? vi.fn(async () => ({ owner: 'acme', repo: 'app', ownerLogin: 'acme' })),
    mint: (overrides.mint as never) ?? vi.fn(async () => ({ token: 'ghs_x', expiresAt: '2999-01-01T00:00:00Z' })),
  });
}

async function postToken(app: ReturnType<typeof broker>, body: unknown) {
  return app.request('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /token', () => {
  it('vends a token for a valid OIDC request', async () => {
    const res = await postToken(broker(), { oidc: 'jwt', repository: 'acme/app' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'ghs_x', expiresAt: '2999-01-01T00:00:00Z' });
  });

  it('rejects a missing oidc token with 400', async () => {
    const res = await postToken(broker(), { repository: 'acme/app' });
    expect(res.status).toBe(400);
  });

  it('rejects a failed OIDC verification with 401', async () => {
    const res = await postToken(broker({ verify: vi.fn(async () => { throw new Error('bad'); }) }), { oidc: 'jwt' });
    expect(res.status).toBe(401);
  });

  it('rejects a repository that does not match the token with 403', async () => {
    const res = await postToken(broker(), { oidc: 'jwt', repository: 'evil/repo' });
    expect(res.status).toBe(403);
  });

  it('returns 502 when minting fails (e.g. app not installed)', async () => {
    const res = await postToken(broker({ mint: vi.fn(async () => { throw new Error('not installed'); }) }), {
      oidc: 'jwt',
      repository: 'acme/app',
    });
    expect(res.status).toBe(502);
  });

  it('answers health checks', async () => {
    const res = await broker().request('/health');
    expect(res.status).toBe(200);
  });
});
