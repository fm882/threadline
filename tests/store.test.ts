import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Conflict, NotFound, Store } from '../src/persistence/store.js';

describe('turn admission', () => {
  it('isolates owners and enforces idempotency and one active turn', async () => {
    const db = new PGlite();
    try {
      const store = new Store(db);
      await store.initialize();
      const conversation = await store.createConversation('alice');
      const first = await store.admit('alice', conversation, 'key', 'hello');
      expect(await store.admit('alice', conversation, 'key', 'hello')).toBe(first);
      await expect(store.admit('alice', conversation, 'key', 'different')).rejects.toBeInstanceOf(Conflict);
      await expect(store.admit('alice', conversation, 'other', 'hello')).rejects.toBeInstanceOf(Conflict);
      await expect(store.admit('bob', conversation, 'key', 'hello')).rejects.toBeInstanceOf(NotFound);
    } finally { await db.close(); }
  });
});

it('persists atomic publication, a fixed cutoff, and owner-scoped history', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db);
    await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'one', 'hello');
    expect((await store.getRun('alice', run)).cutoff).toBe(0);
    expect(await store.publish('alice', run, 'hi')).toBe(true);
    expect(await store.publish('alice', run, 'duplicate')).toBe(false);
    expect((await store.messages('alice', conversation)).map(m => m.content)).toEqual(['hello', 'hi']);
    expect((await store.events('alice', run)).map(e => e.kind)).toEqual(['accepted', 'completed']);
    await expect(store.messages('bob', conversation)).rejects.toBeInstanceOf(NotFound);
    await expect(store.events('bob', run)).rejects.toBeInstanceOf(NotFound);
    const next = await store.admit('alice', conversation, 'two', 'again');
    expect((await store.getRun('alice', next)).cutoff).toBe(2);
  } finally { await db.close(); }
});
