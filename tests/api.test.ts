import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Store } from '../src/persistence/store.js';
import { createApp, chunks } from '../src/api/app.js';

it('enforces ownership, input validation, idempotency and canonical event replay', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    // This test-only identity provider models server-controlled authentication.
    const app = createApp({ store, owner: req => req.headers.get('x-fixture-owner') ?? 'alice', ready: () => null,
      run: async (owner, id) => { await store.publish(owner, id, 'answer'); } });
    const created = await app.request('/api/conversations', { method: 'POST' });
    const { id } = await created.json();
    const path = `/api/conversations/${id}/turns`;
    const submit = (input: string) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'one' }, body: JSON.stringify({ input }) });
    expect((await submit('')).status).toBe(400);
    const accepted = await submit('question');
    expect(accepted.status).toBe(202);
    const { runId } = await accepted.json();
    expect((await (await submit('question')).json()).runId).toBe(runId);
    expect((await submit('different')).status).toBe(409);
    expect((await app.request(`/api/runs/${runId}`, { headers: { 'x-fixture-owner': 'bob' } })).status).toBe(404);
    expect((await app.request(`/api/conversations/${id}/messages`, { headers: { 'x-fixture-owner': 'bob' } })).status).toBe(404);
    expect((await app.request(`/api/runs/${runId}/events`, { headers: { 'x-fixture-owner': 'bob' } })).status).toBe(404);
    const events = await (await app.request(`/api/runs/${runId}/events`)).text();
    expect(events).toContain('event: accepted');
    expect(events).toContain('event: completed');
    expect(events).toContain('answer');
  } finally { await db.close(); }
});

it('refuses admission when the gateway is unconfigured', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const app = createApp({ store, owner: () => 'alice', ready: () => 'Configure the gateway', run: async () => {} });
    expect((await app.request('/health/ready')).status).toBe(503);
    const id = await store.createConversation('alice');
    expect((await app.request(`/api/conversations/${id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key' }, body: JSON.stringify({ input: 'hello' }) })).status).toBe(503);
  } finally { await db.close(); }
});

it('rejects nonlocal origins, untrusted host headers and oversized requests', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => {} });
    expect((await app.request('/api/conversations', { method: 'POST', headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect((await app.request('/api/conversations', { method: 'POST', headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await app.request('/api/conversations/test/turns', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key' }, body: JSON.stringify({ input: 'x'.repeat(40000) }) })).status).toBe(413);
  } finally { await db.close(); }
});


it('returns an accepted idempotent turn even when readiness later fails', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const id = await store.createConversation('alice');
    const run = await store.admit('alice', id, 'key', 'hello');
    const app = createApp({ store, owner: () => 'alice', ready: () => 'Gateway unavailable', run: async () => {} });
    const submit = (input: string) => app.request(`/api/conversations/${id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key' }, body: JSON.stringify({ input }) });
    expect((await (await submit('hello')).json()).runId).toBe(run);
    expect((await submit('changed')).status).toBe(409);
  } finally { await db.close(); }
});


it('streams buffered deltas before the canonical terminal event', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async (owner, run) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      chunks.emit(run, 'partial');
      await store.publish(owner, run, 'partial answer');
    } });
    const accepted = await app.request(`/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'one' }, body: JSON.stringify({ input: 'hello' }) });
    const { runId } = await accepted.json();
    const result = await (await app.request(`/api/runs/${runId}/events`)).text();
    expect(result.indexOf('event: delta')).toBeGreaterThan(-1);
    expect(result.indexOf('event: delta')).toBeLessThan(result.indexOf('event: completed'));
  } finally { await db.close(); }
});

it('rejects input exceeding the byte budget before admission', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const id = await store.createConversation('alice');
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => {} });
    const response = await app.request(`/api/conversations/${id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'one' }, body: JSON.stringify({ input: '界'.repeat(6000) }) });
    expect(response.status).toBe(400);
    expect(await store.messages('alice', id)).toEqual([]);
  } finally { await db.close(); }
});

