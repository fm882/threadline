import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { serve } from '@hono/node-server';
import { Store } from '../src/persistence/store.ts';
import { createApp, chunks } from '../src/api/app.ts';
import { createDispatcher } from '../src/jobs/dispatcher.ts';
import { startIndexingWorker } from '../src/history/index.ts';

const clientCount = 100, activeTurns = 10, historyExchanges = 250, clientsPerTurn = clientCount / activeTurns;
const decoder = new TextDecoder();
const db = new PGlite();
const store = new Store(db);
await store.initialize();

async function beginCrashRecoveryFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'minmi-load-crash-'));
  let requests = 0, child;
  const gateway = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'chat-main-v1' }] })); return; }
    for await (const _ of req) { /* consume the synthetic request */ }
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests === 1) { res.flushHeaders(); return; }
    res.write(`data: ${JSON.stringify({ id: 'crash-recovery', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Recovered after process crash.' }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: 'crash-recovery', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const gatewayAddress = gateway.address();
  if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('Crash fixture gateway did not bind');
  const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
  const reservedAddress = reserved.address();
  if (!reservedAddress || typeof reservedAddress === 'string') throw new Error('Crash fixture API port did not bind');
  const apiPort = reservedAddress.port;
  await new Promise(resolve => reserved.close(resolve));
  const base = `http://127.0.0.1:${apiPort}`;
  const start = () => spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env, APP_DATA_DIR: dir, PORT: String(apiPort), INFERENCE_BASE_URL: `http://127.0.0.1:${gatewayAddress.port}/v1`, INFERENCE_API_KEY: 'fixture', CHAT_MAIN_MODEL: 'chat-main-v1', TAVILY_API_KEY: '', LANGSMITH_TRACING: 'false' } });
  const waitUntil = async (predicate, timeoutMs = 15_000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Crash-recovery fixture timed out');
  };
  const stop = async (signal = 'SIGKILL') => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(signal); await exited;
  };
  try {
    child = start();
    await waitUntil(async () => (await fetch(`${base}/health/ready`).catch(() => null))?.ok === true);
    const conversation = (await (await fetch(`${base}/api/conversations`, { method: 'POST' })).json()).id;
    const admitted = await fetch(`${base}/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'load-crash' }, body: JSON.stringify({ input: 'Recover this run after a local process crash.' }) });
    if (admitted.status !== 202) throw new Error('Crash fixture run was not admitted');
    const { runId } = await admitted.json();
    await waitUntil(async () => requests === 1);
    return {
      async recover() {
        await stop(); child = start();
        await waitUntil(async () => (await (await fetch(`${base}/api/runs/${runId}`).catch(() => null))?.json?.().catch(() => null))?.status === 'completed');
        const messages = await (await fetch(`${base}/api/conversations/${conversation}/messages`)).json();
        return { crashedProcess: true, recoveredStatus: (await (await fetch(`${base}/api/runs/${runId}`)).json()).status, gatewayRequests: requests, oneLogicalAnswer: messages.messages.map(item => item.content).join('\n').match(/Recovered after process crash\./g)?.length === 1 };
      },
      async close() {
        await stop('SIGTERM'); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stop('SIGTERM'); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); await rm(dir, { recursive: true, force: true }); throw error;
  }
}

const space = await store.createEmbeddingGeneration({ id: 'local-load-fixture', model: 'deterministic-load-v1', dimensions: 3, normalized: true, queryMode: 'shared', documentMode: 'shared', chunkingVersion: 'exchange-v1' });
await store.activateEmbeddingGeneration(space.id, space.generation);
const sourceConversation = await store.createConversation('load-test');
await db.query(`INSERT INTO turns (id, conversation_id, owner_id, idempotency_key, payload_hash, input, status, created_at)
  SELECT 'load-turn-' || n, $1, 'load-test', 'load-key-' || n, 'fixture-hash-' || n,
    'Earlier CRM research exchange ' || n, 'completed', now() - (n * interval '1 second')
  FROM generate_series(1, $2) n`, [sourceConversation, historyExchanges]);
await db.query(`INSERT INTO messages (id, conversation_id, owner_id, turn_id, role, content, ordinal, created_at)
  SELECT 'load-user-' || n, $1, 'load-test', 'load-turn-' || n, 'user', 'Earlier CRM research question ' || n,
    n * 2 - 1, now() - (n * interval '1 second')
  FROM generate_series(1, $2) n
  UNION ALL
  SELECT 'load-answer-' || n, $1, 'load-test', 'load-turn-' || n, 'assistant', 'Earlier CRM research answer ' || n,
    n * 2, now() - (n * interval '1 second')
  FROM generate_series(1, $2) n`, [sourceConversation, historyExchanges]);
await db.query(`INSERT INTO owner_sequences (owner_id, value) VALUES ('load-test', $1)
  ON CONFLICT (owner_id) DO UPDATE SET value = GREATEST(owner_sequences.value, EXCLUDED.value)`, [historyExchanges * 2]);
await db.query(`INSERT INTO indexing_jobs (id, message_id, owner_id, space_id, generation, status)
  SELECT 'load-index-' || n, 'load-user-' || n, 'load-test', $2, $3, 'pending'
  FROM generate_series(1, $1) n`, [historyExchanges, space.id, space.generation]);

const stopIndexing = startIndexingWorker(store, space, { embed: async inputs => inputs.map(() => [1, 0, 0]) }, 10, 4);
let releaseWorkers;
const workerGate = new Promise(resolve => { releaseWorkers = resolve; });
const dispatcher = createDispatcher(store, async (owner, runId) => {
  const input = await store.runInput(owner, runId);
  await store.recordProgress(owner, runId, 'searching');
  await workerGate;
  if (input.includes('[synthetic dependency outage]')) throw new Error('Synthetic provider outage');
  for (let i = 0; i < 160; i++) chunks.emit(runId, `synthetic answer chunk ${String(i).padStart(3, '0')} ${'x'.repeat(180)}`);
  await store.publish(owner, runId, `Synthetic verified answer for workload turn ${runId}.`);
});
const app = createApp({ store, owner: () => 'load-test', ready: () => null, run: async (owner, id) => dispatcher.dispatch(owner, id), dispatcher });
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Load evaluator did not bind an HTTP port');
const base = `http://127.0.0.1:${address.port}`;

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(p * sorted.length) - 1].toFixed(2));
}
async function waitUntil(predicate, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Load evaluation timed out waiting for local workers or SSE subscribers');
}

