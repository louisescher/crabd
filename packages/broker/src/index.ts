import { Hono } from 'hono';
import { mintInstallationToken, type MintedToken } from './mint.ts';
import { verifyOidc, type OidcClaims } from './verify.ts';

export { extractClaims, verifyOidc, type OidcClaims } from './verify.ts';
export { mintInstallationToken, type MintedToken, type MintOptions } from './mint.ts';

/**
 * Accept the App private key as a raw PEM **or** a base64-encoded PEM. A PEM has
 * newlines that are awkward in an env var, so base64 is the easier form to pass in;
 * a value that isn't already PEM is base64-decoded.
 */
export function normalizePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf-8').trim();
}

export interface BrokerDeps {
  /** OIDC audience the broker requires (must match the action's request). */
  audience: string;
  /** Verify an OIDC token and return the repository it was issued for. */
  verify: (token: string, audience: string) => Promise<OidcClaims>;
  /** Mint an installation token for a repository. */
  mint: (owner: string, repo: string) => Promise<MintedToken>;
}

/**
 * Build the broker HTTP app. Injectable deps keep it testable without real GitHub
 * calls. `POST /token` verifies the caller's OIDC token, confirms the request is
 * for the repo the token was issued for, and vends a scoped installation token.
 */
export function createBroker(deps: BrokerDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/token', async (c) => {
    let body: { oidc?: unknown; repository?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    if (typeof body.oidc !== 'string') {
      return c.json({ error: 'missing `oidc` token' }, 400);
    }

    let claims: OidcClaims;
    try {
      claims = await deps.verify(body.oidc, deps.audience);
    } catch {
      return c.json({ error: 'OIDC verification failed' }, 401);
    }

    // Defense in depth: a supplied `repository` must match the token's own claim.
    if (typeof body.repository === 'string' && body.repository !== `${claims.owner}/${claims.repo}`) {
      return c.json({ error: 'repository does not match the OIDC token' }, 403);
    }

    try {
      const minted = await deps.mint(claims.owner, claims.repo);
      return c.json(minted);
    } catch {
      // Most often: the crab'd App isn't installed on this repo.
      return c.json({ error: 'could not mint a token (is the crab\'d App installed on this repo?)' }, 502);
    }
  });

  return app;
}

/** Build the broker from environment secrets (`CRABD_APP_ID`, `CRABD_APP_PRIVATE_KEY`). */
export function buildFromEnv(env: NodeJS.ProcessEnv = process.env): Hono {
  const appId = env.CRABD_APP_ID;
  const rawKey = env.CRABD_APP_PRIVATE_KEY;
  const audience = env.CRABD_BROKER_AUDIENCE ?? 'crabd-broker';
  if (!appId || !rawKey) {
    throw new Error('crabd-broker: set CRABD_APP_ID and CRABD_APP_PRIVATE_KEY');
  }
  const privateKey = normalizePrivateKey(rawKey);
  return createBroker({
    audience,
    verify: verifyOidc,
    mint: (owner, repo) => mintInstallationToken({ appId, privateKey, owner, repo }),
  });
}
