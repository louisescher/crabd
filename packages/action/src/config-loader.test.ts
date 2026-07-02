import { describe, expect, it, vi } from 'vitest';
import type { ForgeAdapter, ForgeEvent } from '@crabd/core';
import { loadResolvedConfig } from './config-loader.ts';

function adapterWithOrgConfig(orgYaml: string | undefined): ForgeAdapter {
  return {
    kind: 'github',
    repo: { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true },
    getContext: vi.fn(),
    resolveActor: vi.fn(),
    createTrackingComment: vi.fn(),
    updateTrackingComment: vi.fn(),
    postReview: vi.fn(),
    commitToBranch: vi.fn(),
    openOrUpdatePR: vi.fn(),
    readOrgConfig: vi.fn(async () => orgYaml),
  } as unknown as ForgeAdapter;
}

const event: ForgeEvent = {
  forge: 'github',
  kind: 'issue_comment',
  action: 'created',
  repo: { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true },
  actor: { login: 'dev', association: 'MEMBER', isBot: false },
  raw: {},
};

describe('loadResolvedConfig', () => {
  it('layers org config, action inputs, and defaults, honoring locked keys', async () => {
    const orgYaml = [
      'providers:',
      '  allowlist: [anthropic]',
      'governance:',
      '  locked: [providers.allowlist]',
    ].join('\n');

    const { config } = await loadResolvedConfig({
      adapter: adapterWithOrgConfig(orgYaml),
      event,
      cwd: '/nonexistent-repo-dir',
      env: { CRABD_INPUT_MODEL: 'anthropic/claude-haiku-4-5', CRABD_INPUT_PROVIDERS: 'openai,ollama' },
    });

    // Input model applied.
    expect(config.model).toBe('anthropic/claude-haiku-4-5');
    // providers.allowlist is org-locked, so the CRABD_INPUT_PROVIDERS override is ignored.
    expect(config.providers.allowlist).toEqual(['anthropic']);
    // Default trigger phrase remains.
    expect(config.triggerPhrase).toBe('@crabd');
  });

  it('falls back to defaults when no org config exists', async () => {
    const { config } = await loadResolvedConfig({
      adapter: adapterWithOrgConfig(undefined),
      event,
      cwd: '/nonexistent-repo-dir',
      env: {},
    });
    expect(config.model).toBe('anthropic/claude-sonnet-5');
    expect(config.providers.allowlist).toEqual([]);
  });
});
