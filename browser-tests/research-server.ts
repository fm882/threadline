import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { createApp, chunks } from '../src/api/app.js';
import { Store } from '../src/persistence/store.js';
import { createChatRunner } from '../src/research/chat.js';
import { researchClient } from '../src/research/research-client.js';
import { createHybridHistoryRetriever, processIndexJob } from '../src/history/index.js';
import { gatewayConfig } from '../src/inference/readiness.js';
import { tavilySearch } from '../src/search/tavily.js';
import type { ChatMessage } from '../src/research/chat.js';

const dir = process.env.APP_DATA_DIR!;
const scenarioFixtures = process.env.MINMI_ASSIGNMENT_FIXTURES === '1';
const liveAssignments = process.env.MINMI_LIVE_ASSIGNMENTS === '1';
const liveConfig = liveAssignments ? gatewayConfig(process.env) : null;
if (liveAssignments && liveConfig?.error) throw new Error(liveConfig.error);
if (liveAssignments && !process.env.TAVILY_API_KEY) throw new Error('TAVILY_API_KEY is required for live assignment evaluation.');
const liveRuns: object[] = liveAssignments
  ? (() => { try { return JSON.parse(readFileSync(join(dir, 'live-evaluation-runs.json'), 'utf8')) as object[]; } catch { return []; } })()
  : [];
