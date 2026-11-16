import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Store } from '../src/persistence/store.js';
import { createHybridHistoryRetriever, processIndexJob } from '../src/history/index.js';

const vector = [1, 0, 0];
const config = { id: 'fixture-space', model: 'fixture-embed-v1', dimensions: 3, normalized: true, queryMode: 'shared', documentMode: 'shared', chunkingVersion: 'exchange-v1' };

it('indexes original-backed chunks idempotently and finds a paraphrased reference through the existing snapshot contract', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const space = await store.createEmbeddingGeneration(config);
    const source = await store.createConversation('alice');
    const originalRun = await store.admit('alice', source, 'original', 'CRM shortlist options for our nonprofit');
    await store.publish('alice', originalRun, 'We considered Acme CRM and Northstar CRM.');
    const jobs = await store.pendingIndexJobs(10, space);
    expect(jobs).toHaveLength(1);
    expect(await processIndexJob(store, jobs[0], space, async inputs => inputs.map(() => vector))).toBe(true);
    expect(await processIndexJob(store, jobs[0], space, async inputs => inputs.map(() => vector))).toBe(false);
    const current = await store.createConversation('alice');
    const run = await store.admit('alice', current, 'paraphrase', 'Which customer relationship tools did we consider?');
    const retriever = createHybridHistoryRetriever(store, space, { embed: async () => [vector], rerank: async () => [0] });
    const result = await retriever('alice', run, ['customer', 'relationship', 'tools', 'consider'], null, 'Which customer relationship tools did we consider?');
    expect(result.coverage).toBe('complete');
    expect(result.candidates[0].conversation_id).toBe(source);
    const snapshot = await store.saveReferenceSnapshot('alice', run, 'resolved', result.coverage, null, null, [result.candidates[0]]);
    expect((await store.referenceSnapshot('alice', snapshot)).items[0].content).toContain('nonprofit');
  } finally { await db.close(); }
});

it('filters excluded sources before vector scoring, and falls back with incomplete coverage when embeddings fail', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const space = await store.createEmbeddingGeneration(config);
    const source = await store.createConversation('alice');
    const originalRun = await store.admit('alice', source, 'original', 'CRM shortlist');
    await store.publish('alice', originalRun, 'Acme CRM and Northstar CRM.');
    const [job] = await store.pendingIndexJobs(10, space);
    await processIndexJob(store, job, space, async inputs => inputs.map(() => vector));
    const current = await store.createConversation('alice');
    const run = await store.admit('alice', current, 'query', 'customer relationship product list');
    await store.setRecallEligibility('alice', source, false);
    const retriever = createHybridHistoryRetriever(store, space, { embed: async () => { throw new Error('offline'); }, rerank: async () => [] });
    const result = await retriever('alice', run, ['customer', 'relationship', 'product'], null, 'customer relationship product list');
    expect(result.coverage).toBe('incomplete');
    expect(result.candidates.some(candidate => candidate.conversation_id === source)).toBe(false);
    expect((await db.query('SELECT id FROM history_chunks WHERE conversation_id = $1', [source])).rows).toHaveLength(0);
    expect((await db.query('SELECT chunk_id FROM chunk_embeddings WHERE conversation_id = $1', [source])).rows).toHaveLength(0);
  } finally { await db.close(); }
});

it('returns authorized lexical matches with incomplete coverage when query embeddings fail and exposes that coverage on the message', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const source = await store.createConversation('alice');
    const originalRun = await store.admit('alice', source, 'original', 'CRM pricing for a 20 person team');
    await store.publish('alice', originalRun, 'Acme CRM and Northstar CRM were shortlisted.');
    const current = await store.createConversation('alice');
    const run = await store.admit('alice', current, 'query', 'What did we discuss about CRM pricing?');
    const retriever = createHybridHistoryRetriever(store, null, null);
    const result = await retriever('alice', run, ['CRM', 'pricing'], null, 'What did we discuss about CRM pricing?');
    expect(result.coverage).toBe('incomplete');
    expect(result.candidates.map(candidate => candidate.conversation_id)).toContain(source);
    const snapshot = await store.saveReferenceSnapshot('alice', run, 'incomplete', result.coverage, null, null, result.candidates);
    await store.publish('alice', run, `Partial historical match. [reference:${snapshot}]`);
    expect(await store.messages('alice', current)).toMatchObject([{ role: 'user' }, { role: 'assistant', reference_coverage: 'incomplete' }]);
  } finally { await db.close(); }
});

