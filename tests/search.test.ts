import { it, expect } from 'vitest';
import { tavilySearch, SearchUnavailable } from '../src/search/tavily.js';

it('records source snippets with a fixed observation time and bounded request', async () => {
  let sent: RequestInit | undefined;
  const search = tavilySearch('test-key', { now: () => new Date('2026-01-01T00:00:00Z'), fetch: async (_url, init) => {
    sent = init;
    return Response.json({ results: [{ url: 'https://example.com/', title: 'Source', content: 'Source excerpt' }] });
  } });
  expect(await search('pricing')).toEqual([{ url: 'https://example.com/', title: 'Source', excerpt: 'Source excerpt', observedAt: '2026-01-01T00:00:00.000Z', provider: 'tavily', representation: 'search_snippet' }]);
  expect(JSON.parse(String(sent?.body)).max_results).toBe(5);
  expect(sent?.redirect).toBe('error');
});

it('returns safe errors for invalid provider responses or missing configuration', async () => {
  await expect(tavilySearch('')('query')).rejects.toBeInstanceOf(SearchUnavailable);
  await expect(tavilySearch('key', { fetch: async () => Response.json({ results: [{ url: 'bad' }] }) })('query')).rejects.toThrow('Web search is unavailable');
  await expect(tavilySearch('key', { fetch: async () => { throw new Error('secret'); } })('query')).rejects.not.toThrow('secret');
});

it('rejects unsafe source schemes and oversized provider responses', async () => {
  const unsafe = tavilySearch('key', { fetch: async () => Response.json({ results: [{ url: 'javascript:alert(1)', title: 'x', content: 'x' }] }) });
  await expect(unsafe('query')).rejects.toThrow('Web search is unavailable');
  const oversized = tavilySearch('key', { fetch: async () => new Response('x'.repeat(1_000_001)) });
  await expect(oversized('query')).rejects.toThrow('Web search is unavailable');
});
