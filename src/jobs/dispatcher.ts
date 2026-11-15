import type { Store } from '../persistence/store.js';

export type RunWorker = (owner: string, id: string, signal: AbortSignal) => Promise<void>;

/** Single-process execution registry shared by admission, recovery, and cancellation. */
export function createDispatcher(store: Store, run: RunWorker, maxConcurrent = 10) {
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let stopping = false;
  return {
    dispatch(owner: string, id: string): boolean {
      if (stopping || active.has(id) || active.size >= maxConcurrent) return false;
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => run(owner, id, controller.signal))
        .catch(async () => {
          if (!controller.signal.aborted) await store.fail(owner, id, 'The chat service failed or timed out. Check gateway configuration and try again.');
        }).catch(() => {}).finally(() => active.delete(id));
      active.set(id, { controller, promise });
      return true;
    },
    abort(id: string) { active.get(id)?.controller.abort(); },
    async shutdown() {
      stopping = true;
      const running = [...active.values()];
      for (const task of running) task.controller.abort();
      await Promise.allSettled(running.map(task => task.promise));
    },
  };
}
export type Dispatcher = ReturnType<typeof createDispatcher>;
