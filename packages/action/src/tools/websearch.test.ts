import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@flue/runtime';
import { webSearchTools } from './websearch.ts';

function fetchUrlTool(): ToolDefinition {
  const tool = webSearchTools({ maxResults: 5 }).find((t) => t.name === 'fetch_url');
  if (!tool) throw new Error('fetch_url tool not found');
  return tool;
}

// The URL comes from the model, which can be steered by attacker-controlled PR/issue
// text — so fetch_url must refuse private/internal targets (SSRF) before hitting the network.
describe('fetch_url SSRF guard', () => {
  const tool = fetchUrlTool();

  it.each([
    ['the cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:8080/'],
    ['localhost', 'http://localhost/admin'],
    ['a private 10/8 address', 'http://10.0.0.5/'],
    ['a private 192.168/16 address', 'http://192.168.1.1/'],
    ['a private 172.16/12 address', 'http://172.16.0.1/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['a *.internal host', 'http://vault.internal/secret'],
  ])('refuses %s', async (_label, url) => {
    const result = (await tool.run({ data: { url } } as never)) as { output: { url: string; text: string } };
    expect(result.output.text).toMatch(/^\(refused:/);
  });

  it.each([
    ['file://', 'file:///etc/passwd'],
    ['ftp://', 'ftp://example.com/x'],
  ])('refuses non-http(s) scheme %s', async (_label, url) => {
    const result = (await tool.run({ data: { url } } as never)) as { output: { url: string; text: string } };
    expect(result.output.text).toMatch(/^\(refused:/);
  });

  it('refuses a malformed URL', async () => {
    const result = (await tool.run({ data: { url: 'not a url' } } as never)) as { output: { url: string; text: string } };
    expect(result.output.text).toMatch(/^\(refused:/);
  });
});

// A run whose shell token cannot read the forge API reaches for the web page next. It gets a 404
// on a private repository and chrome on a public one, so the refusal names where the data already is.
describe('fetch_url on the run\'s own forge', () => {
  function tool(): ToolDefinition {
    const found = webSearchTools({ maxResults: 5, forgeHost: 'github.com' }).find((t) => t.name === 'fetch_url');
    if (!found) throw new Error('fetch_url tool not found');
    return found;
  }

  it.each([
    ['a pull request page', 'https://github.com/acme/app/pull/3615'],
    ['a www host', 'https://www.github.com/acme/app/issues/1'],
    ['the host root', 'https://github.com/'],
  ])('refuses %s and points at the context', async (_label, url) => {
    const result = (await tool().run({ data: { url } } as never)) as { output: { text: string } };
    expect(result.output.text).toMatch(/^\(refused:/);
    expect(result.output.text).toContain('already in your context');
  });

  it('leaves another host alone', async () => {
    const result = (await tool().run({ data: { url: 'http://127.0.0.1/' } } as never)) as { output: { text: string } };
    expect(result.output.text).not.toContain('already in your context');
  });

  it('does not refuse a forge host when none is configured', async () => {
    const found = webSearchTools({ maxResults: 5 }).find((t) => t.name === 'fetch_url');
    const result = (await found!.run({ data: { url: 'http://localhost/' } } as never)) as { output: { text: string } };
    expect(result.output.text).not.toContain('already in your context');
  });
});
