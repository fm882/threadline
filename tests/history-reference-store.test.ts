import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { NotFound, Store } from '../src/persistence/store.js';

it('finds and hydrates the original shortlist by owner, cutoff, date, title, and exact source records', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const source = await store.createConversation('alice');
    const original = await store.admit('alice', source, 'shortlist', 'We shortlisted five CRM tools for a 20-person sales team.');
    await db.query("UPDATE messages SET created_at = '2026-06-08T12:00:00Z' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [original]);
    await store.publish('alice', original, 'The five are HubSpot, Salesforce, Pipedrive, Zoho CRM, and Freshsales.');
    const later = await store.createConversation('alice');
    const decoy = await store.admit('alice', later, 'decoy', 'We compared CRM sales tools for 20 people.');
    await db.query("UPDATE messages SET created_at = '2026-06-09T12:00:00Z' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [decoy]);
    await store.publish('alice', decoy, 'HubSpot and Salesforce are under review.');
    const current = await store.createConversation('alice');
    const run = await store.admit('alice', current, 'question', 'On Monday we shortlisted five CRM tools for a 20-person sales team.');
    const found = await store.findReferenceCandidates('alice', run, ['crm', 'sales', 'person'], '2026-06-08');
    expect(found.truncated).toBe(false);
    expect(found.candidates).toHaveLength(1);
    expect(found.candidates[0]).toMatchObject({ id: expect.any(String), conversation_id: source, conversation_title: 'We shortlisted five CRM tools for a 20-person sales team.', answer: 'The five are HubSpot, Salesforce, Pipedrive, Zoho CRM, and Freshsales.' });
    const snapshot = await store.saveReferenceSnapshot('alice', run, 'resolved', 'complete', '2026-06-08', '2026-06-09', found.candidates);
    const page = await store.referenceSnapshot('alice', snapshot);
    expect(page.status).toBe('resolved');
    expect(page.items).toHaveLength(1);
    expect(page.items[0].content).toBe('We shortlisted five CRM tools for a 20-person sales team.');
    expect(page.items[0].answer).toContain('Freshsales');
    await expect(store.referenceSnapshot('bob', snapshot)).rejects.toBeInstanceOf(NotFound);
    await db.query("UPDATE messages SET content = 'changed' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'assistant'", [original]);
    expect((await store.referenceSnapshot('alice', snapshot)).coverage).toBe('incomplete');
  } finally { await db.close(); }
});

it('saves competing original conversations as choices and resolves only the latest clarification', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const current = await store.createConversation('alice');
    const firstSource = await store.createConversation('alice');
    const first = await store.admit('alice', firstSource, 'first', 'We discussed five CRM tools for a small team.');
    await store.publish('alice', first, 'HubSpot, Salesforce, Pipedrive, Zoho CRM, and Freshsales.');
    const secondSource = await store.createConversation('alice');
    const second = await store.admit('alice', secondSource, 'second', 'We discussed five CRM tools for a larger team.');
    await store.publish('alice', second, 'Salesforce, HubSpot, Zoho CRM, Pipedrive, and Freshsales.');
    const clarification = await store.admit('alice', current, 'clarify', 'What about those five CRM tools?');
    const snapshot = await store.saveReferenceSnapshot('alice', clarification, 'clarification_needed', 'complete', null, null, [
      { id: (await store.messages('alice', firstSource))[0].id, conversation_id: firstSource, conversation_title: 'First', content: 'We discussed five CRM tools for a small team.', answer: 'first list', answer_id: null, answer_ordinal: null, answer_created_at: null, ordinal: 1, created_at: new Date(), score: 4 },
      { id: (await store.messages('alice', secondSource))[0].id, conversation_id: secondSource, conversation_title: 'Second', content: 'We discussed five CRM tools for a larger team.', answer: 'second list', answer_id: null, answer_ordinal: null, answer_created_at: null, ordinal: 3, created_at: new Date(), score: 4 },
    ]);
    await store.publish('alice', clarification, `Which one did you mean? [reference:${snapshot}]`);
    const choiceRun = await store.admit('alice', current, 'choice', 'Use option 2');
    expect(await store.pendingReferenceSnapshot('alice', choiceRun)).toBe(snapshot);
    const resolved = await store.saveReferenceChoice('alice', choiceRun, snapshot, 2);
    expect((await store.referenceSnapshot('alice', resolved)).items.map(item => item.conversation_id)).toEqual([secondSource]);
    expect(await store.pendingReferenceSnapshot('alice', clarification)).toBeNull();
  } finally { await db.close(); }
});
