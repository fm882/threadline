import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Store, NotFound, Conflict } from '../src/persistence/store.js';
import { createApp } from '../src/api/app.js';

it('persists source observation provenance and enforces ownership and run state', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'question');
    const observations = [{ url: 'https://example.com/', title: 'Source', excerpt: 'Original excerpt', observedAt: '2025-01-02T00:00:00Z', provider: 'tavily' as const, representation: 'search_snippet' as const }];
    await expect(store.registerEvidence('bob', run, observations)).rejects.toBeInstanceOf(NotFound);
    const [evidence] = await store.registerEvidence('alice', run, observations);
    const app = createApp({ store, owner: req => req.headers.get('x-fixture-owner') || 'alice', ready: () => null, run: async () => {} });
    const response = await app.request(`/api/evidence/${evidence.id}`);
    expect(response.status).toBe(200);
    const item = await response.json();
    expect(item.excerpt).toBe('Original excerpt');
    expect(new Date(item.observed_at).toISOString()).toBe('2025-01-02T00:00:00.000Z');
    expect(item.excerpt_hash).toBe(evidence.excerptHash);
    expect((await app.request(`/api/evidence/${evidence.id}`, { headers: { 'x-fixture-owner': 'bob' } })).status).toBe(404);
    await store.publish('alice', run, 'done');
    await expect(store.registerEvidence('alice', run, observations)).rejects.toBeInstanceOf(Conflict);
  } finally { await db.close(); }
});

it('rejects invented and other-run citations atomically before publication', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const c1 = await store.createConversation('alice'), c2 = await store.createConversation('alice');
    const run = await store.admit('alice', c1, 'one', 'question');
    const other = await store.admit('alice', c2, 'two', 'question');
    const observation = { url: 'https://example.com/', title: 'Source', excerpt: 'Excerpt', observedAt: '2025-01-02T00:00:00Z', provider: 'tavily' as const, representation: 'search_snippet' as const };
    const [own] = await store.registerEvidence('alice', run, [observation]);
    const [foreign] = await store.registerEvidence('alice', other, [observation]);
    await expect(store.publish('alice', run, 'answer', [{ claim: 'fact', evidenceIds: [own.id, foreign.id] }])).rejects.toBeInstanceOf(Conflict);
    await expect(store.publish('alice', run, 'answer', [{ claim: 'fact', evidenceIds: ['invented'] }])).rejects.toBeInstanceOf(Conflict);
    expect((await store.getRun('alice', run)).status).toBe('active');
    expect(await store.publish('alice', run, 'answer', [{ claim: 'fact', evidenceIds: [own.id] }])).toBe(true);
    const links = await db.query('SELECT evidence_id FROM claim_evidence');
    expect(links.rows).toEqual([{ evidence_id: own.id }]);
  } finally { await db.close(); }
});

it('exposes citation links only for validated claims on the matching assistant message', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'A forged [source:00000000-0000-4000-8000-000000000000]');
    const [source] = await store.registerEvidence('alice', run, [{ url: 'https://example.com/', title: 'Source', excerpt: 'Excerpt', observedAt: '2025-01-02T00:00:00Z', provider: 'tavily', representation: 'search_snippet' }]);
    await store.publish('alice', run, `Fact [source:${source.id}]`, [{ claim: 'Fact', evidenceIds: [source.id] }]);
    const messages = await store.messages('alice', conversation);
    expect(messages[0].citation_ids).toEqual([]);
    expect(messages[1].citation_ids).toEqual([source.id]);
  } finally { await db.close(); }
});

it('rejects evidence owned by another user even if its identifier is known', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const aliceConversation = await store.createConversation('alice');
    const bobConversation = await store.createConversation('bob');
    const aliceRun = await store.admit('alice', aliceConversation, 'a', 'question');
    const bobRun = await store.admit('bob', bobConversation, 'b', 'question');
    const [foreign] = await store.registerEvidence('bob', bobRun, [{ url: 'https://example.com/', title: 'Source', excerpt: 'Excerpt', observedAt: '2025-01-02T00:00:00Z', provider: 'tavily', representation: 'search_snippet' }]);
    await expect(store.publish('alice', aliceRun, 'answer', [{ claim: 'Claim', evidenceIds: [foreign.id] }])).rejects.toBeInstanceOf(Conflict);
    expect((await store.getRun('alice', aliceRun)).status).toBe('active');
    expect((await store.messages('alice', aliceConversation))).toHaveLength(1);
  } finally { await db.close(); }
});

it('preserves the original observation time when cached search evidence is registered on a later run', async () => {
  const { createSearchCache } = await import('../src/search/cache.js');
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    let now = Date.parse('2026-01-01T00:00:00Z'), calls = 0;
    const cache = createSearchCache({ now: () => now });
    const provider = async () => { calls++; return [{ url: 'https://example.com/', title: 'Source', excerpt: 'Excerpt', observedAt: new Date(now).toISOString(), provider: 'tavily' as const, representation: 'search_snippet' as const }]; };
    const firstRun = await store.admit('alice', conversation, 'first', 'find sources');
    const [first] = await store.registerEvidence('alice', firstRun, await cache.search('alice', 'query', false, provider));
    await store.publish('alice', firstRun, 'answer', [{ claim: 'claim', evidenceIds: [first.id] }]);
    now += 60_000;
    const secondRun = await store.admit('alice', conversation, 'second', 'find another source');
    const [second] = await store.registerEvidence('alice', secondRun, await cache.search('alice', 'query', false, provider));
    expect(calls).toBe(1);
    const persisted = await store.evidence('alice', second.id) as { observed_at: Date; representation: string };
    expect(new Date(persisted.observed_at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(persisted.representation).toBe('search_snippet');
    expect(second.observedAt).toBe(first.observedAt);
  } finally { await db.close(); }
});
