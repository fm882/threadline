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
