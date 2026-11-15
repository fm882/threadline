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
    await store.publish('alice', recall, 'done');
    for (const [key, timestamp] of [['fall-before', '2025-11-02T03:59:59Z'], ['fall-start', '2025-11-02T04:00:00Z'], ['fall-end', '2025-11-03T04:59:59Z'], ['fall-after', '2025-11-03T05:00:00Z']]) {
      const fallRun = await store.admit('alice', conversation, key, key);
      await db.query("UPDATE messages SET created_at = $1 WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $2) AND role = 'user'", [timestamp, fallRun]);
      await store.publish('alice', fallRun, 'answer');
    }
    const fallRecall = await store.admit('alice', conversation, 'fall-recall', 'recall');
    const fall = await store.questionsOnLocalDate('alice', fallRecall, '2025-11-02');
    expect(fall.total).toBe(2);
    expect(fall.messages.map(message => message.content)).toEqual(['fall-start', 'fall-end']);
    await expect(store.questionsOnLocalDate('bob', recall, '2025-03-09')).rejects.toBeInstanceOf(NotFound);
    await expect(store.questionsOnLocalDate('alice', recall, '2025-02-30')).rejects.toThrow('Invalid local date');
  } finally { await db.close(); }
});

it('does not guess a historical relative date when the original timezone is unavailable', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    await db.query(`INSERT INTO turns (id, conversation_id, owner_id, idempotency_key, payload_hash, input, status)
      VALUES ('legacy-turn', $1, 'alice', 'legacy', 'hash', 'What happened yesterday?', 'completed')`, [conversation]);
    await db.query(`INSERT INTO messages (id, conversation_id, owner_id, turn_id, role, content, ordinal, created_at)
      VALUES ('legacy-message', $1, 'alice', 'legacy-turn', 'user', 'What happened yesterday?', 1, '2025-03-10T02:30:00Z')`, [conversation]);
    await db.query("INSERT INTO owner_sequences (owner_id, value) VALUES ('alice', 1)");
    const run = await store.admit('alice', conversation, 'recall', 'What did I ask on 10 March 2025?');
    const snapshot = await store.prepareDateRecall('alice', run, '2025-03-10');
    const page = await store.dateRecallSnapshot('alice', snapshot);
    expect(page.coverage).toBe('complete');
    expect(page.messages[0].relative_date).toMatchObject({ status: 'timezone_unavailable', timezone: null });
  } finally { await db.close(); }
});

it('paginates chronologically with stable ties and rejects another owner cursor', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    for (const [key, timestamp] of [['later', '2025-05-01T12:00:00.000123Z'], ['earlier', '2025-05-01T10:00:00Z'], ['tied', '2025-05-01T12:00:00.000123Z']]) {
      const run = await store.admit('alice', conversation, key, key);
      await db.query("UPDATE messages SET created_at = $1 WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $2) AND role = 'user'", [timestamp, run]);
      await store.publish('alice', run, 'answer');
    }
    const bob = await store.createConversation('bob');
    const bobRun = await store.admit('bob', bob, 'bob', 'secret');
    const bobOrdinal = (await store.messages('bob', bob))[0].ordinal;
    await store.cancel('bob', bobRun);
    const recall = await store.admit('alice', conversation, 'recall', 'recall');
    const seen: string[] = []; let cursor = 0;
    do { const page = await store.questionsOnLocalDate('alice', recall, '2025-05-01', cursor, 1); seen.push(...page.messages.map(message => message.content)); cursor = page.next || 0; } while (cursor);
    expect(seen).toEqual(['earlier', 'later', 'tied']);
    await expect(store.questionsOnLocalDate('alice', recall, '2025-05-01', 9999, 1)).rejects.toThrow('Invalid pagination cursor');
    expect(bobOrdinal).toBe(1);
  } finally { await db.close(); }
});