it('returns a conflict for another active turn', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    await store.admit('alice', conversation, 'first', 'in progress');
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => {} });
    const response = await app.request(`/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'second' }, body: JSON.stringify({ input: 'another' }) });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('active');
  } finally { await db.close(); }
});

it('derives identity on the server and rejects untrusted identity fields', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const alice = await store.createConversation('alice');
    const bob = await store.createConversation('bob');
    const run = await store.admit('bob', bob, 'bob-key', 'private');
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => {} });
    const list = await (await app.request('/api/conversations', { headers: { 'x-owner-id': 'bob' } })).json();
    expect(list.conversations.map((c: { id: string }) => c.id)).toEqual([alice]);
    const attempt = await app.request(`/api/conversations/${bob}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key', 'x-owner-id': 'bob' }, body: JSON.stringify({ input: 'hello' }) });
    expect(attempt.status).toBe(404);
    expect((await app.request(`/api/conversations/${bob}/messages`)).status).toBe(404);
    expect((await app.request(`/api/runs/${run}`)).status).toBe(404);
    expect((await app.request(`/api/runs/${run}/events`)).status).toBe(404);
    const field = await app.request(`/api/conversations/${alice}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key' }, body: JSON.stringify({ input: 'hello', owner_id: 'bob' }) });
    expect(field.status).toBe(400);
  } finally { await db.close(); }
});

it('does not miss publication that commits between event and state reads', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'race', 'hello');
    const originalEvents = store.events.bind(store);
    let first = true;
    store.events = async (...args) => {
      const result = await originalEvents(...args);
      if (first) { first = false; await store.publish('alice', run, 'done'); }
      return result;
    };
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => {} });
    const data = await (await app.request(`/api/runs/${run}/events`)).text();
    expect(data).toContain('event: completed');
    expect(data).toContain('done');
  } finally { await db.close(); }
});

it('preserves original whitespace and treats altered whitespace as a different payload', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const id = await store.createConversation('alice');
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => {} });
    const submit = (input: string) => app.request(`/api/conversations/${id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'one' }, body: JSON.stringify({ input }) });
    expect((await submit('  hello\n')).status).toBe(202);
    expect((await store.messages('alice', id))[0].content).toBe('  hello\n');
    expect((await submit('hello')).status).toBe(409);
  } finally { await db.close(); }
});

it('keeps the run alive and removes its listener after a subscriber disconnects', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    let release!: () => void;
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async (owner, id) => {
      await proceed;
      await store.publish(owner, id, 'completed after disconnect');
    } });
    const response = await app.request(`/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'one' }, body: JSON.stringify({ input: 'hello' }) });
    const { runId } = await response.json();
    const stream = await app.request(`/api/runs/${runId}/events`);
    const reader = stream.body!.getReader();
    await reader.read();
    expect(chunks.listenerCount(runId)).toBe(1);
    await reader.cancel();
    release();
    for (let n = 0; n < 50 && (await store.getRun('alice', runId)).status === 'active'; n++) await new Promise(resolve => setTimeout(resolve, 20));
    expect((await store.getRun('alice', runId)).status).toBe('completed');
    for (let n = 0; n < 50 && chunks.listenerCount(runId); n++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(chunks.listenerCount(runId)).toBe(0);
  } finally { await db.close(); }
});

it('records a safe terminal failure if the worker rejects unexpectedly', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => { throw new Error('sensitive provider error'); } });
    const response = await app.request(`/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'one' }, body: JSON.stringify({ input: 'hello' }) });
    const { runId } = await response.json();
    for (let n = 0; n < 50 && (await store.getRun('alice', runId)).status === 'active'; n++) await new Promise(resolve => setTimeout(resolve, 20));
    const result = await store.getRun('alice', runId);
    expect(result.status).toBe('failed');
    expect(result.error).not.toContain('sensitive');
    expect(await store.admit('alice', conversation, 'two', 'try again')).toBeTruthy();
  } finally { await db.close(); }
});

