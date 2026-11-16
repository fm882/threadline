import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { Store } from '../src/persistence/store.ts';
import { researchClient } from '../src/research/research-client.ts';
import { loadCapabilities } from '../src/inference/capabilities.ts';
import { root, localKey } from './local-env.mjs';

// Live fast-route integration probe. The main-route 503 and search result are
// synthetic; only the fallback tool-call and prompted-JSON calls reach Bedrock.
const upstream = (process.env.INFERENCE_BASE_URL || 'http://127.0.0.1:4000/v1').replace(/\/$/, '');
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
if (!process.env.INFERENCE_API_KEY && !loopbackHosts.has(new URL(upstream).hostname)) {
  throw new Error('Remote endpoints require an explicit INFERENCE_API_KEY; the local master key is never sent remotely.');
}
const key = localKey();
const main = process.env.CHAT_MAIN_MODEL || 'chat-main-v1';
const fast = process.env.CHAT_FAST_MODEL || 'chat-fast-v1';
const route = process.env.BEDROCK_FAST_ROUTE || 'bedrock/converse/us.amazon.nova-micro-v1:0';
const capability = loadCapabilities(`${root}/config/model-capabilities.json`, main, fast, route);
if (!('manifest' in capability) || !capability.fallback) throw new Error('A live-verified fallback capability must be configured before this probe.');
const fallback = capability.fallback;
const report = { checkedAt: new Date().toISOString(), scope: 'Actual researchClient fallback path; simulated main-route 503 and synthetic search evidence; live fallback inference only.', route, fastAlias: fast, routes: [], usage: [], responsePreviews: [], syntheticSearchCalls: 0 };

const relay = createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  const request = JSON.parse(raw);
  report.routes.push(request.model);
  if (request.model === main) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Synthetic main-route outage for fallback verification.', type: 'server_error' } }));
    return;
  }
  if (request.model !== fast) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unexpected model alias.', type: 'invalid_request_error' } }));
    return;
  }
  const response = await fetch(`${upstream}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(65_000),
  });
  const body = await response.text();
  if (response.ok) {
    const parsed = JSON.parse(body);
    report.usage.push({ responseModel: parsed.model || null, ...parsed.usage });
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === 'string') report.responsePreviews.push(content.slice(0, 1200));
  }
  res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
  res.end(body);
});
relay.listen(0, '127.0.0.1');
await once(relay, 'listening');
const address = relay.address();
if (!address || typeof address === 'string') throw new Error('Could not bind the local fallback relay.');

const db = new PGlite();
const store = new Store(db);
await store.initialize();
const owner = 'live-fallback-check';
const conversation = await store.createConversation(owner);
const runId = await store.admit(owner, conversation, `live-fallback-${Date.now()}`, 'What is the current price for Northstar CRM?');
if (!await store.beginAttempt(owner, runId, 2, 60_000)) throw new Error('Could not begin the synthetic research run.');

try {
  const client = researchClient({
    baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-relay-test', model: main,
    searchKey: '', owner, runId, store, contextTokens: capability.manifest.chatMain.contextTokens,
    fallback,
    search: async () => {
      report.syntheticSearchCalls++;
      return [{ url: 'https://example.com/northstar-pricing', title: 'Synthetic Northstar pricing', excerpt: 'The fictional Northstar CRM Starter plan costs $19 per seat each month.', observedAt: new Date().toISOString(), provider: 'tavily', representation: 'search_snippet' }];
    },
  });
  const result = await client([{ role: 'user', content: 'What is the current price for Northstar CRM?' }], () => {}, AbortSignal.timeout(65_000));
  const budget = await store.researchBudget(owner, runId);
  assert.deepEqual(report.routes, [main, fast, fast]);
  assert.equal(report.syntheticSearchCalls, 1);
  assert.equal(budget.model_calls, 3);
  assert.equal(budget.search_queries, 1);
  assert.ok(result.claims.some(claim => claim.evidenceIds.length > 0));
  report.result = { schemaValidated: true, claims: result.claims.length, citedClaims: result.claims.filter(claim => claim.evidenceIds.length > 0).length };
  report.budget = { modelCalls: budget.model_calls, searchQueries: budget.search_queries, promptBytes: budget.prompt_bytes };
  report.passed = true;
} catch (error) {
  const message = String(error?.message || error).replaceAll(key, '[redacted]').replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-access-key]').replace(/\b\d{12}\b/g, '[account]').slice(0, 1200);
  report.passed = false;
  report.error = message;
  throw error;
} finally {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(`${root}/.data`, { recursive: true, mode: 0o700 });
  writeFileSync(`${root}/.data/live-fallback-integration-${Date.now()}.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await new Promise(resolve => relay.close(resolve));
  await db.close();
}
console.log(`PASS live application fallback integration (${report.routes.join(' -> ')})`);