it('persists an owner-scoped recall snapshot with fixed cutoff and explicit no-match coverage', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const first = await store.admit('alice', conversation, 'one', 'original question');
    await db.query("UPDATE messages SET created_at = '2025-05-01T12:00:00Z' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [first]);
    await store.publish('alice', first, 'answer');
    const run = await store.admit('alice', conversation, 'recall', 'recall');
    const snapshot = await store.prepareDateRecall('alice', run, '2025-05-01');
    expect(await store.prepareDateRecall('alice', run, '2025-05-01')).toBe(snapshot);
    await expect(store.prepareDateRecall('alice', run, '2025-05-02')).rejects.toThrow('different history snapshot');
    await expect(store.dateRecallSnapshot('bob', snapshot)).rejects.toBeInstanceOf(NotFound);
    await store.publish('alice', run, 'done');
    const later = await store.admit('alice', conversation, 'later', 'later question');
    await db.query("UPDATE messages SET created_at = '2025-05-01T13:00:00Z' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [later]);
    const page = await store.dateRecallSnapshot('alice', snapshot);
    expect(page.status).toBe('resolved'); expect(page.coverage).toBe('complete');
    expect(page.messages.map(message => message.content)).toEqual(['original question']);
    await db.query("UPDATE messages SET content = 'altered question' WHERE id = $1", [page.messages[0].id]);
    const altered = await store.dateRecallSnapshot('alice', snapshot);
    expect(altered.coverage).toBe('incomplete');
    expect(altered.messages).toEqual([]);
    await db.query("UPDATE messages SET content = 'original question', created_at = '2025-05-01T12:30:00Z' WHERE id = $1", [page.messages[0].id]);
    const moved = await store.dateRecallSnapshot('alice', snapshot);
    expect(moved.coverage).toBe('incomplete');
    expect(moved.messages).toEqual([]);
    await store.cancel('alice', later);
    const emptyRun = await store.admit('alice', conversation, 'empty', 'recall');
    const empty = await store.prepareDateRecall('alice', emptyRun, '2024-01-01');
    expect((await store.dateRecallSnapshot('alice', empty)).status).toBe('no_match');
  } finally { await db.close(); }
});

it('returns hundreds of originals across chronological pages without truncation', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    await db.query(`INSERT INTO turns (id, conversation_id, owner_id, idempotency_key, payload_hash, input, status)
      SELECT 'bulk-' || n, $1, 'alice', 'key-' || n, 'hash', 'question ' || n, 'completed' FROM generate_series(1, 237) n`, [conversation]);
    await db.query(`INSERT INTO messages (id, conversation_id, owner_id, turn_id, role, content, ordinal, created_at)
      SELECT 'message-' || n, $1, 'alice', 'bulk-' || n, 'user', 'question ' || n, n,
        '2025-05-01T00:00:00Z'::timestamptz + n * interval '1 second' FROM generate_series(1, 237) n`, [conversation]);
    await db.query("INSERT INTO owner_sequences (owner_id, value) VALUES ('alice', 237)");
    const run = await store.admit('alice', conversation, 'recall', 'what did I ask?');
    const snapshot = await store.prepareDateRecall('alice', run, '2025-05-01');
    const all: string[] = []; let after = 0;
    do {
      const page = await store.dateRecallSnapshot('alice', snapshot, after, 50);
      expect(page.total).toBe(237); expect(page.coverage).toBe('complete');
      all.push(...page.messages.map(message => message.content)); after = page.next ?? 0;
    } while (after);
    expect(all).toHaveLength(237);
    expect(all[0]).toBe('question 1'); expect(all[236]).toBe('question 237');
    expect(new Set(all).size).toBe(237);
  } finally { await db.close(); }
});

it('anchors historical relative dates to the original message time and timezone', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    await store.setTimezone('alice', conversation, 'America/New_York', 'user', false);
    const original = await store.admit('alice', conversation, 'first', 'What happened yesterday?');
    await db.query("UPDATE messages SET created_at = '2025-03-10T02:30:00Z' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [original]);
    await store.publish('alice', original, 'answer');
    await store.setTimezone('alice', conversation, 'UTC', 'user', false);
    const run = await store.admit('alice', conversation, 'recall', 'What did I ask on 10 March 2025?');
    const snapshot = await store.prepareDateRecall('alice', run, '2025-03-10');
    const page = await store.dateRecallSnapshot('alice', snapshot);
    expect(page.messages[0].relative_date).toMatchObject({ status: 'resolved', date: '2025-03-08', timezone: 'America/New_York' });
    expect(page.messages[0].content).toBe('What happened yesterday?');
    await db.query("UPDATE runs SET timezone = 'UTC' WHERE id = $1", [original]);
    expect((await store.dateRecallSnapshot('alice', snapshot)).coverage).toBe('incomplete');
  } finally { await db.close(); }
});
