import type { ForgeKind } from '../forge/types.ts';

/**
 * Supplies a forge access token. Different strategies (static secret token, GitHub
 * App installation token, Forgejo OAuth2 / scoped token) implement this behind the
 * same interface, so the forge adapters never care how the token was obtained.
 */
export interface AuthProvider {
  readonly kind: ForgeKind;
  /**
   * Return a usable access token. Implementations should cache and refresh as
   * needed; callers may call this more than once.
   */
  getToken(): Promise<string>;
  /**
   * Mint a **read-only** token to expose in the model's sandbox so it can read *other*
   * repositories (via `gh`/`git`). `repositoryNames` scopes the token to those repos (names
   * within the token's account); omit for the installation's full scope. `packagesRead` adds
   * `packages: read` so the token can authenticate GitHub Packages (`npm.pkg.github.com`) — set
   * it only when a `.npmrc` entry relies on the forge token, to keep least privilege otherwise.
   * Optional: strategies that can't scope a token (a supplied static token / the single-repo
   * broker) don't implement it, and the caller falls back (expose the static token as-is, or
   * skip). Never write-scoped.
   */
  mintScopedToken?(options: { repositoryNames?: string[]; packagesRead?: boolean }): Promise<string>;
  /**
   * The permissions the token from {@link getToken} actually carries, as the forge reports them
   * (`{ contents: 'write', issues: 'write', … }`). Used to notice *before* the run that crab'd
   * cannot commit here, instead of discovering it in a 403 after the model has done the work.
   *
   * Returns `undefined` when the strategy cannot know (a supplied PAT or workflow token carries no
   * introspectable scope), and callers must read that as "unknown", never as "no access".
   * Optional: only strategies that mint their own tokens can answer.
   */
  tokenPermissions?(): Promise<Record<string, string> | undefined>;
}

/** A pre-issued token supplied directly (CI secret / PAT / fine-grained token). */
export class StaticTokenAuth implements AuthProvider {
  constructor(
    readonly kind: ForgeKind,
    private readonly token: string,
  ) {
    if (!token) throw new Error('crabd auth: empty token supplied to StaticTokenAuth');
  }

  getToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
}
