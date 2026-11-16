import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No TCP listener');
  return address.port;
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill(signal); await exit;
}
async function waitUntil(predicate: () => Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await predicate()) return; } catch { /* starting */ } await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for server');
}

it('recovers an admitted run after a process dies during inference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minmi-crash-'));
  let requests = 0;
  const gateway = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'chat-main-v1' }, { id: 'chat-fast-v1' }] })); return; }
    for await (const _ of req) { /* consume */ } requests++;
    const current = requests;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (current === 1) { res.flushHeaders(); return; }
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: { role: 'assistant', content: 'recovered answer' }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const gatewayPort = await listen(gateway);
  const reserved = createServer(); const port = await listen(reserved); await new Promise<void>(resolve => reserved.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const start = () => spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { env: { ...process.env, APP_DATA_DIR: dir, PORT: String(port), INFERENCE_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`, INFERENCE_API_KEY: 'fixture', BEDROCK_FAST_ROUTE: 'bedrock/converse/us.amazon.nova-micro-v1:0', TAVILY_API_KEY: '', LANGSMITH_TRACING: 'false' }, stdio: 'ignore' });
  let child = start();
  try {
    await waitUntil(async () => (await fetch(`${base}/health/ready`)).ok);
    const conversation = (await (await fetch(`${base}/api/conversations`, { method: 'POST' })).json()).id;
    const { runId } = await (await fetch(`${base}/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key' }, body: JSON.stringify({ input: 'question' }) })).json();
    await waitUntil(async () => requests === 1);
    await stop(child, 'SIGKILL'); child = start();
    await waitUntil(async () => (await (await fetch(`${base}/api/runs/${runId}`)).json()).status === 'completed');
    const history = await (await fetch(`${base}/api/conversations/${conversation}/messages`)).json();
    expect(history.messages.map((message: { content: string }) => message.content)).toEqual(['question', 'recovered answer']);
    expect(requests).toBe(2);
  } finally {
    await stop(child); gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  }
}, 40_000);

it('publishes a completed checkpoint after a hard crash even when the gateway is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minmi-checkpoint-crash-'));
  const db = new PGlite(join(dir, 'app-db')); const store = new Store(db); await store.initialize();
  const conversation = await store.createConversation('alice'); const runId = await store.admit('alice', conversation, 'key', 'question'); await db.close();
  const reserved = createServer(); const port = await listen(reserved); await new Promise<void>(resolve => reserved.close(() => resolve()));
  const worker = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/checkpoint-worker.ts'], { env: { ...process.env, APP_DATA_DIR: dir, TEST_RUN_ID: runId }, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = ''; worker.stdout!.on('data', chunk => { output += chunk; });
  let server: ChildProcess | undefined;
  try {
    await waitUntil(async () => output.includes('CHECKPOINT_READY'));
    await stop(worker, 'SIGKILL');
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { env: { ...process.env, APP_DATA_DIR: dir, PORT: String(port), INFERENCE_BASE_URL: 'http://127.0.0.1:1/v1', INFERENCE_API_KEY: 'fixture', BEDROCK_FAST_ROUTE: 'bedrock/converse/us.amazon.nova-micro-v1:0', TAVILY_API_KEY: '', LANGSMITH_TRACING: 'false' }, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    // This fixture uses alice rather than the production local identity; inspect the DB after shutdown.
    await waitUntil(async () => (await fetch(`${base}/health/live`)).ok);
    await new Promise(resolve => setTimeout(resolve, 3500));
    await stop(server);
    const reopened = new PGlite(join(dir, 'app-db')); const recovered = new Store(reopened); await recovered.initialize();
    expect((await recovered.getRun('alice', runId)).status).toBe('completed');
    expect((await recovered.messages('alice', conversation)).map(message => message.content)).toEqual(['question', 'checkpointed response']);
    await reopened.close();
  } finally { await stop(worker); if (server) await stop(server); await rm(dir, { recursive: true, force: true }); }
}, 40_000);

