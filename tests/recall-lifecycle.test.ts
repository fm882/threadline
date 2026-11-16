import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from '../src/persistence/store.js';
import { createApp } from '../src/api/app.js';

it('keeps excluded conversations owner-readable but out of cross-conversation references', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const source = await store.createConversation('alice');
    const sourceRun = await store.admit('alice', source, 'source', 'CRM shortlist');
    await store.publish('alice', sourceRun, 'Five CRM products');
    const current = await store.createConversation('alice');
    const currentRun = await store.admit('alice', current, 'current', 'Which CRM did we shortlist?');
    await store.setRecallEligibility('alice', source, false);
    expect((await store.messages('alice', source)).some(message => message.content === 'CRM shortlist')).toBe(true);
    const candidates = await store.findReferenceCandidates('alice', currentRun, ['CRM', 'shortlist'], null);
    expect(candidates.candidates.some(candidate => candidate.conversation_id === source)).toBe(false);
    await store.setRecallEligibility('alice', source, true);
    const pendingConversation = await store.createConversation('alice');
    const pendingRun = await store.admit('alice', pendingConversation, 'pending', 'Which CRM was shortlisted?');
    const selected = await store.findReferenceCandidates('alice', pendingRun, ['CRM', 'shortlist'], null);
    await store.saveReferenceSnapshot('alice', pendingRun, 'resolved', 'complete', null, null, [selected.candidates[0]]);
    await store.setRecallEligibility('alice', source, false);
    await expect(store.publish('alice', pendingRun, 'Reuse the shortlist')).rejects.toThrow('Selected history is no longer eligible for reuse');
  } finally { await db.close(); }
});

it('revokes conversation access immediately and resumes dependent cleanup through the API', async () => {
  const db = new PGlite();
  const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'retained question');
    await store.publish('alice', run, 'retained answer');
    saver.db.exec('CREATE TABLE checkpoints (thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT); CREATE TABLE writes (thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, task_id TEXT, idx INTEGER);');
    saver.db.prepare('INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id) VALUES (?, ?, ?)').run(run, '', 'checkpoint-1');
    saver.db.prepare('INSERT INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) VALUES (?, ?, ?, ?, ?)').run(run, '', 'checkpoint-1', 'task', 0);
    const checkpointThreads: string[][] = [];
    let failCheckpointRemoval = true;
    const app = createApp({ store, owner: request => request.headers.get('x-owner') || 'alice', ready: () => null, run: async () => {},
      clearCheckpoints: async ids => { checkpointThreads.push(ids); if (failCheckpointRemoval) { failCheckpointRemoval = false; throw new Error('temporary checkpoint store failure'); } for (const id of ids) await saver.deleteThread(id); } });
    expect((await app.request(`/api/conversations/${conversation}`, { method: 'PATCH', headers: { 'x-owner': 'bob', 'Content-Type': 'application/json' }, body: JSON.stringify({ recallEligible: false }) })).status).toBe(404);
    expect((await app.request(`/api/conversations/${conversation}`, { method: 'DELETE', headers: { 'x-owner': 'bob' } })).status).toBe(404);
    expect((await app.request(`/api/conversations/${conversation}/messages`)).status).toBe(200);
    const deletion = await app.request(`/api/conversations/${conversation}`, { method: 'DELETE' });
    expect(deletion.status).toBe(202);
    expect(await deletion.json()).toEqual({ status: 'deleted', cleanup: 'pending' });
    expect((await store.db.query('SELECT conversation_id FROM conversation_cleanup WHERE conversation_id = $1', [conversation])).rows).toHaveLength(1);
    expect((await app.request(`/api/conversations/${conversation}/messages`)).status).toBe(404);
    const restarted = new Store(db); await restarted.initialize();
    await restarted.cleanupDeletedConversations(20, async ids => { checkpointThreads.push(ids); for (const id of ids) await saver.deleteThread(id); });
    expect(checkpointThreads).toEqual([[run], [run]]);
    expect((await app.request(`/api/conversations/${conversation}/messages`)).status).toBe(404);
    expect((await restarted.listConversations('alice'))).toHaveLength(0);
    expect((await db.query('SELECT id FROM conversations WHERE id = $1', [conversation])).rows).toHaveLength(0);
    expect(saver.db.prepare('SELECT thread_id FROM checkpoints').all()).toHaveLength(0);
    expect(saver.db.prepare('SELECT thread_id FROM writes').all()).toHaveLength(0);
  } finally { saver.db.close(); await db.close(); }
});

