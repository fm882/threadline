import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { Store } from '../src/persistence/store.ts';
import { createHybridHistoryRetriever, processIndexJob } from '../src/history/index.ts';

const db = new PGlite();
const started = performance.now();
try {
  const store = new Store(db);
  await store.initialize();
  const space = await store.createEmbeddingGeneration({ id: 'evaluation-fixture', model: 'deterministic-fixture-v1', dimensions: 3, normalized: true, queryMode: 'shared', documentMode: 'shared', chunkingVersion: 'exchange-v1' });
  const sourceConversation = await store.createConversation('evaluation-owner');
  const sourceRun = await store.admit('evaluation-owner', sourceConversation, 'shortlist', 'On Monday we shortlisted five CRM tools for a 20-person sales team.');
  const shortlist = ['Acme CRM', 'Northstar CRM', 'Copper CRM', 'Folk CRM', 'Twenty CRM'];
  await store.publish('evaluation-owner', sourceRun, `The complete shortlist was ${shortlist.join(', ')}.`);
  const [job] = await store.pendingIndexJobs(10, space);
  await processIndexJob(store, job, space, async inputs => inputs.map(() => [1, 0, 0]));

  const currentConversation = await store.createConversation('evaluation-owner');
  const query = 'Which customer relationship platforms did we compare?';
  const run = await store.admit('evaluation-owner', currentConversation, 'paraphrase', query);
  const terms = ['customer', 'relationship', 'platforms', 'compare'];
  const lexicalStart = performance.now();
  const lexical = await store.findReferenceCandidates('evaluation-owner', run, terms, null);
  const lexicalMs = performance.now() - lexicalStart;
  const hybrid = createHybridHistoryRetriever(store, space, { embed: async () => [[1, 0, 0]], rerank: async (_query, documents) => documents.map((_, index) => index) });
  const hybridStart = performance.now();
  const retrieved = await hybrid('evaluation-owner', run, terms, null, query);
  const hybridMs = performance.now() - hybridStart;
  const sourceMessage = (await store.messages('evaluation-owner', sourceConversation))[0];
  const relevant = retrieved.candidates.find(candidate => candidate.id === sourceMessage.id);
  const answer = relevant?.answer || '';
  const subjectsCovered = shortlist.filter(subject => answer.includes(subject));
  console.log(JSON.stringify({
    fixture: 'one human-labeled paraphrase over one original exchange',
    embeddings: 'deterministic synthetic vectors; no model call',
    reranking: 'identity order; no model call',
    lexical: { referenceAccuracyAt1: lexical.candidates[0]?.conversation_id === sourceConversation ? 1 : 0, candidateRecall: lexical.candidates.some(candidate => candidate.conversation_id === sourceConversation) ? 1 : 0, latencyMs: Number(lexicalMs.toFixed(2)) },
    hybrid: { referenceAccuracyAt1: retrieved.candidates[0]?.conversation_id === sourceConversation ? 1 : 0, candidateRecall: retrieved.candidates.some(candidate => candidate.conversation_id === sourceConversation) ? 1 : 0, subjectCoverage: `${subjectsCovered.length}/${shortlist.length}`, coverage: retrieved.coverage, latencyMs: Number(hybridMs.toFixed(2)) },
    totalSetupAndEvaluationMs: Number((performance.now() - started).toFixed(2)),
    externalModelCost: '$0.00',
  }));
} finally {
  await db.close();
}