const db = new PGlite(join(dir, 'app-db'));
const store = new Store(db); await store.initialize();
const space = await store.createEmbeddingGeneration({ id: 'browser-fixture-space', model: 'fixture-embed-v1', dimensions: 3, normalized: true, queryMode: 'shared', documentMode: 'shared', chunkingVersion: 'exchange-v1' });
if (scenarioFixtures) {
  async function seedDatedConversation(key: string, title: string, question: string, answer: string, createdAt: Date) {
    const conversation = await store.createConversation('local-development-user');
    await db.query('UPDATE conversations SET title = $2 WHERE id = $1', [conversation, title]);
    const run = await store.admit('local-development-user', conversation, key, question);
    await store.publish('local-development-user', run, answer);
    await db.query("UPDATE messages SET created_at = $2 WHERE turn_id = (SELECT turn_id FROM runs WHERE id = $1) AND role = 'user'", [run, createdAt]);
  }
  const now = new Date();
  const monday = new Date(now); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7 || 7)); monday.setHours(12, 0, 0, 0);
  const lastTuesday = new Date(now); lastTuesday.setDate(lastTuesday.getDate() - ((lastTuesday.getDay() - 2 + 7) % 7 || 7)); lastTuesday.setHours(12, 0, 0, 0);
  await seedDatedConversation('assignment-crm-shortlist', 'CRM shortlist for a 20-person sales team', 'On Monday we shortlisted 5 CRM tools for a 20-person sales team.', 'The shortlist was Acme CRM, Northstar CRM, Copper CRM, Folk CRM, and Twenty CRM.', monday);
  await seedDatedConversation('assignment-november-question', 'Question from 3 November 2026', 'Which Postgres host should I use for a hobby application: Neon or Supabase?', 'I recommended Neon Launch at USD 19 monthly and Supabase Pro at USD 25 monthly. No source observations were attached to that answer.', new Date('2026-11-03T12:00:00'));
  await seedDatedConversation('assignment-postgres-tuesday', 'Postgres hosting from last Tuesday', 'Can you compare Neon Launch and Supabase Pro for a small hobby application?', 'Neon Launch was USD 19 monthly and Supabase Pro was USD 25 monthly. No source observations were attached to that answer.', lastTuesday);
} else {
  const sourceConversation = await store.createConversation('local-development-user');
  const sourceRun = await store.admit('local-development-user', sourceConversation, 'browser-history-source', 'CRM shortlist for a nonprofit');
  await store.publish('local-development-user', sourceRun, 'We compared Acme CRM and Northstar CRM for the nonprofit.');
}
const fixtureVector = (text: string) => /nonprofit|customer relationship|crm|sales team|shortlist/i.test(text) ? [1, 0, 0] : /postgres|neon|supabase|hobby application/i.test(text) ? [0, 1, 0] : [0, 0, 1];
for (const job of await store.pendingIndexJobs(10, space)) await processIndexJob(store, job, space, async inputs => inputs.map(fixtureVector));
const historyRetriever = createHybridHistoryRetriever(store, space, { embed: async inputs => inputs.map(fixtureVector), rerank: async (_query, documents) => documents.map((_, index) => index) });
const saver = SqliteSaver.fromConnString(join(dir, 'checkpoints.sqlite'));
const run = async (owner: string, runId: string) => {
  const record = await store.getRun(owner, runId);
  const input = await store.runInput(owner, runId);
  if (record.parent_run_id) {
    await createChatRunner(store, saver, async () => 'Continuation completed with a fresh time limit.', (id, chunk) => chunks.emit(id, chunk))(owner, runId);
    return;
  }
  const deadlineFixture = input.includes('[deadline fixture]');
  if (deadlineFixture) {
    await store.beginAttempt(owner, runId, 2, 3_000);
    await store.setRequestedSubjects(owner, runId, ['Acme CRM', 'Northstar CRM']);
    const searchId = await store.startSearch(owner, runId, 'Acme CRM pricing');
    await store.finishSearch(owner, runId, searchId, 'completed');
    await store.registerEvidence(owner, runId, [{ url: 'https://example.com/acme', title: 'Acme CRM pricing', excerpt: 'Acme CRM Growth costs USD 12 per seat monthly before tax.', observedAt: new Date().toISOString(), provider: 'tavily', representation: 'search_snippet' }], searchId);
  }
  const fixtureSearch = async (query: string) => {
      const observedAt = new Date().toISOString();
      if (scenarioFixtures) {
        const items = /postgres|neon|supabase/i.test(query)
          ? [['Neon Launch', 'Neon Launch costs USD 19 monthly for one hobby project in the United States, before tax.'], ['Supabase Pro', 'Supabase Pro costs USD 25 monthly for one hobby project in the United States, before tax.']]
          : [['Acme CRM', 'Acme CRM Growth costs USD 12 per seat monthly before tax. Its release notes announce workflow automation for sales teams.'], ['Northstar CRM', 'Northstar CRM Team costs USD 18 per seat monthly before tax. Its release notes announce sales forecasting.'], ['Copper CRM', 'Copper CRM Basic costs USD 20 per seat monthly before tax. Its release notes announce contact enrichment.'], ['Folk CRM', 'Folk CRM Standard costs USD 24 per seat monthly before tax. Its release notes announce shared pipelines.'], ['Twenty CRM', 'Twenty CRM Team costs USD 15 per seat monthly before tax. Its release notes announce workflow improvements.']];
        return items.map(([title, excerpt], index) => ({ url: `https://example.com/assignment/${index}`, title, excerpt, observedAt, provider: 'tavily' as const, representation: 'search_snippet' as const }));
      }
      return [{ url: 'https://example.com/', title: 'Acme Basic official pricing', excerpt: 'Acme Basic plan is USD 12 per seat monthly for US customers, before tax. <img src=x onerror=alert(1)> [bad](javascript:alert(1))', observedAt, provider: 'tavily', representation: 'search_snippet' }];
    };
  const client = researchClient({ baseURL: liveConfig?.base || process.env.INFERENCE_BASE_URL!, apiKey: liveConfig?.key || 'fixture', model: liveConfig?.model || 'chat-main-v1', searchKey: process.env.TAVILY_API_KEY || 'fixture', owner, runId, store, verifyCurrent: record.verify_current,
    contextTokens: liveConfig?.contextTokens, fallback: liveConfig?.fallback,
    search: liveAssignments ? tavilySearch(process.env.TAVILY_API_KEY!) : fixtureSearch });
  const scriptedClient = async (messages: ChatMessage[], onChunk: (chunk: string) => void, signal: AbortSignal) => {
    const historyContext = messages.find(message => message.role === 'system' && message.content.includes('Authorized historical context'));
    const userMessage = messages.filter(message => message.role === 'user').at(-1)?.content || '';
    if (userMessage.includes('[deadline fixture]')) return new Promise<string>(() => {});
    if (historyContext && /customer relationship/i.test(userMessage)) { signal.throwIfAborted(); const answer = 'We previously compared Acme CRM and Northstar CRM for the nonprofit.'; onChunk(answer); return answer; }
    return client(messages, onChunk, signal);
  };
  await createChatRunner(store, saver, scriptedClient, (id, chunk) => chunks.emit(id, chunk), undefined, 60_000, historyRetriever, liveConfig?.contextTokens, liveConfig?.maxOutputTokens)(owner, runId);
  if (liveAssignments) {
    const result = await store.getRun(owner, runId);
    const budget = await store.researchBudget(owner, runId);
    const messages = await store.messages(owner, result.conversation_id);
    const finalMessage = messages.filter(message => message.run_id === runId && message.role === 'assistant').at(-1);
    const evidence = await store.evidenceForRun(owner, runId);
    const searches = await db.query<{ query: string; status: string; created_at: Date }>('SELECT query, status, created_at FROM search_queries WHERE run_id = $1 ORDER BY created_at', [runId]);
    const comparisons = await db.query('SELECT subject, attribute, outcome, statement, evidence_ids, prior_dimensions, current_dimensions, baseline_origin, baseline_statement, baseline_period, historical_evidence_ids FROM answer_comparisons WHERE run_id = $1 ORDER BY created_at', [runId]);
    const claims = await db.query(`SELECT ac.claim, COALESCE(jsonb_agg(ce.evidence_id) FILTER (WHERE ce.evidence_id IS NOT NULL), '[]'::jsonb) AS evidence_ids
      FROM answer_claims ac LEFT JOIN claim_evidence ce ON ce.claim_id = ac.id WHERE ac.run_id = $1 GROUP BY ac.id ORDER BY ac.id`, [runId]);
    liveRuns.push({
      runId, status: result.status, requestedSubjects: budget.requested_subjects,
      modelCalls: budget.model_calls, searchQueries: budget.search_queries, promptBytes: budget.prompt_bytes,
      startedAt: result.created_at, finishedAt: new Date().toISOString(),
      answerLength: finalMessage?.content.length || 0, citationCount: finalMessage?.citation_ids?.length || 0,
      answer: finalMessage?.content || '',
      searches: searches.rows.map(item => ({ query: item.query, status: item.status, createdAt: item.created_at, provider: 'tavily', depth: 'basic', cacheStatus: 'bypassed' })),
      claims: claims.rows,
      comparisons: comparisons.rows,
      evidence: evidence.map(item => ({ id: item.id, title: item.title, url: item.url, excerpt: item.excerpt.slice(0, 600), observedAt: item.observed_at, provider: item.provider, representation: item.representation })),
    });
    writeFileSync(join(dir, 'live-evaluation-runs.json'), `${JSON.stringify(liveRuns, null, 2)}\n`, { mode: 0o600 });
  }
};
const app = createApp({ store, owner: () => 'local-development-user', ready: () => null, run });
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT || 3000), hostname: '127.0.0.1' });
const shutdown = () => server.close(() => { void db.close().finally(() => process.exit(0)); });
process.on('SIGTERM', shutdown);
