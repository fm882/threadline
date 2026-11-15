import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Store } from '../src/persistence/store.js';
import { createApp } from '../src/api/app.js';

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
