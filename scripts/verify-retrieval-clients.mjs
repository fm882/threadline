import assert from 'node:assert/strict';
import { gatewayConfig } from '../src/inference/readiness.ts';
import { createEmbeddingClient, createRerankClient, vectorSpaceConfig } from '../src/inference/retrieval.ts';

if (process.env.ENV_FILE !== 'false' && (await import('node:fs')).existsSync('.env')) process.loadEnvFile('.env');
const gateway = gatewayConfig(process.env);
if (gateway.error) throw new Error('Configure the local inference gateway before running this synthetic integration check.');
const space = vectorSpaceConfig(process.env);
const embed = createEmbeddingClient({ base: gateway.base, key: gateway.key, model: space.model, dimensions: space.dimensions, normalized: space.normalized, queryMode: space.queryMode, documentMode: space.documentMode });
const vectors = await embed(['A CRM subscription costs twenty dollars per seat monthly.', 'A cat is sleeping on a sofa.'], 'document');
assert.equal(vectors.length, 2);
assert.ok(vectors[0].some((value, index) => value !== vectors[1][index]));
const embeddingResult = { passed: true, dimensions: vectors.map(vector => vector.length) };
const rerankUrl = process.env.RERANK_URL || new URL('/rerank', gateway.base).href;
const rerank = createRerankClient({ url: rerankUrl, key: process.env.RERANK_API_KEY || gateway.key, model: process.env.RERANK_MODEL || 'history-rerank-v1' });
try {
  const order = await rerank('What is the monthly CRM subscription price?', ['The CRM plan costs twenty dollars per seat per month.', 'A cat is sleeping on a sofa.']);
  assert.equal(order[0], 0);
  console.log(JSON.stringify({ embedding: embeddingResult, rerank: { passed: true, topIndex: order[0] }, data: 'synthetic only' }));
} catch (error) {
  const message = error instanceof Error && /HTTP \d+/.test(error.message) ? error.message : 'Rerank request or response validation failed.';
  console.log(JSON.stringify({ embedding: embeddingResult, rerank: { passed: false, error: message }, data: 'synthetic only' }));
  process.exitCode = 1;
}
