import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { join } from 'node:path';
import { createApp, chunks } from '../../src/api/app.js';
import { Store } from '../../src/persistence/store.js';
import { createChatRunner } from '../../src/research/chat.js';
import { researchClient } from '../../src/research/research-client.js';
import { createDispatcher } from '../../src/jobs/dispatcher.js';
import { startRecovery } from '../../src/jobs/recovery.js';

const dir = process.env.APP_DATA_DIR!;
const db = new PGlite(join(dir, 'app-db')); const store = new Store(db); await store.initialize();
const saver = SqliteSaver.fromConnString(join(dir, 'checkpoints.sqlite'));
const run = async (owner: string, runId: string, signal: AbortSignal) => {
  const client = researchClient({ baseURL: process.env.INFERENCE_BASE_URL!, apiKey: 'fixture', model: 'chat-main-v1', searchKey: 'fixture', owner, runId, store,
    search: async () => [{ url: 'https://example.com/', title: 'Recorded source', excerpt: 'Recorded excerpt', observedAt: '2026-01-02T12:00:00Z', provider: 'tavily', representation: 'search_snippet' }] });
  await createChatRunner(store, saver, client, (id, chunk) => chunks.emit(id, chunk))(owner, runId, signal);
};
const dispatcher = createDispatcher(store, run);
const stopRecovery = startRecovery(store, saver, dispatcher, async () => null, 50);
const app = createApp({ store, owner: () => 'local-development-user', ready: () => null, run, dispatcher });
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT), hostname: '127.0.0.1' });
process.on('SIGTERM', () => {
  server.close(); if ('closeAllConnections' in server) server.closeAllConnections();
  void (async () => { await stopRecovery(); await dispatcher.shutdown(); await db.close(); saver.db.close(); })().finally(() => process.exit(0));
});
