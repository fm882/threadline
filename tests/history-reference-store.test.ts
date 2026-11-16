import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotFound, Store } from '../src/persistence/store.js';
import { historicalContextPrompt } from '../src/history/context.js';

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

it('hydrates the evidence attached to a historical answer without treating it as current evidence', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const originalConversation = await store.createConversation('alice');
    const originalRun = await store.admit('alice', originalConversation, 'priced', 'What did we find about Acme pricing?');
    const [source] = await store.registerEvidence('alice', originalRun, [{ url: 'https://example.com/old-pricing', title: 'Acme pricing page', excerpt: 'Team plan: $20 per seat monthly.', observedAt: '2026-06-01T12:00:00Z', provider: 'tavily', representation: 'search_snippet' }]);
    await store.publish('alice', originalRun, 'Acme Team was $20 per seat monthly.', [{ claim: 'Acme Team was $20 per seat monthly.', evidenceIds: [source.id] }]);
    const followupConversation = await store.createConversation('alice');
    const followupRun = await store.admit('alice', followupConversation, 'compare', 'Is the Acme pricing still the same?');
    const candidate = (await store.findReferenceCandidates('alice', followupRun, ['acme', 'pricing'], null)).candidates[0];
    expect(candidate).toBeTruthy();
    const snapshotId = await store.saveReferenceSnapshot('alice', followupRun, 'resolved', 'complete', null, null, [candidate]);
    const snapshot = await store.referenceSnapshot('alice', snapshotId);
    expect(snapshot.items[0].historical_claims).toEqual([{ claim: 'Acme Team was $20 per seat monthly.', evidence: [{ id: source.id, title: 'Acme pricing page', url: 'https://example.com/old-pricing', excerpt: 'Team plan: $20 per seat monthly.', observed_at: expect.any(Date) }] }]);
    expect(snapshot.items[0].historical_claims[0].evidence[0].observed_at.toISOString()).toBe('2026-06-01T12:00:00.000Z');
    await db.query("UPDATE evidence_observations SET excerpt = 'Changed after snapshot' WHERE id = $1", [source.id]);
    expect((await store.referenceSnapshot('alice', snapshotId)).coverage).toBe('incomplete');
  } finally { await db.close(); }
});

it('appends a correction to the referenced answer and returns it with the unchanged original', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const originalConversation = await store.createConversation('alice');
    const originalRun = await store.admit('alice', originalConversation, 'original', 'What did Acme charge in June?');
    await db.query("UPDATE messages SET created_at = '2026-06-01T12:00:00Z' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [originalRun]);
    const [oldSource] = await store.registerEvidence('alice', originalRun, [{ url: 'https://example.com/old', title: 'Old page', excerpt: 'Acme Basic costs $10 monthly.', observedAt: '2026-06-01T00:00:00Z', provider: 'tavily', representation: 'search_snippet' }]);
    const originalAnswer = 'Acme Basic cost $10 monthly.';
    await store.publish('alice', originalRun, originalAnswer, [{ claim: originalAnswer, evidenceIds: [oldSource.id] }]);
    const comparisonConversation = await store.createConversation('alice');
    const comparisonRun = await store.admit('alice', comparisonConversation, 'check', 'Is the old Acme price correct?');
    const candidate = (await store.findReferenceCandidates('alice', comparisonRun, ['acme', 'charge', 'june'], null)).candidates[0];
    const referenceId = await store.saveReferenceSnapshot('alice', comparisonRun, 'resolved', 'complete', null, null, [candidate]);
    const [currentSource] = await store.registerEvidence('alice', comparisonRun, [{ url: 'https://example.com/june', title: 'Dated June page', excerpt: 'The June 2026 price for Acme Basic was $15 monthly.', observedAt: '2026-07-01T00:00:00Z', provider: 'tavily', representation: 'search_snippet' }]);
    const correction = 'Correction: a dated June 2026 source shows Acme Basic was $15 monthly; the earlier $10 answer was incorrect.';
    const dimensions = { plan: 'Basic', currency: 'USD', billingPeriod: 'monthly', seats: 1, region: 'US', taxBasis: 'before tax' };
    await store.publish('alice', comparisonRun, `${correction} [reference:${referenceId}]`, [], [{ subject: 'Acme Basic', attribute: 'price', outcome: 'prior_error', statement: correction, evidenceIds: [currentSource.id], baselineOrigin: 'stored_evidence', baselineStatement: 'Stored June 2026 pricing source.', historicalEvidenceIds: [oldSource.id], priorDimensions: dimensions, currentDimensions: dimensions }]);
    const nextRun = await store.admit('alice', comparisonConversation, 'next', 'Revisit the old Acme price');
    const nextCandidate = (await store.findReferenceCandidates('alice', nextRun, ['acme', 'charge'], '2026-06-01')).candidates[0];
    const nextSnapshotId = await store.saveReferenceSnapshot('alice', nextRun, 'resolved', 'complete', '2026-06-01', null, [nextCandidate]);
    const next = await store.referenceSnapshot('alice', nextSnapshotId);
    expect(next.items[0].answer).toBe(originalAnswer);
    expect(next.items[0].historical_claims[0].evidence[0].id).toBe(oldSource.id);
    expect(next.items[0].corrections).toHaveLength(1);
    expect(next.items[0].corrections[0].correction).toBe(correction);
    const prompt = historicalContextPrompt({ ...next.items[0], score: 0 }, 'complete', '2026-06-01', null);
    expect(prompt).toContain('Original assistant response (preserve this wording as the recorded answer):');
    expect(prompt).toContain(originalAnswer);
    expect(prompt).toContain('Corrections appended later');
    expect(prompt).toContain(correction);
  } finally { await db.close(); }
});

