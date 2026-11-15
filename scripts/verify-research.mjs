// Bounded billable gateway check; search responses are synthetic and no web search is made.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { Store } from '../src/persistence/store.ts';
import { researchClient } from '../src/research/research-client.ts';

const db = new PGlite();
try {
  const store = new Store(db); await store.initialize();
  const conversation = await store.createConversation('synthetic');
  const runId = await store.admit('synthetic', conversation, 'check', 'What is the current fictional Acme service price? Search for it.');
  let searches = 0;
  const client = researchClient({ baseURL: 'http://127.0.0.1:4000/v1', apiKey: readFileSync('.data/litellm.key', 'utf8').trim(), model: 'chat-main-v1', searchKey: '', store, owner: 'synthetic', runId,
    search: async () => { searches++; return [{ url: 'https://example.com/', title: 'Synthetic Acme pricing', excerpt: 'The fictional Acme service costs $10 per month in the United States before tax for one seat.', observedAt: '2026-01-02T12:00:00Z', provider: 'tavily', representation: 'search_snippet' }]; } });
  const result = await client([{ role: 'user', content: 'What is the current fictional Acme service price? Search for it.' }], () => {}, AbortSignal.timeout(60000));
  if (typeof result === 'string' || searches !== 1 || !result.claims.length) throw new Error('Expected a searched, cited response');
  if (!await store.publish('synthetic', runId, result.content, result.claims)) throw new Error('Publication failed');
  console.log(JSON.stringify({ searches, claims: result.claims.length, citationValidated: true }));
} finally { await db.close(); }
