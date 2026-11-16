import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from '../src/persistence/store.js';
import { createChatRunner } from '../src/research/chat.js';
import { createApp } from '../src/api/app.js';

it('resolves an explicit cross-conversation shortlist and gives only original-backed context to the graph', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const source = await store.createConversation('alice');
    const sourceRun = await store.admit('alice', source, 'source', 'We shortlisted five CRM tools for a 20-person sales team.');
    await db.query("UPDATE messages SET created_at = '2026-06-08T12:00:00Z' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [sourceRun]);
    await store.publish('alice', sourceRun, 'The shortlist is HubSpot, Salesforce, Pipedrive, Zoho CRM, and Freshsales.');
    const current = await store.createConversation('alice');
    const decoy = await store.admit('alice', current, 'decoy', 'We compared five CRM tools for a 20-person sales team.');
    await db.query("UPDATE messages SET created_at = '2026-06-09T12:00:00Z' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [decoy]);
    await store.publish('alice', decoy, 'A competing discussion mentioned a different shortlist.');
    const run = await store.admit('alice', current, 'followup', 'On 8 June 2026 we shortlisted five CRM tools for a 20-person sales team. Has pricing changed since last Tuesday?');
    await db.query("UPDATE runs SET created_at = '2026-06-10T12:00:00Z' WHERE id = $1", [run]);
    let received: { role: string; content: string }[] = [];
    await createChatRunner(store, saver, async messages => { received = messages; return 'I will evaluate the original five products.'; })('alice', run);
    expect(received.at(-1)?.content).toContain('Has pricing changed since last Tuesday');
    const context = received.find(message => message.role === 'system')?.content || '';
    expect(context).toContain('The shortlist is HubSpot, Salesforce, Pipedrive, Zoho CRM, and Freshsales.');
    expect(context).toContain('We shortlisted five CRM tools for a 20-person sales team.');
    expect(context).toContain('discussion date 2026-06-08');
    expect(context).toContain('comparison interval anchor 2026-06-09');
    expect(context).toContain('Coverage: complete');
    expect(context).toContain('Source conversation: We shortlisted five CRM tools');
    expect(context).not.toMatch(/score|rank|vector/i);
    const answer = (await store.messages('alice', current)).at(-1)!.content;
    const referenceId = /\[reference:([a-f0-9-]+)\]/.exec(answer)?.[1];
    expect(referenceId).toBeTruthy();
    const app = createApp({ store, owner: request => request.headers.get('x-owner') || 'alice', ready: () => null, run: async () => {} });
    const page = await (await app.request(`/api/references/${referenceId}`)).json();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ conversation_id: source, conversation_title: 'We shortlisted five CRM tools for a 20-person sales team.', answer: 'The shortlist is HubSpot, Salesforce, Pipedrive, Zoho CRM, and Freshsales.' });
    expect((await app.request(`/api/references/${referenceId}`, { headers: { 'x-owner': 'bob' } })).status).toBe(404);
  } finally { saver.db.close(); await db.close(); }
});

it('publishes a visible context limitation instead of sending an oversized original to the model', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const source = await store.createConversation('alice');
    const original = await store.admit('alice', source, 'large-source', 'We shortlisted CRM products.');
    await store.publish('alice', original, `Original source record: ${'product evidence '.repeat(300)}`);
    const current = await store.createConversation('alice');
    const run = await store.admit('alice', current, 'bounded-query', 'What were the CRM products we shortlisted before?');
    let modelCalls = 0;
    await createChatRunner(store, saver, async () => { modelCalls++; return 'unsupported answer'; }, () => {}, undefined, 60_000, undefined, 4000)('alice', run);
    expect(modelCalls).toBe(0);
    expect((await store.messages('alice', current)).at(-1)?.content).toContain('exceed the configured context limit');
  } finally { saver.db.close(); await db.close(); }
});

it('clarifies competing discussions and resolves the user choice in the next authorized turn', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const firstConversation = await store.createConversation('alice');
    const first = await store.admit('alice', firstConversation, 'first', 'We discussed five CRM tools for a small team.');
    await store.publish('alice', first, 'HubSpot, Salesforce, Pipedrive, Zoho CRM, and Freshsales.');
    const secondConversation = await store.createConversation('alice');
    const second = await store.admit('alice', secondConversation, 'second', 'We discussed five CRM tools for a larger team.');
    await store.publish('alice', second, 'Salesforce, HubSpot, Zoho CRM, Pipedrive, and Freshsales.');
    const current = await store.createConversation('alice');
    const clarification = await store.admit('alice', current, 'reference', 'What about those five CRM tools?');
    await createChatRunner(store, saver, async () => { throw new Error('Clarification should not call the model'); })('alice', clarification);
    const clarificationMessage = (await store.messages('alice', current)).at(-1)!;
    expect(clarificationMessage.content).toContain('Which one should I use?');
    const clarificationId = /\[reference:([a-f0-9-]+)\]/.exec(clarificationMessage.content)?.[1];
    expect(clarificationId).toBeTruthy();
    const clarificationPage = await store.referenceSnapshot('alice', clarificationId!);
    expect(clarificationPage.status).toBe('clarification_needed');
    expect(clarificationPage.items).toHaveLength(2);

    const choice = await store.admit('alice', current, 'choice', 'Use option 2');
    let selectedContext = '';
    await createChatRunner(store, saver, async messages => { selectedContext = messages.find(message => message.role === 'system')?.content || ''; return 'Using the larger-team shortlist.'; })('alice', choice);
    expect(selectedContext).toContain('Source conversation: We discussed five CRM tools for a small team.');
    expect(selectedContext).toContain('HubSpot, Salesforce, Pipedrive, Zoho CRM, and Freshsales.');
    const resolvedMessage = (await store.messages('alice', current)).at(-1)!;
    const resolvedId = /\[reference:([a-f0-9-]+)\]/.exec(resolvedMessage.content)?.[1];
    expect(resolvedId).toBeTruthy();
    expect((await store.referenceSnapshot('alice', resolvedId!)).items.map(item => item.conversation_id)).toEqual([firstConversation]);
  } finally { saver.db.close(); await db.close(); }
});