it('rejects definitive price comparisons with missing or mismatched dimensions', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const sourceConversation = await store.createConversation('alice');
    const sourceRun = await store.admit('alice', sourceConversation, 'source', 'What was the Acme Basic price?');
    const [oldPrice] = await store.registerEvidence('alice', sourceRun, [{ url: 'https://example.com/old', title: 'Acme Basic 2026 pricing', excerpt: 'In June 2026, Acme Basic was USD 20 monthly.', observedAt: '2026-06-01T00:00:00Z', provider: 'tavily', representation: 'search_snippet' }]);
    await store.publish('alice', sourceRun, 'Acme Basic was $20 monthly.', [{ claim: 'Acme Basic was $20 monthly.', evidenceIds: [oldPrice.id] }]);
    const compareConversation = await store.createConversation('alice');
    const run = await store.admit('alice', compareConversation, 'compare', 'Has the Acme Basic price changed?');
    const candidate = (await store.findReferenceCandidates('alice', run, ['acme', 'basic', 'price'], null)).candidates[0];
    await store.saveReferenceSnapshot('alice', run, 'resolved', 'complete', null, null, [candidate]);
    const [current] = await store.registerEvidence('alice', run, [{ url: 'https://example.com/current', title: 'Current prices', excerpt: 'Acme Basic is $25 monthly.', observedAt: new Date().toISOString(), provider: 'tavily', representation: 'search_snippet' }]);
    const dimensions = { plan: 'Basic', currency: 'USD', billingPeriod: 'monthly', seats: 1, region: 'US', taxBasis: 'before tax' };
    await expect(store.publish('alice', run, 'Changed.', [], [{ subject: 'Acme Basic', attribute: 'price', outcome: 'supported_change', statement: 'Changed from 20 to 25.', evidenceIds: [current.id], baselineOrigin: 'stored_evidence', historicalEvidenceIds: [oldPrice.id], priorDimensions: dimensions, currentDimensions: { ...dimensions, billingPeriod: 'annual' } }])).rejects.toThrow('Definitive price comparisons require matching');
    await expect(store.publish('alice', run, 'Wrong before.', [], [{ subject: 'Acme Basic', attribute: 'price', outcome: 'prior_error', statement: 'The previous price was wrong.', evidenceIds: [current.id], baselineOrigin: 'stored_evidence', historicalEvidenceIds: [oldPrice.id], priorDimensions: dimensions, currentDimensions: dimensions }])).rejects.toThrow('requires evidence that identifies the historical period');
    expect((await store.getRun('alice', run)).status).toBe('active');
  } finally { await db.close(); }
});

it('accepts and records an explicitly attributed user quote without public-price attribution', async () => {
  const db = new PGlite();
  try {
    const store = new Store(db); await store.initialize();
    const conversation = await store.createConversation('alice');
    const quote = 'I was quoted USD 18 monthly for Acme Basic';
    const run = await store.admit('alice', conversation, 'quote', `${quote}; is the current price higher?`);
    const [current] = await store.registerEvidence('alice', run, [{ url: 'https://example.com/current', title: 'Acme Basic official price', excerpt: 'Acme Basic current price is USD 20 monthly.', observedAt: new Date().toISOString(), provider: 'tavily', representation: 'search_snippet' }]);
    const dimensions = { plan: 'Basic', currency: 'USD', billingPeriod: 'monthly', seats: 1, region: 'US', taxBasis: 'before tax' };
    await store.publish('alice', run, `Current price: USD 20. The user-reported quote was USD 18, not an independently verified public price. [source:${current.id}]`, [], [{ subject: 'Acme Basic', attribute: 'price', outcome: 'supported_change', statement: 'Current pricing is above the user-reported quote.', baselineOrigin: 'user_reported', baselineStatement: 'User-reported quote (not independently verified): I was quoted USD 18 monthly for Acme Basic', userQuote: quote, historicalEvidenceIds: [], evidenceIds: [current.id], priorDimensions: dimensions, currentDimensions: dimensions }]);
    const saved = await db.query<{ baseline_origin: string; user_quote: string; historical_evidence_ids: string }>('SELECT baseline_origin, user_quote, historical_evidence_ids FROM answer_comparisons WHERE run_id = $1', [run]);
    expect(saved.rows[0]).toMatchObject({ baseline_origin: 'user_reported', user_quote: quote, historical_evidence_ids: [] });
    expect((await store.messages('alice', conversation)).at(-1)?.citation_ids).toEqual([current.id]);
  } finally { await db.close(); }
});

