import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, localKey } from './local-env.mjs';

// Real, billable smoke tests. No web search or user/private text is sent.
// No retries: failures remain visible and invocation count stays bounded.
const base = (process.env.INFERENCE_BASE_URL || 'http://127.0.0.1:4000/v1').replace(/\/$/, '');
const rerankUrl = process.env.RERANK_URL || new URL('/rerank', base).href;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
if (!process.env.INFERENCE_API_KEY &&
    [base, rerankUrl].some((url) => !loopbackHosts.has(new URL(url).hostname))) {
  throw new Error('Remote endpoints require an explicit INFERENCE_API_KEY; local master keys are never sent remotely.');
}
const key = localKey();
const main = process.env.CHAT_MAIN_MODEL || 'chat-main-v1';
const fast = process.env.CHAT_FAST_MODEL || 'chat-fast-v1';
const embedding = process.env.EMBEDDING_MODEL || 'history-embedding-v1';
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 1024);
const rerank = process.env.RERANK_MODEL || 'history-rerank-v1';
const allowed = ['main-chat', 'fast-stream', 'tool-call', 'structured-output', 'embeddings', 'rerank'];
const selected = process.argv.slice(2);
if (selected.some((name) => !allowed.includes(name))) {
  throw new Error(`Unknown test. Choose from: ${allowed.join(', ')}`);
}
const report = {
  checkedAt: new Date().toISOString(),
  scope: 'Local LiteLLM HTTP contracts with real AWS Bedrock inference; synthetic inputs only.',
  modelIdentityNote: 'Response model fields may contain gateway aliases. Backend identity must be correlated with the gateway route configuration; this script does not independently attest the provider model.',
  models: { main, fast, embedding, rerank },
  checks: [],
};

function safeError(error) {
  return String(error.message || error)
    .replaceAll(key, '[redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-access-key]')
    .replace(/\b\d{12}\b/g, '[account]')
    .slice(0, 650);
}

async function request(path, body, stream = false) {
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`HTTP ${response.status}: ${payload.error?.message || payload.detail || 'request failed'}`);
  }
  if (stream) return response;
  return response.json();
}

const tools = [{ type: 'function', function: {
  name: 'web_search',
  description: 'Search for public web information.',
  parameters: {
    type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false,
  },
} }];

const checks = {
  'main-chat': async () => {
    const result = await request('/chat/completions', {
      model: main, max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with exactly: local inference works' }],
    });
    assert.match(result.choices?.[0]?.message?.content || '', /local inference works/i);
    return { responseModel: result.model, usage: result.usage };
  },
  'fast-stream': async () => {
    const response = await request('/chat/completions', {
      model: fast, max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: streaming works' }],
    }, true);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    let buffer = '', content = '', count = 0, done = false;
    const decoder = new TextDecoder();
    for await (const part of response.body) {
      buffer += decoder.decode(part, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { done = true; continue; }
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.error) throw new Error(event.error.message || 'Streaming error');
        count++;
        content += event.choices?.[0]?.delta?.content || '';
      }
    }
    assert.match(content, /streaming works/i);
    assert.ok(done, 'SSE stream must terminate with [DONE]');
    return { events: count, done };
  },
  'tool-call': async () => {
    const result = await request('/chat/completions', {
      model: main, max_tokens: 128, tools,
      tool_choice: { type: 'function', function: { name: 'web_search' } },
      messages: [{ role: 'user', content: 'Use web_search to look up the official Node.js documentation.' }],
    });
    const call = result.choices?.[0]?.message?.tool_calls?.[0];
    assert.equal(call?.function?.name, 'web_search');
    assert.ok(typeof JSON.parse(call.function.arguments).q === 'string');
    assert.ok(call.id);
    // Tool is intentionally not executed; verifies the tool-call wire contract only.
    return { tool: call.function.name, responseModel: result.model, usage: result.usage };
  },
  'structured-output': async () => {
    const result = await request('/chat/completions', {
      model: main, max_tokens: 128,
      response_format: { type: 'json_schema', json_schema: {
        name: 'local_check', strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      } },
      messages: [{ role: 'user', content: 'Return an object with ok set to true.' }],
    });
    assert.deepEqual(JSON.parse(result.choices?.[0]?.message?.content || ''), { ok: true });
    return { responseModel: result.model, usage: result.usage };
  },
  embeddings: async () => {
    const result = await request('/embeddings', {
      model: embedding, dimensions, encoding_format: 'float',
      input: ['A CRM subscription costs twenty dollars per seat.', 'A cat is sleeping on a sofa.'],
    });
    assert.equal(result.data?.length, 2);
    const vectors = [...result.data].sort((a, b) => a.index - b.index);
    const norms = vectors.map((row, i) => {
      assert.equal(row.index, i);
      assert.equal(row.embedding.length, dimensions);
      assert.ok(row.embedding.every(Number.isFinite));
      const norm = Math.sqrt(row.embedding.reduce((sum, value) => sum + value * value, 0));
      assert.ok(norm > 0.99 && norm < 1.01, `Expected unit norm, got ${norm}`);
      return norm;
    });
    assert.ok(vectors[0].embedding.some((value, i) => value !== vectors[1].embedding[i]), 'Distinct texts must not yield identical vectors');
    return { vectors: vectors.length, dimensions, norms, responseModel: result.model, usage: result.usage };
  },
  rerank: async () => {
    const result = await request(rerankUrl, {
      model: rerank, query: 'What is the monthly CRM subscription price?', top_n: 2,
      documents: ['The CRM plan costs twenty dollars per seat per month.', 'A cat is sleeping on a sofa.'],
    });
    assert.ok(Array.isArray(result.results) && result.results.length === 2);
    assert.equal(result.results[0].index, 0);
    assert.ok(result.results.every((r) => Number.isFinite(r.relevance_score)));
    return { rankedIndices: result.results.map((r) => r.index) };
  },
};

for (const name of selected.length ? selected : allowed) {
  const start = performance.now();
  try {
    const detail = await checks[name]();
    const entry = { name, passed: true, durationMs: Math.round(performance.now() - start), ...detail };
    report.checks.push(entry);
    console.log(`PASS ${name} (${entry.durationMs} ms)`);
  } catch (error) {
    const entry = { name, passed: false, durationMs: Math.round(performance.now() - start), error: safeError(error) };
    report.checks.push(entry);
    console.error(`FAIL ${name}: ${entry.error}`);
  }
}

mkdirSync(join(root, '.data'), { recursive: true, mode: 0o700 });
const reportPath = join(root, '.data', `inference-check-${Date.now()}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`Sanitized report: ${reportPath}`);
process.exitCode = report.checks.every((c) => c.passed) ? 0 : 1;
