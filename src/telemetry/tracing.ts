import { Client, type ClientConfig } from 'langsmith';

type Stage = 'admission' | 'inference' | 'publication' | 'failure' | 'incomplete' | 'cancelled' | 'compaction' | 'incomplete_coverage' | 'history_coverage_complete';
export type TraceDecision = { name: string; values: Record<string, number | boolean> };
export type TraceRecord = { id: string; start: number; end: number; stages: { name: Stage; at: number }[]; decisions?: TraceDecision[] };
export type TraceSink = (record: TraceRecord) => Promise<void>;

export function langsmithSink(apiKey: string, project: string, options: Pick<ClientConfig, 'apiUrl' | 'fetchImplementation'> = {}): TraceSink {
  const client = new Client({ ...options, apiKey, timeout_ms: 2000, callerOptions: { maxRetries: 0 }, omitTracedRuntimeInfo: true, tracingMode: 'langsmith' });
  return async record => {
    await client.createRun({
      id: record.id, trace_id: record.id, name: 'chat turn', run_type: 'chain', project_name: project,
      start_time: record.start, end_time: record.end,
      inputs: { content: '[redacted]' }, outputs: { content: '[redacted]' },
      extra: { metadata: { stages: record.stages, decisions: record.decisions || [] } },
    });
  };
}

export function traceTurn(id: string, sink?: TraceSink, admittedAt = Date.now()) {
  const start = admittedAt;
  const stages: TraceRecord['stages'] = [{ name: 'admission', at: start }];
  const decisions: TraceDecision[] = [];
  return {
    stage(name: Stage) { stages.push({ name, at: Date.now() }); },
    decision(name: string, values: Record<string, number | boolean>) { decisions.push({ name, values }); },
    finish() {
      if (sink) void Promise.resolve().then(() => sink({ id, start, end: Date.now(), stages, decisions })).catch(() => {});
    },
  };
}
