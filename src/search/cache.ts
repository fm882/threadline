import type { SearchResult } from './tavily.js';

type Search = (query: string, signal?: AbortSignal) => Promise<SearchResult[]>;
type Entry = { expiresAt: number; results: SearchResult[] };

/** A short, owner-scoped reuse policy. Explicit verification always calls the provider. */
export function createSearchCache(options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
  const now = options.now || Date.now;
  const ttl = options.ttlMs ?? 5 * 60_000;
  const maximum = options.maxEntries ?? 100;
  const entries = new Map<string, Entry>();
  return {
    async search(owner: string, query: string, verifyCurrent: boolean, provider: Search, signal?: AbortSignal): Promise<SearchResult[]> {
      const key = JSON.stringify([owner, 'tavily-basic-v1', query.trim()]);
      const timestamp = now();
      const cached = entries.get(key);
      if (!verifyCurrent && cached && timestamp < cached.expiresAt) {
        entries.delete(key); entries.set(key, cached);
        return cached.results.map(result => ({ ...result }));
      }
      if (cached && timestamp >= cached.expiresAt) entries.delete(key);
      const results = await provider(query, signal);
      if (signal?.aborted) throw new Error('Search cancelled');
      if (results.length && maximum > 0 && ttl > 0) {
        const latest = entries.get(key);
        const oldestObservation = (items: SearchResult[]) => Math.min(...items.map(item => Date.parse(item.observedAt)));
        // A slower request must not overwrite evidence observed by a newer request.
        if (latest && latest.expiresAt > now() && oldestObservation(results) < oldestObservation(latest.results)) return results.map(result => ({ ...result }));
        entries.delete(key);
        entries.set(key, { expiresAt: now() + ttl, results: results.map(result => ({ ...result })) });
        while (entries.size > maximum) entries.delete(entries.keys().next().value!);
      }
      return results.map(result => ({ ...result }));
    },
  };
}
