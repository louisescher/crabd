import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { AuthProvider } from './types.ts';

export interface GitHubAppAuthOptions {
  appId: string | number;
  privateKey: string;
  /** Installation ID. Omit to auto-resolve from `repo` via the App JWT. */
  installationId?: string | number;
  /** Repo used to resolve the installation ID when it isn't supplied. */
  repo?: { owner: string; name: string };
  /** GitHub API base URL (for GitHub Enterprise). Defaults to public GitHub. */
  baseUrl?: string;
}

/**
 * Mints (and caches) a GitHub App **installation** access token. Comments and
 * commits made with this token are attributed to the App's bot identity (e.g.
 * `crab'd[bot]`) instead of the generic `github-actions` bot.
 *
 * The token is installation-scoped — typically the whole org — so it can also read
 * the org config repo. When no installation ID is supplied, it is resolved from the
 * target repo using the App JWT, so callers only need the App ID and private key.
 */
export class GitHubAppAuth implements AuthProvider {
  readonly kind = 'github' as const;
  private readonly auth: ReturnType<typeof createAppAuth>;
  private installationId?: number;
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly options: GitHubAppAuthOptions) {
    if (options.installationId != null && options.installationId !== '') {
      this.installationId = Number(options.installationId);
    }
    this.auth = createAppAuth({ appId: options.appId, privateKey: options.privateKey });
  }

  private async resolveInstallationId(): Promise<number> {
    if (this.installationId != null) return this.installationId;
    if (!this.options.repo) {
      throw new Error('crabd: GitHub App auth needs an installation ID or a repo to resolve one');
    }
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: this.options.appId, privateKey: this.options.privateKey },
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
    });
    const { data } = await appOctokit.apps.getRepoInstallation({
      owner: this.options.repo.owner,
      repo: this.options.repo.name,
    });
    this.installationId = data.id;
    return data.id;
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) return this.cached.token;

    const installationId = await this.resolveInstallationId();
    const result = await this.auth({ type: 'installation', installationId });
    this.cached = { token: result.token, expiresAt: new Date(result.expiresAt).getTime() };
    return result.token;
  }
}
