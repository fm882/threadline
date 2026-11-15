import type { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { Store } from '../persistence/store.js';
import { checkpointAnswer } from '../research/chat.js';
import type { Dispatcher } from './dispatcher.js';

/** Recover accepted jobs locally; do not burn attempts while the gateway is unavailable. */
export function startRecovery(store: Store, saver: SqliteSaver, dispatcher: Dispatcher, ready: () => Promise<string | null>, intervalMs = 1000) {
  let stopped = false;
  let poll: Promise<void> | null = null;
  async function runOnce() {
    const pending = await store.pendingRuns();
    if (stopped || !pending.length) return;
    const gatewayReady = (await ready()) === null;
    for (const run of pending) {
      if (stopped) return;
      let hasAnswer = false;
      try { hasAnswer = (await checkpointAnswer(saver, run.id)) !== null; }
      catch { hasAnswer = true; } // Dispatch to fail safely rather than silently strand a bad checkpoint.
      if (gatewayReady || hasAnswer) dispatcher.dispatch(run.owner_id, run.id);
    }
  }
  function tick() {
    if (stopped || poll) return;
    poll = runOnce().catch(() => {}).finally(() => { poll = null; });
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  return async () => { stopped = true; clearInterval(timer); if (poll) await poll; };
}
