import type { AuthProvider } from './types.ts';

/** The canonical, self-hosted crab'd token broker. Override with `CRABD_BROKER_URL`. */
export const DEFAULT_BROKER_URL = 'https://crabd-broker.example.com';

/** Default OIDC audience the broker expects. Must match the broker's `CRABD_BROKER_AUDIENCE`. */
export const DEFAULT_BROKER_AUDIENCE = 'crabd-broker';

/** Whether GitHub Actions OIDC is available (needs `permissions: id-token: write`). */
export function isOidcAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
}

export interface BrokerAuthOptions {
  brokerUrl: string;
  repo: { owner: string; name: string };
  audience?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Obtains a crab'd[bot] installation token from the hosted broker without ever
 * holding the App private key. Flow:
 *   1. mint a GitHub Actions OIDC token for the broker's audience,
 *   2. POST it to the broker, which verifies it and vends a short-lived,
 *      repo-scoped installation token for the canonical crab'd App.
 *
 * This is what gives every install the single, canonical `crab'd[bot]` identity.
 */
export class BrokerAuth implements AuthProvider {
  readonly kind = 'github' as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly audience: string;
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly options: BrokerAuthOptions) {
    this.env = options.env ?? process.env;
    this.audience = options.audience ?? DEFAULT_BROKER_AUDIENCE;
  }

  private async requestOidcToken(): Promise<string> {
    const url = this.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const requestToken = this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !requestToken) {
      throw new Error(
        "crabd: no OIDC token available. Add `permissions: id-token: write` to the job, or use a GitHub App / token.",
      );
    }
    const res = await fetch(`${url}&audience=${encodeURIComponent(this.audience)}`, {
      headers: { Authorization: `Bearer ${requestToken}` },
    });
    if (!res.ok) throw new Error(`crabd: failed to mint OIDC token (${res.status})`);
    const data = (await res.json()) as { value?: string };
    if (!data.value) throw new Error('crabd: OIDC token response had no value');
    return data.value;
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) return this.cached.token;

    const oidc = await this.requestOidcToken();
    const res = await fetch(`${this.options.brokerUrl.replace(/\/$/, '')}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidc, repository: `${this.options.repo.owner}/${this.options.repo.name}` }),
    });
    if (!res.ok) {
      throw new Error(`crabd: broker rejected the request (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { token?: string; expiresAt?: string };
    if (!data.token) throw new Error('crabd: broker response had no token');

    this.cached = {
      token: data.token,
      expiresAt: data.expiresAt ? new Date(data.expiresAt).getTime() : now + 5 * 60_000,
    };
    return data.token;
  }
}
