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

/** A configured private registry paired with whether its auth token actually resolved in the sandbox. */
export interface NpmrcAuthStatus extends ResolvedNpmRegistry {
  /** True when the token this registry authenticates with is present in the sandbox env. */
  authed: boolean;
}

/**
 * Advisory the CLI appends to the agent's instructions so it knows, before it starts, which private
 * registries are usable. Without this the agent rediscovers a missing token the hard way — the exact
 * failure that burned a whole review's tool budget on 401/403 retries. Returns `''` when there are no
 * registries (nothing worth saying) so the caller can skip appending.
 */
export function renderNpmrcAdvisory(statuses: NpmrcAuthStatus[]): string {
  if (statuses.length === 0) return '';
  const lines = statuses.map((s) => {
    const where = s.scope ? `\`${s.scope}\` packages (${s.registry})` : s.registry;
    if (s.authed) {
      return `- ${where}: authenticated — you may install these packages.`;
    }
    const why = s.tokenEnv
      ? `its auth token (env \`${s.tokenEnv}\`) is not available in this sandbox`
      : `no forge token was exposed for it`;
    return `- ${where}: NOT authenticated — ${why}, so \`npm\`/\`pnpm install\` of these packages will fail with 401/403. Do not try to install, build, or test packages that depend on them; review them from source instead.`;
  });
  return `Sandbox private-registry status (read this before running any install):\n${lines.join('\n')}`;
}
