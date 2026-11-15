import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Store, NotFound } from '../src/persistence/store.js';

it('retrieves original questions across a DST local day and respects owner and cutoff', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    await store.setTimezone('alice', conversation, 'America/New_York', 'user', false);
    for (const [key, timestamp] of [['before', '2025-03-09T04:59:59Z'], ['start', '2025-03-09T05:00:00Z'], ['end', '2025-03-10T03:59:59Z'], ['after', '2025-03-10T04:00:00Z']]) {
      const run = await store.admit('alice', conversation, key, key);
      await db.query("UPDATE messages SET created_at = $1 WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $2) AND role = 'user'", [timestamp, run]);
      await store.publish('alice', run, 'answer');
    }
    const recall = await store.admit('alice', conversation, 'recall', 'what did I ask?');
    const first = await store.questionsOnLocalDate('alice', recall, '2025-03-09', 0, 1);
    expect(first.total).toBe(2); expect(first.messages.map(m => m.content)).toEqual(['start']);
    const second = await store.questionsOnLocalDate('alice', recall, '2025-03-09', first.next!, 1);
    expect(second.messages.map(m => m.content)).toEqual(['end']);
    await expect(store.questionsOnLocalDate('bob', recall, '2025-03-09')).rejects.toBeInstanceOf(NotFound);
    await expect(store.questionsOnLocalDate('alice', recall, '2025-02-30')).rejects.toThrow('Invalid local date');
  } finally { await db.close(); }
});
