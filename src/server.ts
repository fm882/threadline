import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp, chunks } from './api/app.js';
import { Store } from './persistence/store.js';
import { createChatRunner, gatewayClient } from './research/chat.js';
import { langsmithSink } from './telemetry/tracing.js';
import { gatewayConfig, gatewayReadiness } from './inference/readiness.js';
import { researchClient } from './research/research-client.js';
import { createSearchCache } from './search/cache.js';
import { tavilySearch } from './search/tavily.js';
import { requiresCurrentVerification } from './research/freshness.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const tracing = process.env.LANGSMITH_TRACING === 'true' && process.env.LANGSMITH_API_KEY
  ? langsmithSink(process.env.LANGSMITH_API_KEY, process.env.LANGSMITH_PROJECT || 'minmi-local') : undefined;
// Disable implicit framework tracing: it can export prompts and responses.
for (const name of ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGCHAIN_VERBOSE']) process.env[name] = 'false';
const dataDir = process.env.APP_DATA_DIR || '.data';
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new PGlite(join(dataDir, 'app-db'));
const store = new Store(db);
await store.initialize();
const config = () => gatewayConfig(process.env);
const searchCache = createSearchCache();
const saver = SqliteSaver.fromConnString(join(dataDir, 'checkpoints.sqlite'));
const runner = async (owner: string, run: string) => {
  const current = config();
  const searchKey = process.env.TAVILY_API_KEY;
  const client = searchKey ? researchClient({ baseURL: current.base, apiKey: current.key, model: current.model, searchKey, store, owner, runId: run,
    search: async (query, signal) => {
      const { current: input } = await store.context(owner, run);
      return searchCache.search(owner, query, requiresCurrentVerification(input.content), tavilySearch(searchKey), signal);
    },
  }) : gatewayClient(current.base, current.key || 'unconfigured', current.model);
  await createChatRunner(store, saver, client, (id, chunk) => chunks.emit(id, chunk), tracing)(owner, run);
};
const app = createApp({ store, owner: () => 'local-development-user', ready: () => gatewayReadiness(config())(), run: runner });
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number');
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, info => console.log(`API listening at http://127.0.0.1:${info.port}`));
const shutdown = () => server.close(() => { void db.close().finally(() => process.exit(0)); });
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
