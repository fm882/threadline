// One synthetic, billable chat turn against the configured local gateway.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'minmi-live-check-'));
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const address = reservation.address();
if (!address || typeof address === 'string') throw new Error('Could not reserve a port');
const port = address.port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child;
function start() {
  return spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, APP_DATA_DIR: dataDir, PORT: String(port), LANGSMITH_TRACING: 'false' }, stdio: 'ignore',
  });
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
}
async function waitReady() {
  let lastError = 'Chat server did not start';
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error('Chat server exited during startup');
    try {
      const response = await fetch(`${base}/health/ready`);
      if (response.ok) return;
      lastError = (await response.json()).error || lastError;
    } catch { /* wait for listener */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(lastError);
}
try {
  child = start(); await waitReady();
  const conversation = (await (await fetch(`${base}/api/conversations`, { method: 'POST' })).json()).id;
  const prompt = 'Reply exactly: local chat works';
  const turn = await fetch(`${base}/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'live-check' }, body: JSON.stringify({ input: prompt }) });
  if (!turn.ok) throw new Error('Chat admission failed');
  const { runId } = await turn.json();
  const events = await (await fetch(`${base}/api/runs/${runId}/events`, { signal: AbortSignal.timeout(70_000) })).text();
  if (!events.includes('event: completed')) throw new Error('Chat did not complete');
  await stop(); child = start(); await waitReady();
  const history = await (await fetch(`${base}/api/conversations/${conversation}/messages`)).json();
  if (history.messages?.[0]?.content !== prompt || !/local chat works/i.test(history.messages?.[1]?.content || '')) throw new Error('Restarted conversation did not contain the expected exchange');
  console.log(JSON.stringify({ completed: true, receivedDeltas: events.includes('event: delta'), restartVerified: true }));
} finally {
  await stop();
  await rm(dataDir, { recursive: true, force: true });
}
