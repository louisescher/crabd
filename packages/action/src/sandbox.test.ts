import { describe, expect, it } from 'vitest';
import type { ResolvedNpmRegistry } from '@crabd/config';
import {
  forgeHost,
  gitCredentialEnv,
  type NpmrcAuthStatus,
  renderNpmrc,
  renderNpmrcAdvisory,
  scopedRepoNames,
} from './sandbox.ts';

describe('gitCredentialEnv', () => {
  it('uses the x-access-token username for GitHub installation tokens', () => {
    const env = gitCredentialEnv('github', 'github.com', 'ghs_tok');
    expect(env.GIT_CONFIG_KEY_0).toBe('url.https://x-access-token:ghs_tok@github.com/.insteadOf');
    expect(env.GIT_CONFIG_VALUE_0).toBe('https://github.com/');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
  });

  it('uses the token itself as the username for Forgejo, at the instance host', () => {
    const env = gitCredentialEnv('forgejo', 'forgejo.acme.dev', 'fj_tok');
    expect(env.GIT_CONFIG_KEY_0).toBe('url.https://fj_tok@forgejo.acme.dev/.insteadOf');
    expect(env.GIT_CONFIG_VALUE_0).toBe('https://forgejo.acme.dev/');
  });
});

describe('forgeHost', () => {
  it('defaults to github.com and derives the host from the server URL', () => {
    expect(forgeHost(undefined)).toBe('github.com');
    expect(forgeHost('https://github.com')).toBe('github.com');
    expect(forgeHost('https://ghe.acme.dev')).toBe('ghe.acme.dev');
    expect(forgeHost('not a url')).toBe('github.com');
  });
});

describe('scopedRepoNames', () => {
  it('scopes to explicit repos plus the trigger repo (deduped, names only)', () => {
    expect(scopedRepoNames(['acme/infra', 'acme/shared'], 'app')).toEqual(['app', 'infra', 'shared']);
    expect(scopedRepoNames(['acme/app'], 'app')).toEqual(['app']); // trigger deduped
  });

  it('returns just the trigger repo when no cross-repo access is configured', () => {
    expect(scopedRepoNames(undefined, 'app')).toEqual(['app']);
  });

  it('returns undefined (installation-wide) for "all" or globs', () => {
    expect(scopedRepoNames('all', 'app')).toBeUndefined();
    expect(scopedRepoNames(['acme/*'], 'app')).toBeUndefined();
  });
});

describe('renderNpmrc', () => {
  it('writes a scoped registry + env-referenced auth token (no secret literal)', () => {
    const regs: ResolvedNpmRegistry[] = [
      { registry: 'https://npm.pkg.github.com', scope: '@myorg', tokenEnv: 'NODE_AUTH_TOKEN' },
    ];
    const npmrc = renderNpmrc(regs, 'GH_TOKEN');
    expect(npmrc).toContain('@myorg:registry=https://npm.pkg.github.com/');
    expect(npmrc).toContain('//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}');
    expect(npmrc).not.toContain('ghp_'); // never a literal token
  });

  it('falls back to the forge token env when no tokenEnv is given, and sets a default registry', () => {
    const npmrc = renderNpmrc([{ registry: 'https://npm.pkg.github.com' }], 'GH_TOKEN');
    expect(npmrc).toContain('registry=https://npm.pkg.github.com/');
    expect(npmrc).toContain('//npm.pkg.github.com/:_authToken=${GH_TOKEN}');
  });

  it('handles path-based registries and skips malformed URLs', () => {
    const npmrc = renderNpmrc(
      [
        { registry: 'https://gitlab.com/api/v4/packages/npm/', scope: '@grp', tokenEnv: 'GL_TOKEN' },
        { registry: 'not-a-url' },
      ],
      'GH_TOKEN',
    );
    expect(npmrc).toContain('//gitlab.com/api/v4/packages/npm/:_authToken=${GL_TOKEN}');
    expect(npmrc).not.toContain('not-a-url');
  });

  it('returns an empty string when there are no registries', () => {
    expect(renderNpmrc([], 'GH_TOKEN')).toBe('');
  });
});

describe('renderNpmrcAdvisory', () => {
  it('returns an empty string when there are no registries', () => {
    expect(renderNpmrcAdvisory([])).toBe('');
  });

  it('tells the agent it may install when a registry is authenticated', () => {
    const statuses: NpmrcAuthStatus[] = [
      { registry: 'https://registry.npmjs.org', scope: '@example', tokenEnv: 'NPM_TOKEN', authed: true },
    ];
    const advisory = renderNpmrcAdvisory(statuses);
    expect(advisory).toContain('`@example` packages (https://registry.npmjs.org)');
    expect(advisory).toContain('authenticated — you may install');
    expect(advisory).not.toContain('401/403');
  });

  it('warns the agent off installs and names the missing token env when not authenticated', () => {
    const statuses: NpmrcAuthStatus[] = [
      { registry: 'https://registry.npmjs.org', scope: '@example', tokenEnv: 'NPM_TOKEN', authed: false },
    ];
    const advisory = renderNpmrcAdvisory(statuses);
    expect(advisory).toContain('NOT authenticated');
    expect(advisory).toContain('env `NPM_TOKEN`');
    expect(advisory).toContain('401/403');
    expect(advisory).toContain('review them from source');
  });

  it('explains a missing forge token for a fallback (no token_env) registry', () => {
    const statuses: NpmrcAuthStatus[] = [{ registry: 'https://npm.pkg.github.com', authed: false }];
    const advisory = renderNpmrcAdvisory(statuses);
    expect(advisory).toContain('no forge token was exposed for it');
    expect(advisory).toContain('NOT authenticated');
  });
});