it('persists the explicit verification choice and includes it in idempotency', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => {} });
    const submit = (verifyCurrent: boolean) => app.request(`/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'choice' }, body: JSON.stringify({ input: 'What about this?', verifyCurrent }) });
    const response = await submit(true); expect(response.status).toBe(202);
    const { runId } = await response.json();
    expect((await store.getRun('alice', runId)).verify_current).toBe(true);
    expect((await (await submit(true)).json()).runId).toBe(runId);
    expect((await submit(false)).status).toBe(409);
  } finally { await db.close(); }
});

it('cancels an active run once, aborts the worker and prevents late publication', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    let workerSignal!: AbortSignal;
    const app = createApp({ store, owner: req => req.headers.get('x-fixture-owner') || 'alice', ready: () => null, run: async (_owner, _run, signal) => { workerSignal = signal; started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } });
    const response = await app.request(`/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'cancel' }, body: JSON.stringify({ input: 'hello' }) });
    const { runId } = await response.json(); await running;
    expect((await app.request(`/api/runs/${runId}/cancel`, { method: 'POST', headers: { 'x-fixture-owner': 'bob' } })).status).toBe(404);
    expect((await (await app.request(`/api/runs/${runId}/cancel`, { method: 'POST' })).json()).status).toBe('cancelled');
    expect(workerSignal.aborted).toBe(true);
    expect((await (await app.request(`/api/runs/${runId}/cancel`, { method: 'POST' })).json()).status).toBe('cancelled');
    expect(await store.publish('alice', runId, 'late answer')).toBe(false);
    expect((await store.events('alice', runId)).map(event => event.kind)).toEqual(['accepted', 'cancelled']);
  } finally { await db.close(); }
});

it('returns completed when publication wins before cancellation', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'hello');
    await store.publish('alice', run, 'done');
    expect(await store.cancel('alice', run)).toBe('completed');
    expect((await store.events('alice', run)).map(event => event.kind)).toEqual(['accepted', 'completed']);
  } finally { await db.close(); }
});

it('only exposes a conversation active run to its owner', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'hello');
    const app = createApp({ store, owner: req => req.headers.get('x-fixture-owner') || 'alice', ready: () => null, run: async () => {} });
    expect((await (await app.request(`/api/conversations/${conversation}/active-run`)).json()).runId).toBe(run);
    expect((await app.request(`/api/conversations/${conversation}/active-run`, { headers: { 'x-fixture-owner': 'bob' } })).status).toBe(404);
    await store.publish('alice', run, 'done');
    expect((await (await app.request(`/api/conversations/${conversation}/active-run`)).json()).runId).toBeNull();
  } finally { await db.close(); }
});

it('resets unavailable cursors and recovers a pruned terminal result from canonical state', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'hello');
    await store.publish('alice', run, 'canonical answer');
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => {} });
    const original = await store.events('alice', run);
    const replay = await (await app.request(`/api/runs/${run}/events?after=${original[0].id}`)).text();
    expect(replay).not.toContain('event: accepted');
    expect(replay).toContain('event: completed');
    await db.query("DELETE FROM run_events WHERE run_id = $1 AND kind = 'completed'", [run]);
    const reset = await (await app.request(`/api/runs/${run}/events?after=2147483647`)).text();
    expect(reset).toContain('event: reset');
    expect(reset).toContain('event: completed');
    expect(reset).toContain('canonical answer');
    expect(reset.match(/event: completed/g)).toHaveLength(1);
    const afterAccepted = await (await app.request(`/api/runs/${run}/events?after=${original[0].id}`)).text();
    expect(afterAccepted).toContain('canonical answer');
  } finally { await db.close(); }
});

it('bounds buffered deltas while preserving the canonical final answer for a slow subscriber', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'hello');
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run: async () => {} });
    const response = await app.request(`/api/runs/${run}/events`);
    const reader = response.body!.getReader();
    const first = await reader.read();
    for (let i = 0; i < 2000; i++) chunks.emit(run, 'x'.repeat(4096));
    await store.publish('alice', run, 'canonical final');
    const parts: Uint8Array[] = first.value ? [first.value] : [];
    while (true) { const part = await reader.read(); if (part.done) break; parts.push(part.value); }
    const text = parts.map(part => new TextDecoder().decode(part)).join('');
    expect(text.length).toBeLessThan(100_000);
    expect(text).toContain('canonical final');
    expect(text.match(/event: completed/g)).toHaveLength(1);
  } finally { await db.close(); }
});
