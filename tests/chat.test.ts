import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from '../src/persistence/store.js';
import { createChatRunner } from '../src/research/chat.js';

it('executes a checkpointed turn with a bounded authorized history and publishes once', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const chunks: string[] = [];
    const runChat = createChatRunner(store, SqliteSaver.fromConnString(':memory:'), async (messages, chunk) => {
      expect(messages.map(m => m.content)).toEqual(['hello']);
      chunk('hi'); return 'hi';
    }, (_, chunk) => chunks.push(chunk));
    const run = await store.admit('alice', conversation, 'one', 'hello');
    await runChat('alice', run);
    await runChat('alice', run);
    expect(chunks).toEqual(['hi']);
    expect((await store.getRun('alice', run)).status).toBe('completed');
    expect((await store.messages('alice', conversation)).map(m => m.content)).toEqual(['hello', 'hi']);
  } finally { await db.close(); }
});

it('publishes a safe failure without exposing provider details', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'one', 'hello');
    await createChatRunner(store, SqliteSaver.fromConnString(':memory:'), async () => { throw new Error('secret credential'); })('alice', run);
    const result = await store.getRun('alice', run);
    expect(result.status).toBe('failed');
    expect(result.error).not.toContain('secret');
  } finally { await db.close(); }
});

it('omits failed turns and includes completed history before the fixed cutoff', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const first = await store.admit('alice', conversation, '1', 'first');
    await store.publish('alice', first, 'first answer');
    const failed = await store.admit('alice', conversation, '2', 'failed question');
    await store.fail('alice', failed, 'failed');
    const current = await store.admit('alice', conversation, '3', 'current');
    const run = createChatRunner(store, SqliteSaver.fromConnString(':memory:'), async messages => {
      expect(messages.map(m => m.content)).toEqual(['first', 'first answer', 'current']);
      return 'done';
    });
    await run('alice', current);
    expect((await store.getRun('alice', current)).status).toBe('completed');
  } finally { await db.close(); }
});

it('emits redacted lifecycle metadata and ignores exporter failures', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'trace', 'private input');
    let traceText = '';
    const runner = createChatRunner(store, SqliteSaver.fromConnString(':memory:'), async () => 'private output', () => {}, async trace => {
      traceText = JSON.stringify(trace);
      throw new Error('export failure');
    });
    await runner('alice', run);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await store.getRun('alice', run)).status).toBe('completed');
    expect(traceText).toContain('admission');
    expect(traceText).toContain('inference');
    expect(traceText).toContain('publication');
    expect(traceText).not.toContain('private');
  } finally { await db.close(); }
});