it('keeps reciprocal-rank fusion order when the reranker fails', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const space = await store.createEmbeddingGeneration(config);
    const sourceIds: string[] = [];
    for (const [key, content] of [['older', 'CRM tools we shortlisted'], ['newer', 'CRM vendors we compared']] as const) {
      const source = await store.createConversation('alice'); sourceIds.push(source);
      const originalRun = await store.admit('alice', source, key, content);
      await store.publish('alice', originalRun, `${content}: Acme and Northstar.`);
      const [job] = await store.pendingIndexJobs(10, space);
      await processIndexJob(store, job, space, async inputs => inputs.map(() => vector));
    }
    const current = await store.createConversation('alice');
    const run = await store.admit('alice', current, 'query', 'Which CRM tools did we discuss?');
    const lexical = await store.findReferenceCandidates('alice', run, ['crm'], null);
    const retriever = createHybridHistoryRetriever(store, space, {
      embed: async () => [vector],
      rerank: async () => { throw new Error('provider unavailable'); },
    });
    const result = await retriever('alice', run, ['crm'], null, 'Which CRM tools did we discuss?');
    expect(result.candidates.map(candidate => candidate.id)).toEqual(lexical.candidates.map(candidate => candidate.id));
    expect(result.candidates.map(candidate => candidate.conversation_id)).toEqual([...sourceIds].reverse());
  } finally { await db.close(); }
});

it('keeps dimensions and model bindings isolated across staged generations and supports activation and rollback', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const first = await store.createEmbeddingGeneration(config);
    const second = await store.createEmbeddingGeneration({ ...config, id: 'fixture-space-next', model: 'other-model-v1' }, true);
    expect(second.status).toBe('building');
    const source = await store.createConversation('alice');
    const originalRun = await store.admit('alice', source, 'original', 'CRM shortlist');
    await store.publish('alice', originalRun, 'Acme CRM and Northstar CRM.');
    const jobs = await store.pendingIndexJobs(10, first);
    expect(jobs).toHaveLength(1);
    await processIndexJob(store, jobs[0], first, async inputs => inputs.map(() => vector));
    const current = await store.createConversation('alice');
    const run = await store.admit('alice', current, 'query', 'CRM products we considered');
    expect((await store.indexedReferenceCandidates('alice', run, ['CRM'], null, vector, second)).candidates).toHaveLength(0);
    const stagedJobs = await store.pendingIndexJobs(10, second);
    expect(stagedJobs).toHaveLength(1);
    await processIndexJob(store, stagedJobs[0], second, async inputs => inputs.map(() => vector));
    expect((await store.indexedReferenceCandidates('alice', run, ['CRM'], null, vector, second)).candidates).toHaveLength(1);
    const usedSpaces: string[] = [];
    const dynamicRetriever = createHybridHistoryRetriever(store, () => store.activeEmbeddingGeneration(), async selected => {
      usedSpaces.push(selected.id);
      return { embed: async () => [vector], rerank: async (_query, documents) => documents.map((_, index) => index) };
    });
    expect((await dynamicRetriever('alice', run, ['CRM'], null, 'CRM products'))).toMatchObject({ coverage: 'complete' });
    expect(usedSpaces.at(-1)).toBe(first.id);
    await store.activateEmbeddingGeneration(second.id, second.generation);
    expect((await store.activeEmbeddingGeneration())?.id).toBe(second.id);
    expect((await dynamicRetriever('alice', run, ['CRM'], null, 'CRM products')).coverage).toBe('complete');
    expect(usedSpaces.at(-1)).toBe(second.id);
    await store.activateEmbeddingGeneration(first.id, first.generation);
    expect((await store.activeEmbeddingGeneration())?.id).toBe(first.id);
    expect(Object.fromEntries((await store.listEmbeddingGenerations()).map(row => [row.id, row.status]))).toEqual({ [first.id]: 'active', [second.id]: 'retired' });
  } finally { await db.close(); }
});

it('retries partial index failures without advancing coverage across an unfinished original', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const space = await store.createEmbeddingGeneration(config);
    const firstConversation = await store.createConversation('alice');
    const firstRun = await store.admit('alice', firstConversation, 'first', 'CRM for a nonprofit');
    await store.publish('alice', firstRun, 'Acme CRM is one option.');
    const secondConversation = await store.createConversation('alice');
    const secondRun = await store.admit('alice', secondConversation, 'second', 'Customer relationship tracking');
    await store.publish('alice', secondRun, 'Northstar is another option.');
    const current = await store.createConversation('alice');
    const currentRun = await store.admit('alice', current, 'query', 'Which CRM products were options?');
    const [failedJob, remainingJob] = await store.pendingIndexJobs(10, space);
    expect(await processIndexJob(store, failedJob, space, async () => { throw new Error('gateway timeout'); })).toBe(false);
    expect(await processIndexJob(store, remainingJob, space, async inputs => inputs.map(() => vector))).toBe(true);
    expect(await store.embeddingCoverage('alice', currentRun, space)).toMatchObject({ total: 2, indexed: 1, complete: false });
    expect((await db.query('SELECT id FROM history_chunks WHERE message_id = $1', [failedJob.message_id])).rows).toHaveLength(0);
    const retry = (await store.pendingIndexJobs(10, space)).find(job => job.id === failedJob.id)!;
    expect(await processIndexJob(store, retry, space, async inputs => inputs.map(() => vector))).toBe(true);
    expect(await store.embeddingCoverage('alice', currentRun, space)).toMatchObject({ total: 2, indexed: 2, complete: true });
    expect((await db.query('SELECT id FROM history_chunks WHERE message_id = $1', [failedJob.message_id])).rows.length).toBeGreaterThan(0);
  } finally { await db.close(); }
});
