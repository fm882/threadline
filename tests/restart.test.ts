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
