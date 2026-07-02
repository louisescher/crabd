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

  const auth = createAppAuth({ appId: options.appId, privateKey: options.privateKey });
  const result = await auth({
    type: 'installation',
    installationId: installation.id,
    repositoryNames: [options.repo],
    permissions: { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' },
  });

  return { token: result.token, expiresAt: result.expiresAt };
}
