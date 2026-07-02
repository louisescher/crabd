import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
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
  });
  if (!res.ok) throw new Error(`tavily search failed (${res.status})`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
}

/** Keyless DuckDuckGo HTML fallback — best-effort, no API key required. */
async function duckduckgoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; crabd-bot)' },
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
        const res = await fetch(input.url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; crabd-bot)' } });
        if (!res.ok) return { url: input.url, text: `(failed to fetch: HTTP ${res.status})` };
        const text = htmlToText(await res.text());
        return { url: input.url, text: text.slice(0, 20_000) };
      },
    }),
  ];
}
