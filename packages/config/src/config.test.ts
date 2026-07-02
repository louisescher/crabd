import { describe, expect, it } from 'vitest';
import { parseConfigYaml } from './yaml.ts';
import { providerOf, resolveConfig } from './merge.ts';
import type { CrabdConfigPartial } from './schema.ts';

describe('parseConfigYaml', () => {
  it('parses a full document', () => {
    const cfg = parseConfigYaml(`
model: openai/gpt-5.5
trigger_phrase: "@bot"
providers:
  allowlist: [openai, anthropic]
modes:
  review:
    enabled: false
`);
    expect(cfg.model).toBe('openai/gpt-5.5');
    expect(cfg.trigger_phrase).toBe('@bot');
    expect(cfg.providers?.allowlist).toEqual(['openai', 'anthropic']);
    expect(cfg.modes?.review?.enabled).toBe(false);
  });

  it('treats an empty document as an empty partial', () => {
    expect(parseConfigYaml('')).toEqual({});
    expect(parseConfigYaml('\n# comment\n')).toEqual({});
  });

  it('rejects a non-mapping top level', () => {
    expect(() => parseConfigYaml('- a\n- b')).toThrow(/mapping/);
  });

  it('rejects an unknown shape', () => {
    expect(() => parseConfigYaml('model: 123')).toThrow();
  });
});

describe('resolveConfig — defaults', () => {
  it('fills every field from built-in defaults', () => {
    const r = resolveConfig({ layers: {} });
    expect(r.model).toBe('anthropic/claude-sonnet-5');
    expect(r.triggerPhrase).toBe('/crabd');
    expect(r.thinkingLevel).toBe('medium');
    expect(r.providers.allowlist).toEqual([]);
    expect(r.review.commentOnly).toBe(false);
    expect(r.webSearch).toEqual({ enabled: true, maxResults: 5 });
    expect(r.limits.maxTurns).toBe(40);
    expect(r.modes.mention?.enabled).toBe(true);
    expect(r.modes.mention?.tools).toEqual(['comment', 'commit']);
  });
});

describe('resolveConfig — merge semantics', () => {
  it('scalars: highest layer wins', () => {
    const r = resolveConfig({
      layers: {
        org: { model: 'openai/gpt-5.5' },
        repo: { model: 'openrouter/moonshotai/kimi-k2.6' },
      },
    });
    expect(r.model).toBe('openrouter/moonshotai/kimi-k2.6');
  });

  it('instructions: accumulate across all layers in precedence order', () => {
    const r = resolveConfig({
      layers: {
        org: { prompt: { instructions: 'org rule' } },
        repo: { prompt: { instructions: 'repo rule' } },
        inputs: { prompt: { instructions: 'input rule' } },
      },
    });
    expect(r.prompt.instructions).toBe('org rule\n\nrepo rule\n\ninput rule');
  });

  it('lists: replaced by the highest layer (not merged)', () => {
    const r = resolveConfig({
      layers: {
        org: { providers: { allowlist: ['anthropic', 'openai'] } },
        repo: { providers: { allowlist: ['ollama'] } },
      },
    });
    expect(r.providers.allowlist).toEqual(['ollama']);
  });

  it('per-mode: scalars override, instructions accumulate, tools replace', () => {
    const r = resolveConfig({
      layers: {
        org: { modes: { review: { instructions: 'be strict', tools: ['comment', 'review'] } } },
        repo: { modes: { review: { model: 'openai/gpt-5.5', instructions: 'focus on tests', tools: ['review'] } } },
      },
    });
    expect(r.modes.review?.model).toBe('openai/gpt-5.5');
    expect(r.modes.review?.instructions).toBe('be strict\n\nfocus on tests');
    expect(r.modes.review?.tools).toEqual(['review']);
  });

  it('discovers custom mode names from any layer (registry is pluggable)', () => {
    const r = resolveConfig({
      layers: { repo: { modes: { triage: { enabled: true, instructions: 'label it' } } } },
    });
    expect(r.modes.triage?.enabled).toBe(true);
    expect(r.modes.triage?.instructions).toBe('label it');
  });
});

