import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const prEvent: ForgeEvent = {
  forge: 'github',
  kind: 'pull_request',
  action: 'opened',
  repo: { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true },
  actor: { login: 'contributor', association: 'CONTRIBUTOR', isBot: false },
  pullRequest: {
    number: 42,
    title: 'add feature',
    body: '',
    author: 'contributor',
    labels: [],
    state: 'open',
    headRef: 'feature-branch',
    baseRef: 'main',
    headSha: 'abc123',
    fromFork: true,
    isDraft: false,
  },
  raw: {},
};

/** A fake adapter whose `readOrgConfig` answers per repo slug, keyed as in the fixtures above. */
function adapterWithConfigs(configs: Record<string, string | undefined>): ForgeAdapter {
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
    readOrgConfig: vi.fn(async (repoSlug: string) => configs[repoSlug]),
  } as unknown as ForgeAdapter;
}

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
    expect(config.triggerPhrase).toBe('/crabd');
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

  it('maps the fallback-models input into the rate_limit fallback chain', async () => {
    const { config } = await loadResolvedConfig({
      adapter: adapterWithOrgConfig(undefined),
      event,
      cwd: '/nonexistent-repo-dir',
      env: { CRABD_INPUT_FALLBACK_MODELS: 'anthropic/claude-haiku-4-5, openai/gpt-x' },
    });
    expect(config.rateLimit.fallbackModels).toEqual(['anthropic/claude-haiku-4-5', 'openai/gpt-x']);
  });
});

describe('loadResolvedConfig: repoTrusted (permissions/governance from the default branch)', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function checkoutWith(yaml: string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), 'crabd-config-loader-'));
    if (yaml !== undefined) writeFileSync(join(dir, '.crabd.yml'), yaml, 'utf-8');
    createdDirs.push(dir);
    return dir;
  }

  it('reads permissions from the default branch on a pull request, and it wins over the checkout', async () => {
    const cwd = checkoutWith('permissions:\n  write: true\n');
    const adapter = adapterWithConfigs({ 'acme/app': 'permissions:\n  write: false\n' });

    const { config } = await loadResolvedConfig({ adapter, event: prEvent, cwd, env: {} });

    expect(config.permissions.write).toBe(false);
    expect(adapter.readOrgConfig).toHaveBeenCalledWith('acme/app', '.crabd.yml');
  });

  it('leaves every other checkout key contributor-reachable', async () => {
    const cwd = checkoutWith(
      'permissions:\n  write: true\nimplement:\n  verify:\n    commands: ["pnpm test"]\n',
    );
    const adapter = adapterWithConfigs({ 'acme/app': 'permissions:\n  write: false\n' });

    const { config } = await loadResolvedConfig({ adapter, event: prEvent, cwd, env: {} });

    expect(config.implement.verify.commands).toEqual(['pnpm test']);
  });

  it('fetches default-branch permissions even when the checkout has no .crabd.yml at all', async () => {
    const cwd = checkoutWith(undefined);
    const adapter = adapterWithConfigs({ 'acme/app': 'permissions:\n  write: false\n' });

    const { config } = await loadResolvedConfig({ adapter, event: prEvent, cwd, env: {} });

    expect(config.permissions.write).toBe(false);
  });

  it('does not fetch the default branch when the run is not on a pull request', async () => {
    const cwd = checkoutWith('permissions:\n  write: false\n');
    const adapter = adapterWithConfigs({});

    const { config } = await loadResolvedConfig({ adapter, event, cwd, env: {} });

    expect(config.permissions.write).toBe(false);
    expect(adapter.readOrgConfig).toHaveBeenCalledTimes(1); // the org layer only
  });

  it('skips the fetch when the pull request head is already the default branch', async () => {
    const cwd = checkoutWith('permissions:\n  write: false\n');
    const sameBranchEvent: ForgeEvent = {
      ...prEvent,
      pullRequest: { ...prEvent.pullRequest!, headRef: 'main' },
    };
    const adapter = adapterWithConfigs({});

    const { config } = await loadResolvedConfig({ adapter, event: sameBranchEvent, cwd, env: {} });

    expect(config.permissions.write).toBe(false);
    expect(adapter.readOrgConfig).toHaveBeenCalledTimes(1);
  });

  it('falls through to the org/default layers, ignoring the checkout, when the default-branch file is absent', async () => {
    const cwd = checkoutWith('permissions:\n  write: false\n');
    const adapter = adapterWithConfigs({ 'acme/app': undefined });

    const { config } = await loadResolvedConfig({ adapter, event: prEvent, cwd, env: {} });

    expect(config.permissions.write).toBe(true);
  });

  it('falls through to the org/default layers, without failing the run, when the default-branch file is unparseable', async () => {
    const cwd = checkoutWith('permissions:\n  write: false\n');
    const adapter = adapterWithConfigs({ 'acme/app': '- not\n- a mapping\n' });

    const { config } = await loadResolvedConfig({ adapter, event: prEvent, cwd, env: {} });

    expect(config.permissions.write).toBe(true);
  });
});
