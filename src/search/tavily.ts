import { z } from 'zod';

const responseSchema = z.object({ results: z.array(z.object({ url: z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)), title: z.string(), content: z.string() })).max(20) });
const MAX_RESPONSE_BYTES = 1_000_000;

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
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
      const data = responseSchema.parse(await boundedJson(response));
      const observedAt = (options.now || (() => new Date()))().toISOString();
      return data.results.slice(0, 5).map(result => ({ url: result.url, title: result.title.slice(0, 500), excerpt: result.content.slice(0, 4000), observedAt, provider: 'tavily', representation: 'search_snippet' }));
    } catch {
      throw new SearchUnavailable('Web search is unavailable. Try again later.');
    }
  };
}
