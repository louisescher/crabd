import {
  BrokerAuth,
  DEFAULT_BROKER_URL,
  ForgejoForge,
  GitHubAppAuth,
  GitHubForge,
  StaticTokenAuth,
  isOidcAvailable,
  type AuthProvider,
  type ForgeAdapter,
  type ForgeKind,
  type ForgeRepo,
} from '@crabd/core';

/** Which auth strategy `buildForge` selected — the CLI uses this to reason about cross-repo scope. */
export type ForgeAuthStrategy = 'app' | 'broker' | 'static';

export interface BuiltForge {
  adapter: ForgeAdapter;
  /** The auth provider, exposed so the CLI can mint a token for the progress-tool subprocess. */
  auth: AuthProvider;
  /**
   * The selected strategy. `app` can mint scoped read-only tokens (cross-repo capable); `static`
   * carries whatever the supplied token has; `broker` is single-repo by design (no cross-repo).
   */
  strategy: ForgeAuthStrategy;
}

/** Detect which forge we are running on from the environment. */
export function detectForge(env: NodeJS.ProcessEnv = process.env): ForgeKind {
  const explicit = env.CRABD_FORGE?.toLowerCase();
  if (explicit === 'github' || explicit === 'forgejo') return explicit;
  // Forgejo Actions set GITHUB_* vars too; FORGEJO_ACTIONS distinguishes it.
  if (env.FORGEJO_ACTIONS || env.GITHUB_SERVER_URL?.includes('forgejo')) return 'forgejo';
  return 'github';
}

/** Build the auth provider + forge adapter for the given repo from environment secrets. */
export function buildForge(forge: ForgeKind, repo: ForgeRepo, env: NodeJS.ProcessEnv = process.env): BuiltForge {
  if (forge === 'forgejo') {
    const token = env.CRABD_FORGEJO_TOKEN || env.CRABD_GITHUB_TOKEN || env.GITHUB_TOKEN;
    if (!token) throw new Error('crabd: no Forgejo token found. Set CRABD_FORGEJO_TOKEN.');
    // Derive the API root from the server URL Forgejo Actions expose.
    const server = (env.CRABD_FORGEJO_API_URL || env.GITHUB_API_URL || env.GITHUB_SERVER_URL || '').replace(/\/$/, '');
    if (!server) throw new Error('crabd: set CRABD_FORGEJO_API_URL to the Forgejo /api/v1 root.');
    const apiRoot = server.endsWith('/api/v1') ? server : `${server}/api/v1`;
    const auth = new StaticTokenAuth('forgejo', token);
    return { adapter: new ForgejoForge({ auth, repo, baseUrl: apiRoot }), auth, strategy: 'static' };
  }

  const baseUrl = env.CRABD_GITHUB_API_URL || env.GITHUB_API_URL || undefined;

  // 1. Custom/self-hosted App credentials override everything — this is how a repo
  //    or org runs its own branded App (it holds the key). Installation ID auto-resolved.
  if (env.CRABD_APP_ID && env.CRABD_APP_PRIVATE_KEY) {
    const auth = new GitHubAppAuth({
      appId: env.CRABD_APP_ID,
      privateKey: env.CRABD_APP_PRIVATE_KEY,
      ...(env.CRABD_APP_INSTALLATION_ID ? { installationId: env.CRABD_APP_INSTALLATION_ID } : {}),
      repo: { owner: repo.owner, name: repo.name },
      ...(baseUrl ? { baseUrl } : {}),
    });
    return { adapter: new GitHubForge({ auth, repo, ...(baseUrl ? { baseUrl } : {}) }), auth, strategy: 'app' };
  }

  // 2. Canonical crab'd[bot] via the hosted broker — the default when OIDC is
  //    available (`permissions: id-token: write`) and the broker isn't disabled.
  if (isOidcAvailable(env) && env.CRABD_DISABLE_BROKER !== 'true') {
    const auth = new BrokerAuth({
      // Composite-action inputs arrive as '' when unset, so fall back with ||.
      brokerUrl: env.CRABD_BROKER_URL || DEFAULT_BROKER_URL,
      repo: { owner: repo.owner, name: repo.name },
      ...(env.CRABD_BROKER_AUDIENCE ? { audience: env.CRABD_BROKER_AUDIENCE } : {}),
    });
    return { adapter: new GitHubForge({ auth, repo, ...(baseUrl ? { baseUrl } : {}) }), auth, strategy: 'broker' };
  }

  // 3. Fallback: the workflow token — works, but comments come from github-actions.
  const token = env.CRABD_GITHUB_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'crabd: no GitHub credentials. Enable OIDC (`permissions: id-token: write`) for the crab\'d bot, ' +
        'set CRABD_APP_* for your own App, or provide CRABD_GITHUB_TOKEN / GITHUB_TOKEN.',
    );
  }
  const auth = new StaticTokenAuth('github', token);
  return { adapter: new GitHubForge({ auth, repo, ...(baseUrl ? { baseUrl } : {}) }), auth, strategy: 'static' };
}
