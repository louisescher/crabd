import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

export interface MintOptions {
  appId: string | number;
  privateKey: string;
  owner: string;
  repo: string;
}

export interface MintedToken {
  token: string;
  expiresAt: string;
  /** Permissions the installation actually granted, so the action can tell what it may do. */
  permissions?: Record<string, string>;
}

/**
 * Mint a short-lived installation token for the canonical crab'd App, **scoped to
 * the single requesting repository** with only the permissions crab'd needs. This
 * is the only place the App private key is used.
 *
 * Throws if the App is not installed on the repo — which is the authorization check:
 * a token is only ever vended for repos that installed crab'd.
 */
export async function mintInstallationToken(options: MintOptions): Promise<MintedToken> {
  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: options.appId, privateKey: options.privateKey },
  });
  const { data: installation } = await appOctokit.apps.getRepoInstallation({
    owner: options.owner,
    repo: options.repo,
  });

  // GitHub rejects the whole mint with 422 when the requested permissions are not a subset of what
  // the installation granted, so anything optional has to be intersected rather than asked for.
  // `checks`/`actions` are read only by a feedback round, and an installation that has not accepted
  // them yet must keep working without the CI context rather than failing every run.
  const granted = (installation.permissions ?? {}) as Record<string, string | undefined>;
  const optional = (['checks', 'actions'] as const).reduce<Record<string, 'read'>>((acc, name) => {
    if (granted[name]) acc[name] = 'read';
    return acc;
  }, {});

  const auth = createAppAuth({ appId: options.appId, privateKey: options.privateKey });
  const result = await auth({
    type: 'installation',
    installationId: installation.id,
    repositoryNames: [options.repo],
    permissions: {
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      metadata: 'read',
      ...optional,
    },
  });

  return {
    token: result.token,
    expiresAt: result.expiresAt,
    ...(result.permissions ? { permissions: result.permissions as Record<string, string> } : {}),
  };
}
