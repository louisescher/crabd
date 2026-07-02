import { describe, expect, it } from 'vitest';
import { collectSecrets, redactSecrets } from './redact.ts';

describe('redactSecrets', () => {
  it('redacts a secret value from text', () => {
    expect(redactSecrets('token is sk-abcdef123456 here', ['sk-abcdef123456'])).toBe('token is [redacted] here');
  });

  it('ignores empty and very short values', () => {
    expect(redactSecrets('nothing to redact', ['', 'ab'])).toBe('nothing to redact');
  });

  it('leaves text without secrets unchanged', () => {
    expect(redactSecrets('all clear', ['sk-notpresent0000'])).toBe('all clear');
  });
});

describe('collectSecrets', () => {
  it('gathers set provider/token env values', () => {
    const secrets = collectSecrets({ ANTHROPIC_API_KEY: 'sk-anthropic-123', GITHUB_TOKEN: 'ghs_token_456' } as NodeJS.ProcessEnv);
    expect(secrets).toEqual(['sk-anthropic-123', 'ghs_token_456']);
  });
});
