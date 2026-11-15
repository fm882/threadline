import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from '../src/persistence/store.js';
import { createApp } from '../src/api/app.js';
import { createChatRunner } from '../src/research/chat.js';

it('admits and publishes a checkpointed turn through the HTTP interface', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const run = createChatRunner(store, SqliteSaver.fromConnString(':memory:'), async messages => {
      expect(messages.map(m => m.content)).toEqual(['How are you?']);
      return 'Ready to help.';
    });
    const app = createApp({ store, owner: () => 'alice', ready: () => null, run });
    const conversation = (await (await app.request('/api/conversations', { method: 'POST' })).json()).id;
    const response = await app.request(`/api/conversations/${conversation}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'test' }, body: JSON.stringify({ input: 'How are you?' }) });
    expect(response.status).toBe(202);
    const { runId } = await response.json();
    const events = await (await app.request(`/api/runs/${runId}/events`)).text();
    expect(events).toContain('event: completed');
    expect((await (await app.request(`/api/runs/${runId}`)).json()).status).toBe('completed');
    expect((await (await app.request(`/api/conversations/${conversation}/messages`)).json()).messages.map((m: { content: string }) => m.content)).toEqual(['How are you?', 'Ready to help.']);
  } finally { await db.close(); }
});
