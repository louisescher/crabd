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
