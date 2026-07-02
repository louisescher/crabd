import { describe, expect, it } from 'vitest';
import { resolveConfig } from '@crabd/config';
import { authorizeActor } from './trust.ts';
import { checkProviderAllowlist } from './providers.ts';

describe('authorizeActor', () => {
  it('allows an allowlisted association', () => {
    expect(authorizeActor({ login: 'a', association: 'MEMBER', isBot: false }, ['OWNER', 'MEMBER']).allowed).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(authorizeActor({ login: 'a', association: 'member', isBot: false }, ['MEMBER']).allowed).toBe(true);
  });
  it('denies a non-allowlisted association', () => {
    const r = authorizeActor({ login: 'a', association: 'NONE', isBot: false }, ['OWNER']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not in the allowlist/);
  });
  it('always denies bots', () => {
    const r = authorizeActor({ login: 'bot[bot]', association: 'OWNER', isBot: true }, ['OWNER']);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/bot/);
  });
});

describe('checkProviderAllowlist', () => {
  it('passes when default and mode models use allowlisted providers', () => {
    const config = resolveConfig({
      layers: {
        org: { model: 'anthropic/claude-sonnet-4-6', providers: { allowlist: ['anthropic', 'openai'] } },
        repo: { modes: { review: { model: 'openai/gpt-5.5' } } },
      },
    });
    expect(checkProviderAllowlist(config).ok).toBe(true);
  });

  it('allows any provider when the allowlist is empty (zero-config default)', () => {
    const config = resolveConfig({ layers: { repo: { model: 'whatever/model' } } });
    expect(config.providers.allowlist).toEqual([]);
    expect(checkProviderAllowlist(config).ok).toBe(true);
  });

  it('flags a mode model whose provider is not allowlisted', () => {
    const config = resolveConfig({
      layers: {
        org: { model: 'anthropic/claude-sonnet-4-6', providers: { allowlist: ['anthropic'] } },
        repo: { modes: { review: { model: 'openai/gpt-5.5' } } },
      },
    });
    const r = checkProviderAllowlist(config);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatch(/openai/);
  });
});
