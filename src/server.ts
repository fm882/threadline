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
import { createDispatcher } from './jobs/dispatcher.js';
import { startRecovery } from './jobs/recovery.js';
import { createEmbeddingClient, createRerankClient, vectorSpaceConfig, type RetrievalInference } from './inference/retrieval.js';
import { createHybridHistoryRetriever, startIndexingWorker } from './history/index.js';

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
const operationalEventRetentionDays = Number(process.env.OPERATIONAL_EVENT_RETENTION_DAYS || 30);
if (!Number.isInteger(operationalEventRetentionDays) || operationalEventRetentionDays < 1 || operationalEventRetentionDays > 3650) throw new Error('OPERATIONAL_EVENT_RETENTION_DAYS must be an integer from 1 to 3650');
await store.pruneOperationalEvents(operationalEventRetentionDays);
const retentionTimer = setInterval(() => { void store.pruneOperationalEvents(operationalEventRetentionDays).catch(() => {}); }, 6 * 60 * 60 * 1000);
const config = () => gatewayConfig(process.env);
const searchCache = createSearchCache();
const saver = SqliteSaver.fromConnString(join(dataDir, 'checkpoints.sqlite'));
const clearCheckpoints = async (runIds: string[]) => { for (const id of runIds) await saver.deleteThread(id); };
await store.cleanupDeletedConversations(100, clearCheckpoints).catch(() => {});
const deletionCleanupTimer = setInterval(() => { void store.cleanupDeletedConversations(100, clearCheckpoints).catch(() => {}); }, 5000);
const currentInference = config();
const vectorConfig = vectorSpaceConfig(process.env);
let buildSpace = await store.createEmbeddingGeneration(vectorConfig);
const activeSpace = await store.activeEmbeddingGeneration();
if (!activeSpace) { await store.activateEmbeddingGeneration(buildSpace.id, buildSpace.generation); }
const rerankUrl = process.env.RERANK_URL || new URL('/rerank', currentInference.base).href;
const parsedRerankUrl = URL.parse(rerankUrl);
const localInferenceHosts = ['localhost', '127.0.0.1', '[::1]'];
if (!parsedRerankUrl || !['http:', 'https:'].includes(parsedRerankUrl.protocol) || parsedRerankUrl.username || parsedRerankUrl.password || parsedRerankUrl.search || parsedRerankUrl.hash || (!localInferenceHosts.includes(parsedRerankUrl.hostname) && parsedRerankUrl.protocol !== 'https:')) throw new Error('Configure a valid HTTPS rerank endpoint.');
const inferenceBaseUrl = URL.parse(currentInference.base);
const rerankHasDedicatedKey = Boolean(process.env.RERANK_API_KEY);
if (!currentInference.error && inferenceBaseUrl && !localInferenceHosts.includes(parsedRerankUrl.hostname) && parsedRerankUrl.origin !== inferenceBaseUrl.origin && !rerankHasDedicatedKey) throw new Error('A separate remote rerank endpoint requires RERANK_API_KEY.');
const inferenceCache = new Map<string, RetrievalInference>();
const inferenceFor = (space: typeof buildSpace) => {
  if (currentInference.error) return null;
  const key = `${space.id}:${space.generation}`;
  const cached = inferenceCache.get(key);
  if (cached) return cached;
  const inference = {
    embed: createEmbeddingClient({ base: currentInference.base, key: currentInference.key, model: space.model, dimensions: space.dimensions, normalized: space.normalized, queryMode: space.queryMode, documentMode: space.documentMode }),
    rerank: createRerankClient({ url: rerankUrl, key: process.env.RERANK_API_KEY || currentInference.key, model: process.env.RERANK_MODEL || 'history-rerank-v1' }),
  };
  inferenceCache.set(key, inference);
  return inference;
};
const historicalRetriever = createHybridHistoryRetriever(store, () => store.activeEmbeddingGeneration(), inferenceFor);
const stopIndexing = startIndexingWorker(store, buildSpace, inferenceFor(buildSpace));
const runner = async (owner: string, run: string, signal: AbortSignal) => {
  const current = config();
  const record = await store.getRun(owner, run);
  const searchKey = process.env.TAVILY_API_KEY;
  const client = searchKey ? researchClient({ baseURL: current.base, apiKey: current.key, model: current.model, searchKey, store, owner, runId: run, verifyCurrent: record.verify_current, contextTokens: current.contextTokens, fallback: current.fallback,
    search: async (query, signal) => {
      const { current: input } = await store.context(owner, run);
      return searchCache.search(owner, query, record.verify_current || requiresCurrentVerification(input.content), tavilySearch(searchKey), signal);
    },
  }) : gatewayClient(current.base, current.key || 'unconfigured', current.model, record.verify_current,
    promptBytes => store.reserveResearchWork(owner, run, { modelCalls: 1, promptBytes }));
  await createChatRunner(store, saver, client, (id, chunk) => chunks.emit(id, chunk), tracing, 60_000, historicalRetriever, current.contextTokens, current.maxOutputTokens)(owner, run, signal);
};
const ready = () => gatewayReadiness(config())();
const dispatcher = createDispatcher(store, runner);
const stopRecovery = startRecovery(store, saver, dispatcher, ready);
const app = createApp({ store, owner: () => 'local-development-user', ready, run: runner, dispatcher, clearCheckpoints });
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number');
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, info => console.log(`API listening at http://127.0.0.1:${info.port}`));
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  if ('closeAllConnections' in server) server.closeAllConnections();
  clearInterval(retentionTimer);
  clearInterval(deletionCleanupTimer);
  void (async () => { await stopRecovery(); await stopIndexing(); await dispatcher.shutdown(); await db.close(); saver.db.close(); })().finally(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
