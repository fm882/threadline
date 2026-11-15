import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from '../src/persistence/store.js';
import { createChatRunner } from '../src/research/chat.js';
import { createDispatcher } from '../src/jobs/dispatcher.js';
import { startRecovery } from '../src/jobs/recovery.js';

async function waitFor(predicate: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for recovery');
}

it('publishes an already completed checkpoint without repeating inference', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'question');
    const publish = store.publish.bind(store), fail = store.fail.bind(store);
    store.publish = async () => { throw new Error('Simulated process interruption before publication'); };
    store.fail = async () => {};
    await createChatRunner(store, saver, async () => 'checkpointed answer')('alice', run);
    store.publish = publish; store.fail = fail;
    let calls = 0;
    await createChatRunner(store, saver, async () => { calls++; return 'duplicate'; })('alice', run);
    expect(calls).toBe(0);
    expect((await store.getRun('alice', run)).status).toBe('completed');
    expect((await store.messages('alice', conversation)).map(message => message.content)).toEqual(['question', 'checkpointed answer']);
  } finally { saver.db.close(); await db.close(); }
});

it('waits for gateway readiness before resuming an accepted job', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'question');
    let ready = false, calls = 0;
    const dispatcher = createDispatcher(store, createChatRunner(store, saver, async () => { calls++; return 'answer'; }));
    const stop = startRecovery(store, saver, dispatcher, async () => ready ? null : 'unavailable', 20);
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(calls).toBe(0);
      expect((await store.getRun('alice', run)).status).toBe('active');
      ready = true;
      await waitFor(async () => (await store.getRun('alice', run)).status === 'completed');
      expect(calls).toBe(1);
    } finally { await stop(); await dispatcher.shutdown(); }
  } finally { saver.db.close(); await db.close(); }
});

it('leaves an interrupted worker active for a later recovery instead of marking it failed', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'question');
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    const dispatcher = createDispatcher(store, createChatRunner(store, saver, async () => { started(); return new Promise(() => {}); }));
    dispatcher.dispatch('alice', run); await entered; await dispatcher.shutdown();
    expect((await store.getRun('alice', run)).status).toBe('active');
    expect((await store.pendingRuns()).map(item => item.id)).toContain(run);
  } finally { saver.db.close(); await db.close(); }
});

it('limits repeated interrupted inference attempts while allowing a new turn', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'question');
    expect(await store.beginAttempt('alice', run)).toBe(true);
    expect(await store.beginAttempt('alice', run)).toBe(true);
    let calls = 0;
    await createChatRunner(store, saver, async () => { calls++; return 'answer'; })('alice', run);
    expect(calls).toBe(0);
    expect((await store.getRun('alice', run)).status).toBe('failed');
    expect((await store.getRun('alice', run)).error).toContain('attempt limit');
    expect(await store.admit('alice', conversation, 'next', 'try again')).toBeTruthy();
  } finally { saver.db.close(); await db.close(); }
});
