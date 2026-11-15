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

it('serializes concurrent admissions and prevents duplicate publication', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const retries = await Promise.all(Array.from({ length: 5 }, () => store.admit('alice', conversation, 'same', 'hello')));
    expect(new Set(retries).size).toBe(1);
    const results = await Promise.all(Array.from({ length: 5 }, () => store.publish('alice', retries[0], 'answer')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.messages('alice', conversation)).map(m => m.content)).toEqual(['hello', 'answer']);
    const attempts = await Promise.allSettled(['two', 'three'].map(key => store.admit('alice', conversation, key, key)));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
  } finally { await db.close(); }
});

it('keeps the admitted input outside its immutable historical cutoff', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const first = await store.admit('alice', conversation, 'first', 'one');
    await expect(store.admit('alice', conversation, 'other', 'concurrent')).rejects.toBeInstanceOf(Conflict);
    await store.publish('alice', first, 'answer one');
    const second = await store.admit('alice', conversation, 'second', 'two');
    await store.publish('alice', second, 'answer two');
    const later = await store.admit('alice', conversation, 'third', 'three');
    await store.publish('alice', later, 'answer three');
    const snapshot = await store.context('alice', second);
    expect(snapshot.current.content).toBe('two');
    expect(snapshot.history.map(message => message.content)).toEqual(['one', 'answer one']);
    expect((await store.getRun('alice', second)).cutoff).toBe(2);
  } finally { await db.close(); }
});

it('freezes the conversation timezone at turn admission', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    await store.setTimezone('alice', conversation, 'Asia/Kolkata', 'user', false);
    const first = await store.admit('alice', conversation, 'first', 'question');
    await store.setTimezone('alice', conversation, 'America/New_York', 'user', false);
    expect((await store.getRun('alice', first)).timezone).toBe('Asia/Kolkata');
    await store.publish('alice', first, 'answer');
    const second = await store.admit('alice', conversation, 'second', 'another');
    expect((await store.getRun('alice', second)).timezone).toBe('America/New_York');
  } finally { await db.close(); }
});
