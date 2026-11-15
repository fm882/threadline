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
