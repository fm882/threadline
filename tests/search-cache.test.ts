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

it('does not reuse cached evidence when explicit fresh verification fails', async () => {
  const cache = createSearchCache({ now: () => Date.parse('2026-01-01T00:00:00Z') });
  const original: SearchResult[] = [{ url: 'https://example.com/', title: 'Source', excerpt: 'Old excerpt', observedAt: '2026-01-01T00:00:00Z', provider: 'tavily', representation: 'search_snippet' }];
  await cache.search('alice', 'query', false, async () => original);
  await expect(cache.search('alice', 'query', true, async () => { throw new Error('provider unavailable'); })).rejects.toThrow('provider unavailable');
});

it('does not cache a result after cancellation', async () => {
  const cache = createSearchCache();
  const controller = new AbortController();
  let calls = 0;
  const provider = async (): Promise<SearchResult[]> => { calls++; controller.abort(); return [{ url: 'https://example.com/', title: 'Source', excerpt: 'Excerpt', observedAt: '2026-01-01T00:00:00Z', provider: 'tavily', representation: 'search_snippet' }]; };
  await expect(cache.search('alice', 'query', false, provider, controller.signal)).rejects.toThrow('cancelled');
  await cache.search('alice', 'query', false, provider);
  expect(calls).toBe(2);
});

it('does not let a slower earlier search overwrite newer verified evidence', async () => {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const cache = createSearchCache({ now: () => time });
  let release!: (results: SearchResult[]) => void;
  const slow = cache.search('alice', 'query', false, () => new Promise(resolve => { release = resolve; }));
  time += 1000;
  const fresh: SearchResult = { url: 'https://example.com/', title: 'Fresh', excerpt: 'new', observedAt: new Date(time).toISOString(), provider: 'tavily', representation: 'search_snippet' };
  await cache.search('alice', 'query', true, async () => [fresh]);
  release([{ ...fresh, title: 'Old', observedAt: '2026-01-01T00:00:00Z' }]);
  expect((await slow)[0].title).toBe('Old');
  expect((await cache.search('alice', 'query', false, async () => { throw new Error('Unexpected provider call'); }))[0].title).toBe('Fresh');
});