describe('resolveConfig — custom providers', () => {
  it('resolves custom providers into camelCase for runtime registration', () => {
    const r = resolveConfig({
      layers: {
        repo: {
          providers: {
            allowlist: ['my-llm'],
            custom: [{ id: 'my-llm', base_url: 'https://llm.internal/v1', api_key_env: 'MY_LLM_KEY' }],
          },
        },
      },
    });
    expect(r.providers.custom).toEqual([
      { id: 'my-llm', baseUrl: 'https://llm.internal/v1', apiKeyEnv: 'MY_LLM_KEY' },
    ]);
  });

  it('defaults custom providers to an empty list', () => {
    expect(resolveConfig({ layers: {} }).providers.custom).toEqual([]);
  });

  it('reconciles custom providers by id across layers (reuse org + override)', () => {
    const r = resolveConfig({
      layers: {
        org: { providers: { custom: [{ id: 'shared', base_url: 'https://org/v1' }] } },
        repo: {
          providers: {
            custom: [
              { id: 'shared', base_url: 'https://repo/v1' }, // overrides org's `shared`
              { id: 'repo-only', base_url: 'https://x/v1' },
            ],
          },
        },
      },
    });
    expect(r.providers.custom).toEqual([
      { id: 'shared', baseUrl: 'https://repo/v1' },
      { id: 'repo-only', baseUrl: 'https://x/v1' },
    ]);
  });
});

describe('resolveConfig — mcp reconciliation', () => {
  it('merges mcp servers by name across layers', () => {
    const r = resolveConfig({
      layers: {
        org: { mcp: [{ name: 'sentry', url: 'https://org/sentry' }] },
        repo: {
          mcp: [
            { name: 'sentry', url: 'https://repo/sentry' }, // override
            { name: 'docs', url: 'https://repo/docs' },
          ],
        },
      },
    });
    expect(r.mcp).toEqual([
      { name: 'sentry', url: 'https://repo/sentry' },
      { name: 'docs', url: 'https://repo/docs' },
    ]);
  });
});

describe('resolveConfig — governance / locked keys', () => {
  const org: CrabdConfigPartial = {
    providers: { allowlist: ['anthropic'] },
    governance: { locked: ['providers.allowlist'] },
  };

  it('a repo cannot override a locked key', () => {
    const r = resolveConfig({
      layers: { org, repo: { providers: { allowlist: ['ollama', 'openai'] } } },
    });
    expect(r.providers.allowlist).toEqual(['anthropic']);
  });

  it('env cannot override a locked key either', () => {
    const r = resolveConfig({
      layers: { org, env: { providers: { allowlist: ['ollama'] } } },
    });
    expect(r.providers.allowlist).toEqual(['anthropic']);
  });

  it('unlocked keys remain overridable', () => {
    const r = resolveConfig({
      layers: { org, repo: { model: 'openai/gpt-5.5' } },
    });
    expect(r.model).toBe('openai/gpt-5.5');
    expect(r.providers.allowlist).toEqual(['anthropic']);
  });
});

describe('resolveConfig — full prompt override gating', () => {
  const repo: CrabdConfigPartial = {
    prompt: { allow_full_override: true, override: 'CUSTOM SYSTEM PROMPT' },
  };

  it('applies override only when org allowlists the repo AND repo opts in', () => {
    const r = resolveConfig({
      repoSlug: 'acme/app',
      layers: { org: { governance: { full_override_repos: ['acme/app'] } }, repo },
    });
    expect(r.prompt.override).toBe('CUSTOM SYSTEM PROMPT');
  });

  it('denies override when the org does not allowlist the repo', () => {
    const r = resolveConfig({
      repoSlug: 'acme/app',
      layers: { org: { governance: { full_override_repos: ['other/repo'] } }, repo },
    });
    expect(r.prompt.override).toBeUndefined();
  });

  it('denies override when the repo did not opt in, even if allowlisted', () => {
    const r = resolveConfig({
      repoSlug: 'acme/app',
      layers: {
        org: { governance: { full_override_repos: ['acme/app'] } },
        repo: { prompt: { override: 'X' } },
      },
    });
    expect(r.prompt.override).toBeUndefined();
  });
});

describe('providerOf', () => {
  it('extracts the provider id from a specifier', () => {
    expect(providerOf('anthropic/claude-sonnet-4-6')).toBe('anthropic');
    expect(providerOf('openrouter/moonshotai/kimi-k2.6')).toBe('openrouter');
    expect(providerOf('bare')).toBe('bare');
  });
});