it('recovers one logical research answer after a hard crash during tool-result continuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minmi-tool-crash-'));
  let initialCalls = 0, continuationCalls = 0;
  const gateway = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body);
    const tool = request.messages.find((message: { role: string }) => message.role === 'tool');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (tool) {
      continuationCalls++;
      if (continuationCalls === 1) { res.flushHeaders(); return; }
      const evidence = JSON.parse(tool.content)[0];
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'chat-main-v1', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ claims: [{ claim: 'Recorded finding.', kind: 'other', evidenceIds: [evidence.id] }], uncertainty: '' }) }, finish_reason: 'stop' }] }));
    } else {
      initialCalls++;
      res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'chat-main-v1', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"details"}' } }] }, finish_reason: 'tool_calls' }] }));
    }
  });
  const gatewayPort = await listen(gateway);
  const reserved = createServer(); const port = await listen(reserved); await new Promise<void>(resolve => reserved.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const start = () => spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/research-recovery-server.ts'], { env: { ...process.env, APP_DATA_DIR: dir, PORT: String(port), INFERENCE_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`, LANGSMITH_TRACING: 'false' }, stdio: 'ignore' });
  let child = start();
  try {
    await waitUntil(async () => (await fetch(`${base}/health/live`)).ok);
    const conversation = (await (await fetch(`${base}/api/conversations`, { method: 'POST' })).json()).id;
    const { runId } = await (await fetch(`${base}/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key' }, body: JSON.stringify({ input: 'find details' }) })).json();
    await waitUntil(async () => continuationCalls === 1);
    await stop(child, 'SIGKILL'); child = start();
    await waitUntil(async () => (await (await fetch(`${base}/api/runs/${runId}`)).json()).status === 'completed');
    const history = await (await fetch(`${base}/api/conversations/${conversation}/messages`)).json();
    expect(history.messages).toHaveLength(2);
    expect(history.messages[1].content).toContain('Recorded finding.');
    const events = await (await fetch(`${base}/api/runs/${runId}/events`)).text();
    expect(events.match(/event: completed/g)).toHaveLength(1);
    expect(initialCalls).toBe(2); expect(continuationCalls).toBe(2);
  } finally {
    await stop(child); gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  }
}, 40_000);

it('does not repeat publication after a hard crash immediately after commit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minmi-publish-crash-'));
  const db = new PGlite(join(dir, 'app-db')); const store = new Store(db); await store.initialize();
  const conversation = await store.createConversation('alice'); const runId = await store.admit('alice', conversation, 'key', 'question'); await db.close();
  const worker = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/publication-worker.ts'], { env: { ...process.env, APP_DATA_DIR: dir, TEST_RUN_ID: runId }, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = ''; worker.stdout!.on('data', chunk => { output += chunk; });
  const reserved = createServer(); const port = await listen(reserved); await new Promise<void>(resolve => reserved.close(() => resolve()));
  let server: ChildProcess | undefined;
  try {
    await waitUntil(async () => output.includes('PUBLICATION_COMMITTED'));
    await stop(worker, 'SIGKILL');
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { env: { ...process.env, APP_DATA_DIR: dir, PORT: String(port), INFERENCE_BASE_URL: 'http://127.0.0.1:1/v1', INFERENCE_API_KEY: 'fixture', BEDROCK_FAST_ROUTE: 'bedrock/converse/us.amazon.nova-micro-v1:0', TAVILY_API_KEY: '', LANGSMITH_TRACING: 'false' }, stdio: 'ignore' });
    await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/health/live`)).ok);
    await new Promise(resolve => setTimeout(resolve, 1200)); await stop(server);
    const reopened = new PGlite(join(dir, 'app-db')); const recovered = new Store(reopened); await recovered.initialize();
    expect((await recovered.getRun('alice', runId)).status).toBe('completed');
    expect((await recovered.messages('alice', conversation)).map(message => message.content)).toEqual(['question', 'published response']);
    expect((await recovered.events('alice', runId)).filter(event => event.kind === 'completed')).toHaveLength(1);
    await reopened.close();
  } finally { await stop(worker); if (server) await stop(server); await rm(dir, { recursive: true, force: true }); }
}, 40_000);

it('dispatches an admitted job after a hard crash before execution starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minmi-admission-crash-'));
  const gateway = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'chat-main-v1' }, { id: 'chat-fast-v1' }] })); return; }
    for await (const _ of req) { /* consume */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: { role: 'assistant', content: 'recovered admission' }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const gatewayPort = await listen(gateway);
  const reserved = createServer(); const port = await listen(reserved); await new Promise<void>(resolve => reserved.close(() => resolve()));
  const worker = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/admission-worker.ts'], { env: { ...process.env, APP_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = ''; worker.stdout!.on('data', chunk => { output += chunk; });
  let server: ChildProcess | undefined;
  try {
    await waitUntil(async () => output.includes('\n'));
    const { conversation, runId } = JSON.parse(output.trim());
    await stop(worker, 'SIGKILL');
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { env: { ...process.env, APP_DATA_DIR: dir, PORT: String(port), INFERENCE_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`, INFERENCE_API_KEY: 'fixture', BEDROCK_FAST_ROUTE: 'bedrock/converse/us.amazon.nova-micro-v1:0', TAVILY_API_KEY: '', LANGSMITH_TRACING: 'false' }, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    await waitUntil(async () => (await (await fetch(`${base}/api/runs/${runId}`)).json()).status === 'completed');
    const history = await (await fetch(`${base}/api/conversations/${conversation}/messages`)).json();
    expect(history.messages.map((message: { content: string }) => message.content)).toEqual(['question', 'recovered admission']);
    const events = await (await fetch(`${base}/api/runs/${runId}/events`)).text();
    expect(events.match(/event: completed/g)).toHaveLength(1);
  } finally { await stop(worker); if (server) await stop(server); gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}, 40_000);
