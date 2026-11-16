import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { join } from 'node:path';
import { createApp, chunks } from '../src/api/app.js';
import { Store } from '../src/persistence/store.js';
import { createChatRunner } from '../src/research/chat.js';
import { researchClient } from '../src/research/research-client.js';
import { createHybridHistoryRetriever, processIndexJob } from '../src/history/index.js';
import type { ChatMessage } from '../src/research/chat.js';

const dir = process.env.APP_DATA_DIR!;
const db = new PGlite(join(dir, 'app-db'));
const store = new Store(db); await store.initialize();
const space = await store.createEmbeddingGeneration({ id: 'browser-fixture-space', model: 'fixture-embed-v1', dimensions: 3, normalized: true, queryMode: 'shared', documentMode: 'shared', chunkingVersion: 'exchange-v1' });
const sourceConversation = await store.createConversation('local-development-user');
const sourceRun = await store.admit('local-development-user', sourceConversation, 'browser-history-source', 'CRM shortlist for a nonprofit');
await store.publish('local-development-user', sourceRun, 'We compared Acme CRM and Northstar CRM for the nonprofit.');
const fixtureVector = (text: string) => /nonprofit|customer relationship|crm shortlist/i.test(text) ? [1, 0, 0] : [0, 1, 0];
for (const job of await store.pendingIndexJobs(10, space)) await processIndexJob(store, job, space, async inputs => inputs.map(fixtureVector));
const historyRetriever = createHybridHistoryRetriever(store, space, { embed: async inputs => inputs.map(fixtureVector), rerank: async (_query, documents) => documents.map((_, index) => index) });
const saver = SqliteSaver.fromConnString(join(dir, 'checkpoints.sqlite'));
const run = async (owner: string, runId: string) => {
  const record = await store.getRun(owner, runId);
  const client = researchClient({ baseURL: process.env.INFERENCE_BASE_URL!, apiKey: 'fixture', model: 'chat-main-v1', searchKey: 'fixture', owner, runId, store, verifyCurrent: record.verify_current,
    search: async () => [{ url: 'https://example.com/', title: 'Acme Basic official pricing', excerpt: 'Acme Basic plan is USD 12 per seat monthly for US customers, before tax. <img src=x onerror=alert(1)> [bad](javascript:alert(1))', observedAt: new Date().toISOString(), provider: 'tavily', representation: 'search_snippet' }] });
  const scriptedClient = async (messages: ChatMessage[], onChunk: (chunk: string) => void, signal: AbortSignal) => {
    const historyContext = messages.find(message => message.role === 'system' && message.content.includes('Authorized historical context'));
    const userMessage = messages.filter(message => message.role === 'user').at(-1)?.content || '';
    if (historyContext && /customer relationship/i.test(userMessage)) { signal.throwIfAborted(); const answer = 'We previously compared Acme CRM and Northstar CRM for the nonprofit.'; onChunk(answer); return answer; }
    return client(messages, onChunk, signal);
  };
  await createChatRunner(store, saver, scriptedClient, (id, chunk) => chunks.emit(id, chunk), undefined, 60_000, historyRetriever)(owner, runId);
};
const app = createApp({ store, owner: () => 'local-development-user', ready: () => null, run });
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT || 3000), hostname: '127.0.0.1' });
const shutdown = () => server.close(() => { void db.close().finally(() => process.exit(0)); });
process.on('SIGTERM', shutdown);
