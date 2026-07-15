import { describe, expect, it, vi } from 'vitest';

// Capture the options passed to the installation auth call. `vi.hoisted` makes the array
// available inside the (hoisted) vi.mock factory below.
const { authCalls } = vi.hoisted(() => ({ authCalls: [] as Record<string, unknown>[] }));

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: () => async (opts: Record<string, unknown>) => {
    authCalls.push(opts);
    return { token: 'ghs_scoped', expiresAt: '2999-01-01T00:00:00Z' };
  },
}));

import { GitHubAppAuth } from './github-app.ts';

const PEM = '-----BEGIN KEY-----\nabc\n-----END KEY-----';

describe('GitHubAppAuth.mintScopedToken', () => {
  it('mints a read-only token scoped to the given repositories', async () => {
    authCalls.length = 0;
    const auth = new GitHubAppAuth({ appId: 1, privateKey: PEM, installationId: 42 });
    const token = await auth.mintScopedToken({ repositoryNames: ['app', 'other'] });
    expect(token).toBe('ghs_scoped');
    expect(authCalls.at(-1)).toMatchObject({
      type: 'installation',
      installationId: 42,
      permissions: { contents: 'read', metadata: 'read' },
      repositoryNames: ['app', 'other'],
    });
  });

  it("omits repositoryNames for installation-wide ('all') scope, still read-only", async () => {
    authCalls.length = 0;
    const auth = new GitHubAppAuth({ appId: 1, privateKey: PEM, installationId: 42 });
    await auth.mintScopedToken({});
    expect(authCalls.at(-1)?.repositoryNames).toBeUndefined();
    expect(authCalls.at(-1)?.permissions).toEqual({ contents: 'read', metadata: 'read' });
  });

  it('adds packages:read only when requested (for a GitHub Packages .npmrc fallback)', async () => {
    authCalls.length = 0;
    const auth = new GitHubAppAuth({ appId: 1, privateKey: PEM, installationId: 42 });

    await auth.mintScopedToken({ packagesRead: true });
    expect(authCalls.at(-1)?.permissions).toEqual({ contents: 'read', metadata: 'read', packages: 'read' });

    await auth.mintScopedToken({ packagesRead: false });
    expect(authCalls.at(-1)?.permissions).toEqual({ contents: 'read', metadata: 'read' });
  });
});
