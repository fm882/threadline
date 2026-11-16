import { it, expect } from 'vitest';
import { langsmithSink } from '../src/telemetry/tracing.js';

it('exports a correlated redacted trace to the LangSmith API contract', async () => {
  const requests: { url: string; body: string }[] = [];
  const sink = langsmithSink('fixture-key', 'synthetic', {
    apiUrl: 'http://127.0.0.1:12345',
    fetchImplementation: async (input, init) => {
      const body = init?.body;
      requests.push({ url: String(input), body: body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? '') });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const id = '1ab22b0d-3bf2-47a7-a707-f7299ba5bbcc';
  await sink({ id, start: 1000, end: 2000, stages: [{ name: 'admission', at: 1000 }, { name: 'inference', at: 1200 }, { name: 'compaction', at: 1250 }, { name: 'publication', at: 1900 }], decisions: [{ name: 'context_budget', values: { removedPairs: 2, inputTokens: 12000, availableTokens: 28928 } }, { name: 'history_coverage', values: { complete: false } }] });
  const submission = requests.find(request => request.url.endsWith('/runs'));
  expect(submission).toBeDefined();
  const data = JSON.parse(submission!.body);
  expect(data.id).toBe(id);
  expect(data.trace_id).toBe(id);
  expect(data.inputs).toEqual({ content: '[redacted]' });
  expect(data.outputs).toEqual({ content: '[redacted]' });
  expect(data.extra.metadata.stages.map((stage: { name: string }) => stage.name)).toEqual(['admission', 'inference', 'compaction', 'publication']);
  expect(data.extra.metadata.decisions).toEqual([{ name: 'context_budget', values: { removedPairs: 2, inputTokens: 12000, availableTokens: 28928 } }, { name: 'history_coverage', values: { complete: false } }]);
});