it('reconstructs a baseline only from evidence text that explicitly identifies the earlier period', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'minmi-reconstructed-baseline-'));
  let db = new PGlite(join(dir, 'db'));
  try {
    const store = new Store(db); await store.initialize();
    const sourceConversation = await store.createConversation('alice');
    const sourceRun = await store.admit('alice', sourceConversation, 'old', 'What was Acme Basic pricing in June 2026?');
    await db.query("UPDATE messages SET created_at = '2026-06-01T12:00:00Z' WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [sourceRun]);
    await store.publish('alice', sourceRun, 'Acme Basic was USD 18 monthly.');
    const conversation = await store.createConversation('alice');
    const run = await store.admit('alice', conversation, 'reconstruct', 'Has Acme Basic pricing changed since the June 2026 discussion?');
    const candidate = (await store.findReferenceCandidates('alice', run, ['acme', 'basic', 'pricing'], '2026-06-01')).candidates[0];
    await store.saveReferenceSnapshot('alice', run, 'resolved', 'complete', '2026-06-01', null, [candidate]);
    const [current] = await store.registerEvidence('alice', run, [{ url: 'https://example.com/current', title: 'Acme Basic pricing', excerpt: 'Acme Basic currently costs USD 20 monthly.', observedAt: new Date().toISOString(), provider: 'tavily', representation: 'search_snippet' }]);
    const [historical] = await store.registerEvidence('alice', run, [{ url: 'https://example.com/archive', title: 'Acme Basic archive', excerpt: 'For June 2026, Acme Basic cost USD 18 monthly.', observedAt: new Date().toISOString(), provider: 'tavily', representation: 'search_snippet' }]);
    const dimensions = { plan: 'Basic', currency: 'USD', billingPeriod: 'monthly', seats: 1, region: 'US', taxBasis: 'before tax' };
    await expect(store.publish('alice', run, 'Rejected reconstruction.', [], [{ subject: 'Acme Basic', attribute: 'price', outcome: 'supported_change', statement: 'It changed.', baselineOrigin: 'reconstructed', baselineStatement: 'USD 18 monthly.', baselinePeriod: 'June 2026', historicalEvidenceIds: [current.id], evidenceIds: [current.id], priorDimensions: dimensions, currentDimensions: dimensions }])).rejects.toThrow('identify the stated historical period');
    expect(await store.publish('alice', run, 'Reconstructed baseline from the June 2026 dated source; the original answer had no attached evidence.', [], [{ subject: 'Acme Basic', attribute: 'price', outcome: 'supported_change', statement: 'The price increased relative to the reconstructed historical price.', baselineOrigin: 'reconstructed', baselineStatement: 'USD 18 monthly.', baselinePeriod: 'June 2026', historicalEvidenceIds: [historical.id], evidenceIds: [current.id], priorDimensions: dimensions, currentDimensions: dimensions }])).toBe(true);
    const saved = await db.query<{ baseline_origin: string; baseline_period: string }>('SELECT baseline_origin, baseline_period FROM answer_comparisons WHERE run_id = $1', [run]);
    expect(saved.rows).toEqual([{ baseline_origin: 'reconstructed', baseline_period: 'June 2026' }]);
    const snapshotId = (await db.query<{ id: string }>('SELECT id FROM reference_snapshots WHERE run_id = $1', [run])).rows[0].id;
    const sourceAgain = await store.referenceSnapshot('alice', snapshotId);
    expect(sourceAgain.items[0].historical_claims).toEqual([]);
    expect(sourceAgain.items[0].answer).toBe('Acme Basic was USD 18 monthly.');
    await db.close();
    db = new PGlite(join(dir, 'db'));
    const restarted = new Store(db); await restarted.initialize();
    const persisted = await restarted.referenceSnapshot('alice', snapshotId);
    expect(persisted.items[0].answer).toBe('Acme Basic was USD 18 monthly.');
    expect(persisted.items[0].historical_claims).toEqual([]);
    expect((await restarted.messages('alice', conversation)).at(-1)?.citation_ids).toContain(current.id);
    expect((await restarted.messages('alice', conversation)).at(-1)?.citation_ids).toContain(historical.id);
    const stored = await db.query<{ baseline_origin: string; baseline_period: string; baseline_statement: string }>('SELECT baseline_origin, baseline_period, baseline_statement FROM answer_comparisons WHERE run_id = $1', [run]);
    expect(stored.rows[0]).toMatchObject({ baseline_origin: 'reconstructed', baseline_period: 'June 2026' });
    expect(stored.rows[0].baseline_statement).toContain('June 2026');
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
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