const admissionLatencies = [], runIds = [], conversationIds = [], firstAnswerByRun = new Map(), terminalByRun = new Map(), terminalLatencyByRun = new Map();
const runStarted = new Map();
let connectedClients = 0, connectionErrors = 0;
async function subscribe(runId, slow = false) {
  const response = await fetch(`${base}/api/runs/${runId}/events`);
  if (!response.ok || !response.body) { connectionErrors++; throw new Error(`SSE returned ${response.status}`); }
  connectedClients++;
  const reader = response.body.getReader();
  const monitor = async () => {
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (!firstAnswerByRun.has(runId) && text.includes('event: delta')) firstAnswerByRun.set(runId, performance.now() - runStarted.get(runId));
      for (const kind of ['completed', 'failed', 'cancelled', 'incomplete']) {
        if (text.includes(`event: ${kind}`)) { terminalByRun.set(runId, kind); terminalLatencyByRun.set(runId, performance.now() - runStarted.get(runId)); return text; }
      }
    }
    return text;
  };
  return { reader, monitoring: slow ? null : monitor() };
}

const indexerStart = performance.now();
let crashRecovery;
try {
  for (let i = 0; i < activeTurns; i++) {
    const created = await fetch(`${base}/api/conversations`, { method: 'POST' });
    if (!created.ok) throw new Error('Conversation creation failed');
    conversationIds.push((await created.json()).id);
  }
  for (let i = 0; i < activeTurns; i++) {
    const input = i === activeTurns - 1 ? '[synthetic dependency outage] Compare current CRM options.' : 'Compare current CRM options for the local load fixture.';
    const started = performance.now();
    const response = await fetch(`${base}/api/conversations/${conversationIds[i]}/turns`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `load-${i}` }, body: JSON.stringify({ input }),
    });
    admissionLatencies.push(performance.now() - started);
    if (response.status !== 202) throw new Error(`Turn admission returned ${response.status}`);
    const { runId } = await response.json(); runIds.push(runId); runStarted.set(runId, performance.now());
  }

  const subscriptions = [];
  for (const runId of runIds) for (let i = 0; i < clientsPerTurn; i++) subscriptions.push(await subscribe(runId, runId === runIds[0] && i === 0));
  await waitUntil(() => runIds.every(runId => chunks.listenerCount(runId) === clientsPerTurn));
  const initialConnectedClients = connectedClients;
  const slowStream = subscriptions[0];
  crashRecovery = await beginCrashRecoveryFixture();
  const workloadStarted = performance.now();
  const crashRecoveryPromise = crashRecovery.recover();
  releaseWorkers();
  const monitored = await Promise.all(subscriptions.filter(subscription => subscription.monitoring).map(subscription => subscription.monitoring));
  const crashResult = await crashRecoveryPromise;
  const workloadMs = performance.now() - workloadStarted;
  const slowText = await slowStream.reader.read().then(async first => {
    let text = first.value ? decoder.decode(first.value) : '';
    while (!first.done && !text.includes('event: completed')) {
      first = await slowStream.reader.read();
      if (first.value) text += decoder.decode(first.value);
    }
    return text;
  });
  for (const subscription of subscriptions) await subscription.reader.cancel().catch(() => {});

  const reconnectStart = performance.now();
  const reconnects = await Promise.all(runIds.flatMap(runId => Array.from({ length: clientsPerTurn }, () => subscribe(runId))));
  const reconnectConnectedClients = connectedClients - initialConnectedClients;
  await Promise.all(reconnects.map(connection => connection.monitoring));
  const reconnectMs = performance.now() - reconnectStart;
  for (const connection of reconnects) await connection.reader.cancel().catch(() => {});

  await waitUntil(async () => (await store.pendingIndexJobs(10_000, space)).length === 0, 20_000).catch(() => {});
  const indexCounts = (await db.query(`SELECT status, count(*)::int AS count FROM indexing_jobs GROUP BY status ORDER BY status`)).rows;
  const historyBytes = (await db.query(`SELECT sum(octet_length(content))::int AS bytes FROM messages WHERE conversation_id = $1`, [sourceConversation])).rows[0].bytes;
  const finalStatuses = await Promise.all(runIds.map(async id => (await store.getRun('load-test', id)).status));
  const result = {
    workload: { initialConnectedClients: initialConnectedClients, reconnectBurstClients: reconnectConnectedClients, activeTurns, configuredConcurrentLimit: 10, syntheticHistoryExchanges: historyExchanges, historyPayloadBytes: historyBytes, requestInputBytes: Buffer.byteLength('Compare current CRM options for the local load fixture.'), generatedDeltaBytesPerSuccessfulTurn: 160 * Buffer.byteLength(`synthetic answer chunk 000 ${'x'.repeat(180)}`), cacheConditions: 'cold process caches; no search cache used', externalModelCalls: 0, externalModelCost: '$0.00' },
    hardware: { node: process.version, cpuModel: cpus()[0]?.model || 'unknown', logicalCores: cpus().length, totalMemoryBytes: totalmem() },
    latencyMs: {
      acknowledgement: { p50: percentile(admissionLatencies, 0.5), p95: percentile(admissionLatencies, 0.95), samples: admissionLatencies.length },
      firstAnswer: { p50: percentile([...firstAnswerByRun.values()], 0.5), p95: percentile([...firstAnswerByRun.values()], 0.95), samples: firstAnswerByRun.size },
      completion: { p50: percentile([...terminalLatencyByRun.entries()].filter(([id]) => terminalByRun.get(id) === 'completed').map(([, ms]) => ms), 0.5), p95: percentile([...terminalLatencyByRun.entries()].filter(([id]) => terminalByRun.get(id) === 'completed').map(([, ms]) => ms), 0.95), samples: [...terminalByRun.values()].filter(kind => kind === 'completed').length },
      terminal: { p50: percentile([...terminalLatencyByRun.values()], 0.5), p95: percentile([...terminalLatencyByRun.values()], 0.95), samples: terminalLatencyByRun.size },
      initialWorkloadWall: Number(workloadMs.toFixed(2)), reconnectBurstWall: Number(reconnectMs.toFixed(2)),
    },
    outcomes: { terminals: Object.fromEntries([...terminalByRun.entries()]), runStatuses: finalStatuses, expectedSyntheticOutages: 1, connectionErrors, slowConsumerReceivedCanonicalCompletion: slowText.includes('event: completed') && slowText.includes('Synthetic verified answer'), processCrashRecovery: crashResult, indexingStatusCounts: indexCounts, indexingElapsedMs: Number((performance.now() - indexerStart).toFixed(2)) },
    limitations: ['Synthetic workers and embeddings do not measure hosted provider latency, quality, cost, or multi-process capacity.', 'The hard-crash recovery process uses an independent file-backed store and gateway fixture; the process handling the 100 primary SSE clients was not killed and its in-memory database was not shared with the crash fixture.'],
  };
  if (initialConnectedClients !== clientCount || reconnectConnectedClients !== clientCount || finalStatuses.filter(status => status === 'completed').length !== activeTurns - 1 || finalStatuses.filter(status => status === 'failed').length !== 1 || connectionErrors || !result.outcomes.slowConsumerReceivedCanonicalCompletion || crashResult.recoveredStatus !== 'completed' || crashResult.gatewayRequests !== 2 || !crashResult.oneLogicalAnswer) throw new Error(`Local load acceptance failed: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  releaseWorkers();
  if (crashRecovery) await crashRecovery.close().catch(() => {});
  await stopIndexing();
  await dispatcher.shutdown();
  if ('closeAllConnections' in server) server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await db.close();
}
