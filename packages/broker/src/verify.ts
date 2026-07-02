import { createRemoteJWKSet, jwtVerify } from 'jose';

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

export interface OidcClaims {
  /** Repository owner (org or user login). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** `repository_owner` claim (may differ in casing from `owner`). */
  ownerLogin: string;
}

/**
 * Extract the repository identity from a verified GitHub Actions OIDC payload.
 * Pure and separately testable — the signature check lives in {@link verifyOidc}.
 */
export function extractClaims(payload: Record<string, unknown>): OidcClaims {
  const repository = payload.repository;
  if (typeof repository !== 'string' || !repository.includes('/')) {
    throw new Error('oidc: missing or malformed `repository` claim');
  }
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error('oidc: malformed `repository` claim');
  return { owner, repo, ownerLogin: String(payload.repository_owner ?? owner) };
}

const jwks = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`));

/**
 * Verify a GitHub Actions OIDC token (signature via GitHub's JWKS, issuer, and
 * audience) and return the repository it was issued for. Throws on any failure.
 */
export async function verifyOidc(token: string, audience: string): Promise<OidcClaims> {
  const { payload } = await jwtVerify(token, jwks, { issuer: GITHUB_OIDC_ISSUER, audience });
  return extractClaims(payload as Record<string, unknown>);
}
