import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { Conflict, NotFound, Store } from '../persistence/store.js';
import { MAX_INPUT_CHARS } from '../research/chat.js';

export const chunks = new EventEmitter();
chunks.setMaxListeners(0);
const bodySchema = z.object({ input: z.string().trim().min(1).max(MAX_INPUT_CHARS) }).strict();
const cursorSchema = z.coerce.number().int().min(0).max(2_147_483_647).default(0);

export function createApp(options: { store: Store; owner: (request: Request) => string; ready: () => string | null | Promise<string | null>; run: (owner: string, id: string) => Promise<void> }) {
  const { store, owner, ready, run } = options;
  const app = new Hono();
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return c.json({ error: 'Invalid host' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      const parsed = URL.parse(origin);
      if (!parsed || parsed.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsed.hostname) || !['3000', '5173'].includes(parsed.port)) return c.json({ error: 'Invalid origin' }, 403);
    }
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 32_768, onError: c => c.json({ error: 'Request too large' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof NotFound) return c.json({ error: error.message }, 404);
    if (error instanceof Conflict) return c.json({ error: error.message }, 409);
    return c.json({ error: 'Internal service error' }, 500);
  });
  app.get('/health/live', c => c.json({ status: 'live' }));
  app.get('/health/ready', async c => {
    const problem = await ready();
    return problem ? c.json({ status: 'unavailable', error: problem }, 503) : c.json({ status: 'ready' });
  });
  app.post('/api/conversations', async c => c.json({ id: await store.createConversation(owner(c.req.raw)) }, 201));
  app.get('/api/conversations', async c => {
    const offset = cursorSchema.safeParse(c.req.query('offset'));
    if (!offset.success) return c.json({ error: 'Invalid offset' }, 400);
    return c.json({ conversations: await store.listConversations(owner(c.req.raw), 50, offset.data) });
  });
  app.get('/api/conversations/:id/messages', async c => {
    const after = cursorSchema.safeParse(c.req.query('after'));
    if (!after.success) return c.json({ error: 'Invalid cursor' }, 400);
    return c.json({ messages: await store.messages(owner(c.req.raw), c.req.param('id'), after.data) });
  });
  app.post('/api/conversations/:id/turns', async c => {
    const key = c.req.header('Idempotency-Key');
    if (!key || key.length > 200) return c.json({ error: 'A valid Idempotency-Key is required' }, 400);
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Input must be nonempty and at most 8000 characters' }, 400);
    const identity = owner(c.req.raw);
    const existing = await store.existingAdmission(identity, c.req.param('id'), key, parsed.data.input);
    if (existing) return c.json({ runId: existing }, 202);
    const problem = await ready();
    if (problem) return c.json({ error: problem }, 503);
    const id = await store.admit(identity, c.req.param('id'), key, parsed.data.input);
    // Identical retries may call the runner again; reserve execution in this process.
    if (!executing.has(id)) {
      executing.add(id);
      void run(identity, id).finally(() => executing.delete(id)).catch(() => {});
    }
    return c.json({ runId: id }, 202);
  });
  const executing = new Set<string>();
  app.get('/api/runs/:id', async c => c.json(await store.getRun(owner(c.req.raw), c.req.param('id'))));
  app.get('/api/runs/:id/events', async c => {
    const identity = owner(c.req.raw), id = c.req.param('id');
    const cursor = cursorSchema.safeParse(c.req.header('Last-Event-ID') ?? c.req.query('after'));
    if (!cursor.success) return c.json({ error: 'Invalid cursor' }, 400);
    await store.getRun(identity, id);
    return streamSSE(c, async stream => {
      let last = cursor.data;
      const pending: string[] = [];
      const listener = (part: string) => { if (pending.length < 128) pending.push(part); };
      chunks.on(id, listener);
      try {
        while (!stream.aborted) {
          const events = await store.events(identity, id, last);
          for (const event of events) {
            last = event.id;
            await stream.writeSSE({ id: String(event.id), event: event.kind, data: event.data });
          }
          while (pending.length) await stream.writeSSE({ event: 'delta', data: JSON.stringify({ content: pending.shift() }) });
          const state = await store.getRun(identity, id);
          if (state.status !== 'active' && events.length < 100) break;
          await stream.sleep(250);
        }
      } finally { chunks.off(id, listener); }
    });
  });
  return app;
}
