import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store, Conflict, NotFound, RunBudgetExceeded } from '../src/persistence/store.js';
import { createChatRunner } from '../src/research/chat.js';
import { createApp } from '../src/api/app.js';

it('turns a run deadline into an explicit incomplete terminal result, distinct from provider failure and cancellation', async () => {
  const db = new PGlite(), saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'timeout', 'Research current CRM pricing.');
    const runner = createChatRunner(store, saver, async () => new Promise(() => {}), () => {}, undefined, 10);
    await runner('alice', run);
    expect((await store.getRun('alice', run)).status).toBe('incomplete');
    expect(await store.terminalSnapshot('alice', run)).toMatchObject({ kind: 'incomplete' });
    expect((await store.events('alice', run)).at(-1)?.kind).toBe('incomplete');
    expect((await store.messages('alice', conversation)).at(-1)?.content).toContain('No supported partial findings are available yet');
  } finally { saver.db.close(); await db.close(); }
});

it('keeps deadline and call, query, and prompt limits shared across worker retries', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'budgeted', 'Research CRM pricing.');
    expect(await store.beginAttempt('alice', run, 2, 60_000)).toBe(true);
    const first = await store.researchBudget('alice', run);
    await store.reserveResearchWork('alice', run, { modelCalls: 1, promptBytes: 32_000 });
    await store.reserveResearchWork('alice', run, { searchQueries: 1 });
    await store.reserveResearchWork('alice', run, { modelCalls: 1, promptBytes: 32_000 });
    await store.reserveResearchWork('alice', run, { modelCalls: 1, promptBytes: 32_000, searchQueries: 1 });
    await store.reserveResearchWork('alice', run, { modelCalls: 1, promptBytes: 32_000 });
    await expect(store.reserveResearchWork('alice', run, { modelCalls: 1 })).rejects.toBeInstanceOf(RunBudgetExceeded);
    await expect(store.reserveResearchWork('alice', run, { searchQueries: 1 })).rejects.toBeInstanceOf(RunBudgetExceeded);
    expect(await store.beginAttempt('alice', run, 2, 60_000)).toBe(true);
    const retried = await store.researchBudget('alice', run);
    expect(retried.deadline_at.getTime()).toBe(first.deadline_at.getTime());
    expect(retried).toMatchObject({ model_calls: 4, search_queries: 2, prompt_bytes: 128_000 });
    expect(await store.beginAttempt('alice', run, 2, 60_000)).toBe(false);
  } finally { await db.close(); }
});

it('admits an owner-scoped continuation as a fresh linked run and keeps retries idempotent', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const parent = await store.admit('alice', conversation, 'timed-out', 'Research current CRM pricing.', true);
    await store.publishIncomplete('alice', parent, 'Research timed out. Continue when ready.');
    const app = createApp({ store, owner: request => request.headers.get('x-owner') || 'alice', ready: () => null, run: async () => {} });
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'continue-once' };
    const response = await app.request(`/api/runs/${parent}/continue`, { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(202);
    const { runId, continuationOf } = await response.json() as { runId: string; continuationOf: string };
    expect(continuationOf).toBe(parent);
    expect((await store.getRun('alice', runId))).toMatchObject({ status: 'active', parent_run_id: parent, verify_current: true });
    expect(await store.existingAdmission('alice', conversation, 'continue-once', 'Research current CRM pricing.', true, parent)).toBe(runId);
    const duplicate = await app.request(`/api/runs/${parent}/continue`, { method: 'POST', headers, body: '{}' });
    expect((await duplicate.json() as { runId: string }).runId).toBe(runId);
    const conflict = await app.request(`/api/runs/${parent}/continue`, { method: 'POST', headers, body: JSON.stringify({ input: 'Different request' }) });
    expect(conflict.status).toBe(409);
    const wrongOwner = await app.request(`/api/runs/${parent}/continue`, { method: 'POST', headers: { ...headers, 'x-owner': 'bob' }, body: '{}' });
    expect(wrongOwner.status).toBe(404);
    await expect(store.admit('alice', conversation, 'bad-parent', 'another', false, runId)).rejects.toBeInstanceOf(Conflict);
  } finally { await db.close(); }
});

it('refuses continuation after selected source history is excluded', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const source = await store.createConversation('alice');
    const original = await store.admit('alice', source, 'original', 'CRM shortlist');
    await store.publish('alice', original, 'Acme CRM was considered.');
    const current = await store.createConversation('alice');
    const incomplete = await store.admit('alice', current, 'incomplete', 'Continue CRM research');
    const candidate = (await store.findReferenceCandidates('alice', incomplete, ['crm'], null)).candidates[0];
    await store.saveReferenceSnapshot('alice', incomplete, 'resolved', 'complete', null, null, [candidate]);
    await store.publishIncomplete('alice', incomplete, 'Research stopped before completing.');
    await store.setRecallEligibility('alice', source, false);
    await expect(store.continuationSource('alice', incomplete)).resolves.toMatchObject({ eligible: false });
    await expect(store.admit('alice', current, 'revoked-continuation', 'continue', false, incomplete)).rejects.toBeInstanceOf(Conflict);
    await expect(store.continuationSource('bob', incomplete)).rejects.toBeInstanceOf(NotFound);
  } finally { await db.close(); }
});