it('prefers a clear current-conversation match when no explicit date points elsewhere', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const current = await store.createConversation('alice');
    const local = await store.admit('alice', current, 'local', 'We compared CRM systems for this team.');
    await store.publish('alice', local, 'Local conversation shortlist.');
    const other = await store.createConversation('alice');
    const elsewhere = await store.admit('alice', other, 'other', 'We compared CRM systems for another team.');
    await store.publish('alice', elsewhere, 'Other conversation shortlist.');
    const run = await store.admit('alice', current, 'followup', 'What about those CRM systems?');
    let context = '';
    await createChatRunner(store, saver, async messages => { context = messages.find(message => message.role === 'system')?.content || ''; return 'Using the current discussion.'; })('alice', run);
    expect(context).toContain('Source conversation: We compared CRM systems for this team.');
    expect(context).toContain('Local conversation shortlist.');
    expect(context).not.toContain('Other conversation shortlist.');
  } finally { saver.db.close(); await db.close(); }
});

it('does not search history for unrelated questions and reports discovery failures as incomplete', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const ordinary = await store.admit('alice', conversation, 'ordinary', 'What is the current population of Delhi?');
    let calls = 0;
    const search = store.findReferenceCandidates.bind(store);
    store.findReferenceCandidates = async (...args) => { calls++; return search(...args); };
    await createChatRunner(store, saver, async () => 'Population answer.')('alice', ordinary);
    expect(calls).toBe(0);

    const missing = await store.admit('alice', conversation, 'missing', 'What did we decide in the earlier CRM shortlist?');
    await createChatRunner(store, saver, async () => { throw new Error('A confirmed no-match must not call the model'); })('alice', missing);
    expect((await store.messages('alice', conversation)).at(-1)!.content).toContain('could not find a matching earlier discussion');
    expect((await store.messages('alice', conversation)).at(-1)!.content).not.toContain('could not search the retained history completely');

    const reference = await store.admit('alice', conversation, 'reference', 'What about that CRM shortlist?');
    store.findReferenceCandidates = async () => { throw new Error('private retrieval failure'); };
    await createChatRunner(store, saver, async () => { throw new Error('Incomplete retrieval must not call the model'); })('alice', reference);
    expect((await store.messages('alice', conversation)).at(-1)!.content).toContain('could not search the retained history completely');
    expect((await store.messages('alice', conversation)).at(-1)!.content).not.toContain('private retrieval failure');
  } finally { saver.db.close(); await db.close(); }
});

it('caps original-record discovery and reports truncated candidate coverage without looping or claiming absence', async () => {
  const db = new PGlite(); const saver = SqliteSaver.fromConnString(':memory:');
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    await db.query(`INSERT INTO turns (id, conversation_id, owner_id, idempotency_key, payload_hash, input, status)
      SELECT 'bulk-' || n, $1, 'alice', 'bulk-key-' || n, 'hash', 'We discussed CRM tools ' || n, 'completed' FROM generate_series(1, 205) n`, [conversation]);
    await db.query(`INSERT INTO messages (id, conversation_id, owner_id, turn_id, role, content, ordinal, created_at)
      SELECT 'bulk-message-' || n, $1, 'alice', 'bulk-' || n, 'user', 'We discussed CRM tools ' || n, n,
        '2025-01-01T00:00:00Z'::timestamptz + n * interval '1 day' FROM generate_series(1, 205) n`, [conversation]);
    await db.query("INSERT INTO owner_sequences (owner_id, value) VALUES ('alice', 205)");
    const run = await store.admit('alice', conversation, 'bounded', 'What about that CRM shortlist?');
    let searches = 0;
    const search = store.findReferenceCandidates.bind(store);
    store.findReferenceCandidates = async (...args) => { searches++; return search(...args); };
    let modelCalls = 0;
    await createChatRunner(store, saver, async () => { modelCalls++; return 'unknown'; })('alice', run);
    expect(searches).toBe(1);
    expect(modelCalls).toBe(0);
    const answer = (await store.messages('alice', conversation, 205)).at(-1)!.content;
    expect(answer).toContain('could not search the retained history completely');
    expect(answer).not.toContain('could not find a matching');
  } finally { saver.db.close(); await db.close(); }
});
