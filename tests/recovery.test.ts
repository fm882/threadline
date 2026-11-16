import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from '../src/persistence/store.js';
import { createChatRunner } from '../src/research/chat.js';
import { createDispatcher } from '../src/jobs/dispatcher.js';
import { startRecovery } from '../src/jobs/recovery.js';
import { processIndexJob } from '../src/history/index.js';

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

it('keeps foreground concurrency bounded while the separate indexer makes progress', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const space = await store.createEmbeddingGeneration({ id: 'budget-index', model: 'fixture-v1', dimensions: 3, normalized: true, queryMode: 'shared', documentMode: 'shared', chunkingVersion: 'exchange-v1' });
    await store.activateEmbeddingGeneration(space.id, space.generation);
    const conversation = await store.createConversation('alice');
    const source = await store.admit('alice', conversation, 'source', 'CRM shortlist');
    await store.publish('alice', source, 'Acme CRM and Northstar CRM.');
    const [indexJob] = await store.pendingIndexJobs(4, space);
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const dispatcher = createDispatcher(store, async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    }, 1);
    try {
      expect(dispatcher.dispatch('alice', 'active-1')).toBe(true);
      await entered;
      expect(dispatcher.dispatch('alice', 'active-2')).toBe(false);
      expect(await processIndexJob(store, indexJob, space, async inputs => inputs.map(() => [1, 0, 0]))).toBe(true);
    } finally { release(); await dispatcher.shutdown(); }
  } finally { await db.close(); }
});

it('keeps backpressure and indexing effective through a dependency timeout, then frees the slot', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const space = await store.createEmbeddingGeneration({ id: 'timeout-index', model: 'fixture-v1', dimensions: 3, normalized: true, queryMode: 'shared', documentMode: 'shared', chunkingVersion: 'exchange-v1' });
    await store.activateEmbeddingGeneration(space.id, space.generation);
    const conversation = await store.createConversation('alice');
    const source = await store.admit('alice', conversation, 'source', 'Earlier research question');
    await store.publish('alice', source, 'Earlier research answer.');
    const [indexJob] = await store.pendingIndexJobs(4, space);
    const first = await store.admit('alice', conversation, 'timeout', 'Research with a stalled dependency');
    const laterConversation = await store.createConversation('alice');
    const second = await store.admit('alice', laterConversation, 'after-timeout', 'A later bounded run');
    let calls = 0, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const client = async () => {
      calls++;
      if (calls === 1) { started(); return new Promise<string>(() => {}); }
      return 'Recovered answer';
    };
    const runner = createChatRunner(store, saver, client, () => {}, undefined, 600);
    const dispatcher = createDispatcher(store, runner, 1);
    try {
      expect(dispatcher.dispatch('alice', first)).toBe(true);
      await entered;
      expect(dispatcher.dispatch('alice', second)).toBe(false);
      expect(await processIndexJob(store, indexJob, space, async inputs => inputs.map(() => [1, 0, 0]))).toBe(true);
      expect(await store.pendingIndexJobs(4, space)).toHaveLength(0);
      await waitFor(async () => (await store.getRun('alice', first)).status === 'incomplete');
      expect(dispatcher.dispatch('alice', second)).toBe(true);
      await waitFor(async () => (await store.getRun('alice', second)).status === 'completed');
      expect(calls).toBe(2);
    } finally { await dispatcher.shutdown(); }
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

it('does not publish a saved checkpoint after the run has been cancelled', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'question');
    const publish = store.publish.bind(store), fail = store.fail.bind(store);
    store.publish = async () => { throw new Error('Simulated interruption'); };
    store.fail = async () => {};
    await createChatRunner(store, saver, async () => 'checkpointed response')('alice', run);
    store.publish = publish; store.fail = fail;
    expect(await store.cancel('alice', run)).toBe('cancelled');
    let calls = 0;
    await createChatRunner(store, saver, async () => { calls++; return 'unexpected'; })('alice', run);
    expect(calls).toBe(0);
    expect((await store.getRun('alice', run)).status).toBe('cancelled');
    expect((await store.messages('alice', conversation)).map(item => item.content)).toEqual(['question']);
    expect((await store.events('alice', run)).map(item => item.kind)).toEqual(['accepted', 'cancelled']);
  } finally { saver.db.close(); await db.close(); }
});

it('does not let a stale failure or answer overwrite an already completed run', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'key', 'question');
    await store.publish('alice', run, 'canonical answer');
    await store.fail('alice', run, 'stale failure');
    expect(await store.publish('alice', run, 'stale answer')).toBe(false);
    expect((await store.getRun('alice', run)).status).toBe('completed');
    expect((await store.messages('alice', conversation)).map(item => item.content)).toEqual(['question', 'canonical answer']);
    expect((await store.events('alice', run)).map(event => event.kind)).toEqual(['accepted', 'completed']);
  } finally { saver.db.close(); await db.close(); }
});
