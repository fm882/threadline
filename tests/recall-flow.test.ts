import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from '../src/persistence/store.js';
import { createChatRunner } from '../src/research/chat.js';
import { createApp } from '../src/api/app.js';
import { prepareExactRecall } from '../src/history/recall.js';

it('publishes an original-backed date recall and exposes its owner-scoped page', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const original = await store.admit('alice', conversation, 'one', 'Original question?');
    await db.query("UPDATE messages SET created_at = '2025-11-03T12:00:00Z' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [original]);
    await store.publish('alice', original, 'Original answer');
    const run = await store.admit('alice', conversation, 'two', 'What did I ask on 3 November 2025? Is your answer still correct today?');
    let modelCalls = 0;
    await createChatRunner(store, saver, async () => { modelCalls++; return 'fabricated'; })('alice', run);
    expect(modelCalls).toBe(0);
    const messages = await store.messages('alice', conversation);
    const match = /\[recall:([a-f0-9-]+)\]/.exec(messages.at(-1)!.content);
    expect(match).not.toBeNull();
    expect(messages.at(-1)!.content).toContain('I have not verified any earlier answer');
    const app = createApp({ store, owner: req => req.headers.get('x-fixture-owner') || 'alice', ready: () => null, run: async () => {} });
    const page = await (await app.request(`/api/history/${match![1]}`)).json();
    expect(page.messages.map((m: { content: string }) => m.content)).toEqual(['Original question?']);
    expect(page.coverage).toBe('complete');
    expect((await app.request(`/api/history/${match![1]}`, { headers: { 'x-fixture-owner': 'bob' } })).status).toBe(404);
  } finally { saver.db.close(); await db.close(); }
});

it('asks for the year when retained originals match the same month and day in multiple years', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    for (const year of [2023, 2024]) {
      const run = await store.admit('alice', conversation, String(year), `Question ${year}`);
      await db.query("UPDATE messages SET created_at = $1 WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $2) AND role = 'user'", [`${year}-11-03T12:00:00Z`, run]);
      await store.publish('alice', run, 'answer');
    }
    const run = await store.admit('alice', conversation, 'recall', 'What did I ask on 3 November?');
    await createChatRunner(store, saver, async () => { throw new Error('Unexpected model call'); })('alice', run);
    const answer = (await store.messages('alice', conversation)).at(-1)!.content;
    expect(answer).toContain('multiple years');
    expect(answer).toContain('2024'); expect(answer).toContain('2023');
    expect(answer).not.toContain('[recall:');
  } finally { saver.db.close(); await db.close(); }
});

it('distinguishes no match, failed retrieval, and incomplete snapshot coverage', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'What did I ask on 3 November 2020?');
    const args = [store, 'alice', run, 'What did I ask on 3 November 2020?', new Date('2026-01-01T00:00:00Z'), 'UTC'] as const;
    expect(await prepareExactRecall(...args)).toContain('No retained questions found');
    const saved = store.dateRecallSnapshot.bind(store);
    store.dateRecallSnapshot = async () => { throw new Error('private database detail'); };
    const failed = await prepareExactRecall(...args);
    expect(failed).toContain('History retrieval failed');
    expect(failed).not.toContain('private database detail');
    store.dateRecallSnapshot = async (...params) => ({ ...await saved(...params), coverage: 'incomplete' });
    const incomplete = await prepareExactRecall(...args);
    expect(incomplete).toContain('could not retrieve complete history');
    expect(incomplete).not.toContain('No retained questions found');
  } finally { await db.close(); }
});
