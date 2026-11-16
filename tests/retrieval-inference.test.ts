import { it, expect } from 'vitest';
import { createEmbeddingClient, createRerankClient } from '../src/inference/retrieval.js';

it('validates dimensions, indexes, finite values, and configured normalization for embedding responses', async () => {
  const client = createEmbeddingClient({ base: 'http://gateway/v1', key: 'test', model: 'embedding-test', dimensions: 2, normalized: true, queryMode: 'shared', documentMode: 'shared' }, async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'embedding-test', dimensions: 2, encoding_format: 'float', input: ['first', 'second'] });
    return Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] });
  });
  expect(await client(['first', 'second'])).toEqual([[1, 0], [0, 1]]);
  const malformed = createEmbeddingClient({ base: 'http://gateway/v1', key: 'test', model: 'bad', dimensions: 2, normalized: false, queryMode: 'shared', documentMode: 'shared' }, async () => Response.json({ data: [{ index: 0, embedding: [0, Number.NaN] }] }));
  await expect(malformed(['bad'])).rejects.toThrow('invalid vector shape');
  const zero = createEmbeddingClient({ base: 'http://gateway/v1', key: 'test', model: 'bad', dimensions: 2, normalized: false, queryMode: 'shared', documentMode: 'shared' }, async () => Response.json({ data: [{ index: 0, embedding: [0, 0] }] }));
  await expect(zero(['bad'])).rejects.toThrow('zero or invalid vector');
  const wrongNorm = createEmbeddingClient({ base: 'http://gateway/v1', key: 'test', model: 'bad', dimensions: 2, normalized: true, queryMode: 'shared', documentMode: 'shared' }, async () => Response.json({ data: [{ index: 0, embedding: [2, 0] }] }));
  await expect(wrongNorm(['bad'])).rejects.toThrow('normalized vector space');
  let queryMode = '';
  const asymmetric = createEmbeddingClient({ base: 'http://gateway/v1', key: 'test', model: 'mode-test', dimensions: 2, normalized: false, queryMode: 'search_query', documentMode: 'search_document' }, async (_url, init) => {
    queryMode = JSON.parse(String(init?.body)).input_type;
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  });
  await asymmetric(['query text'], 'query');
  expect(queryMode).toBe('search_query');
});

it('validates rerank indexes and scores and returns score-ranked document indexes', async () => {
  const client = createRerankClient({ url: 'http://gateway/rerank', key: 'test', model: 'rerank-test' }, async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'rerank-test', query: 'query', documents: ['a', 'b'], top_n: 2 });
    return Response.json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] });
  });
  expect(await client('query', ['a', 'b'])).toEqual([1, 0]);
  const invalid = createRerankClient({ url: 'http://gateway/rerank', key: 'test', model: 'bad' }, async () => Response.json({ results: [{ index: 0, relevance_score: Number.NaN }] }));
  await expect(invalid('query', ['a'])).rejects.toThrow('invalid rankings');
});
