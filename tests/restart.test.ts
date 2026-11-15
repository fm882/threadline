import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';

it('retains original messages and terminal state after closing and reopening the database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minmi-restart-'));
  try {
    let db = new PGlite(join(dir, 'db'));
    let store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'original question');
    await store.publish('alice', run, 'original answer');
    await db.close();
    db = new PGlite(join(dir, 'db')); store = new Store(db); await store.initialize();
    expect((await store.messages('alice', conversation)).map(m => m.content)).toEqual(['original question', 'original answer']);
    expect((await store.getRun('alice', run)).status).toBe('completed');
    expect(await store.admit('alice', conversation, 'key', 'original question')).toBe(run);
    expect((await store.messages('alice', conversation, 1)).map(m => m.content)).toEqual(['original answer']);
    await db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('serves persisted conversation pages through the owned HTTP API after restart', async () => {
  const { createApp } = await import('../src/api/app.js');
  const dir = await mkdtemp(join(tmpdir(), 'minmi-api-restart-'));
  try {
    let db = new PGlite(join(dir, 'db'));
    let store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'question');
    await store.publish('alice', run, 'answer');
    await db.close();
    db = new PGlite(join(dir, 'db')); store = new Store(db); await store.initialize();
    const app = createApp({ store, owner: req => req.headers.get('x-fixture-owner') || 'alice', ready: () => null, run: async () => {} });
    const history = await (await app.request(`/api/conversations/${conversation}/messages`)).json();
    expect(history.messages.map((m: { content: string }) => m.content)).toEqual(['question', 'answer']);
    const page = await (await app.request(`/api/conversations/${conversation}/messages?after=${history.messages[0].ordinal}`)).json();
    expect(page.messages.map((m: { content: string }) => m.content)).toEqual(['answer']);
    expect((await app.request(`/api/conversations/${conversation}/messages`, { headers: { 'x-fixture-owner': 'bob' } })).status).toBe(404);
    await db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
