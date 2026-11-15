import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { join } from 'node:path';
import { createApp, chunks } from '../src/api/app.js';
import { Store } from '../src/persistence/store.js';
import { createChatRunner } from '../src/research/chat.js';
import { researchClient } from '../src/research/research-client.js';

const dir = process.env.APP_DATA_DIR!;
const db = new PGlite(join(dir, 'app-db'));
const store = new Store(db); await store.initialize();
const saver = SqliteSaver.fromConnString(join(dir, 'checkpoints.sqlite'));
const run = async (owner: string, runId: string) => {
  const client = researchClient({ baseURL: process.env.INFERENCE_BASE_URL!, apiKey: 'fixture', model: 'chat-main-v1', searchKey: 'fixture', owner, runId, store,
    search: async () => [{ url: 'https://example.com/', title: 'Recorded source', excerpt: 'Recorded source excerpt', observedAt: '2026-01-02T12:00:00Z', provider: 'tavily', representation: 'search_snippet' }] });
  await createChatRunner(store, saver, client, (id, chunk) => chunks.emit(id, chunk))(owner, runId);
};
const app = createApp({ store, owner: () => 'local-development-user', ready: () => null, run });
const server = serve({ fetch: app.fetch, port: 3000, hostname: '127.0.0.1' });
const shutdown = () => server.close(() => { void db.close().finally(() => process.exit(0)); });
process.on('SIGTERM', shutdown);
