import { z } from 'zod';

const responseSchema = z.object({ results: z.array(z.object({ url: z.string().url(), title: z.string(), content: z.string() })).max(20) });
export type SearchResult = { url: string; title: string; excerpt: string; observedAt: string; provider: 'tavily'; representation: 'search_snippet' };
export class SearchUnavailable extends Error {}

export function tavilySearch(apiKey: string, options: { fetch?: typeof fetch; now?: () => Date; endpoint?: string } = {}) {
  const request = options.fetch || fetch;
  return async (query: string, signal?: AbortSignal): Promise<SearchResult[]> => {
    if (!apiKey) throw new SearchUnavailable('Web search is not configured.');
    if (!query.trim() || query.length > 500) throw new SearchUnavailable('Invalid search query.');
    try {
      const response = await request(options.endpoint || 'https://api.tavily.com/search', {
        method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results: 5, search_depth: 'basic', include_raw_content: false }),
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('provider failure');
      const data = responseSchema.parse(await response.json());
      const observedAt = (options.now || (() => new Date()))().toISOString();
      return data.results.map(result => ({ url: result.url, title: result.title.slice(0, 500), excerpt: result.content.slice(0, 4000), observedAt, provider: 'tavily', representation: 'search_snippet' }));
    } catch {
      throw new SearchUnavailable('Web search is unavailable. Try again later.');
    }
  };
}
