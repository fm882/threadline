import { Client } from 'langsmith';

type Stage = 'admission' | 'inference' | 'publication' | 'failure';
export type TraceRecord = { id: string; start: number; end: number; stages: { name: Stage; at: number }[] };
export type TraceSink = (record: TraceRecord) => Promise<void>;

export function langsmithSink(apiKey: string, project: string): TraceSink {
  const client = new Client({ apiKey });
  return async record => {
    await client.createRun({
      id: record.id, name: 'chat turn', run_type: 'chain', project_name: project,
      start_time: record.start, end_time: record.end,
      inputs: { content: '[redacted]' }, outputs: { content: '[redacted]' },
      extra: { metadata: { stages: record.stages } },
    });
  };
}

export function traceTurn(id: string, sink?: TraceSink) {
  const start = Date.now();
  const stages: TraceRecord['stages'] = [{ name: 'admission', at: start }];
  return {
    stage(name: Stage) { stages.push({ name, at: Date.now() }); },
    finish() {
      if (sink) void Promise.resolve().then(() => sink({ id, start, end: Date.now(), stages })).catch(() => {});
    },
  };
}
