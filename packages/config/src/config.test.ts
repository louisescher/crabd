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
    expect(r.appearance).toEqual({ name: "crab'd", emoji: '🦀', footer: true });
    expect(r.limits.maxTurns).toBe(40);
    expect(r.modes.mention?.enabled).toBe(true);
    expect(r.modes.mention?.tools).toEqual(['comment', 'commit']);
  });
});

describe('resolveConfig — appearance', () => {
  it('lets a repo override name/emoji/footer', () => {
    const r = resolveConfig({
      layers: { repo: { appearance: { name: 'DevBot', emoji: '🐙', footer: false } } },
    });
    expect(r.appearance).toEqual({ name: 'DevBot', emoji: '🐙', footer: false });
  });

  it('keeps an explicit empty emoji (removal) but falls back on a blank name', () => {
    const r = resolveConfig({ layers: { repo: { appearance: { emoji: '', name: '   ' } } } });
    expect(r.appearance.emoji).toBe('');
    expect(r.appearance.name).toBe("crab'd");
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

describe('resolveConfig — rate_limit', () => {
  it('fills rate_limit from built-in defaults', () => {
    const r = resolveConfig({ layers: {} });
    expect(r.rateLimit.fallbackModels).toEqual([]);
    expect(r.rateLimit.maxRetries).toBe(4);
    expect(r.rateLimit.maxWaitSeconds).toBe(180);
    expect(r.rateLimit.triggerScope).toBe('transient');
    expect(r.rateLimit.onExhausted).toBeUndefined();
    expect(r.rateLimit.backoff).toEqual({
      strategy: 'exponential',
      initialDelaySeconds: 2,
      maxDelaySeconds: 30,
      multiplier: 2,
      jitter: true,
    });
  });

  it('scalars: highest layer wins; backoff scalars merge per-leaf', () => {
    const r = resolveConfig({
      layers: {
        org: { rate_limit: { max_wait_seconds: 90, backoff: { strategy: 'linear', multiplier: 3 } } },
        repo: { rate_limit: { max_wait_seconds: 240, on_exhausted: 'fail' } },
      },
    });
    expect(r.rateLimit.maxWaitSeconds).toBe(240);
    expect(r.rateLimit.onExhausted).toBe('fail');
    // org's backoff.strategy survives; other leaves fall back to defaults.
    expect(r.rateLimit.backoff.strategy).toBe('linear');
    expect(r.rateLimit.backoff.multiplier).toBe(3);
    expect(r.rateLimit.backoff.initialDelaySeconds).toBe(2);
  });

  it('fallback_models is a value-list replaced by the highest layer', () => {
    const r = resolveConfig({
      layers: {
        org: { rate_limit: { fallback_models: ['anthropic/claude-haiku-4-5'] } },
        repo: { rate_limit: { fallback_models: ['openai/gpt-x', 'google/gemini-y'] } },
      },
    });
    expect(r.rateLimit.fallbackModels).toEqual(['openai/gpt-x', 'google/gemini-y']);
  });

  it('org can lock a rate_limit path against lower layers', () => {
    const org: CrabdConfigPartial = {
      rate_limit: { fallback_models: ['anthropic/claude-haiku-4-5'] },
      governance: { locked: ['rate_limit.fallback_models'] },
    };
    const r = resolveConfig({
      layers: { org, repo: { rate_limit: { fallback_models: ['openai/gpt-x'] } } },
    });
    expect(r.rateLimit.fallbackModels).toEqual(['anthropic/claude-haiku-4-5']);
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

describe('resolveConfig — repos & sandbox', () => {
  it('defaults to no cross-repo access and empty sandbox', () => {
    const r = resolveConfig({ layers: {} });
    expect(r.repos.read).toBeUndefined();
    expect(r.sandbox).toEqual({ env: [], npmrc: [] });
  });

  it('resolves repos.read as "all" or a list', () => {
    expect(resolveConfig({ layers: { repo: { repos: { read: 'all' } } } }).repos.read).toBe('all');
    expect(
      resolveConfig({ layers: { repo: { repos: { read: ['org/a', 'org/*'] } } } }).repos.read,
    ).toEqual(['org/a', 'org/*']);
  });

  it('resolves sandbox.env (replace) and maps npmrc token_env → tokenEnv', () => {
    const r = resolveConfig({
      layers: {
        repo: {
          sandbox: {
            env: ['NODE_AUTH_TOKEN', 'NPM_TOKEN'],
            npmrc: [{ registry: 'https://npm.pkg.github.com', scope: '@myorg', token_env: 'NODE_AUTH_TOKEN' }],
          },
        },
      },
    });
    expect(r.sandbox.env).toEqual(['NODE_AUTH_TOKEN', 'NPM_TOKEN']);
    expect(r.sandbox.npmrc).toEqual([
      { registry: 'https://npm.pkg.github.com', scope: '@myorg', tokenEnv: 'NODE_AUTH_TOKEN' },
    ]);
  });

  it('lets the org lock repos.read and sandbox.env against lower layers', () => {
    const org: CrabdConfigPartial = {
      repos: { read: ['org/allowed'] },
      sandbox: { env: ['ORG_TOKEN'] },
      governance: { locked: ['repos.read', 'sandbox.env'] },
    };
    const r = resolveConfig({
      layers: { org, repo: { repos: { read: 'all' }, sandbox: { env: ['SNEAKY'] } } },
    });
    expect(r.repos.read).toEqual(['org/allowed']);
    expect(r.sandbox.env).toEqual(['ORG_TOKEN']);
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
