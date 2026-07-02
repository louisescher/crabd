import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrokerAuth, isOidcAvailable } from './broker.ts';

const OIDC_ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-tok',
} as unknown as NodeJS.ProcessEnv;

afterEach(() => vi.unstubAllGlobals());

describe('isOidcAvailable', () => {
  it('is true only when both OIDC env vars are present', () => {
    expect(isOidcAvailable(OIDC_ENV)).toBe(true);
    expect(isOidcAvailable({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('BrokerAuth', () => {
  it('mints an OIDC token for the audience and exchanges it at the broker', async () => {
    const requests: { url: string; body?: unknown; auth?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      requests.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined, auth: headers.Authorization });
      if (url.startsWith('https://oidc.example/token')) {
        return new Response(JSON.stringify({ value: 'the-oidc-jwt' }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: 'ghs_installtoken', expiresAt: '2999-01-01T00:00:00Z' }), {
        status: 200,
      });
    });

    const auth = new BrokerAuth({
      brokerUrl: 'https://broker.example/',
      repo: { owner: 'acme', name: 'app' },
      audience: 'crabd-broker',
      env: OIDC_ENV,
    });
    const token = await auth.getToken();

    expect(token).toBe('ghs_installtoken');
    // OIDC request carries the audience and bearer.
    expect(requests[0]?.url).toBe('https://oidc.example/token&audience=crabd-broker');
    expect(requests[0]?.auth).toBe('Bearer req-tok');
    // Broker request carries the minted OIDC token and the repository.
    expect(requests[1]?.url).toBe('https://broker.example/token');
    expect(requests[1]?.body).toEqual({ oidc: 'the-oidc-jwt', repository: 'acme/app' });

    // Second call is served from cache (no new requests).
    await auth.getToken();
    expect(requests).toHaveLength(2);
  });

  it('fails clearly when OIDC is not enabled', async () => {
    const auth = new BrokerAuth({ brokerUrl: 'https://broker.example', repo: { owner: 'a', name: 'b' }, env: {} as NodeJS.ProcessEnv });
    await expect(auth.getToken()).rejects.toThrow(/id-token: write/);
  });
});