it('hides and purges answers that depended on a conversation being deleted', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const source = await store.createConversation('alice');
    const sourceRun = await store.admit('alice', source, 'source', 'CRM shortlist options');
    await store.publish('alice', sourceRun, 'Five CRM products');
    const current = await store.createConversation('alice');
    const currentRun = await store.admit('alice', current, 'current', 'Which CRM did we shortlist?');
    const found = await store.findReferenceCandidates('alice', currentRun, ['CRM', 'shortlist'], null);
    const snapshot = await store.saveReferenceSnapshot('alice', currentRun, 'resolved', 'complete', null, null, [found.candidates[0]]);
    await store.publish('alice', currentRun, `Use the shortlist. [reference:${snapshot}]`);
    expect((await store.messages('alice', current)).some(message => message.role === 'assistant')).toBe(true);
    await store.deleteConversation('alice', source);
    expect((await store.messages('alice', current)).some(message => message.role === 'assistant')).toBe(false);
    await store.cleanupDeletedConversations();
    expect((await store.messages('alice', current)).some(message => message.role === 'assistant')).toBe(false);
    expect((await store.getRun('alice', currentRun)).status).toBe('failed');
  } finally { await db.close(); }
});

it('expires old operational progress events without expiring originals or bounded evidence', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'durable original question');
    const [evidence] = await store.registerEvidence('alice', run, [{ url: 'https://example.com/', title: 'Source', excerpt: 'Bounded retained excerpt.', observedAt: '2026-11-15T00:00:00Z', provider: 'tavily', representation: 'search_snippet' }]);
    await store.recordProgress('alice', run, 'searching');
    await db.query("UPDATE run_events SET created_at = '2020-01-01T00:00:00Z' WHERE run_id = $1 AND kind = 'progress'", [run]);
    expect(await store.pruneOperationalEvents(30, new Date('2026-11-16T00:00:00Z'))).toBe(1);
    expect((await store.messages('alice', conversation)).some(message => message.content === 'durable original question')).toBe(true);
    expect(((await store.evidence('alice', evidence.id)) as { excerpt: string }).excerpt).toBe('Bounded retained excerpt.');
    expect((await store.events('alice', run)).some(event => event.kind === 'accepted')).toBe(true);
  } finally { await db.close(); }
});

it('blocks citations, event access, and late publication as soon as source history is deleted', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const source = await store.createConversation('alice');
    const sourceRun = await store.admit('alice', source, 'source', 'CRM shortlist options');
    const [evidence] = await store.registerEvidence('alice', sourceRun, [{ url: 'https://example.com/', title: 'CRM source', excerpt: 'Source excerpt.', observedAt: new Date().toISOString(), provider: 'tavily', representation: 'search_snippet' }]);
    await store.publish('alice', sourceRun, 'Five CRM products', [{ claim: 'Five options were listed.', evidenceIds: [evidence.id] }]);
    const current = await store.createConversation('alice');
    const currentRun = await store.admit('alice', current, 'current', 'Which CRM did we shortlist?');
    const found = await store.findReferenceCandidates('alice', currentRun, ['CRM', 'shortlist'], null);
    await store.saveReferenceSnapshot('alice', currentRun, 'resolved', 'complete', null, null, [found.candidates[0]]);
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => {} });
    expect((await app.request(`/api/evidence/${evidence.id}`)).status).toBe(200);
    const cancelled = await store.deleteConversation('alice', source);
    expect(cancelled).toContain(currentRun);
    expect((await app.request(`/api/evidence/${evidence.id}`)).status).toBe(404);
    expect((await app.request(`/api/runs/${sourceRun}/events`)).status).toBe(404);
    await expect(store.publish('alice', currentRun, 'A stale answer')).rejects.toThrow('Selected history is no longer eligible for reuse');
    await store.cleanupDeletedConversations();
    expect((await store.getRun('alice', currentRun)).status).toBe('failed');
  } finally { await db.close(); }
});
