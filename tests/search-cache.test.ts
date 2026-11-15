import { it, expect } from 'vitest';
import { createSearchCache } from '../src/search/cache.js';
import type { SearchResult } from '../src/search/tavily.js';

it('reuses ordinary searches within one owner without refreshing observation time', async () => {
  let time = Date.parse('2026-01-01T00:00:00Z'), calls = 0;
  const cache = createSearchCache({ now: () => time, ttlMs: 300_000 });
  const provider = async (): Promise<SearchResult[]> => { calls++; return [{ url: 'https://example.com/', title: 'Source', excerpt: 'Excerpt', observedAt: new Date(time).toISOString(), provider: 'tavily', representation: 'search_snippet' }]; };
  const first = await cache.search('alice', 'query', false, provider);
  time += 60_000;
  const reused = await cache.search('alice', 'query', false, provider);
  expect(calls).toBe(1);
  expect(reused[0].observedAt).toBe(first[0].observedAt);
  reused[0].title = 'changed';
  expect((await cache.search('alice', 'query', false, provider))[0].title).toBe('Source');
  await cache.search('bob', 'query', false, provider);
  expect(calls).toBe(2);
  const verified = await cache.search('alice', 'query', true, provider);
  expect(calls).toBe(3);
  expect(verified[0].observedAt).not.toBe(first[0].observedAt);
  time += 300_000;
  await cache.search('alice', 'query', false, provider);
  expect(calls).toBe(4);
});
