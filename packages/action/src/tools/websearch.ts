import { lookup } from 'node:dns/promises';
import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Per-request deadline so a slow endpoint can't hang the whole turn. */
const REQUEST_TIMEOUT_MS = 10_000;

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local — includes the cloud metadata IP
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isBlockedIp(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique-local
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1]) return isBlockedIpv4(mapped[1]);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return isBlockedIpv4(ip);
  return false;
}

/**
 * SSRF guard: reject non-http(s) URLs and anything that resolves to a private,
 * loopback, or link-local address (e.g. the cloud metadata endpoint). The URL comes
 * from the model, which can be steered by attacker-controlled PR/issue text.
 */
async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('refusing to fetch an internal host');
  }
  // IP literal → check directly; hostname → resolve and check every address.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isBlockedIp(host)) throw new Error('refusing to fetch a private/internal address');
    return;
  }
  const addresses = await lookup(host, { all: true });
  if (addresses.some((a) => isBlockedIp(a.address))) {
    throw new Error('refusing to fetch a private/internal address');
  }
}

/** Strip HTML to readable text (best-effort) for the fetch_url tool. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tavily — an LLM-oriented search API. Used when TAVILY_API_KEY is set. */
async function tavilySearch(query: string, maxResults: number, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`tavily search failed (${res.status})`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
}

/** Keyless DuckDuckGo HTML fallback — best-effort, no API key required. */
async function duckduckgoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; crabd-bot)' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [...html.matchAll(snippetRe)].map((m) => htmlToText(m[1] ?? ''));
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = linkRe.exec(html)) !== null && results.length < maxResults) {
    let url = match[1] ?? '';
    // DuckDuckGo wraps external links as /l/?uddg=<encoded>.
    const wrapped = /[?&]uddg=([^&]+)/.exec(url);
    if (wrapped?.[1]) url = decodeURIComponent(wrapped[1]);
    results.push({ title: htmlToText(match[2] ?? ''), url, snippet: snippets[i] ?? '' });
    i += 1;
  }
  return results;
}

/**
 * Tools that let the agent research things beyond its training cutoff — current
 * library versions, changelogs, issues, APIs. `web_search` finds sources;
 * `fetch_url` reads one.
 */
export function webSearchTools(options: { maxResults: number }): ToolDefinition[] {
  return [
    defineTool({
      name: 'web_search',
      description:
        'Search the web for current information (library versions, changelogs, APIs, issues, recent changes). Use this instead of guessing when something may be newer than your training data.',
      input: v.object({ query: v.string() }),
      output: v.object({
        results: v.array(v.object({ title: v.string(), url: v.string(), snippet: v.string() })),
        note: v.optional(v.string()),
      }),
      async run({ input }) {
        const key = process.env.TAVILY_API_KEY;
        try {
          const results = key
            ? await tavilySearch(input.query, options.maxResults, key)
            : await duckduckgoSearch(input.query, options.maxResults);
          if (results.length === 0) {
            return { results, note: 'No results. Set TAVILY_API_KEY for more reliable search, or try fetch_url on a known URL.' };
          }
          return { results };
        } catch (error) {
          return { results: [], note: `web_search failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      },
    }),
    defineTool({
      name: 'fetch_url',
      description: 'Fetch a web page (e.g. docs or an issue found via web_search) and return its text content.',
      input: v.object({ url: v.string() }),
      output: v.object({ url: v.string(), text: v.string() }),
      async run({ input }) {
        try {
          await assertPublicUrl(input.url);
        } catch (error) {
          return { url: input.url, text: `(refused: ${error instanceof Error ? error.message : 'blocked URL'})` };
        }
        try {
          const res = await fetch(input.url, {
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; crabd-bot)' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!res.ok) return { url: input.url, text: `(failed to fetch: HTTP ${res.status})` };
          const text = htmlToText(await res.text());
          return { url: input.url, text: text.slice(0, 20_000) };
        } catch (error) {
          return { url: input.url, text: `(failed to fetch: ${error instanceof Error ? error.message : String(error)})` };
        }
      },
    }),
  ];
}
