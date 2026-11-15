import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createApp, chunks } from './api/app.js';
import { Store } from './persistence/store.js';
import { createChatRunner, gatewayClient } from './research/chat.js';
import { langsmithSink } from './telemetry/tracing.js';
import { loadCapabilities } from './inference/capabilities.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const tracing = process.env.LANGSMITH_TRACING === 'true' && process.env.LANGSMITH_API_KEY
  ? langsmithSink(process.env.LANGSMITH_API_KEY, process.env.LANGSMITH_PROJECT || 'minmi-local') : undefined;
// Disable implicit framework tracing: it can export prompts and responses.
for (const name of ['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGCHAIN_VERBOSE']) process.env[name] = 'false';
mkdirSync('.data', { recursive: true, mode: 0o700 });
const db = new PGlite('.data/app-db');
const store = new Store(db);
await store.initialize();
const base = process.env.INFERENCE_BASE_URL || 'http://127.0.0.1:4000/v1';
const url = URL.parse(base);
const loopback = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const localKey = '.data/litellm.key';
const key = process.env.INFERENCE_API_KEY || (loopback && existsSync(localKey) ? readFileSync(localKey, 'utf8').trim() : '');
const model = process.env.CHAT_MAIN_MODEL || 'chat-main-v1';
const capabilities = loadCapabilities(process.env.MODEL_CAPABILITIES_PATH || 'config/model-capabilities.json', model);
const problem = 'error' in capabilities ? capabilities.error ?? 'Invalid capability manifest.' : !url || !['http:', 'https:'].includes(url.protocol) ? 'Set a valid INFERENCE_BASE_URL.' : !key ? 'Start the local gateway or set INFERENCE_API_KEY.' : null;
const saver = SqliteSaver.fromConnString('.data/checkpoints.sqlite');
const client = gatewayClient(base, key || 'unconfigured', model);
const runner = createChatRunner(store, saver, client, (run, chunk) => chunks.emit(run, chunk), tracing);
const app = createApp({ store, owner: () => 'local-development-user', ready: () => problem, run: runner });
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number');
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, info => console.log(`API listening at http://127.0.0.1:${info.port}`));
const shutdown = () => server.close(() => { void db.close().finally(() => process.exit(0)); });
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
