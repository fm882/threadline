import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP listener');
  return address.port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
}
async function waitReady(base: string, child: ChildProcess) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
    try { if ((await fetch(`${base}/health/ready`)).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become ready');
}

it('retains a completed HTTP chat after a clean server process restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minmi-process-'));
  const gateway = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'chat-main-v1' }, { id: 'chat-fast-v1' }] })); return; }
    for await (const _ of req) { /* consume request */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: { role: 'assistant', content: 'persisted answer' }, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  const gatewayPort = await listen(gateway);
  const reserved = createServer(); const port = await listen(reserved);
  await new Promise<void>(resolve => reserved.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const start = () => spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { env: { ...process.env, APP_DATA_DIR: dir, PORT: String(port), INFERENCE_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`, INFERENCE_API_KEY: 'fixture-key', BEDROCK_FAST_ROUTE: 'bedrock/converse/us.amazon.nova-micro-v1:0', TAVILY_API_KEY: '', LANGSMITH_TRACING: 'false' }, stdio: 'ignore' });
  let child = start();
  try {
    await waitReady(base, child);
    const conversation = (await (await fetch(`${base}/api/conversations`, { method: 'POST' })).json()).id;
    const response = await fetch(`${base}/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'test' }, body: JSON.stringify({ input: 'persisted question' }) });
    expect(response.status).toBe(202);
    const { runId } = await response.json();
    expect(await (await fetch(`${base}/api/runs/${runId}/events`)).text()).toContain('event: completed');
    await stop(child);
    child = start(); await waitReady(base, child);
    const history = await (await fetch(`${base}/api/conversations/${conversation}/messages`)).json();
    expect(history.messages.map((m: { content: string }) => m.content)).toEqual(['persisted question', 'persisted answer']);
    await stop(child);
    const saver = SqliteSaver.fromConnString(join(dir, 'checkpoints.sqlite'));
    const checkpoint = await saver.get({ configurable: { thread_id: runId } });
    expect(checkpoint?.channel_values.answer).toBe('persisted answer');
  } finally {
    await stop(child);
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
