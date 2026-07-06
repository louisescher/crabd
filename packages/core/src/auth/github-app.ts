import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type { AuthProvider } from './types.ts';

/**
 * Accept the App private key as a raw PEM **or** a base64-encoded PEM. Base64 is the
 * easier form to pass through an env var (no newlines); a non-PEM value is decoded.
 */
export function normalizePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf-8').trim();
}

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
  private readonly privateKey: string;
  private installationId?: number;
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly options: GitHubAppAuthOptions) {
    if (options.installationId != null && options.installationId !== '') {
      this.installationId = Number(options.installationId);
    }
    // Accept a raw PEM or a base64-encoded PEM.
    this.privateKey = normalizePrivateKey(options.privateKey);
    this.auth = createAppAuth({ appId: options.appId, privateKey: this.privateKey });
  }

  private async resolveInstallationId(): Promise<number> {
    if (this.installationId != null) return this.installationId;
    if (!this.options.repo) {
      throw new Error('crabd: GitHub App auth needs an installation ID or a repo to resolve one');
    }
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: this.options.appId, privateKey: this.privateKey },
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

  /**
   * Mint a fresh, **read-only** installation token for the sandbox. Scoped to
   * `repositoryNames` when given (least privilege), else the installation's full scope
   * (for `repos.read: all`). Not cached — it carries narrower permissions than
   * {@link getToken}, so it must not be shared with the write-capable adapter token.
   */
  async mintScopedToken(options: { repositoryNames?: string[] }): Promise<string> {
    const installationId = await this.resolveInstallationId();
    const result = await this.auth({
      type: 'installation',
      installationId,
      permissions: { contents: 'read', metadata: 'read' },
      ...(options.repositoryNames && options.repositoryNames.length > 0
        ? { repositoryNames: options.repositoryNames }
        : {}),
    });
    return result.token;
  }
}
