import type { ResolvedNpmRegistry } from '@crabd/config';

/**
 * Pure helpers for wiring the model's sandbox: which repos a read token covers, how to render a
 * managed `.npmrc`, and the forge host for git auth. The side effects (minting the token, reading
 * `process.env`, writing the `.npmrc`) live in the CLI; this module stays pure and testable.
 */

/**
 * Env that preconfigures `git` in the sandbox to authenticate `https://<host>/…` clones with
 * `token` (via a `url.<…>.insteadOf` rewrite). GitHub **installation** tokens require the
 * `x-access-token` basic-auth username; Forgejo/Gitea accept the token itself as the username.
 */
export function gitCredentialEnv(forge: string, host: string, token: string): Record<string, string> {
  const userinfo = forge === 'forgejo' ? token : `x-access-token:${token}`;
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.https://${userinfo}@${host}/.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://${host}/`,
  };
}

/** Host (e.g. `github.com`) for git/gh auth in the sandbox, derived from the Actions server URL. */
export function forgeHost(serverUrl: string | undefined): string {
  if (!serverUrl) return 'github.com';
  try {
    return new URL(serverUrl).host;
  } catch {
    return 'github.com';
  }
}

/**
 * Repo names (within the token's account) to scope the read-only sandbox token to, or `undefined`
 * for installation-wide access (`all`, or a glob we can't enumerate here). Always includes the
 * trigger repo so `gh`/`git` work on it too.
 */
export function scopedRepoNames(read: 'all' | string[] | undefined, triggerName: string): string[] | undefined {
  if (read === 'all') return undefined;
  if (read === undefined) return [triggerName];
  if (read.some((r) => r.includes('*'))) return undefined;
  const names = read.map((slug) => (slug.includes('/') ? slug.slice(slug.indexOf('/') + 1) : slug));
  return [...new Set([triggerName, ...names])];
}

/**
 * Render a managed `.npmrc` from configured registries. Auth tokens are referenced by env-var
 * name (`${NAME}`) — npm/pnpm expand them at runtime — so no secret literal is written to disk.
 * Entries without an explicit `tokenEnv` fall back to `fallbackTokenEnv` (the exposed forge token).
 */
export function renderNpmrc(registries: ResolvedNpmRegistry[], fallbackTokenEnv: string): string {
  const lines: string[] = [];
  for (const r of registries) {
    let hostPath: string;
    try {
      const url = new URL(r.registry);
      hostPath = `${url.host}${url.pathname}`.replace(/\/+$/, '') + '/';
    } catch {
      continue; // skip a malformed registry URL
    }
    const base = r.registry.replace(/\/+$/, '') + '/';
    lines.push(r.scope ? `${r.scope}:registry=${base}` : `registry=${base}`);
    lines.push(`//${hostPath}:_authToken=\${${r.tokenEnv ?? fallbackTokenEnv}}`);
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}
